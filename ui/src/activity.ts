import { ANCHORAGES, DOC_TYPES, REASON_LABEL, REASONS, ROLE_LABEL, ZERO_ADDRESS, discountPct, fmtPct, fmtSgd, fmtTonnes, roleFromHash, shortHex } from "./domain";
import type { ActivityEvent, TxInfo } from "./domain";

export interface TxGroup {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  from: string;
  fn: string | null;
  contract: string | null;
  orderId?: number;
  /** In log order, oldest first. */
  events: ActivityEvent[];
}

type NameOf = (address: string) => string;

/** Who held an order's claim at a given point in the event log; undefined when no claim existed. */
export type PayeeAt = (orderId: number | undefined, blockNumber: number, logIndex: number) => string | undefined;

/** Builds a PayeeAt from the event list (newest first) by replaying the claim's Transfer events. */
export function makePayeeAt(events: ActivityEvent[]): PayeeAt {
  const byOrder = new Map<number, { block: number; idx: number; holder: string }[]>();
  for (const e of events) {
    if (e.contract !== "SettlementClaim" || e.name !== "Transfer" || e.orderId === undefined) continue;
    const list = byOrder.get(e.orderId) ?? [];
    list.push({ block: e.blockNumber, idx: e.logIndex, holder: String(e.args.to) });
    byOrder.set(e.orderId, list);
  }
  for (const list of byOrder.values()) list.sort((a, b) => a.block - b.block || a.idx - b.idx);
  return (orderId, blockNumber, logIndex) => {
    if (orderId === undefined) return undefined;
    let holder: string | undefined;
    for (const t of byOrder.get(orderId) ?? []) {
      if (t.block > blockNumber || (t.block === blockNumber && t.idx > logIndex)) break;
      holder = t.holder;
    }
    return holder && holder !== ZERO_ADDRESS ? holder : undefined;
  };
}

const MAX_UINT = (1n << 256n) - 1n;

/** Groups events by transaction, newest first. `events` is expected newest first. */
export function groupByTx(events: ActivityEvent[], txs: Record<string, TxInfo>): TxGroup[] {
  const map = new Map<string, TxGroup>();
  for (const e of events) {
    let g = map.get(e.txHash);
    if (!g) {
      const t = txs[e.txHash];
      g = {
        txHash: e.txHash,
        blockNumber: e.blockNumber,
        timestamp: e.timestamp,
        from: t?.from ?? "",
        fn: t?.fn ?? null,
        contract: t?.contract ?? null,
        events: [],
      };
      map.set(e.txHash, g);
    }
    g.events.push(e);
    if (g.orderId === undefined && e.orderId !== undefined) g.orderId = e.orderId;
  }
  const groups = [...map.values()];
  for (const g of groups) g.events.sort((a, b) => a.logIndex - b.logIndex);
  groups.sort((a, b) => b.blockNumber - a.blockNumber || (b.events[0]?.logIndex ?? 0) - (a.events[0]?.logIndex ?? 0));
  return groups;
}

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));
const sgd = (v: unknown) => `${fmtSgd(big(v))} mSGD`;
const docName = (v: unknown) => DOC_TYPES[Number(v)] ?? String(v);
const reasonName = (v: unknown) => {
  const r = REASONS[Number(v)];
  return r ? REASON_LABEL[r] : String(v);
};

