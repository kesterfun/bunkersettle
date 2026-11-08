import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ethers } from "ethers";
import deployments from "../deployments.json";
import {
  ROLES,
  ROLE_HASH,
  STATUS,
  REASONS,
  accountIndex,
  roleFromHash,
  shortHex,
  type ActivityEvent,
  type ClaimView,
  type DisputeView,
  type OrderView,
  type Participant,
  type RoleName,
  type TxInfo,
} from "../domain";
import { decodeError, type DecodedError } from "./errors";

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      on?(event: string, cb: (...args: never[]) => void): void;
      removeListener?(event: string, cb: (...args: never[]) => void): void;
    };
  }
}

/** Fields written by scripts/deploy.ts; older manifests may lack them. */
interface ManifestExtras {
  rpcUrl?: string;
  networkName?: string;
  besuNodes?: BesuNode[];
}
const manifest = deployments as typeof deployments & ManifestExtras;

/** One Besu validator as listed in the deployment manifest. */
export interface BesuNode {
  name: string;
  rpcUrl: string;
  /** Validator (block signer) address; equals the block miner field when it proposes. */
  validator: string;
}

export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? manifest.rpcUrl ?? "http://127.0.0.1:8545";
export const EXPECTED_CHAIN_ID: number = deployments.chainId;
export const NETWORK_NAME: string = manifest.networkName ?? (EXPECTED_CHAIN_ID === 31337 ? "localhost" : "unknown");
export const BESU_NODES: BesuNode[] = manifest.besuNodes ?? [];
/** Name shown to the user and offered to MetaMask for this chain. */
export const CHAIN_LABEL: string =
  NETWORK_NAME === "besu" ? "Besu QBFT (BunkerSettle)" : EXPECTED_CHAIN_ID === 31337 ? "Hardhat localhost" : `Chain ${EXPECTED_CHAIN_ID}`;

export type ContractName = keyof typeof deployments.contracts;
const NAMES = Object.keys(deployments.contracts) as ContractName[];
export const ADDRESSES = Object.fromEntries(NAMES.map((n) => [n, deployments.contracts[n].address])) as Record<
  ContractName,
  string
>;
export type Contracts = Record<ContractName, ethers.Contract>;

export type View = "harbour" | "order" | "create" | "oracle" | "disputes" | "activity" | "market";

export interface Toast {
  id: number;
  kind: "pending" | "success" | "error";
  title: string;
  detail?: string;
  error?: DecodedError;
}

export interface Me {
  address: string;
  name: string;
  roles: RoleName[];
  suspended: boolean;
  /** Hardhat account number 0–8, or -1. */
  index: number;
}

export interface ChainState {
  /** Local node reachable at RPC_URL. */
  rpcOk: boolean;
  hasMetaMask: boolean;
  account: string | null;
  walletChainId: number | null;
  wrongNetwork: boolean;
  connect(): Promise<void>;
  /** Opens MetaMask's account picker for this site, so another account can be connected and selected. */
  changeAccount(): Promise<void>;
  switchNetwork(): Promise<void>;
  /** Registry data for the connected account. */
  me: Me | null;

  blockNumber: number;
  orders: OrderView[];
  disputes: DisputeView[];
  /** Every decoded contract event, newest first. */
  events: ActivityEvent[];
  /** Sender and decoded function call for every transaction that emitted an event, by tx hash. */
  txs: Record<string, TxInfo>;
  participants: Participant[];
  /** mSGD balance by lower-cased address (participants + escrow). */
  balances: Record<string, bigint>;
  /** Connected account's mSGD allowance to PaymentEscrow. */
  allowance: bigint;
  /** Connected account's mSGD allowance to SettlementClaim (needed to buy a claim). */
  claimAllowance: bigint;
  paused: boolean;
  /** Registry name for an address, else a short hex. */
  nameOf(address: string): string;

