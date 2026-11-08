import { useEffect, useMemo, useRef, useState } from "react";
import { useChain } from "../chain/ChainContext";
import { groupByTx, headline, isNoise, makePayeeAt } from "../activity";
import "./ActivityTicker.css";

/** Slim strip fixed to the bottom of every page: latest transaction, flashes on new ones. */
export function ActivityTicker() {
  const { events, txs, nameOf, blockNumber, go, view } = useChain();
  const latest = useMemo(() => groupByTx(events, txs)[0], [events, txs]);
  const payeeAt = useMemo(() => makePayeeAt(events), [events]);
  const [flash, setFlash] = useState(false);
  const seen = useRef<string | null | undefined>(undefined);

  const hash = latest?.txHash ?? null;
  const count = latest ? latest.events.filter((e) => !isNoise(e, latest)).length : 0;
  useEffect(() => {
    if (seen.current === undefined) {
      // first render: remember, don't flash. Wait until events have loaded.
      if (hash) seen.current = hash;
      return;
    }
    if (hash && hash !== seen.current) {
      seen.current = hash;
      setFlash(true);
      const t = window.setTimeout(() => setFlash(false), 1600);
      return () => window.clearTimeout(t);
    }
  }, [hash]);

  if (view === "activity") return null;

  return (
    <button type="button" className={`tk${flash ? " tk-flash" : ""}`} onClick={() => go("activity")}>
      <span className="tk-dot" aria-hidden="true" />
      <span className="tk-block mono">Block {blockNumber}</span>
      <span className="tk-text">{latest ? headline(latest, nameOf, payeeAt) : "No transactions yet"}</span>
      <span className="tk-count">
        {count} {count === 1 ? "event" : "events"}
      </span>
      <span className="tk-open">Open activity</span>
    </button>
  );
}
