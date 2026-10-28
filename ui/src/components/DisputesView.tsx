import { useState } from "react";
import { useChain } from "../chain/ChainContext";
import { DOC_LABEL, DOC_TYPES, REASON_LABEL, fmtSgd, hashText, shortHex, type DisputeView } from "../domain";
import { Who } from "./ui";
import "./DisputesView.css";

function DisputeCard({ d }: { d: DisputeView }) {
  const { orders, events, send, go } = useChain();
  const order = orders.find((o) => o.id === d.orderId);
  const held = order?.held ?? 0n;
  const evidence = events.filter((e) => e.name === "EvidenceSubmitted" && Number(e.args.disputeId) === d.id);

  const [docType, setDocType] = useState(0);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [share, setShare] = useState(70);

  const bps = share * 100;
  const supplierGets = (held * BigInt(bps)) / 10_000n;
  const bankGets = held - supplierGets;

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="dv-title">Dispute #{d.id}</span>
        <span className={`chip ${d.resolved ? "tone-done" : "tone-disputed"}`}>{d.resolved ? "Resolved" : "Open"}</span>
      </div>
      <div className="panel-body">
        <dl className="dv-facts">
          <div>
            <dt className="label">Order</dt>
            <dd>
              <button className="btn btn-ghost btn-sm" onClick={() => go("order", d.orderId)}>
                Order #{d.orderId}
              </button>
            </dd>
          </div>
          <div>
            <dt className="label">Reason</dt>
            <dd>{REASON_LABEL[d.reason]}</dd>
          </div>
          <div>
            <dt className="label">Opened by</dt>
            <dd>
              <Who address={d.openedBy} />
            </dd>
          </div>
          <div>
            <dt className="label">Held at stake</dt>
            <dd>{fmtSgd(held)} mSGD</dd>
          </div>
          {d.resolved && (
            <div>
              <dt className="label">Resolved share</dt>
              <dd>Supplier {d.supplierShareBps / 100} %</dd>
            </div>
          )}
        </dl>

        <div>
          <div className="label">Evidence ({evidence.length})</div>
          {evidence.length === 0 ? (
            <div className="empty">No evidence submitted yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Hash</th>
                    <th>Note</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.map((e) => {
                    const t = DOC_TYPES[Number(e.args.docType)];
                    return (
                      <tr key={e.key}>
                        <td>{t ? `${t} – ${DOC_LABEL[t]}` : String(e.args.docType)}</td>
                        <td className="mono" title={String(e.args.docHash)}>
                          {shortHex(String(e.args.docHash))}
                        </td>
                        <td>{String(e.args.note ?? "")}</td>
                        <td>{e.args.by ? <Who address={String(e.args.by)} /> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!d.resolved && (
          <div className="dv-forms">
            <div className="dv-form">
              <div className="label">Submit evidence (buyer, supplier or bank of the order)</div>
              <label className="field">
                <span>Document type</span>
                <select id={`dv-doctype-${d.id}`} value={docType} onChange={(e) => setDocType(Number(e.target.value))}>
                  {DOC_TYPES.map((t, i) => (
                    <option key={t} value={i}>
                      {t} – {DOC_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Document text</span>
                <textarea id={`dv-text-${d.id}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
                <small className="mono dv-hash">{hashText(text)}</small>
              </label>
              <label className="field">
                <span>Note</span>
                <input id={`dv-note-${d.id}`} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button
                id={`dv-evidence-${d.id}`}
                className="btn"
                onClick={() => send("Submit evidence", (c) => c.DisputeManager.submitEvidence(d.id, docType, hashText(text), note))}
              >
                Submit evidence
              </button>
            </div>

            <div className="dv-form">
              <div className="label">Resolve (Arbiter #7)</div>
              <label className="field">
                <span>Supplier share: {share} %</span>
                <input id={`dv-share-${d.id}`} type="range" min={0} max={100} step={5} value={share} onChange={(e) => setShare(Number(e.target.value))} />
              </label>
              <div className="dv-split">
                <div>
                  <div className="label">Supplier gets</div>
                  <div className="figure">{fmtSgd(supplierGets)}</div>
                </div>
                <div>
                  <div className="label">Bank gets</div>
                  <div className="figure">{fmtSgd(bankGets)}</div>
                </div>
              </div>
              <button id={`dv-resolve-${d.id}`} className="btn" onClick={() => send("Resolve dispute", (c) => c.DisputeManager.resolve(d.id, bps))}>
                Resolve dispute
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** All disputes, open first, with evidence, submit-evidence and arbiter resolution. */
export function DisputesView() {
  const { disputes } = useChain();
  const sorted = [...disputes].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.id - a.id);
  return (
    <>
      <h1 className="page-title">
        Disputes
        <small>Open disputes first. The arbiter splits the held amount between supplier and bank.</small>
      </h1>
      {sorted.length === 0 ? (
        <div className="empty">No disputes. They open automatically on short delivery, a meter and e-BDN mismatch, or a lab fail.</div>
      ) : (
        sorted.map((d) => <DisputeCard key={d.id} d={d} />)
      )}
    </>
  );
}