/** One plain-English line for an event. */
export function describeEvent(e: ActivityEvent, nameOf: NameOf, payeeAt?: PayeeAt): string {
  const a = e.args;
  const who = (k: string) => nameOf(String(a[k]));
  /** Name of whoever holds the claim (and so receives the supplier's share) when the event was emitted. */
  const payee = () => {
    const h = payeeAt?.(e.orderId, e.blockNumber, e.logIndex);
    return h ? nameOf(h) : "the supplier";
  };
  if (e.contract === "SettlementClaim") {
    const orderNo = a.orderId ?? a.tokenId;
    switch (e.name) {
      case "Transfer": {
        const from = String(a.from);
        const to = String(a.to);
        if (from === ZERO_ADDRESS) return `Payment claim for order ${orderNo} issued to ${nameOf(to)}`;
        if (to === ZERO_ADDRESS) return `Payment claim for order ${orderNo} cancelled`;
        return `${nameOf(from)} transferred the claim for order ${orderNo} to ${nameOf(to)}`;
      }
      case "ClaimOffered":
        return `${who("seller")} offered the claim for order ${orderNo} at ${sgd(a.price)} (${fmtPct(discountPct(big(a.price), big(a.outstanding)))} below the ${sgd(a.outstanding)} outstanding)`;
      case "OfferCancelled":
        return `${who("seller")} withdrew the offer on the claim for order ${orderNo}`;
      case "ClaimSold":
        return `${who("seller")} sold the claim for order ${orderNo} to ${who("buyer")} for ${sgd(a.price)} (${fmtPct(discountPct(big(a.price), big(a.outstanding)))} below the ${sgd(a.outstanding)} outstanding)`;
      case "Approval":
      case "ApprovalForAll":
        return `${who("owner")} approved a transfer of the claim`;
    }
  }
  switch (e.name) {
    case "OrderCreated":
      return `Order ${a.id} created: ${who("buyer")} buys ${fmtTonnes(big(a.qtyKg))} from ${who("supplier")} at ${sgd(a.pricePerTonne)} per tonne, ${ANCHORAGES[Number(a.anchorage)]?.name ?? "anchorage"}`;
    case "OrderAccepted":
      return `${who("supplier")} accepted order ${a.id}`;
    case "OrderFunded":
      return `${who("bank")} funded order ${a.id} with ${sgd(a.amount)}`;
    case "OrderCancelled":
      return `Order ${a.id} cancelled by ${who("by")}${big(a.refunded) > 0n ? `, ${sgd(a.refunded)} refunded` : ""}`;
    case "QuantityApproved":
      return `Quantity approved: ${fmtTonnes(big(a.deliveredKg))} delivered, ${sgd(a.payableAmount)} payable (${sgd(a.releasedNow)} released now)`;
    case "OrderSettled":
      return `Order ${a.id} settled: ${sgd(a.paidToSupplier)} to ${payee()}, ${sgd(a.refundedToBank)} back to the bank`;
    case "OrderDisputed":
      return `Order ${a.id} disputed (dispute #${a.disputeId})`;
    case "OrderResolved":
      return `Order ${a.id} resolved: ${sgd(a.supplierAmount)} to ${payee()}, ${sgd(a.bankAmount)} to the bank`;
    case "ModulesSet":
      return "Contract modules linked";
    case "Paused":
      return "Order contract paused";
    case "Unpaused":
      return "Order contract resumed";
    case "Deposited":
      return `${who("from")} locked ${sgd(a.amount)} in escrow for order ${a.id}`;
    case "Released":
      return `${sgd(a.amount)} released to ${who("to")}`;
    case "Refunded":
      return `${sgd(a.amount)} refunded to ${who("to")}`;
    case "Split":
      return `Escrow split: ${sgd(a.supplierAmount)} to ${who("supplier")}, ${sgd(a.bankAmount)} to ${who("bank")}`;
    case "OrderContractSet":
      return "Escrow linked to the order contract";
    case "DisputeManagerSet":
      return "Escrow linked to the dispute manager";
    case "MeterReadingSubmitted":
      return `Meter reading submitted for order ${a.id}: ${fmtTonnes(big(a.qtyKg))}`;
    case "EBDNSubmitted":
      return `e-BDN submitted for order ${a.id}: ${fmtTonnes(big(a.qtyKg))}`;
    case "DeliveryVerified":
      return `Delivery verified: ${fmtTonnes(big(a.deliveredKg))}`;
    case "QuantityMismatch":
      return `Quantity mismatch: meter ${fmtTonnes(big(a.meterKg))}, e-BDN ${fmtTonnes(big(a.ebdnKg))}`;
    case "LabResultSubmitted":
      return `Lab result: ${a.passed ? "pass" : "fail"}`;
    case "DisputeOpened":
      return `Dispute #${a.disputeId} opened: ${reasonName(a.reason)}`;
    case "EvidenceSubmitted":
      return `Evidence added to dispute #${a.disputeId}: ${docName(a.docType)}${a.note ? ` (${a.note})` : ""}`;
    case "DisputeResolved":
      return `Dispute #${a.disputeId} resolved with a ${Number(a.supplierShareBps) / 100}% supplier share: ${sgd(a.supplierAmount)} to ${payee()}, ${sgd(a.bankAmount)} to the bank`;
    case "ParticipantRegistered": {
      const r = roleFromHash(String(a.role));
      return `${a.name} registered${r ? ` as ${ROLE_LABEL[r].toLowerCase()}` : ""}`;
    }
    case "ParticipantRevoked": {
      const r = roleFromHash(String(a.role));
      return `${who("account")} lost the ${r ? ROLE_LABEL[r].toLowerCase() : "a"} role`;
    }
    case "ParticipantSuspended":
      return `${who("account")} suspended`;
    case "ParticipantReinstated":
      return `${who("account")} reinstated`;
    case "RoleGranted": {
      const r = roleFromHash(String(a.role));
      return `${who("account")} granted ${r ? ROLE_LABEL[r].toLowerCase() : shortHex(String(a.role))} role`;
    }
    case "RoleRevoked": {
      const r = roleFromHash(String(a.role));
      return `${who("account")} lost ${r ? ROLE_LABEL[r].toLowerCase() : shortHex(String(a.role))} role`;
    }
    case "RoleAdminChanged":
      return "Role admin changed";
    case "Transfer": {
      const from = String(a.from);
      if (/^0x0{40}$/.test(from)) return `${sgd(a.value)} minted to ${who("to")}`;
      return `${who("from")} sent ${sgd(a.value)} to ${who("to")}`;
    }
    case "Approval":
      return big(a.value) === MAX_UINT
        ? `${who("owner")} approved ${who("spender")} to spend unlimited mSGD`
        : `${who("owner")} approved ${who("spender")} to spend ${sgd(a.value)}`;
    default:
      return e.name;
  }
}

