import { ethers } from "ethers";
import deployments from "../deployments.json";

/** One interface holding every custom error from every deployed contract (incl. OpenZeppelin errors). */
const errorIface = new ethers.Interface(
  Object.values(deployments.contracts).flatMap((c) =>
    (c.abi as { type: string }[]).filter((f) => f.type === "error"),
  ) as ethers.InterfaceAbi,
);

export interface DecodedError {
  /** Custom error name, e.g. "NotAuthorized", or a short label for non-contract failures. */
  name: string;
  /** "role=BUYER, account=0x…" style argument text. Empty when there are none. */
  args: string;
  /** Raw message when the error could not be decoded. */
  message?: string;
}

/** Finds the first revert-data hex string anywhere inside an ethers / MetaMask error object. */
function findRevertData(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== "object" || depth > 6) return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ["data", "error", "info", "cause", "originalError", "payload"]) {
    const v = e[key];
    if (typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v)) return v;
    if (v && typeof v === "object") {
      const found = findRevertData(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function fmtArg(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) {
    // Role hashes read better as names.
    for (const r of ["ADMIN", "BANK", "BUYER", "SUPPLIER", "METER_ORACLE", "EBDN_ORACLE", "LAB", "ARBITER"]) {
      if (ethers.keccak256(ethers.toUtf8Bytes(r)) === v.toLowerCase()) return r;
    }
  }
  return String(v);
}

/** Turns a failed transaction error into the contract's custom error name and arguments. */
export function decodeError(err: unknown): DecodedError {
  const e = err as { code?: unknown; shortMessage?: string; message?: string };
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001) {
    return { name: "Rejected", args: "", message: "Transaction rejected in MetaMask." };
  }
  const data = findRevertData(err);
  if (data) {
    try {
      const parsed = errorIface.parseError(data);
      if (parsed) {
        const args = parsed.fragment.inputs.map((input, i) => `${input.name || i}=${fmtArg(parsed.args[i])}`).join(", ");
        return { name: parsed.name, args };
      }
    } catch {
      // fall through to the raw message
    }
  }
  return { name: "Error", args: "", message: e?.shortMessage ?? e?.message ?? String(err) };
}
