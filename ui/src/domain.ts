import { ethers } from "ethers";

/** Order lifecycle states, in `Status` enum order (contracts/interfaces/BunkerTypes.sol). */
export const STATUS = [
  "Created",
  "Accepted",
  "Funded",
  "QuantityApproved",
  "Settled",
  "Disputed",
  "Resolved",
  "Cancelled",
] as const;
export type StatusName = (typeof STATUS)[number];

export const STATUS_LABEL: Record<StatusName, string> = {
  Created: "Created",
  Accepted: "Accepted",
  Funded: "Funded",
  QuantityApproved: "Qty approved",
  Settled: "Settled",
  Disputed: "Disputed",
  Resolved: "Resolved",
  Cancelled: "Cancelled",
};

/** Main path shown in the status pipeline. Disputed/Resolved/Cancelled branch off it. */
export const PIPELINE: StatusName[] = ["Created", "Accepted", "Funded", "QuantityApproved", "Settled"];

/** `DisputeReason` enum order. */
export const REASONS = ["OUT_OF_TOLERANCE", "QUANTITY_MISMATCH", "QUALITY_FAIL", "MANUAL"] as const;
export const REASON_LABEL: Record<(typeof REASONS)[number], string> = {
  OUT_OF_TOLERANCE: "Out of tolerance",
  QUANTITY_MISMATCH: "Meter and e-BDN disagree",
  QUALITY_FAIL: "Lab fail",
  MANUAL: "Opened by a party",
};

/** SS 709:2024 document types, in `DocType` enum order. */
export const DOC_TYPES = ["DSC", "BRF", "BMT", "BDN", "QTR", "COQ", "NOPV", "NOPB", "SOF", "DSI"] as const;
export const DOC_LABEL: Record<(typeof DOC_TYPES)[number], string> = {
  DSC: "Sales confirmation – Delivered",
  BRF: "Bunker requisition form",
  BMT: "Bunker metering ticket",
  BDN: "Bunker delivery note",
  QTR: "Quality test report",
  COQ: "Certificate of quality",
  NOPV: "Note of protest (vessel)",
  NOPB: "Note of protest (bunker tanker)",
  SOF: "Statement of fact",
  DSI: "Sales invoice – Delivered",
};

export const ROLES = ["ADMIN", "BANK", "BUYER", "SUPPLIER", "METER_ORACLE", "EBDN_ORACLE", "LAB", "ARBITER"] as const;
export type RoleName = (typeof ROLES)[number];
export const ROLE_HASH: Record<RoleName, string> = Object.fromEntries(
  ROLES.map((r) => [r, ethers.keccak256(ethers.toUtf8Bytes(r))]),
) as Record<RoleName, string>;
export const ROLE_LABEL: Record<RoleName, string> = {
  ADMIN: "Admin",
  BANK: "Bank",
  BUYER: "Buyer",
  SUPPLIER: "Supplier",
  METER_ORACLE: "Meter oracle",
  EBDN_ORACLE: "e-BDN oracle",
  LAB: "Lab",
  ARBITER: "Arbiter",
};
/** Role name for a role hash, or undefined. */
export const roleFromHash = (hash: string): RoleName | undefined =>
  ROLES.find((r) => ROLE_HASH[r].toLowerCase() === hash.toLowerCase());

/** Hardhat default accounts #0–#8 (SPEC 9), used to show "account #n" hints. */
export const HARDHAT_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
];
/** Hardhat account index (0–8) for an address, or -1. */
export const accountIndex = (addr?: string | null): number =>
  addr ? HARDHAT_ACCOUNTS.findIndex((a) => a.toLowerCase() === addr.toLowerCase()) : -1;

export interface AnchorageInfo {
  id: number;
  key: string;
  name: string;
  /** Dashed zone on the harbour chart, in the chart's 600 x 340 viewBox. */
  zone: { x: number; y: number; w: number; h: number };
  /** Where the zone's italic label sits. */
  label: { x: number; y: number };
}

/** `Anchorage` enum order, with positions on the harbour chart. */
export const ANCHORAGES: AnchorageInfo[] = [
  { id: 0, key: "WESTERN_PETROLEUM_A", name: "Western Petroleum A", zone: { x: 40, y: 182, w: 120, h: 48 }, label: { x: 100, y: 243 } },
  { id: 1, key: "WESTERN_PETROLEUM_B", name: "Western Petroleum B", zone: { x: 170, y: 214, w: 120, h: 38 }, label: { x: 230, y: 264 } },
  { id: 2, key: "EASTERN_PETROLEUM_A", name: "Eastern Petroleum A", zone: { x: 366, y: 160, w: 104, h: 46 }, label: { x: 418, y: 218 } },
  { id: 3, key: "EASTERN_PETROLEUM_B", name: "Eastern Petroleum B", zone: { x: 474, y: 190, w: 112, h: 48 }, label: { x: 530, y: 250 } },
];

// ------------------------------------------------------------------ view models

export interface DeliveryView {
  meterKg: bigint;
  ebdnKg: bigint;
  ticketHash: string;
  ebdnHash: string;
  meterSubmitted: boolean;
  ebdnSubmitted: boolean;
}