/** "<sender> <verb>" for the transaction. */
export function headline(g: TxGroup, nameOf: NameOf, payeeAt?: PayeeAt): string {
  const who = g.from ? nameOf(g.from) : "Someone";
  const ev = (n: string) => g.events.find((e) => e.name === n);
  const id = g.orderId;
  const ord = id !== undefined ? ` order ${id}` : " an order";
  /** "<relayer> relayed <signer>'s signed <what> for order N": the signer is the event's oracle/lab. */
  const relayed = (eventName: string, what: string, signerKey = "oracle") => {
    const signer = ev(eventName)?.args[signerKey];
    return signer
      ? `${who} relayed ${nameOf(String(signer))}'s signed ${what} for${ord}`
      : `${who} relayed a signed ${what} for${ord}`;
  };
  switch (g.fn) {
    case "createOrder":
      return `${who} created${ord}`;
    case "acceptOrder":
      return `${who} accepted${ord}`;
    case "fundOrder":
      return `${who} funded${ord}`;
    case "cancelOrder":
      return `${who} cancelled${ord}`;
    case "cancelExpired":
      return `${who} cancelled expired${ord}`;
    case "releaseAfterTimeout":
      return `${who} released the retention for${ord}`;
    case "submitMeterReading":
      return `${who} filed the meter reading for${ord}`;
    case "submitEBDN":
      return `${who} filed the e-BDN for${ord}`;
    case "submitLabResult":
      return `${who} filed the lab result for${ord}`;
    case "submitMeterReadingBySig":
      return relayed("MeterReadingSubmitted", "meter reading");
    case "submitEBDNBySig":
      return relayed("EBDNSubmitted", "e-BDN");
    case "submitLabResultBySig":
      return relayed("LabResultSubmitted", "lab result", "lab");
    case "openDispute":
      return `${who} opened a dispute on${ord}`;
    case "submitEvidence":
      return `${who} added evidence to a dispute on${ord}`;
    case "resolve": {
      const r = ev("DisputeResolved");
      return r
        ? `${who} resolved dispute #${r.args.disputeId} with a ${Number(r.args.supplierShareBps) / 100}% supplier share`
        : `${who} resolved a dispute`;
    }
    case "register": {
      const r = ev("ParticipantRegistered");
      return r ? `${who} registered ${r.args.name}` : `${who} registered a participant`;
    }
    case "revoke":
      return `${who} revoked a role`;
    case "suspend":
      return `${who} suspended a participant`;
    case "reinstate":
      return `${who} reinstated a participant`;
    case "mint":
      return `${who} minted mSGD`;
    case "approve":
      return ev("Approval") && big(ev("Approval")!.args.value) === MAX_UINT
        ? `${who} approved unlimited mSGD for escrow`
        : `${who} approved mSGD for escrow`;
    case "offer": {
      const o = ev("ClaimOffered");
      return o ? `${who} offered the claim for${ord} at ${sgd(o.args.price)}` : `${who} offered a claim for sale`;
    }
    case "cancelOffer":
      return `${who} withdrew the offer on the claim for${ord}`;
    case "buy": {
      const sold = ev("ClaimSold");
      return sold ? `${who} bought the claim for${ord} for ${sgd(sold.args.price)}` : `${who} bought a claim`;
    }
    case "transferFrom":
    case "safeTransferFrom":
      return `${who} transferred the claim for${ord}`;
    case "setClaim":
      return `${who} linked the settlement claim contract`;
    case "setModules":
      return `${who} linked the contract modules`;
    case "setOrderContract":
      return `${who} linked the order contract`;
    case "setDisputeManager":
      return `${who} linked the dispute manager`;
    case "pause":
      return `${who} paused the order contract`;
    case "unpause":
      return `${who} resumed the order contract`;
  }
  if (!g.fn && !g.contract && g.from) return `${who} deployed a contract`;
  const first = g.events[0];
  return first ? describeEvent(first, nameOf, payeeAt) : `${who} sent a transaction`;
}

const ESCROW = new Set(["Deposited", "Released", "Refunded", "Split"]);

/** True for events that repeat what another event in the same tx already says. */
export function isNoise(e: ActivityEvent, g: TxGroup): boolean {
  if (e.name === "RoleGranted" || e.name === "RoleAdminChanged") {
    return g.events.some((x) => x.name === "ParticipantRegistered");
  }
  if (e.contract === "MockSGD" && e.name === "Transfer") {
    return g.events.some((x) => ESCROW.has(x.name) || x.name === "ClaimSold");
  }
  if (e.contract === "SettlementClaim" && e.name === "Transfer") {
    return g.events.some((x) => x.name === "ClaimSold");
  }
  return false;
}
