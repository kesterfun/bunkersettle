import { useState, type ReactNode } from "react";
import type { ContractTransactionResponse } from "ethers";
import { ADDRESSES, useChain, useChainNow, type Contracts } from "../chain/ChainContext";
import {
  ANCHORAGES,
  PIPELINE,
  REASON_LABEL,
  STATUS_LABEL,
  accountIndex,
  fmtDuration,
  fmtSgd,
  fmtTonnes,
  fundingAmount,
  isBunkering,
  isMyTurn,
  nextStep,
  ROLE_LABEL,
  shortHex,
  type OrderView,
  type StatusName,
} from "../domain";
import { ActivityLog } from "./ActivityLog";
import { BravoFlag, Stamp, Who } from "./ui";
import { EscrowTank } from "./EscrowTank";
import { DemoGuide, NextStepBox } from "./ScenarioStepper";
import "./OrderScreen.css";

const ZERO_HASH = /^0x0*$/;
const BRANCH: StatusName[] = ["Disputed", "Resolved", "Cancelled"];

/** Index of the pipeline stage a branch status left from. */
function branchIndex(o: OrderView): number {
  if (o.status === "Cancelled") return o.fundedAmount > 0n ? 2 : 0;
  return o.approvedAt === 0 ? 2 : 3;
}

function Pipeline({ o }: { o: OrderView }) {
  const branch = BRANCH.includes(o.status);
  const cur = branch ? branchIndex(o) : PIPELINE.indexOf(o.status);
  return (
    <div>
      <div className="os-pipe" role="list">
        {PIPELINE.map((s, i) => {
          let cls = "os-next-stage";
          if (o.status === "Settled") cls = i === 4 ? "os-fin" : "os-done";
          else if (branch) cls = i <= cur ? "os-done" : "os-next-stage";
          else if (i < cur) cls = "os-done";
          else if (i === cur) cls = "os-now";
          return (
            <div key={s} role="listitem" className={cls}>
              {STATUS_LABEL[s]}
              <small>{i + 1}/5</small>
            </div>
          );
        })}
      </div>
      {branch && (
        <div className="os-branch" style={{ marginLeft: `${(cur / 5) * 100}%`, width: `${100 / 5}%`, minWidth: "9rem" }}>
          <span className={`os-branch-band os-branch-${o.status}`}>{STATUS_LABEL[o.status]}</span>
          <small>left after {STATUS_LABEL[PIPELINE[cur]]}</small>
        </div>
      )}
    </div>
  );
}

function Hash({ h }: { h: string }) {
  return <code title={h}>{ZERO_HASH.test(h) ? "none" : shortHex(h, 5)}</code>;
}

interface Act {
  key: string;
  label: string;
  who: ReactNode;
  turn: boolean;
  /** The connected account is a party allowed to take this action (ignores timers). */
  party: boolean;
  can: boolean;
  reason: string;
  danger?: boolean;
  run: (c: Contracts) => Promise<ContractTransactionResponse>;
}

