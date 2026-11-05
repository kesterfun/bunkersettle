import { useEffect, useRef, useState } from "react";
import { BESU_NODES, RPC_URL, useChain } from "../chain/ChainContext";
import { shortHex } from "../domain";
import "./NetworkPanel.css";

const POLL_MS = 2000;
const TIMEOUT_MS = 1500;
const HALT_AFTER_S = 6;
const AVG_WINDOW = 20;

interface NodeStatus {
  online: boolean;
  block: number;
  peers: number;
  /** Miner (proposer) of this node's latest block, lower-cased. */
  proposer: string;
}

const OFFLINE: NodeStatus = { online: false, block: 0, peers: 0, proposer: "" };

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function pollNode(url: string): Promise<NodeStatus> {
  try {
    const [blockHex, peersHex, latest] = await Promise.all([
      rpc<string>(url, "eth_blockNumber"),
      rpc<string>(url, "net_peerCount"),
      rpc<{ miner: string } | null>(url, "eth_getBlockByNumber", ["latest", false]),
    ]);
    return { online: true, block: parseInt(blockHex, 16), peers: parseInt(peersHex, 16), proposer: (latest?.miner ?? "").toLowerCase() };
  } catch {
    return OFFLINE;
  }
}

/** Average seconds per block over the last AVG_WINDOW blocks, read from the first node that answers. */
async function averageBlockTime(urls: string[], head: number): Promise<number | null> {
  if (head < 2) return null;
  const from = Math.max(0, head - AVG_WINDOW);
  for (const url of urls) {
    try {
      const [a, b] = await Promise.all([
        rpc<{ timestamp: string }>(url, "eth_getBlockByNumber", ["0x" + from.toString(16), false]),
        rpc<{ timestamp: string }>(url, "eth_getBlockByNumber", ["0x" + head.toString(16), false]),
      ]);
      return (parseInt(b.timestamp, 16) - parseInt(a.timestamp, 16)) / (head - from);
    } catch {
      continue;
    }
  }
  return null;
}

/** Live view of the Besu validators: online state, height, peers, proposer of the latest block. Shown on Besu only. */
export function NetworkPanel() {
  const { isBesu } = useChain();
  // Without per-node URLs in the manifest, fall back to the single RPC endpoint.
  const nodes = BESU_NODES.length ? BESU_NODES : [{ name: "Validator 1", rpcUrl: RPC_URL, validator: "" }];
  const [status, setStatus] = useState<NodeStatus[]>(() => nodes.map(() => OFFLINE));
  const [validators, setValidators] = useState<string[]>([]);
  const [avg, setAvg] = useState<number | null>(null);
  const [halted, setHalted] = useState(false);
  const [checked, setChecked] = useState(false);
  const best = useRef({ block: -1, since: Date.now() });

  useEffect(() => {
    if (!isBesu) return;
    let cancelled = false;
    const tick = async () => {
      const next = await Promise.all(nodes.map((n) => pollNode(n.rpcUrl)));
      if (cancelled) return;
      setStatus(next);
      setChecked(true);
      const online = next.map((s, i) => ({ s, i })).filter((x) => x.s.online);
      const head = Math.max(0, ...online.map((x) => x.s.block));
      if (head > best.current.block) best.current = { block: head, since: Date.now() };
      setHalted(online.length === 0 || (Date.now() - best.current.since) / 1000 > HALT_AFTER_S);
      const urls = online.map((x) => nodes[x.i].rpcUrl);
      if (urls.length) {
        try {
          const v = await rpc<string[]>(urls[0], "qbft_getValidatorsByBlockNumber", ["latest"]);
          if (!cancelled) setValidators(v.map((a) => a.toLowerCase()));
        } catch {
          // validator list is optional
        }
        const a = await averageBlockTime(urls, head);
        if (!cancelled) setAvg(a);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBesu]);

  if (!isBesu) return null;

  const onlineCount = status.filter((s) => s.online).length;
  const head = Math.max(0, ...status.map((s) => s.block));
  // The proposer of the highest block any node has seen.
  const leader = status.find((s) => s.online && s.block === head)?.proposer ?? "";
  const quorum = Math.floor((2 * nodes.length) / 3) + 1;

  return (
    <section className="panel net" aria-label="Besu network">
      <div className="panel-head">
        <span className="net-title">Hyperledger Besu · QBFT network</span>
        <span className={checked && !halted ? "net-status net-ok" : "net-status net-halt"}>
          {!checked ? "Checking…" : halted ? `Halted — needs ${quorum} of ${nodes.length} validators` : "Producing blocks"}
        </span>
        <span className="net-stats mono">
          block {head} · {avg === null ? "–" : avg.toFixed(1)}s avg · {onlineCount}/{nodes.length} validators online
          {validators.length ? ` · ${validators.length} in set` : ""}
        </span>
      </div>
      <div className="net-grid">
        {nodes.map((n, i) => {
          const s = status[i] ?? OFFLINE;
          const addr = (n.validator || "").toLowerCase();
          const proposing = s.online && !!addr && addr === leader;
          const cls = ["net-card", s.online ? "" : "net-off", proposing ? "net-prop" : ""].join(" ");
          return (
            <div key={n.rpcUrl} className={cls}>
              <div className="net-card-top">
                <b>{n.name}</b>
                <span className="net-dot" aria-hidden />
                <span className="label">{s.online ? "online" : "offline"}</span>
              </div>
              {proposing && <div className="net-badge">Proposed latest block</div>}
              <div className="mono net-line">{n.validator ? shortHex(n.validator) : "validator"}</div>
              <div className="mono net-line">{s.online ? `block ${s.block} · ${s.peers} peers` : "no response"}</div>
              <div className="mono net-line net-url">{n.rpcUrl.replace("http://", "")}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
