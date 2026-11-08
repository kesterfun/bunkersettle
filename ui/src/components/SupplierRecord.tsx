import { useMemo } from "react";
import { useChain } from "../chain/ChainContext";
import { REASONS, type OrderView } from "../domain";
import "./ClaimPanel.css";

type Reason = (typeof REASONS)[number];

/** Plain-English phrase for each dispute reason, as used in "resolved after a dispute" counts. */
const REASON_PHRASE: Record<Reason, string> = {
  OUT_OF_TOLERANCE: "delivered quantity outside tolerance",
  QUANTITY_MISMATCH: "meter and e-BDN disagreed",
  QUALITY_FAIL: "lab test failed",
  MANUAL: "a party opened the dispute",
};

export interface SupplierRecordData {
  /** Funded orders that have reached an end state. */
  completed: number;
  settledClean: number;
  resolved: number;
  resolvedByReason: Record<Reason, number>;
  cancelledNoDelivery: number;
  inProgress: number;
  /** Share of completed orders that settled with no dispute and no cancellation, or null when none completed. */
  cleanRate: number | null;
}

/**
 * Track record of one supplier, replayed from contract events: OrderCreated (who is the supplier),
 * OrderFunded (the order reached funding), DisputeOpened (reason). Orders that never reached funding
 * are not counted; the supplier's claim only exists from funding.
 */
export function useSupplierRecord(supplier: string): SupplierRecordData {
  const { events, orders } = useChain();
  return useMemo(() => {
    const key = supplier.toLowerCase();
    const funded = new Set<number>();
    const reasonOf = new Map<number, Reason>();
    const mine = new Set<number>();
    for (const e of events) {
      if (e.name === "OrderCreated" && String(e.args.supplier).toLowerCase() === key) mine.add(Number(e.args.id));
    }
    for (const e of events) {
      if (e.name === "OrderFunded" && mine.has(Number(e.args.id))) funded.add(Number(e.args.id));
      if (e.name === "DisputeOpened" && mine.has(Number(e.args.orderId))) {
        const r = REASONS[Number(e.args.reason)];
        if (r && !reasonOf.has(Number(e.args.orderId))) reasonOf.set(Number(e.args.orderId), r);
      }
    }
    const rec: SupplierRecordData = {
      completed: 0,
      settledClean: 0,
      resolved: 0,
      resolvedByReason: { OUT_OF_TOLERANCE: 0, QUANTITY_MISMATCH: 0, QUALITY_FAIL: 0, MANUAL: 0 },
      cancelledNoDelivery: 0,
      inProgress: 0,
      cleanRate: null,
    };
    const byId = new Map<number, OrderView>(orders.map((o) => [o.id, o]));
    for (const id of funded) {
      const o = byId.get(id);
      if (!o) continue;
      if (o.status === "Settled") {
        rec.completed++;
        rec.settledClean++;
      } else if (o.status === "Resolved") {
        rec.completed++;
        rec.resolved++;
        rec.resolvedByReason[reasonOf.get(id) ?? "MANUAL"]++;
      } else if (o.status === "Cancelled") {
        rec.completed++;
        rec.cancelledNoDelivery++;
      } else {
        rec.inProgress++;
      }
    }
    if (rec.completed > 0) rec.cleanRate = (rec.settledClean / rec.completed) * 100;
    return rec;
  }, [events, orders, supplier]);
}

/** Supplier's delivery history, shown to a financier right above the buy button. */
export function SupplierRecord({ supplier }: { supplier: string }) {
  const { nameOf } = useChain();
  const r = useSupplierRecord(supplier);
  const reasons = REASONS.filter((k) => r.resolvedByReason[k] > 0);
  return (
    <div className="cp-record">
      <span className="label">Supplier track record, {nameOf(supplier)}</span>
      {r.completed === 0 ? (
        <p className="cp-rate cp-rate-none">No completed orders yet</p>
      ) : (
        <p className="cp-rate">
          <b>{Math.round(r.cleanRate ?? 0)} %</b> settled on time and clean
          <small>
            {r.settledClean} of {r.completed} completed {r.completed === 1 ? "order" : "orders"}
          </small>
        </p>
      )}
      <dl>
        <div><dt>Completed</dt><dd>{r.completed}</dd></div>
        <div><dt>Settled cleanly</dt><dd>{r.settledClean}</dd></div>
        <div>
          <dt>Resolved after a dispute</dt>
          <dd>
            {r.resolved}
            {reasons.length > 0 && (
              <small>{reasons.map((k) => `${r.resolvedByReason[k]} ${REASON_PHRASE[k]}`).join(", ")}</small>
            )}
          </dd>
        </div>
        <div><dt>Cancelled for non-delivery</dt><dd>{r.cancelledNoDelivery}</dd></div>
        <div><dt>Still in progress</dt><dd>{r.inProgress}<small>not counted in the rate</small></dd></div>
      </dl>
    </div>
  );
}