  /** Read-only contracts on the local node. */
  read: Contracts;
  /**
   * Sends a transaction signed by MetaMask. Shows a toast that ends in "confirmed" or in the
   * decoded custom error. Never pre-validates. Resolves true when the tx was mined.
   * `doneLabel` replaces the toast title once confirmed (for example "Buy claim" -> "Claim bought").
   */
  send(label: string, build: (c: Contracts) => Promise<ethers.ContractTransactionResponse>, doneLabel?: string): Promise<boolean>;
  /**
   * Asks the connected MetaMask account to sign (no transaction, no gas), e.g. an EIP-712 message.
   * Shows a toast that ends in "signed" or in the error. Resolves null when signing failed.
   */
  sign<T>(label: string, run: (signer: ethers.Signer) => Promise<T>): Promise<T | null>;
  /** web3_clientVersion of the RPC node, or null until it answers. */
  clientVersion: string | null;
  /** The RPC node reports itself as Hyperledger Besu. */
  isBesu: boolean;
  /** chainId 31337 only. */
  isDevChain: boolean;
  /** evm_increaseTime + evm_mine. */
  fastForward(seconds: number): Promise<void>;

  view: View;
  orderId: number | null;
  go(view: View, orderId?: number): void;
  /** Client-side checks that disable impossible actions. Default off (SPEC 8). */
  toasts: Toast[];
  dismissToast(id: number): void;
}

const ChainContext = createContext<ChainState | null>(null);
const ClockContext = createContext<number>(0);

/** All chain data, wallet state, navigation and the tx helper. */
export function useChain(): ChainState {
  const ctx = useContext(ChainContext);
  if (!ctx) throw new Error("useChain must be used inside <ChainProvider>");
  return ctx;
}

/** Estimated chain time in seconds, ticking once per second. Tracks evm_increaseTime. */
export function useChainNow(): number {
  return useContext(ClockContext);
}

function toOrder(r: ethers.Result, held: bigint, d: ethers.Result, lab: ethers.Result, claim: ClaimView): OrderView {
  return {
    id: Number(r.id),
    buyer: r.buyer,
    supplier: r.supplier,
    bank: r.bank,
    fuelGrade: r.fuelGrade,
    qtyKg: r.qtyKg,
    pricePerTonne: r.pricePerTonne,
    toleranceBps: Number(r.toleranceBps),
    retentionBps: Number(r.retentionBps),
    deliveryDeadline: Number(r.deliveryDeadline),
    retentionWindow: Number(r.retentionWindow),
    fundedAmount: r.fundedAmount,
    deliveredKg: r.deliveredKg,
    payableAmount: r.payableAmount,
    releasedAmount: r.releasedAmount,
    refundedAmount: r.refundedAmount,
    approvedAt: Number(r.approvedAt),
    status: STATUS[Number(r.status)],
    disputeId: Number(r.disputeId),
    dscHash: r.dscHash,
    anchorage: Number(r.anchorage),
    held,
    claim,
    delivery: {
      meterKg: d.meterKg,
      ebdnKg: d.ebdnKg,
      ticketHash: d.ticketHash,
      ebdnHash: d.ebdnHash,
      meterSubmitted: d.meterSubmitted,
      ebdnSubmitted: d.ebdnSubmitted,
    },
    lab: {
      submitted: lab.submitted,
      passed: lab.passed,
      reportHash: lab.reportHash,
      lab: lab.lab,
      submittedAt: Number(lab.submittedAt),
    },
  };
}

/** Contracts whose `id` event arg is an order id. */
const ORDER_SCOPED = new Set<ContractName>(["BunkerOrder", "PaymentEscrow", "DeliveryRecord", "QualityRecord", "DisputeManager"]);