export function OrderScreen() {
  const { orders, disputes, me, allowance, orderId, go, send, uiChecks, nameOf, blockNumber } = useChain();
  const now = useChainNow();
  const [guideOpen, setGuideOpen] = useState(false);

  if (orders.length === 0) {
    return (
      <div className="empty os-empty">
        <p>No orders on chain yet.</p>
        <button className="btn" onClick={() => go("create")}>
          Create an order
        </button>
      </div>
    );
  }
  const o = orders.find((x) => x.id === orderId) ?? orders[orders.length - 1];
  const dispute = o.disputeId ? disputes.find((d) => d.id === o.disputeId) : undefined;
  const anchorage = ANCHORAGES[o.anchorage];
  const mine = (a: string) => !!me && me.address.toLowerCase() === a.toLowerCase();

  const person = (role: string, addr: string) => (
    <>
      {role} · {nameOf(addr)}
      {accountIndex(addr) >= 0 && ` #${accountIndex(addr)}`}
    </>
  );
  const buyerOrSupplier = mine(o.buyer) || mine(o.supplier);
  const turn = isMyTurn(o, me);

  const acts: Act[] = [];
  const st = o.status;
  if (st === "Created") {
    acts.push({
      key: "accept", label: "Accept order", who: person("Supplier", o.supplier), turn: turn && mine(o.supplier),
      party: mine(o.supplier), can: mine(o.supplier), reason: "Only the order's supplier can accept.",
      run: (c) => c.BunkerOrder.acceptOrder(o.id),
    });
  }
  if (st === "Accepted") {
    if (allowance < fundingAmount(o)) {
      acts.push({
        key: "approve", label: "Approve mSGD for escrow", who: person("Bank", o.bank), turn: mine(o.bank),
        party: mine(o.bank), can: mine(o.bank), reason: "Only the bank needs to approve its own mSGD.",
        run: (c) => c.MockSGD.approve(ADDRESSES.PaymentEscrow, fundingAmount(o)),
      });
    }
    acts.push({
      key: "fund", label: "Fund order", who: person("Bank", o.bank), turn: turn && mine(o.bank),
      party: mine(o.bank), can: mine(o.bank) && allowance >= fundingAmount(o),
      reason: mine(o.bank) ? "Approve mSGD for escrow first." : "Only the order's bank can fund.",
      run: (c) => c.BunkerOrder.fundOrder(o.id),
    });
  }
  if (st === "Created" || st === "Accepted") {
    acts.push({
      key: "cancel", label: "Cancel order", who: person("Buyer", o.buyer), turn: false, danger: true,
      party: mine(o.buyer), can: mine(o.buyer), reason: "Only the order's buyer can cancel.",
      run: (c) => c.BunkerOrder.cancelOrder(o.id),
    });
  }
  if (st === "Funded") {
    acts.push({
      key: "expire", label: "Cancel expired order", who: "Anyone", turn: false,
      party: !!me, can: !!me && now > o.deliveryDeadline, reason: "The delivery deadline has not passed.",
      run: (c) => c.BunkerOrder.cancelExpired(o.id),
    });
  }
  if (st === "QuantityApproved") {
    acts.push({
      key: "release", label: "Release retention after timeout", who: "Anyone", turn: false,
      party: !!me, can: !!me && now >= o.approvedAt + o.retentionWindow, reason: "The retention window is still running.",
      run: (c) => c.BunkerOrder.releaseAfterTimeout(o.id),
    });
  }
  if (st === "Funded" || st === "QuantityApproved") {
    acts.push({
      key: "dispute", label: "Open dispute (manual)", who: "Buyer or Supplier", turn: false, danger: true,
      party: buyerOrSupplier, can: buyerOrSupplier, reason: "Only the buyer or supplier can open a manual dispute.",
      run: (c) => c.DisputeManager.openDispute(o.id, 3),
    });
  }

  // The connected account's own actions come first; the rest stay reachable (collapsed) so the
  // demo can still trigger a revert from the wrong account (SPEC 8: never hide contract reverts).
  const myActs = acts.filter((a) => a.party);
  const otherActs = acts.filter((a) => !a.party);
  const next = nextStep(o);
  const renderAct = (a: Act) => {
    const blocked = uiChecks && !a.can;
    return (
      <div key={a.key} className={`os-act${a.turn ? " os-act-turn" : ""}`}>
        <button
          className={`btn${a.danger ? " btn-danger" : ""}${a.party ? "" : " btn-ghost"}`}
          disabled={blocked}
          onClick={() => void send(a.label, a.run)}
        >
          {a.label}
        </button>
        <span className="os-act-who">
          {a.turn && <b className="os-turn">Your turn</b>}
          {a.who}
          {blocked && <small>{a.reason}</small>}
        </span>
      </div>
    );
  };

  const showDeliveryClock = st === "Created" || st === "Accepted" || st === "Funded";
  const retentionEnd = o.approvedAt + o.retentionWindow;
  const clock = (end: number) => (end - now > 0 ? fmtDuration(end - now) : "passed");

  const stampNote = st === "Disputed" && dispute ? REASON_LABEL[dispute.reason] : `Block ${blockNumber}`;
  const delivered = o.deliveredKg === 0n && o.delivery.meterSubmitted ? o.delivery.meterKg : o.deliveredKg;

  return (
    <div className="os-grid">
      <DemoGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

      <section className="os-main">
        <div className="os-bar">
          <label className="os-pick">
            <span className="label">Order</span>
            <select value={o.id} onChange={(e) => go("order", Number(e.target.value))}>
              {[...orders].reverse().map((x) => (
                <option key={x.id} value={x.id}>
                  Order {x.id} · {STATUS_LABEL[x.status]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-sm btn-ghost os-guide-btn" onClick={() => setGuideOpen(true)}>
            Demo guide
          </button>
          <span className="os-bar-gap" />
          {isBunkering(o) && (
            <span className="os-bravo">
              <BravoFlag size={2.4} /> Bunkering in progress
            </span>
          )}
        </div>

        <div className="os-title">
          <div>
            <h3>
              Order {o.id} · {fmtTonnes(o.qtyKg)} {o.fuelGrade}
            </h3>
            <p className="os-parties">
              <b><Who address={o.buyer} /></b> → <b><Who address={o.supplier} /></b>
              <span className="os-sep"> · bank </span>
              <b><Who address={o.bank} /></b>
            </p>
            {anchorage && <p className="os-anch">{anchorage.name}</p>}
          </div>
          <Stamp status={st} note={stampNote} />
        </div>

        <Pipeline o={o} />

        <div className="os-money">
          <div><span className="label">Funded</span><b>{fmtSgd(o.fundedAmount)}</b></div>
          <div><span className="label">Paid to supplier</span><b>{fmtSgd(o.releasedAmount)}</b></div>
          <div><span className="label">Refunded to bank</span><b>{fmtSgd(o.refundedAmount)}</b></div>
          <div><span className="label">Delivered</span><b>{fmtTonnes(delivered)}</b></div>
        </div>

        <div className="os-deadlines">
          {showDeliveryClock && (
            <div>
              <span className="label">Delivery deadline</span>
              <b className="mono">{clock(o.deliveryDeadline)}</b>
            </div>
          )}
          {st === "QuantityApproved" && (
            <div>
              <span className="label">Retention window</span>
              <b className="mono">{clock(retentionEnd)}</b>
            </div>
          )}
          {(showDeliveryClock || st === "QuantityApproved") && (
            <p className="os-hint">Waiting on a timer? Use Fast-forward in the header.</p>
          )}
        </div>

        <div className="os-evidence">
          <span className="label">Evidence</span>
          <table className="data">
            <tbody>
              <tr>
                <td>Meter</td>
                <td>{o.delivery.meterSubmitted ? fmtTonnes(o.delivery.meterKg) : "not submitted"}</td>
                <td><Hash h={o.delivery.ticketHash} /></td>
              </tr>
              <tr>
                <td>e-BDN</td>
                <td>{o.delivery.ebdnSubmitted ? fmtTonnes(o.delivery.ebdnKg) : "not submitted"}</td>
                <td><Hash h={o.delivery.ebdnHash} /></td>
              </tr>
              <tr>
                <td>Lab result</td>
                <td>{o.lab.submitted ? (o.lab.passed ? "Pass" : "Fail") : "not submitted"}</td>
                <td><Hash h={o.lab.reportHash} /></td>
              </tr>
              <tr>
                <td>Sales confirmation</td>
                <td>DSC</td>
                <td><Hash h={o.dscHash} /></td>
              </tr>
            </tbody>
          </table>
          {o.disputeId > 0 && (
            <p>
              Dispute #{o.disputeId}
              {dispute && <> · {REASON_LABEL[dispute.reason]}{dispute.resolved ? " · resolved" : ""}</>}{" "}
              <button className="btn btn-ghost btn-sm" onClick={() => go("disputes")}>Open Disputes view</button>
            </p>
          )}
        </div>

        <NextStepBox order={o} />

        <div className="os-actions">
          <span className="label">Actions</span>
          {acts.length === 0 && st !== "Disputed" && <p className="os-hint">No actions left on this order.</p>}
          {acts.length > 0 && myActs.length === 0 && (
            <p className="os-hint">
              Nothing for {me ? nameOf(me.address) : "this account"} to do here.
              {next && <> Next: {next.label} ({ROLE_LABEL[next.role]}).</>}
            </p>
          )}
          {myActs.map(renderAct)}
          {otherActs.length > 0 && (
            <details className="os-others">
              <summary>Other parties' actions ({otherActs.length}). Press one to demo the revert.</summary>
              {otherActs.map(renderAct)}
            </details>
          )}
          {(st === "Funded" || st === "QuantityApproved") && (
            <button className="btn btn-ghost" onClick={() => go("oracle", o.id)}>
              Oracle console ({st === "Funded" ? "meter / e-BDN" : "lab"})
            </button>
          )}
          {st === "Disputed" && (
            <button className="btn" onClick={() => go("disputes")}>
              Go to Disputes view (arbiter resolves)
            </button>
          )}
        </div>

        <div className="os-feed">
          <span className="label">Activity for this order</span>
          <ActivityLog orderId={o.id} limit={8} compact />
        </div>
      </section>

      <EscrowTank order={o} />
    </div>
  );
}
