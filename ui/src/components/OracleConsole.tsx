import { useState } from "react";
import { useChain } from "../chain/ChainContext";
import { fmtTonnes, hashText, shortHex } from "../domain";
import { StatusChip } from "./ui";
import "./OracleConsole.css";

const kg = (t: string) => BigInt(Math.round((Number(t) || 0) * 1000));

/** Demo-only stand-in for the meter logger, the e-BDN system and the lab. */
export function OracleConsole() {
  const { orders, orderId, send, uiChecks } = useChain();
  const fallback = [...orders].reverse().find((o) => o.status === "Funded")?.id ?? orders[orders.length - 1]?.id ?? 0;
  const [sel, setSel] = useState<number | null>(null);
  const id = sel ?? orderId ?? fallback;
  const order = orders.find((o) => o.id === id);

  const [mT, setMT] = useState("500.2");
  const [mText, setMText] = useState("Metering ticket: 500.2 t VLSFO");
  const [eT, setET] = useState("500.0");
  const [eText, setEText] = useState("BDN: 500.0 t VLSFO");
  const [pass, setPass] = useState(true);
  const [lText, setLText] = useState("Lab report: ISO 8217 pass");

  const fill = (m: string, e: string, lab: boolean) => {
    setMT(m);
    setMText(`Metering ticket: ${m} t VLSFO`);
    setET(e);
    setEText(`BDN: ${e} t VLSFO`);
    setPass(lab);
    setLText(lab ? "Lab report: ISO 8217 pass" : "Lab report: ISO 8217 FAIL (sulphur above limit)");
  };

  const notFunded = uiChecks && order && order.status !== "Funded" ? "Order must be Funded." : "";
  const notApproved = uiChecks && order && order.status !== "QuantityApproved" ? "Order must be Qty approved." : "";

  return (
    <>
      <h1 className="page-title">
        Oracle console
        <small>
          <span className="demo-only">Demo only – stands in for meter loggers, the e-BDN system and the lab</span>
        </small>
      </h1>

      <section className="panel">
        <div className="panel-body">
          <div className="form-grid">
            <label className="field">
              <span>Order</span>
              <select id="oc-order" value={id} onChange={(e) => setSel(Number(e.target.value))}>
                {orders.length === 0 && <option value={0}>No orders</option>}
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    #{o.id} {o.fuelGrade} ({o.status})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {order && (
            <div className="oc-state">
              <StatusChip status={order.status} />
              <span>
                Meter: {order.delivery.meterSubmitted ? `${fmtTonnes(order.delivery.meterKg)} (${shortHex(order.delivery.ticketHash)})` : "none"}
              </span>
              <span>
                e-BDN: {order.delivery.ebdnSubmitted ? `${fmtTonnes(order.delivery.ebdnKg)} (${shortHex(order.delivery.ebdnHash)})` : "none"}
              </span>
              <span>Lab: {order.lab.submitted ? (order.lab.passed ? "pass" : "fail") : "none"}</span>
            </div>
          )}
          <div className="oc-quick">
            <span className="label">Quick fill</span>
            <button className="btn btn-ghost btn-sm" onClick={() => fill("500.2", "500.0", true)}>
              Scenario 1: meter 500.2 t, e-BDN 500.0 t
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => fill("480", "480", true)}>
              Scenario 2: 480 t on both
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => fill("500.2", "500.0", false)}>
              Scenario 3: lab fail
            </button>
          </div>
          <small className="oc-hint">Sign with #4 (meter), #5 (e-BDN) or #6 (lab). Switch to #8 to see NotAuthorized.</small>
        </div>
      </section>

      <div className="oc-grid">
        <section className="panel">
          <div className="panel-head">
            <span className="label">Meter reading</span>
            <span className="label">Sign: #4</span>
          </div>
          <div className="panel-body">
            <label className="field">
              <span>Quantity (tonnes)</span>
              <input id="oc-meter-t" type="number" step="any" value={mT} onChange={(e) => setMT(e.target.value)} />
            </label>
            <label className="field">
              <span>Metering ticket text (BMT)</span>
              <textarea id="oc-meter-text" rows={3} value={mText} onChange={(e) => setMText(e.target.value)} />
              <small className="mono oc-hash">{hashText(mText)}</small>
            </label>
            <button
              id="oc-meter-submit"
              className="btn"
              disabled={!!notFunded}
              onClick={() => send("Submit meter reading", (c) => c.DeliveryRecord.submitMeterReading(id, kg(mT), hashText(mText)))}
            >
              Submit meter reading
            </button>
            {notFunded && <small className="oc-hint">{notFunded}</small>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="label">e-BDN</span>
            <span className="label">Sign: #5</span>
          </div>
          <div className="panel-body">
            <label className="field">
              <span>Quantity (tonnes)</span>
              <input id="oc-ebdn-t" type="number" step="any" value={eT} onChange={(e) => setET(e.target.value)} />
            </label>
            <label className="field">
              <span>BDN text (BDN)</span>
              <textarea id="oc-ebdn-text" rows={3} value={eText} onChange={(e) => setEText(e.target.value)} />
              <small className="mono oc-hash">{hashText(eText)}</small>
            </label>
            <button
              id="oc-ebdn-submit"
              className="btn"
              disabled={!!notFunded}
              onClick={() => send("Submit e-BDN", (c) => c.DeliveryRecord.submitEBDN(id, kg(eT), hashText(eText)))}
            >
              Submit e-BDN
            </button>
            {notFunded && <small className="oc-hint">{notFunded}</small>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="label">Lab result</span>
            <span className="label">Sign: #6</span>
          </div>
          <div className="panel-body">
            <fieldset className="oc-radio">
              <legend className="label">Result (QTR)</legend>
              <label htmlFor="oc-lab-pass">
                <input id="oc-lab-pass" type="radio" name="oc-lab" checked={pass} onChange={() => setPass(true)} /> Pass
              </label>
              <label htmlFor="oc-lab-fail">
                <input id="oc-lab-fail" type="radio" name="oc-lab" checked={!pass} onChange={() => setPass(false)} /> Fail
              </label>
            </fieldset>
            <label className="field">
              <span>Report text (QTR)</span>
              <textarea id="oc-lab-text" rows={3} value={lText} onChange={(e) => setLText(e.target.value)} />
              <small className="mono oc-hash">{hashText(lText)}</small>
            </label>
            <button
              id="oc-lab-submit"
              className="btn"
              disabled={!!notApproved}
              onClick={() => send("Submit lab result", (c) => c.QualityRecord.submitLabResult(id, pass, hashText(lText)))}
            >
              Submit lab result
            </button>
            {notApproved && <small className="oc-hint">{notApproved}</small>}
          </div>
        </section>
      </div>
    </>
  );
}
