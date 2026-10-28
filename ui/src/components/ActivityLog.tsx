import { useMemo, useState } from "react";
import { ethers } from "ethers";
import { useChain } from "../chain/ChainContext";
import { describeEvent, groupByTx, headline, isNoise } from "../activity";
import { ANCHORAGES, DOC_TYPES, REASONS, roleFromHash, shortHex, type ActivityEvent } from "../domain";
import "./ActivityLog.css";

/** Event colour swatch: evidence yellow, money blue, disputes red, settlement green. */
function tone(e: ActivityEvent): string {
  if (/Dispute|Mismatch|Cancelled/.test(e.name)) return "var(--red)";
  if (/Settled|Resolved|Refunded|Split/.test(e.name)) return "var(--green)";
  if (/Submitted|Evidence/.test(e.name)) return "var(--yellow)";
  if (e.contract === "ParticipantRegistry") return "var(--grey)";
  return "var(--blue)";
}

function fmtValue(key: string, v: unknown, nameOf: (a: string) => string): string {
  if (typeof v === "bigint") {
    if (/amount|Amount|^value$|refunded|paidTo|releasedNow/.test(key)) return `${Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 2 })} mSGD`;
    if (/Kg$/.test(key)) return `${v.toLocaleString("en-US")} kg`;
    if (key === "docType") return DOC_TYPES[Number(v)] ?? String(v);
    if (key === "reason") return REASONS[Number(v)] ?? String(v);
    if (key === "pricePerTonne") return `${ethers.formatEther(v)} mSGD/t`;
    if (key === "anchorage") return ANCHORAGES[Number(v)]?.name ?? String(v);
    return v.toString();
  }
  if (typeof v === "string" && ethers.isAddress(v)) return nameOf(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) return roleFromHash(v) ?? shortHex(v);
  return String(v);
}

function fmtTime(ts: number): string {
  return ts ? new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost al-copy"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * Live feed of decoded contract events, newest first, grouped by transaction.
 * @param orderId only transactions with events for this order
 * @param limit max transactions in the grouped view, or rows in the raw view (default all)
 * @param compact grouped cards only, no filters
 */
export function ActivityLog({ orderId, limit, compact }: { orderId?: number; limit?: number; compact?: boolean }) {
  const { events, txs, nameOf, me } = useChain();
  const [raw, setRaw] = useState(false);
  const [orderSel, setOrderSel] = useState("");
  const [contractSel, setContractSel] = useState("");
  const [mineOnly, setMineOnly] = useState(false);

  const groups = useMemo(() => groupByTx(events, txs), [events, txs]);
  const orderIds = useMemo(() => [...new Set(events.map((e) => e.orderId).filter((x): x is number => x !== undefined))].sort((a, b) => a - b), [events]);
  const contracts = useMemo(() => [...new Set(events.map((e) => e.contract))].sort(), [events]);

  const myAddr = me?.address.toLowerCase();
  const isMine = (from: string, evs: ActivityEvent[]) =>
    !!myAddr &&
    (from.toLowerCase() === myAddr ||
      evs.some((e) => Object.values(e.args).some((v) => typeof v === "string" && v.toLowerCase() === myAddr)));

  const effOrder = orderId !== undefined ? orderId : orderSel ? Number(orderSel) : undefined;
  const filtering = !compact;

  // Grouped view.
  let shown = groups;
  if (effOrder !== undefined) shown = shown.filter((g) => g.events.some((e) => e.orderId === effOrder));
  if (filtering && contractSel) shown = shown.filter((g) => g.events.some((e) => e.contract === contractSel));
  if (filtering && mineOnly) shown = shown.filter((g) => isMine(g.from, g.events));
  if (limit) shown = shown.slice(0, limit);

  // Raw view.
  let rows = events;
  if (effOrder !== undefined) rows = rows.filter((e) => e.orderId === effOrder);
  if (filtering && contractSel) rows = rows.filter((e) => e.contract === contractSel);
  if (filtering && mineOnly) rows = rows.filter((e) => isMine(txs[e.txHash]?.from ?? "", [e]));
  if (limit) rows = rows.slice(0, limit);

  const showRaw = filtering && raw;

  return (
    <div className="al">
      {filtering && (
        <div className="al-bar">
          {orderId === undefined && (
            <label className="field al-sel">
              <span>Order</span>
              <select value={orderSel} onChange={(e) => setOrderSel(e.target.value)}>
                <option value="">All orders</option>
                {orderIds.map((id) => (
                  <option key={id} value={id}>
                    Order {id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field al-sel">
            <span>Contract</span>
            <select value={contractSel} onChange={(e) => setContractSel(e.target.value)}>
              <option value="">All contracts</option>
              {contracts.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="al-check">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} disabled={!me} />
            Only my account
          </label>
          <label className="al-check">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
            Raw events
          </label>
        </div>
      )}

      {(showRaw ? rows.length === 0 : shown.length === 0) ? (
        <div className="empty">
          {events.length === 0
            ? "No events yet. They appear here as soon as a transaction is mined."
            : "Nothing matches these filters. Clear a filter to see more."}
        </div>
      ) : showRaw ? (
        <div className="table-wrap">
          <table className="data al-table">
            <thead>
              <tr>
                <th>Block</th>
                <th>Event</th>
                <th>Details</th>
                <th>Contract</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.key}>
                  <td className="mono">{e.blockNumber}</td>
                  <td className="al-name">
                    <span className="al-sw" style={{ background: tone(e) }} />
                    {e.name}
                  </td>
                  <td className="al-args">
                    {Object.entries(e.args).map(([k, v]) => (
                      <span key={k}>
                        <span className="al-k">{k}</span> {fmtValue(k, v, nameOf)}
                      </span>
                    ))}
                  </td>
                  <td>{e.contract}</td>
                  <td className="mono" title={e.txHash}>
                    {shortHex(e.txHash)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ol className="al-groups">
          {shown.map((g) => {
            const visible = g.events.filter((e) => !isNoise(e, g));
            const nContracts = new Set(visible.map((e) => e.contract)).size;
            return (
              <li key={g.txHash} className="al-card">
                <div className="al-head">{headline(g, nameOf)}</div>
                <div className="al-meta">
                  <span>Block {g.blockNumber}</span>
                  {g.timestamp > 0 && <span>{fmtTime(g.timestamp)}</span>}
                  <span className="mono" title={g.txHash}>
                    {shortHex(g.txHash)}
                  </span>
                  <CopyButton text={g.txHash} />
                  <span className="al-count">
                    {visible.length} {visible.length === 1 ? "event" : "events"}
                  </span>
                  {nContracts > 1 && <span className="al-chain">{nContracts} contracts</span>}
                </div>
                <ul className="al-chainlist">
                  {visible.map((e) => (
                    <li key={e.key}>
                      <span className="al-sw" style={{ background: tone(e) }} />
                      <span className="al-arrow" aria-hidden="true">
                        →
                      </span>
                      {describeEvent(e, nameOf)}
                    </li>
                  ))}
                </ul>
                <details className="al-raw">
                  <summary>Raw args</summary>
                  {g.events.map((e) => (
                    <div key={e.key} className="al-rawev">
                      <b>{e.name}</b> <span className="al-k">{e.contract}</span>
                      <div className="al-args">
                        {Object.entries(e.args).map(([k, v]) => (
                          <span key={k}>
                            <span className="al-k">{k}</span> {fmtValue(k, v, nameOf)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
