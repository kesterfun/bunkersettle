import { useMemo, useState } from "react";
import { ethers } from "ethers";
import { useChain, useChainNow } from "../chain/ChainContext";
import { ANCHORAGES, fmtSgd, fundingAmount, hashText, shortHex } from "../domain";
import "./CreateOrderForm.css";

const FREE = "__free__";

/** Buyer creates an order. Prefilled with SPEC 9 scenario 1. */
export function CreateOrderForm() {
  const { participants, send, read, go, uiChecks } = useChain();
  const now = useChainNow();
  const suppliers = participants.filter((p) => p.roles.includes("SUPPLIER"));
  const banks = participants.filter((p) => p.roles.includes("BANK"));

  const [supplierSel, setSupplierSel] = useState("");
  const [supplierFree, setSupplierFree] = useState("");
  const [bankSel, setBankSel] = useState("");
  const [grade, setGrade] = useState("VLSFO");
  const [tonnes, setTonnes] = useState("500");
  const [price, setPrice] = useState("980");
  const [tol, setTol] = useState("50");
  const [ret, setRet] = useState("1000");
  const [days, setDays] = useState("7");
  const [retWindow, setRetWindow] = useState("120");
  const [anchorage, setAnchorage] = useState("3");
  const [dscText, setDscText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const supplierChoice = supplierSel || suppliers[0]?.address || FREE;
  const supplier = supplierChoice === FREE ? supplierFree.trim() : supplierChoice;
  const bank = bankSel || banks[0]?.address || "";

  const dscDefault = useMemo(
    () =>
      JSON.stringify(
        {
          document: "DSC",
          fuelGrade: grade,
          quantityTonnes: tonnes,
          pricePerTonneMSGD: price,
          toleranceBps: tol,
          retentionBps: ret,
          anchorage: ANCHORAGES[Number(anchorage)]?.name,
          terms: "Delivered",
        },
        null,
        2,
      ),
    [grade, tonnes, price, tol, ret, anchorage],
  );
  const dsc = dscText ?? dscDefault;
  const dscHash = hashText(dsc);

  const num = (s: string) => (s.trim() === "" || isNaN(Number(s)) ? 0 : Number(s));
  const qtyKg = BigInt(Math.round(num(tonnes) * 1000));
  const pricePerTonne = (() => {
    try {
      return ethers.parseEther(price.trim() || "0");
    } catch {
      return 0n;
    }
  })();
  const toleranceBps = Math.round(num(tol));
  const payable = (qtyKg * pricePerTonne) / 1000n;
  const lock = fundingAmount({ qtyKg, pricePerTonne, toleranceBps });

  const submit = async () => {
    setBusy(true);
    try {
      const ok = await send("Create order", (c) =>
        c.BunkerOrder.createOrder({
          supplier,
          bank,
          fuelGrade: grade,
          qtyKg,
          pricePerTonne,
          toleranceBps,
          retentionBps: Math.round(num(ret)),
          deliveryDeadline: BigInt(Math.floor(now + num(days) * 86400)),
          retentionWindow: BigInt(Math.round(num(retWindow))),
          dscHash,
          anchorage: Number(anchorage),
        }),
      );
      if (ok) {
        const count = await read.BunkerOrder.orderCount();
        go("order", Number(count));
      }
    } finally {
      setBusy(false);
    }
  };

  const blocked =
    uiChecks && (!ethers.isAddress(supplier) || !ethers.isAddress(bank)) ? "Supplier and bank must be valid addresses." : "";

  return (
    <>
      <h1 className="page-title">
        New order
        <small>Sign with Buyer (#2). Prefilled with demo scenario 1.</small>
      </h1>
      <div className="cf">
        <section className="panel">
          <div className="panel-head">
            <span className="label">Order terms</span>
            <span className="label">Signer: Buyer #2</span>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <label className="field">
                <span>Supplier</span>
                <select id="cf-supplier" value={supplierChoice} onChange={(e) => setSupplierSel(e.target.value)}>
                  {suppliers.map((p) => (
                    <option key={p.address} value={p.address}>
                      {p.name || shortHex(p.address)}
                    </option>
                  ))}
                  <option value={FREE}>Other address…</option>
                </select>
              </label>
              {supplierChoice === FREE && (
                <label className="field">
                  <span>Supplier address</span>
                  <input id="cf-supplier-free" value={supplierFree} onChange={(e) => setSupplierFree(e.target.value)} placeholder="0x…" />
                </label>
              )}
              <label className="field">
                <span>Bank</span>
                <select id="cf-bank" value={bank} onChange={(e) => setBankSel(e.target.value)}>
                  {banks.map((p) => (
                    <option key={p.address} value={p.address}>
                      {p.name || shortHex(p.address)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Fuel grade</span>
                <input id="cf-grade" value={grade} onChange={(e) => setGrade(e.target.value)} />
              </label>
              <label className="field">
                <span>Quantity (tonnes)</span>
                <input id="cf-tonnes" type="number" min="0" step="any" value={tonnes} onChange={(e) => setTonnes(e.target.value)} />
              </label>
              <label className="field">
                <span>Price (mSGD per tonne)</span>
                <input id="cf-price" type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
              </label>
              <label className="field">
                <span>Tolerance (bps)</span>
                <input id="cf-tol" type="number" min="0" step="1" value={tol} onChange={(e) => setTol(e.target.value)} />
                <small>50 bps = 0.5 %</small>
              </label>
              <label className="field">
                <span>Retention (bps)</span>
                <input id="cf-ret" type="number" min="0" step="1" value={ret} onChange={(e) => setRet(e.target.value)} />
                <small>1000 bps = 10 % held back</small>
              </label>
              <label className="field">
                <span>Delivery deadline (days from now)</span>
                <input id="cf-days" type="number" min="0" step="any" value={days} onChange={(e) => setDays(e.target.value)} />
              </label>
              <label className="field">
                <span>Retention window (seconds)</span>
                <input id="cf-window" type="number" min="0" step="1" value={retWindow} onChange={(e) => setRetWindow(e.target.value)} />
              </label>
              <label className="field">
                <span>Anchorage</span>
                <select id="cf-anchorage" value={anchorage} onChange={(e) => setAnchorage(e.target.value)}>
                  {ANCHORAGES.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Sales confirmation (DSC) document text</span>
              <textarea id="cf-dsc" rows={9} value={dsc} onChange={(e) => setDscText(e.target.value)} />
              <small className="mono cf-hash">keccak256: {dscHash}</small>
            </label>
          </div>
        </section>

        <aside className="panel">
          <div className="panel-head">
            <span className="label">Preview</span>
          </div>
          <div className="panel-body">
            <div>
              <div className="label">Payable at ordered quantity</div>
              <div className="figure">
                {fmtSgd(payable)} <span className="unit">mSGD</span>
              </div>
            </div>
            <div>
              <div className="label">Bank will lock</div>
              <div className="figure">
                {fmtSgd(lock)} <span className="unit">mSGD</span>
              </div>
              <small className="cf-note">Payable plus {toleranceBps} bps tolerance.</small>
            </div>
            <button id="cf-submit" className="btn" disabled={busy || !!blocked} onClick={submit}>
              {busy ? "Creating…" : "Create order"}
            </button>
            {blocked && <small className="cf-note">{blocked}</small>}
            <small className="cf-note">Signs as Buyer (#2). The contract checks every term.</small>
          </div>
        </aside>
      </div>
    </>
  );
}
