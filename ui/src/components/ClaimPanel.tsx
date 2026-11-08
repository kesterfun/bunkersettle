import { useMemo, useState, type ReactNode } from "react";
import type { ContractTransactionResponse } from "ethers";
import { ethers } from "ethers";
import { ADDRESSES, useChain, useChainNow, type Contracts } from "../chain/ChainContext";
import {
  ZERO_ADDRESS,
  accountIndex,
  discountPct,
  fmtPct,
  fmtSgd,
  isFinanced,
  type OrderView,
} from "../domain";
import { SupplierRecord } from "./SupplierRecord";
import "./ClaimPanel.css";

/** What each recipient has been paid out of escrow for this order, replayed from Released and Split events. */
export function usePayouts(orderId: number): { to: string; amount: bigint }[] {
  const { events } = useChain();
  return useMemo(() => {
    const paid = new Map<string, bigint>();
    const add = (to: string, amount: bigint) => paid.set(to, (paid.get(to) ?? 0n) + amount);
    for (const e of events) {
      if (e.orderId !== orderId) continue;
      if (e.name === "Released") add(String(e.args.to), e.args.amount as bigint);
      if (e.name === "Split" && (e.args.supplierAmount as bigint) > 0n) add(String(e.args.supplier), e.args.supplierAmount as bigint);
    }
    return [...paid.entries()].map(([to, amount]) => ({ to, amount }));
  }, [events, orderId]);
}

/** Why the claim cannot be traded right now, in plain words; null when it can. */
function lockReason(o: OrderView, paused: boolean, now: number): string | null {
  if (paused) return "The platform is paused, so claims can't be traded right now.";
  switch (o.status) {
    case "Disputed":
      return "This claim can't be traded while the order is in dispute. Payment waits for the arbiter's decision.";
    case "Settled":
      return "This order is settled, so the claim has been paid out and can't be traded.";
    case "Resolved":
      return "The dispute was resolved and the claim has been paid out, so it can't be traded.";
    case "Cancelled":
      return "The order was cancelled and the claim cancelled with it, so there is nothing to trade.";
    case "Funded":
      if (now > o.deliveryDeadline && !o.delivery.meterSubmitted && !o.delivery.ebdnSubmitted) {
        return "This claim can't be traded: the delivery deadline passed with no delivery evidence.";
      }
      return null;
    default:
      return null;
  }
}

/** Default asking price: 99 % of the outstanding amount, as a plain decimal string. */
function defaultPrice(outstanding: bigint): string {
  return Number(ethers.formatEther((outstanding * 99n) / 100n)).toFixed(2);
}

