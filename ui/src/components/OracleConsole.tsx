import { Fragment, useState, type ReactNode } from "react";
import type { ethers } from "ethers";
import { useChain, useChainNow } from "../chain/ChainContext";
import { ROLE_LABEL, fmtTonnes, hashText, shortHex } from "../domain";
import { StatusChip } from "./ui";
import "./OracleConsole.css";

const kg = (t: string) => BigInt(Math.round((Number(t) || 0) * 1000));

/** How long a signature stays valid, in chain seconds. */
const SIGNATURE_TTL = 900;

type Kind = "meter" | "ebdn" | "lab";

/** An oracle's EIP-712 signature waiting for any account to relay it. Numbers are strings so it can be saved. */
interface Signed {
  kind: Kind;
  id: number;
  /** Quantity in kg (meter, e-BDN) or "1" / "0" for pass / fail (lab). */
  value: string;
  hash: string;
  deadline: number;
  signer: string;
  signature: string;
}

const KIND_LABEL: Record<Kind, string> = { meter: "Meter reading", ebdn: "e-BDN", lab: "Lab result" };

/** EIP-712 field lists; they must match the TYPEHASH strings in DeliveryRecord and QualityRecord. */
const TYPES: Record<Kind, { primary: string; fields: { name: string; type: string }[] }> = {
  meter: {
    primary: "MeterReading",
    fields: [
      { name: "id", type: "uint256" },
      { name: "qtyKg", type: "uint256" },
      { name: "ticketHash", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
  ebdn: {
    primary: "EBDN",
    fields: [
      { name: "id", type: "uint256" },
      { name: "qtyKg", type: "uint256" },
      { name: "ebdnHash", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
  lab: {
    primary: "LabResult",
    fields: [
      { name: "id", type: "uint256" },
      { name: "passed", type: "bool" },
      { name: "reportHash", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
};

const STORE_KEY = "bunkersettle.signed";
const loadSigned = (): Signed[] => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]") as Signed[];
  } catch {
    return [];
  }
};
const saveSigned = (v: Signed[]) => {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: the list just will not survive a reload */
  }
};

type OracleRole = "METER_ORACLE" | "EBDN_ORACLE" | "LAB";
const ORACLE_ROLES: OracleRole[] = ["METER_ORACLE", "EBDN_ORACLE", "LAB"];

/** Demo-only stand-in for the meter logger, the e-BDN system and the lab. */
export function OracleConsole() {
  const { orders, orderId, send, sign, read, nameOf, me } = useChain();
  const chainNow = useChainNow();
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

  const [signed, setSignedState] = useState<Signed[]>(loadSigned);
  const setSigned = (v: Signed[]) => {
    setSignedState(v);
    saveSigned(v);
  };

  /** Oracle signs the typed message in MetaMask. No transaction is sent. */
  const signKind = async (kind: Kind, value: bigint, hash: string) => {
    const contract = kind === "lab" ? read.QualityRecord : read.DeliveryRecord;
    const deadline = chainNow + SIGNATURE_TTL;
    const item = await sign(`Sign ${KIND_LABEL[kind].toLowerCase()}`, async (signer: ethers.Signer) => {
      const d = await contract.eip712Domain();
      const domain = { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
      const t = TYPES[kind];
      const message: Record<string, unknown> = {
        [t.fields[0].name]: id,
        [t.fields[1].name]: kind === "lab" ? value === 1n : value,
        [t.fields[2].name]: hash,
        deadline,
      };
      const signature = await signer.signTypedData(domain, { [t.primary]: t.fields }, message);
      return { kind, id, value: value.toString(), hash, deadline, signer: await signer.getAddress(), signature } as Signed;
    });
    if (item) setSigned([...signed, item]);
  };

  const relay = async (it: Signed) => {
    const ok = await send(`Relay signed ${KIND_LABEL[it.kind].toLowerCase()}`, (c) => {
      if (it.kind === "meter") return c.DeliveryRecord.submitMeterReadingBySig(it.id, BigInt(it.value), it.hash, it.deadline, it.signature);
      if (it.kind === "ebdn") return c.DeliveryRecord.submitEBDNBySig(it.id, BigInt(it.value), it.hash, it.deadline, it.signature);
      return c.QualityRecord.submitLabResultBySig(it.id, it.value === "1", it.hash, it.deadline, it.signature);
    });
    if (ok) setSigned(signed.filter((x) => x !== it));
  };

  const panels: Record<OracleRole, ReactNode> = {
    METER_ORACLE: (
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
                  onClick={() => send("Submit meter reading", (c) => c.DeliveryRecord.submitMeterReading(id, kg(mT), hashText(mText)))}
                >
                  Submit meter reading
                </button>
                <button
                  id="oc-meter-sign"
                  className="btn btn-ghost"
                  onClick={() => signKind("meter", kg(mT), hashText(mText))}
                >
                  Sign offline
                </button>
              </div>
            </section>
    ),
    EBDN_ORACLE: (
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
                  onClick={() => send("Submit e-BDN", (c) => c.DeliveryRecord.submitEBDN(id, kg(eT), hashText(eText)))}
                >
                  Submit e-BDN
                </button>
                <button
                  id="oc-ebdn-sign"
                  className="btn btn-ghost"
                  onClick={() => signKind("ebdn", kg(eT), hashText(eText))}
                >
                  Sign offline
                </button>
              </div>
            </section>
    ),
    LAB: (
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
                  onClick={() => send("Submit lab result", (c) => c.QualityRecord.submitLabResult(id, pass, hashText(lText)))}
                >
                  Submit lab result
                </button>
                <button
                  id="oc-lab-sign"
                  className="btn btn-ghost"
                  onClick={() => signKind("lab", pass ? 1n : 0n, hashText(lText))}
                >
                  Sign offline
                </button>
              </div>
            </section>
    ),
  };
  const mineRoles = ORACLE_ROLES.filter((r) => me?.roles.includes(r));
  const otherRoles = ORACLE_ROLES.filter((r) => !mineRoles.includes(r));
  const grid = (rs: OracleRole[]) => (
    <div className="oc-grid">
      {rs.map((r) => (
        <Fragment key={r}>{panels[r]}</Fragment>
      ))}
    </div>
  );

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
              Run A: meter 500.2 t, e-BDN 500.0 t
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => fill("480", "480", true)}>
              Run B: 480 t on both
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => fill("500.2", "500.0", false)}>
              Run C: normal delivery, then lab fail
            </button>
          </div>
          <small className="oc-hint">Each account signs its own type: #4 meter, #5 e-BDN, #6 lab. Switch to #8 to see NotAuthorized.</small>
        </div>
      </section>

      {mineRoles.length > 0 && (
        <p className="oc-you">
          You are signed in as {mineRoles.map((r) => ROLE_LABEL[r]).join(" and ")}. Your submission is below.
        </p>
      )}
      {mineRoles.length > 0 && grid(mineRoles)}
      {otherRoles.length > 0 && (
        <details className="oc-others" open={mineRoles.length === 0}>
          <summary>
            {mineRoles.length > 0
              ? "Other roles' submissions. Press one to demo the revert."
              : "Submissions by role. This account holds none of these roles, so any submit will revert."}
          </summary>
          {grid(otherRoles)}
        </details>
      )}

      <section className="panel">
        <div className="panel-head">
          <span className="label">Signed submissions (EIP-712)</span>
          <span className="label">{signed.length} waiting</span>
        </div>
        <div className="panel-body">
          <small className="oc-hint">
            An oracle signs offline (for example on a barge with no connection), then any account relays the signature. The contract records the
            signer, not the relayer, and rejects it if the signer lacks the role. Sign as #4 / #5 / #6, use
            Change account to switch to #8 (no role), then press Relay.
          </small>
          {signed.length === 0 && <small className="oc-hint">Nothing signed yet.</small>}
          {signed.map((it) => (
            <div key={`${it.kind}-${it.id}-${it.signature}`} className="oc-signed">
              <div>
                <strong>
                  {KIND_LABEL[it.kind]} for order #{it.id}
                </strong>{" "}
                signed by {nameOf(it.signer)}
                <small className="oc-hint">
                  {" "}
                  {chainNow > it.deadline ? "expired" : `expires in ${it.deadline - chainNow} s`}
                </small>
                <small className="mono oc-hash">{it.signature}</small>
              </div>
              <div className="oc-signed-actions">
                <button className="btn btn-sm" onClick={() => relay(it)}>
                  Relay
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setSigned(signed.filter((x) => x !== it))}>
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
