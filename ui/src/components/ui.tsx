import { useEffect, useRef } from "react";
import { STATUS_LABEL, STATUS_TONE, accountIndex, type StatusName } from "../domain";
import { useChain } from "../chain/ChainContext";

/** Small status pill coloured by tone. */
export function StatusChip({ status, text }: { status: StatusName; text?: string }) {
  return <span className={`chip tone-${STATUS_TONE[status]}`}>{text ?? STATUS_LABEL[status]}</span>;
}

/** Rubber stamp for the current status. Thumps down whenever the status changes. */
export function Stamp({ status, note }: { status: StatusName; note?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el) return;
    el.classList.remove("thump");
    void el.offsetWidth; // restart the animation
    el.classList.add("thump");
  }, [status]);
  return (
    <div ref={ref} className={`stamp tone-${STATUS_TONE[status]}`} role="status">
      {STATUS_LABEL[status]}
      {note && <small>{note}</small>}
    </div>
  );
}

/** Red swallow-tailed Bravo flag, flown by vessels while bunkering. */
export function BravoFlag({ size = 1.6 }: { size?: number }) {
  return (
    <svg viewBox="0 0 34 22" style={{ width: `${size}rem`, height: "auto" }} aria-hidden="true">
      <polygon points="0,0 34,0 24,11 34,22 0,22" fill="#D7262E" />
    </svg>
  );
}

/** Registry name of an address, with its Hardhat account number when known. */
export function Who({ address, plain }: { address: string; plain?: boolean }) {
  const { nameOf } = useChain();
  const idx = accountIndex(address);
  return (
    <span title={address}>
      {nameOf(address)}
      {!plain && idx >= 0 && <span style={{ color: "var(--grey)", fontWeight: 400 }}> · #{idx}</span>}
    </span>
  );
}