export interface LabView {
  submitted: boolean;
  passed: boolean;
  reportHash: string;
  lab: string;
  submittedAt: number;
}

export interface OrderView {
  id: number;
  buyer: string;
  supplier: string;
  bank: string;
  fuelGrade: string;
  qtyKg: bigint;
  pricePerTonne: bigint;
  toleranceBps: number;
  retentionBps: number;
  deliveryDeadline: number;
  retentionWindow: number;
  fundedAmount: bigint;
  deliveredKg: bigint;
  payableAmount: bigint;
  releasedAmount: bigint;
  refundedAmount: bigint;
  approvedAt: number;
  status: StatusName;
  disputeId: number;
  dscHash: string;
  anchorage: number;
  /** heldAmount(id): funded - released - refunded. */
  held: bigint;
  delivery: DeliveryView;
  lab: LabView;
}

export interface DisputeView {
  id: number;
  orderId: number;
  reason: (typeof REASONS)[number];
  openedBy: string;
  openedAt: number;
  evidenceCount: number;
  resolved: boolean;
  supplierShareBps: number;
}

export interface Participant {
  address: string;
  name: string;
  roles: RoleName[];
}

/** One decoded contract event for the activity log. */
export interface ActivityEvent {
  /** `${txHash}:${logIndex}`, unique. */
  key: string;
  contract: string;
  name: string;
  /** Named args, values as returned by ethers (bigint, string, boolean). */
  args: Record<string, unknown>;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  timestamp: number;
  /** Order the event concerns, when it has an `id`/`orderId` arg on an order-scoped contract. */
  orderId?: number;
}

// ------------------------------------------------------------------ formatting

/** 18-decimal mSGD amount as "441,176.40". */
export function fmtSgd(v: bigint, decimals = 2): string {
  const n = Number(ethers.formatEther(v));
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Kilograms as tonnes, e.g. 500200n -> "500.2 t". */
export function fmtTonnes(kg: bigint): string {
  const t = Number(kg) / 1000;
  return `${t.toLocaleString("en-US", { maximumFractionDigits: 3 })} t`;
}

/** 0x1234…abcd */
export const shortHex = (h: string, keep = 4) => (h.length > 2 + keep * 2 ? `${h.slice(0, 2 + keep)}…${h.slice(-keep)}` : h);

/** keccak256 of the UTF-8 text, as used for every off-chain document hash. */
export const hashText = (text: string) => ethers.keccak256(ethers.toUtf8Bytes(text));

/** "1m 12s", "3d 4h", or "0s". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Amount the bank must lock when funding: qty * price / 1000 * (1 + tolerance). Mirrors BunkerOrder.fundOrder. */
export const fundingAmount = (o: Pick<OrderView, "qtyKg" | "pricePerTonne" | "toleranceBps">) =>
  ((o.qtyKg * o.pricePerTonne) / 1000n) * (10_000n + BigInt(o.toleranceBps)) / 10_000n;

/** Visual tone of a status: who needs to look at it. Maps to the .tone-* classes and state colours. */
export type Tone = "action" | "progress" | "disputed" | "done" | "void";
export const STATUS_TONE: Record<StatusName, Tone> = {
  Created: "action",
  Accepted: "action",
  Funded: "progress",
  QuantityApproved: "progress",
  Settled: "done",
  Disputed: "disputed",
  Resolved: "done",
  Cancelled: "void",
};

/** Red Bravo flag: the order is between funding and settlement (fuel is being transferred or checked). */
export const isBunkering = (o: OrderView) => o.status === "Funded" || o.status === "QuantityApproved";

export interface NextStep {
  role: RoleName;
  /** The specific account that must act, when the contract restricts it to an order party. */
  actor: string | null;
  label: string;
}

/** Who acts next on the order's main path, or null when the order is finished. */
export function nextStep(o: OrderView): NextStep | null {
  switch (o.status) {
    case "Created":
      return { role: "SUPPLIER", actor: o.supplier, label: "Accept order" };
    case "Accepted":
      return { role: "BANK", actor: o.bank, label: "Approve and fund" };
    case "Funded":
      if (!o.delivery.meterSubmitted) return { role: "METER_ORACLE", actor: null, label: "Submit meter reading" };
      return { role: "EBDN_ORACLE", actor: null, label: "Submit e-BDN" };
    case "QuantityApproved":
      return { role: "LAB", actor: null, label: "Submit lab result" };
    case "Disputed":
      return { role: "ARBITER", actor: null, label: "Resolve dispute" };
    default:
      return null;
  }
}

/** True when the connected account holds the next step's role (and is the named party, if any). */
export function isMyTurn(o: OrderView, me: { address: string; roles: RoleName[] } | null): boolean {
  const step = nextStep(o);
  if (!step || !me) return false;
  if (!me.roles.includes(step.role)) return false;
  return !step.actor || step.actor.toLowerCase() === me.address.toLowerCase();
}

/** Retention still held on a quantity-approved order: payable - released. */
export const retentionOf = (o: OrderView) =>
  o.status === "QuantityApproved" ? o.payableAmount - o.releasedAmount : 0n;
