import { ANCHORAGES, DOC_TYPES, REASON_LABEL, REASONS, ROLE_LABEL, fmtSgd, fmtTonnes, roleFromHash, shortHex } from "./domain";
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
export function describeEvent(e: ActivityEvent, nameOf: NameOf): string {
  const a = e.args;
  const who = (k: string) => nameOf(String(a[k]));
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
      return `Order ${a.id} settled: ${sgd(a.paidToSupplier)} to the supplier, ${sgd(a.refundedToBank)} back to the bank`;
    case "OrderDisputed":
      return `Order ${a.id} disputed (dispute #${a.disputeId})`;
    case "OrderResolved":
      return `Order ${a.id} resolved: ${sgd(a.supplierAmount)} to the supplier, ${sgd(a.bankAmount)} to the bank`;
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
      return `Dispute #${a.disputeId} resolved at ${Number(a.supplierShareBps) / 100}% to the supplier`;
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
export function headline(g: TxGroup, nameOf: NameOf): string {
  const who = g.from ? nameOf(g.from) : "Someone";
  const ev = (n: string) => g.events.find((e) => e.name === n);
  const id = g.orderId;
  const ord = id !== undefined ? ` order ${id}` : " an order";
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
    case "openDispute":
      return `${who} opened a dispute on${ord}`;
    case "submitEvidence":
      return `${who} added evidence to a dispute on${ord}`;
    case "resolve": {
      const r = ev("DisputeResolved");
      return r
        ? `${who} resolved dispute #${r.args.disputeId} at ${Number(r.args.supplierShareBps) / 100}% to the supplier`
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
  return first ? describeEvent(first, nameOf) : `${who} sent a transaction`;
}

const ESCROW = new Set(["Deposited", "Released", "Refunded", "Split"]);

/** True for events that repeat what another event in the same tx already says. */
export function isNoise(e: ActivityEvent, g: TxGroup): boolean {
  if (e.name === "RoleGranted" || e.name === "RoleAdminChanged") {
    return g.events.some((x) => x.name === "ParticipantRegistered");
  }
  if (e.contract === "MockSGD" && e.name === "Transfer") {
    return g.events.some((x) => ESCROW.has(x.name));
  }
  return false;
}
