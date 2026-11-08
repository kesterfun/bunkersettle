import { nextStep, ROLE_LABEL, accountIndex, type OrderView } from "../domain";
import { useChain } from "../chain/ChainContext";

/** Who acts next on this order, and with which account. Sits above the order's actions. */
export function NextStepBox({ order: o }: { order: OrderView }) {
  const { nameOf } = useChain();
  const step = nextStep(o);
  const idx = step?.actor ? accountIndex(step.actor) : -1;
  return (
    <div className="os-nextwrap">
      <span className="label">Next for this order</span>
      {step ? (
        <div className="os-next">
          <b>{step.label}</b>
          <span>
            {ROLE_LABEL[step.role]}
            {step.actor && ` · ${nameOf(step.actor)}`}
            {idx >= 0 && ` · #${idx}`}
          </span>
        </div>
      ) : (
        <div className="os-next os-next-none">Nothing pending on the main path.</div>
      )}
      {(o.status === "Funded" || o.status === "QuantityApproved") && (
        <small className="os-hint">
          Optional: the claim holder ({nameOf(o.claim.holder)}) can sell the payment claim to a financier (#9) from the payment claim panel below.
        </small>
      )}
    </div>
  );
}
