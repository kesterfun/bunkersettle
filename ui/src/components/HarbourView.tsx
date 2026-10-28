import { useState } from "react";
import { useChain } from "../chain/ChainContext";
import { fmtSgd, isMyTurn } from "../domain";
import { HarbourChart } from "./HarbourChart";
import { OrderList } from "./OrderList";
import "./HarbourView.css";

const FINISHED = ["Settled", "Resolved", "Cancelled"];
const LEGEND = [
  ["progress", "In progress"],
  ["action", "Needs action"],
  ["disputed", "Disputed"],
  ["done", "Settled"],
  ["void", "Cancelled"],
] as const;

/** Home screen: harbour chart with one pin per order, plus the order list. */
export function HarbourView() {
  const { orders, me, go } = useChain();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<number | null>(null);

  const mine = (a: string) => !!me && a.toLowerCase() === me.address.toLowerCase();
  const has = (r: string) => !!me && me.roles.some((x) => x === r);
  const exposure = orders.filter((o) => mine(o.bank)).reduce((s, o) => s + o.held, 0n);
  const paid = orders.filter((o) => mine(o.supplier)).reduce((s, o) => s + o.releasedAmount, 0n);
  const pending = orders
    .filter((o) => mine(o.supplier) && !FINISHED.includes(o.status))
    .reduce((s, o) => s + o.held, 0n);
  const buyerCount = orders.filter((o) => mine(o.buyer)).length;
  const turns = orders.filter((o) => isMyTurn(o, me)).length;

  const shown = filter === null ? orders : orders.filter((o) => o.anchorage === filter);
  const selected = orders.find((o) => o.id === selectedId) ?? null;

  return (
    <div className="hv panel">
      <div className="hv-bar">
        <div className="hv-stats">
          {has("BANK") && (
            <div className="hv-stat">
              <span className="label">Total exposure</span>
              <span className="figure">
                {fmtSgd(exposure)}
                <span className="unit">mSGD</span>
              </span>
            </div>
          )}
          {has("SUPPLIER") && (
            <>
              <div className="hv-stat">
                <span className="label">Paid so far</span>
                <span className="figure">
                  {fmtSgd(paid)}
                  <span className="unit">mSGD</span>
                </span>
              </div>
              <div className="hv-stat">
                <span className="label">Pending</span>
                <span className="figure">
                  {fmtSgd(pending)}
                  <span className="unit">mSGD</span>
                </span>
              </div>
            </>
          )}
          {has("BUYER") && (
            <div className="hv-stat">
              <span className="label">Your orders</span>
              <span className="figure">{buyerCount}</span>
            </div>
          )}
          <div className="hv-stat">
            <span className="label">Your turn</span>
            <span className="figure">{turns}</span>
          </div>
        </div>
        <button type="button" className="btn" onClick={() => go("create")}>
          New order
        </button>
      </div>
      <div className="hv-body">
        <div className="hv-chart">
          <HarbourChart orders={orders} me={me} selected={selectedId} onSelect={setSelectedId} onFilter={setFilter} />
          <div className="hv-legend">
            {LEGEND.map(([t, text]) => (
              <span key={t} className={`tone-${t}`}>
                {text}
              </span>
            ))}
          </div>
        </div>
        <OrderList
          orders={shown}
          total={orders.length}
          me={me}
          selected={selected}
          filter={filter}
          onSelect={setSelectedId}
          onClearFilter={() => setFilter(null)}
          onOpen={(id) => go("order", id)}
          onCreate={() => go("create")}
        />
      </div>
    </div>
  );
}
