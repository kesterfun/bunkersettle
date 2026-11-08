import { useChain, EXPECTED_CHAIN_ID, type View } from "../chain/ChainContext";
import { ROLE_LABEL, isBunkering, shortHex } from "../domain";
import { BravoFlag } from "./ui";
import "./Header.css";

const NAV: { view: View; label: string }[] = [
  { view: "harbour", label: "Harbour" },
  { view: "order", label: "Order" },
  { view: "create", label: "New order" },
  { view: "oracle", label: "Oracle console" },
  { view: "disputes", label: "Disputes" },
  { view: "activity", label: "Activity" },
  { view: "market", label: "Market" },
];

/** Brand, navigation, connected account with registry name and roles, network check and demo toggles. */
export function Header() {
  const c = useChain();
  const bunkering = c.orders.filter(isBunkering).length;

  return (
    <header className="hd">
      <div className="hd-top">
        <div className="hd-brand">
          <span className="hd-logo">BunkerSettle</span>
          {bunkering > 0 && (
            <button
              type="button"
              className="hd-bravo"
              title="Bravo flag: orders that are funded but not yet settled. Opens the harbour chart."
              onClick={() => c.go("harbour")}
            >
              <BravoFlag size={1.5} /> Bunkering in progress · {bunkering} {bunkering === 1 ? "order" : "orders"}
            </button>
          )}
        </div>

        <div className="hd-account">
          {c.isBesu && (
            <span className="hd-net hd-net-besu" title="Connected to a 4-validator Hyperledger Besu QBFT network">
              Besu QBFT · chain {EXPECTED_CHAIN_ID} · block {c.blockNumber}
            </span>
          )}
          {!c.rpcOk && <span className="hd-warn">Local node not reachable. Run npm run besu:up.</span>}
          {!c.hasMetaMask ? (
            <span className="hd-warn">Install MetaMask to sign transactions.</span>
          ) : !c.account ? (
            <button className="btn" type="button" onClick={() => void c.connect()}>
              Connect MetaMask
            </button>
          ) : c.wrongNetwork ? (
            <button className="btn btn-danger" type="button" onClick={() => void c.switchNetwork()}>
              Wrong network ({c.walletChainId}). Switch to {EXPECTED_CHAIN_ID}
            </button>
          ) : (
            <div className="hd-who">
              <b>{c.me?.name || "Unregistered account"}</b>
              {c.me?.index !== undefined && c.me.index >= 0 && <span className="hd-idx">#{c.me.index}</span>}
              {c.me?.roles.map((r) => (
                <span key={r} className="hd-role">
                  {ROLE_LABEL[r]}
                </span>
              ))}
              {c.me?.suspended && <span className="hd-role hd-suspended">Suspended</span>}
              <span className="hd-addr mono">{shortHex(c.account)}</span>
              {!c.isBesu && <span className="hd-net">Chain {EXPECTED_CHAIN_ID} · block {c.blockNumber}</span>}
              <button className="btn btn-sm btn-ghost" type="button" onClick={() => void c.changeAccount()}>
                Change account
              </button>
            </div>
          )}
        </div>
      </div>

      <nav className="hd-nav" aria-label="Views">
        {NAV.map((n) => (
          <button
            key={n.view}
            type="button"
            className="hd-tab"
            aria-current={c.view === n.view ? "page" : undefined}
            onClick={() => c.go(n.view)}
          >
            {n.label}
          </button>
        ))}
        <span className="hd-spacer" />
      </nav>
      {c.paused && <div className="hd-paused">Order creation and funding are paused by the admin.</div>}
    </header>
  );
}
