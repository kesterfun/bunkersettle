import { useEffect, useState } from "react";
import { nextStep, ROLE_LABEL, accountIndex, type OrderView } from "../domain";
import { useChain } from "../chain/ChainContext";

const KEY = "bs.scenarios";

const ACCOUNTS =
  "Buyer #2 · Supplier #3 · Bank #1 · Meter #4 · e-BDN #5 · Lab #6 · Arbiter #7 · Outsider #8";

interface Scenario {
  id: string;
  title: string;
  steps: string[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "normal",
    title: "1. Normal",
    steps: [
      "Buyer #2 creates the order (500 t VLSFO)",
      "Supplier #3 accepts; Bank #1 funds",
      "Meter #4 submits 500.2 t; e-BDN #5 submits 500.0 t, so 90% is paid",
      "Lab #6 submits a pass: retention paid, excess refunded, Settled",
      "Or skip the lab: Fast-forward past the 120 s window and anyone presses Release after timeout",
    ],
  },
  {
    id: "short",
    title: "2. Short delivery",
    steps: ["Create, accept and fund a new order", "Meter #4 submits 480 t, e-BDN #5 submits 500 t", "Order goes to Disputed (out of tolerance)"],
  },
  {
    id: "quality",
    title: "3. Contaminated fuel",
    steps: ["Normal delivery up to 90% paid", "Lab #6 submits a fail", "Dispute QUALITY_FAIL opens, retention stays held"],
  },
  {
    id: "outsider",
    title: "4. Outsider",
    steps: ["Switch MetaMask to Outsider #8", "Open the Oracle console and submit a meter reading", "Expect a NotAuthorized revert"],
  },
  {
    id: "resolution",
    title: "5. Resolution",
    steps: ["Take the disputed order from scenario 2 or 3", "Arbiter #7 resolves at 70/30 in the Disputes view", "Funds split between supplier and bank"],
  },
];

function load(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Sidebar: what happens next on this order, plus the five SPEC 9 demo scenarios as a checklist. */
export function ScenarioStepper({ order: o }: { order: OrderView | null }) {
  const { nameOf } = useChain();
  const [done, setDone] = useState<Record<string, boolean>>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(done));
    } catch {
      // storage unavailable; ticks just won't persist
    }
  }, [done]);

  const step = o ? nextStep(o) : null;
  const idx = step?.actor ? accountIndex(step.actor) : -1;
  return (
    <aside className="os-steps" aria-label="Scenario stepper">
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
        <div className="os-next os-next-none">{o ? "Nothing pending on the main path." : "No order selected."}</div>
      )}

      <span className="label">Demo scenarios</span>
      <ol className="os-sc">
        {SCENARIOS.map((s) => (
          <li key={s.id} className={done[s.id] ? "os-sc-done" : undefined}>
            <label className="os-sc-head">
              <input
                type="checkbox"
                checked={!!done[s.id]}
                onChange={(e) => setDone({ ...done, [s.id]: e.target.checked })}
              />
              <span>{s.title}</span>
            </label>
            <ul className="os-sub">
              {s.steps.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <p className="os-hint">{ACCOUNTS}</p>
      <p className="os-hint">Waiting on a timer? Use Fast-forward in the header.</p>
    </aside>
  );
}