export function ChainProvider({ children }: { children: ReactNode }) {
  const provider = useMemo(() => {
    const p = new ethers.JsonRpcProvider(RPC_URL, ethers.Network.from(EXPECTED_CHAIN_ID), { staticNetwork: true });
    p.pollingInterval = 1000;
    return p;
  }, []);
  const read = useMemo(
    () => Object.fromEntries(NAMES.map((n) => [n, new ethers.Contract(ADDRESSES[n], deployments.contracts[n].abi as ethers.InterfaceAbi, provider)])) as Contracts,
    [provider],
  );
  const byAddress = useMemo(() => {
    const m = new Map<string, { name: ContractName; iface: ethers.Interface }>();
    for (const n of NAMES) m.set(ADDRESSES[n].toLowerCase(), { name: n, iface: read[n].interface });
    return m;
  }, [read]);

  // ---------------------------------------------------------------- wallet
  const hasMetaMask = typeof window !== "undefined" && !!window.ethereum;
  const [account, setAccount] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    eth.request({ method: "eth_accounts" }).then((a) => setAccount((a as string[])[0] ?? null)).catch(() => {});
    eth.request({ method: "eth_chainId" }).then((c) => setWalletChainId(parseInt(c as string, 16))).catch(() => {});
    const onAccounts = (a: string[]) => setAccount(a[0] ?? null);
    const onChain = (c: string) => setWalletChainId(parseInt(c, 16));
    eth.on?.("accountsChanged", onAccounts as never);
    eth.on?.("chainChanged", onChain as never);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts as never);
      eth.removeListener?.("chainChanged", onChain as never);
    };
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) return;
    const a = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
    setAccount(a[0] ?? null);
  }, []);

  const changeAccount = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    } catch {
      return; // closed the picker
    }
    const a = (await eth.request({ method: "eth_accounts" })) as string[];
    setAccount(a[0] ?? null);
  }, []);

  const switchNetwork = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    const chainId = "0x" + EXPECTED_CHAIN_ID.toString(16);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId, chainName: CHAIN_LABEL, rpcUrls: [RPC_URL], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 } }],
      });
    }
  }, []);

  // ---------------------------------------------------------------- chain data
  const [rpcOk, setRpcOk] = useState(true);
  const [blockNumber, setBlockNumber] = useState(0);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [disputes, setDisputes] = useState<DisputeView[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [txs, setTxs] = useState<Record<string, TxInfo>>({});
  const txsRef = useRef<Record<string, TxInfo>>({});
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [me, setMe] = useState<Me | null>(null);
  const [allowance, setAllowance] = useState(0n);
  const [claimAllowance, setClaimAllowance] = useState(0n);
  const [paused, setPaused] = useState(false);
  const [clientVersion, setClientVersion] = useState<string | null>(null);
  const [timeOffset, setTimeOffset] = useState<number | null>(null);

  const clientVersionRef = useRef<string | null>(null);
  const eventsRef = useRef<ActivityEvent[]>([]);
  const lastLogBlock = useRef(-1);
  const blockTimes = useRef(new Map<number, number>());
  const running = useRef(false);
  const again = useRef(false);
  const accountRef = useRef(account);
  accountRef.current = account;

  const participants = useMemo(() => {
    const map = new Map<string, Participant>();
    for (const e of [...events].reverse()) {
      if (e.contract !== "ParticipantRegistry") continue;
      const addr = String(e.args.account);
      const key = addr.toLowerCase();
      const role = roleFromHash(String(e.args.role ?? ""));
      if (e.name === "ParticipantRegistered") {
        const p = map.get(key) ?? { address: addr, name: "", roles: [] };
        p.name = String(e.args.name);
        if (role && !p.roles.includes(role)) p.roles.push(role);
        map.set(key, p);
      } else if (e.name === "ParticipantRevoked" && role) {
        const p = map.get(key);
        if (p) p.roles = p.roles.filter((r) => r !== role);
      }
    }
    return [...map.values()];
  }, [events]);

  const participantsRef = useRef(participants);
  participantsRef.current = participants;

  const refresh = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      const latest = await provider.getBlock("latest");
      if (!latest) return;
      setRpcOk(true);
      if (!clientVersionRef.current) {
        try {
          clientVersionRef.current = String(await provider.send("web3_clientVersion", []));
          setClientVersion(clientVersionRef.current);
        } catch {
          // client string is cosmetic; retried on the next refresh
        }
      }
      // A restarted node starts over at a lower block: drop everything cached.
      if (latest.number < lastLogBlock.current) {
        eventsRef.current = [];
        txsRef.current = {};
        lastLogBlock.current = -1;
        blockTimes.current.clear();
        setTimeOffset(null);
      }
      setTimeOffset((prev) => {
        const off = latest.timestamp - Date.now() / 1000;
        return prev === null ? off : Math.max(prev, off);
      });

      const { BunkerOrder: order, DeliveryRecord: delivery, QualityRecord: quality, DisputeManager: dispute, MockSGD: token, ParticipantRegistry: registry, SettlementClaim: claim } = read;

      // events since the last poll
      if (latest.number > lastLogBlock.current) {
        const logs = await provider.getLogs({
          address: NAMES.map((n) => ADDRESSES[n]),
          fromBlock: lastLogBlock.current + 1,
          toBlock: latest.number,
        });
        const fresh: ActivityEvent[] = [];
        for (const log of logs) {
          const src = byAddress.get(log.address.toLowerCase());
          if (!src) continue;
          let parsed: ethers.LogDescription | null = null;
          try {
            parsed = src.iface.parseLog(log);
          } catch {
            parsed = null;
          }
          if (!parsed) continue;
          let ts = blockTimes.current.get(log.blockNumber);
          if (ts === undefined) {
            ts = (await provider.getBlock(log.blockNumber))?.timestamp ?? 0;
            blockTimes.current.set(log.blockNumber, ts);
          }
          const args: Record<string, unknown> = {};
          parsed.fragment.inputs.forEach((input, i) => (args[input.name || String(i)] = parsed!.args[i]));
          const rawId =
            args.orderId ??
            (src.name === "SettlementClaim" ? args.tokenId : undefined) ??
            (ORDER_SCOPED.has(src.name) && src.name !== "DisputeManager" ? args.id : undefined);
          fresh.push({
            key: `${log.transactionHash}:${log.index}`,
            contract: src.name,
            name: parsed.name,
            args,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            logIndex: log.index,
            timestamp: ts,
            orderId: rawId !== undefined ? Number(rawId) : undefined,
          });
        }
        // Sender + decoded call for each new transaction, so the feed can say who did what.
        const newHashes = [...new Set(fresh.map((e) => e.txHash))].filter((h) => !txsRef.current[h]);
        if (newHashes.length) {
          const infos = await Promise.all(
            newHashes.map(async (hash): Promise<TxInfo> => {
              const tx = await provider.getTransaction(hash);
              const target = tx?.to ? byAddress.get(tx.to.toLowerCase()) : undefined;
              let fn: string | null = null;
              const args: Record<string, unknown> = {};
              if (tx && target) {
                try {
                  const parsed = target.iface.parseTransaction({ data: tx.data, value: tx.value });
                  if (parsed) {
                    fn = parsed.name;
                    parsed.fragment.inputs.forEach((input, i) => (args[input.name || String(i)] = parsed.args[i]));
                  }
                } catch {
                  fn = null;
                }
              }
              return { hash, from: tx?.from ?? "", contract: target?.name ?? null, fn, args };
            }),
          );
          txsRef.current = { ...txsRef.current, ...Object.fromEntries(infos.map((t) => [t.hash, t])) };
          setTxs(txsRef.current);
        }
        lastLogBlock.current = latest.number;
        if (fresh.length) {
          eventsRef.current = [...fresh.reverse(), ...eventsRef.current];
          setEvents(eventsRef.current);
        } else if (eventsRef.current.length === 0) {
          setEvents([]);
        }
      }

      // orders
      const count = Number(await order.orderCount());
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      const fetched = await Promise.all(
        ids.map(async (id) => {
          const [r, held, d, lab, holder, outstanding, offer] = await Promise.all([
            order.getOrder(id),
            order.heldAmount(id),
            delivery.getDelivery(id),
            quality.getResult(id),
            claim.payeeOf(id) as Promise<string>,
            claim.outstanding(id) as Promise<bigint>,
            claim.getOffer(id),
          ]);
          return toOrder(r, held, d, lab, { holder, outstanding, offerPrice: offer.seller === ethers.ZeroAddress ? 0n : offer.price });
        }),
      );
      setOrders(fetched);

      // disputes
      const dCount = Number(await dispute.disputeCount());
      const ds = await Promise.all(
        Array.from({ length: dCount }, (_, i) => i + 1).map(async (id) => {
          const r = await dispute.getDispute(id);
          return {
            id,
            orderId: Number(r.orderId),
            reason: REASONS[Number(r.reason)],
            openedBy: r.openedBy,
            openedAt: Number(r.openedAt),
            evidenceCount: Number(r.evidenceCount),
            resolved: r.resolved,
            supplierShareBps: Number(r.supplierShareBps),
          } satisfies DisputeView;
        }),
      );
      setDisputes(ds);

      // balances of every participant + escrow
      const addrs = new Set<string>([ADDRESSES.PaymentEscrow, ...participantsRef.current.map((p) => p.address)]);
      const acct = accountRef.current;
      if (acct) addrs.add(acct);
      const bal: Record<string, bigint> = {};
      await Promise.all([...addrs].map(async (a) => (bal[a.toLowerCase()] = await token.balanceOf(a))));
      setBalances(bal);
      setPaused(await order.paused());

      if (acct) {
        const [name, suspended, allow, claimAllow, ...has] = await Promise.all([
          registry.nameOf(acct) as Promise<string>,
          registry.isSuspended(acct) as Promise<boolean>,
          token.allowance(acct, ADDRESSES.PaymentEscrow) as Promise<bigint>,
          token.allowance(acct, ADDRESSES.SettlementClaim) as Promise<bigint>,
          ...ROLES.map((r) => registry.hasRole(ROLE_HASH[r], acct) as Promise<boolean>),
        ]);
        setMe({ address: acct, name, suspended, roles: ROLES.filter((_, i) => has[i]), index: accountIndex(acct) });
        setAllowance(allow);
        setClaimAllowance(claimAllow);
      } else {
        setMe(null);
        setAllowance(0n);
        setClaimAllowance(0n);
      }
      setBlockNumber(latest.number);
    } catch (err) {
      console.error("[BunkerSettle] refresh failed", err);
      setRpcOk(false);
    } finally {
      running.current = false;
      if (again.current) {
        again.current = false;
        void refresh();
      }
    }
  }, [provider, read, byAddress]);

  useEffect(() => {
    void refresh();
    const onBlock = () => void refresh();
    void provider.on("block", onBlock);
    // Retry while the node is down; the block listener does the rest once it is up.
    const retry = setInterval(() => void refresh(), 5000);
    return () => {
      void provider.off("block", onBlock);
      clearInterval(retry);
    };
  }, [provider, refresh]);

  useEffect(() => void refresh(), [account, refresh]);

  // ---------------------------------------------------------------- clock
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const chainNow = Math.floor(now + (timeOffset ?? 0));

  // ---------------------------------------------------------------- toasts + tx
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const upsertToast = useCallback((t: Toast) => setToasts((all) => [...all.filter((x) => x.id !== t.id), t]), []);
  const dismissToast = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);

  const send = useCallback<ChainState["send"]>(
    async (label, build, doneLabel) => {
      const id = ++toastId.current;
      upsertToast({ id, kind: "pending", title: label, detail: "Confirm in MetaMask…" });
      try {
        if (!window.ethereum) throw new Error("MetaMask is not installed.");
        if (!accountRef.current) throw new Error("Connect MetaMask first.");
        const browser = new ethers.BrowserProvider(window.ethereum);
        browser.pollingInterval = 500;
        const signer = await browser.getSigner(accountRef.current);
        const write = Object.fromEntries(NAMES.map((n) => [n, read[n].connect(signer)])) as Contracts;
        const tx = await build(write);
        upsertToast({ id, kind: "pending", title: label, detail: `Sent ${shortHex(tx.hash)}, waiting for a block…` });
        const rc = await tx.wait();
        upsertToast({ id, kind: "success", title: doneLabel ?? label, detail: `Confirmed in block ${rc?.blockNumber ?? "?"}` });
        setTimeout(() => dismissToast(id), 6000);
        void refresh();
        return true;
      } catch (err) {
        const error = decodeError(err);
        upsertToast({ id, kind: "error", title: label, error });
        void refresh();
        return false;
      }
    },
    [read, refresh, upsertToast, dismissToast],
  );

  const sign = useCallback<ChainState["sign"]>(
    async (label, run) => {
      const id = ++toastId.current;
      upsertToast({ id, kind: "pending", title: label, detail: "Sign in MetaMask (no gas)…" });
      try {
        if (!window.ethereum) throw new Error("MetaMask is not installed.");
        if (!accountRef.current) throw new Error("Connect MetaMask first.");
        const browser = new ethers.BrowserProvider(window.ethereum);
        const result = await run(await browser.getSigner(accountRef.current));
        upsertToast({ id, kind: "success", title: label, detail: "Signed. Nothing was sent to the chain." });
        setTimeout(() => dismissToast(id), 6000);
        return result;
      } catch (err) {
        upsertToast({ id, kind: "error", title: label, error: decodeError(err) });
        return null;
      }
    },
    [upsertToast, dismissToast],
  );

  const isDevChain = EXPECTED_CHAIN_ID === 31337;
  const fastForward = useCallback(
    async (seconds: number) => {
      if (!isDevChain) return;
      await provider.send("evm_increaseTime", [seconds]);
      await provider.send("evm_mine", []);
      void refresh();
    },
    [provider, isDevChain, refresh],
  );

  // ---------------------------------------------------------------- ui state
  const [view, setView] = useState<View>("harbour");
  const [orderId, setOrderId] = useState<number | null>(null);
  const go = useCallback((v: View, id?: number) => {
    setView(v);
    if (id !== undefined) setOrderId(id);
    window.scrollTo({ top: 0 });
  }, []);

  const nameOf = useCallback(
    (address: string) => {
      const p = participants.find((x) => x.address.toLowerCase() === address.toLowerCase());
      if (p?.name) return p.name;
      const contract = NAMES.find((n) => ADDRESSES[n].toLowerCase() === address.toLowerCase());
      return contract ? `${contract} contract` : shortHex(address);
    },
    [participants],
  );

  const value: ChainState = {
    rpcOk,
    hasMetaMask,
    account,
    walletChainId,
    wrongNetwork: walletChainId !== null && walletChainId !== EXPECTED_CHAIN_ID,
    connect,
    changeAccount,
    switchNetwork,
    me,
    blockNumber,
    orders,
    disputes,
    events,
    txs,
    participants,
    balances,
    allowance,
    claimAllowance,
    paused,
    nameOf,
    read,
    send,
    sign,
    clientVersion,
    isBesu: !!clientVersion && clientVersion.toLowerCase().startsWith("besu"),
    isDevChain,
    fastForward,
    view,
    orderId,
    go,
    toasts,
    dismissToast,
  };

  return (
    <ChainContext.Provider value={value}>
      <ClockContext.Provider value={chainNow}>{children}</ClockContext.Provider>
    </ChainContext.Provider>
  );
}
