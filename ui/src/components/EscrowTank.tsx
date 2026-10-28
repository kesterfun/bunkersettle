import { fmtSgd, retentionOf, fundingAmount, type OrderView } from "../domain";

/** Vertical escrow tank: blue = held in escrow, striped yellow = retention still held. */
export function EscrowTank({ order: o }: { order: OrderView }) {
  const capacity = o.fundedAmount > 0n ? o.fundedAmount : fundingAmount(o);
  const pct = (v: bigint) => (capacity > 0n ? Math.min(100, Number((v * 10000n) / capacity) / 100) : 0);
  const retention = retentionOf(o);
  const heldPct = pct(o.held);
  const retPct = Math.min(heldPct, pct(retention));
  return (
    <aside className="os-tankcol" aria-label="Escrow tank">
      <span className="label">Escrow tank</span>
      <div className="os-tank" role="img" aria-label={`Held ${fmtSgd(o.held)} of ${fmtSgd(capacity)} mSGD`}>
        <div className="os-fill" style={{ height: `${heldPct}%` }} />
        <div className="os-ret" style={{ height: `${retPct}%` }} />
      </div>
      <div className="os-tankv">
        {fmtSgd(o.held)}
        <span className="os-unit"> mSGD held</span>
      </div>
      <div className="os-key">
        <span style={{ ["--k" as string]: "var(--blue)" }}>Held in escrow</span>
        <span style={{ ["--k" as string]: "var(--yellow)" }}>Retention {fmtSgd(retention)}</span>
        <span style={{ ["--k" as string]: "var(--soft)" }}>
          {o.fundedAmount > 0n ? "Capacity" : "To be funded"} {fmtSgd(capacity)}
        </span>
      </div>
    </aside>
  );
}
