import { useState } from "react";
import { ethers } from "ethers";
import { useChain } from "../chain/ChainContext";
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

/**
 * Live feed of decoded contract events, newest first.
 * @param orderId only events for this order
 * @param limit max rows (default all)
 * @param compact hide the contract and tx columns
 */
export function ActivityLog({ orderId, limit, compact }: { orderId?: number; limit?: number; compact?: boolean }) {
  const { events, nameOf } = useChain();
  const [filter, setFilter] = useState("");
  let rows = orderId !== undefined ? events.filter((e) => e.orderId === orderId) : events;
  if (filter) {
    const f = filter.toLowerCase();
    rows = rows.filter((e) => e.name.toLowerCase().includes(f) || e.contract.toLowerCase().includes(f));
  }
  if (limit) rows = rows.slice(0, limit);

  return (
    <div className="al">
      {!compact && (
        <label className="field al-filter">
          <span>Filter events</span>
          <input id="al-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="e.g. Dispute, PaymentEscrow" />
        </label>
      )}
      {rows.length === 0 ? (
        <div className="empty">No events yet. They appear here as soon as a transaction is mined.</div>
      ) : (
        <div className="table-wrap">
          <table className="data al-table">
            <thead>
              <tr>
                <th>Block</th>
                <th>Event</th>
                <th>Details</th>
                {!compact && <th>Contract</th>}
                {!compact && <th>Tx</th>}
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
                    {Object.entries(e.args)
                      .filter(([k]) => !(compact && (k === "id" || k === "orderId")))
                      .map(([k, v]) => (
                        <span key={k}>
                          <span className="al-k">{k}</span> {fmtValue(k, v, nameOf)}
                        </span>
                      ))}
                  </td>
                  {!compact && <td>{e.contract}</td>}
                  {!compact && (
                    <td className="mono" title={e.txHash}>
                      {shortHex(e.txHash)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
