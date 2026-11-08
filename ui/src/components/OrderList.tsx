import { ANCHORAGES, STATUS_TONE, fmtSgd, fmtTonnes, isFinanced, isMyTurn, type OrderView } from "../domain";
import { useChain, type Me } from "../chain/ChainContext";
import { StatusChip, Who } from "./ui";

interface Props {
  orders: OrderView[];
  total: number;
  me: Me | null;
  selected: OrderView | null;
  filter: number | null;
  onSelect: (id: number) => void;
  onClearFilter: () => void;
  onOpen: (id: number) => void;
  onCreate: () => void;
}

/** Order cards beside the chart, with the selected order's footer. */
export function OrderList({ orders, total, me, selected, filter, onSelect, onClearFilter, onOpen, onCreate }: Props) {
  const filterName = filter !== null ? ANCHORAGES[filter]?.name : null;
  const { events, nameOf } = useChain();
  const createdBlock = (id: number) => events.find((e) => e.name === "OrderCreated" && e.orderId === id)?.blockNumber;
  return (
    <div className="hv-list">
      <div className="hv-lhead">
        <span>{filterName ? `${filterName} · ${orders.length} orders` : `Orders · ${total}`}</span>
        {filter !== null && (
          <button type="button" className="hv-showall" onClick={onClearFilter}>
            Show all
          </button>
        )}
      </div>
      <div className="hv-cards">
        {total === 0 ? (
          <div className="hv-empty">
            <p>No orders yet. Create the first one: the buyer enters the grade, quantity, price and anchorage, and the order appears on the chart as a pin.</p>
            <button type="button" className="btn" onClick={onCreate}>
              Create the first order
            </button>
          </div>
        ) : (
          orders.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`hv-card tone-${STATUS_TONE[o.status]}`}
              aria-pressed={selected?.id === o.id}
              onClick={() => onSelect(o.id)}
            >
              <span className="hv-num">{o.id}</span>
              <span className="hv-main">
                <span className="hv-ttl">
                  {fmtTonnes(o.qtyKg)} {o.fuelGrade}
                </span>
                <span className="hv-loc">{ANCHORAGES[o.anchorage]?.name ?? "Unknown anchorage"}</span>
                <span className="hv-tags">
                  <StatusChip status={o.status} />
                  {isMyTurn(o, me) && <span className="hv-turn">Your turn</span>}
                  {isFinanced(o) && <span className="hv-fin-tag">Financed by {nameOf(o.claim.holder)}</span>}
                </span>
              </span>
              <span className="hv-held">
                {fmtSgd(o.held)}
                <small>held</small>
              </span>
            </button>
          ))
        )}
      </div>
      <div className="hv-foot">
        {selected ? (
          <>
            <span>
              <b>Order {selected.id}</b> · <Who address={selected.buyer} plain /> → <Who address={selected.supplier} plain />
            </span>
            <span className="hv-src">
              Location from <code>OrderCreated</code>
              {createdBlock(selected.id) !== undefined && <>, block {createdBlock(selected.id)}</>}
            </span>
            <button type="button" className="btn hv-open" onClick={() => onOpen(selected.id)}>
              Open order
            </button>
          </>
        ) : (
          <span className="hv-src">Select a pin or a row to see the parties.</span>
        )}
      </div>
    </div>
  );
}