function parsePrice(text: string): bigint | null {
  try {
    const v = ethers.parseEther(text.trim());
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

interface ClaimAct {
  key: string;
  who: ReactNode;
  party: boolean;
  node: ReactNode;
}

/** The order's payment claim: who holds it, what is still owed, the open offer, and who can trade it. */
export function ClaimPanel({ order: o }: { order: OrderView }) {
  const { me, send, nameOf, paused, claimAllowance, events } = useChain();
  const now = useChainNow();
  const payouts = usePayouts(o.id);
  const [priceText, setPriceText] = useState<string | null>(null);

  const holder = o.claim.holder;
  const hasClaim = holder !== ZERO_ADDRESS;
  const mine = (a: string) => !!me && me.address.toLowerCase() === a.toLowerCase();
  const iHold = hasClaim && mine(holder);
  const isFinancier = !!me?.roles.includes("FINANCIER");
  const lock = lockReason(o, paused, now);
  const financed = isFinanced(o);
  const outstanding = o.claim.outstanding;
  const offer = o.claim.offerPrice;
  const hasOffer = offer > 0n;

  const sale = useMemo(() => events.find((e) => e.name === "ClaimSold" && e.orderId === o.id), [events, o.id]);

  const who = (a: string) => `${nameOf(a)}${accountIndex(a) >= 0 ? ` · #${accountIndex(a)}` : ""}`;
  const askText = priceText ?? defaultPrice(outstanding);
  const ask = parsePrice(askText);
  const askDiscount = ask !== null && outstanding > 0n ? discountPct(ask, outstanding) : null;

  const run = (label: string, build: (c: Contracts) => Promise<ContractTransactionResponse>, done: string) => () =>
    void send(label, build, done);

  const buy = async () => {
    const price = offer;
    if (isFinancier && claimAllowance < price) {
      const ok = await send(
        "Approve mSGD for claim purchase, step 1 of 2",
        (c) => c.MockSGD.approve(ADDRESSES.SettlementClaim, price),
        "mSGD approved, buying next",
      );
      if (!ok) return;
      await send("Buy claim, step 2 of 2", (c) => c.SettlementClaim.buy(o.id, price), "Claim bought");
      return;
    }
    await send("Buy claim", (c) => c.SettlementClaim.buy(o.id, price), "Claim bought");
  };

  const acts: ClaimAct[] = [];
  if (!lock && hasClaim) {
    acts.push({
      key: "offer",
      party: iHold,
      who: `Claim holder · ${who(holder)}`,
      node: iHold ? (
        <div className="cp-offer">
          <label className="cp-ask">
            <span>Asking price (mSGD)</span>
            <input
              inputMode="decimal"
              value={askText}
              onChange={(e) => setPriceText(e.target.value)}
              aria-describedby={`cp-ask-${o.id}`}
            />
          </label>
          <div className="cp-live" id={`cp-ask-${o.id}`}>
            {askDiscount === null ? (
              <span>Enter a price above zero.</span>
            ) : (
              <>
                <b>{fmtPct(askDiscount)}</b> <span>{askDiscount >= 0 ? "discount" : "above outstanding"}</span>
              </>
            )}
          </div>
          <button
            className="btn"
            disabled={ask === null}
            onClick={run("Offer for sale", (c) => c.SettlementClaim.offer(o.id, ask!), "Claim offered")}
          >
            Offer for sale
          </button>
        </div>
      ) : (
        <button
          className="btn btn-ghost"
          onClick={run("Offer for sale", (c) => c.SettlementClaim.offer(o.id, parsePrice(defaultPrice(outstanding)) ?? 1n), "Claim offered")}
        >
          Offer for sale
        </button>
      ),
    });
    if (hasOffer) {
      acts.push({
        key: "withdraw",
        party: iHold,
        who: `Claim holder · ${who(holder)}`,
        node: (
          <button
            className={`btn${iHold ? "" : " btn-ghost"}`}
            onClick={run("Withdraw offer", (c) => c.SettlementClaim.cancelOffer(o.id), "Offer withdrawn")}
          >
            Withdraw offer
          </button>
        ),
      });
      if (!iHold) {
        const party = isFinancier;
        acts.push({
          key: "buy",
          party,
          who: party ? `Financier · ${me ? who(me.address) : ""}` : "Financier only",
          node: (
            <div className="cp-buy">
              {party && <SupplierRecord supplier={o.supplier} />}
              <button className={`btn${party ? "" : " btn-ghost"}`} onClick={() => void buy()}>
                Buy claim for {fmtSgd(offer)} mSGD
              </button>
            </div>
          ),
        });
      }
    }
  }
  const myActs = acts.filter((a) => a.party);
  const otherActs = acts.filter((a) => !a.party);
  const renderAct = (a: ClaimAct) => (
    <div key={a.key} className="cp-act">
      <span className="cp-who">{a.who}</span>
      {a.node}
    </div>
  );

  return (
    <section className="cp" aria-label="Payment claim">
      <h4 className="cp-title">Payment claim</h4>
      <p className="cp-lede">The right to be paid for this order. Whoever holds it receives every payout from escrow.</p>

      <dl className="cp-facts">
        <div>
          <dt>Held by</dt>
          <dd>
            {hasClaim ? who(holder) : "No claim (the order was cancelled or not funded yet)"}
            {financed && <span className="cp-tag">Financier</span>}
          </dd>
        </div>
        <div>
          <dt>Still outstanding</dt>
          <dd className="cp-num">{fmtSgd(outstanding)} mSGD</dd>
        </div>
      </dl>

      {hasOffer && (
        <div className="cp-readout" role="status">
          <b>{fmtPct(discountPct(offer, outstanding))}</b>
          <span>
            discount: offered at {fmtSgd(offer)} mSGD against {fmtSgd(outstanding)} outstanding
          </span>
        </div>
      )}
      {!hasOffer && !lock && hasClaim && <p className="cp-quiet">No open offer. The holder can offer the claim for sale.</p>}

      {lock && <p className="cp-lock">{lock}</p>}

      {financed && (
        <p className="cp-fin">
          {sale
            ? `${nameOf(String(sale.args.seller))} sold this claim to ${nameOf(holder)} for ${fmtSgd(sale.args.price as bigint)} mSGD. `
            : ""}
          Payouts go to {nameOf(holder)}, not to {nameOf(o.supplier)}.
        </p>
      )}

      {payouts.length > 0 && (
        <ul className="cp-paid">
          {payouts.map((p) => (
            <li key={p.to}>
              Paid to {nameOf(p.to)}: <b>{fmtSgd(p.amount)} mSGD</b>
            </li>
          ))}
        </ul>
      )}

      {acts.length > 0 && (
        <div className="cp-acts">
          {myActs.map(renderAct)}
          {otherActs.length > 0 && (
            <details className="os-others">
              <summary>Other parties' claim actions ({otherActs.length}). Press one to demo the revert.</summary>
              {otherActs.map(renderAct)}
            </details>
          )}
        </div>
      )}
    </section>
  );
}
