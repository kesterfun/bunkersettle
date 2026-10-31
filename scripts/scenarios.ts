import { ethers } from "hardhat";
import type { Interface, InterfaceAbi } from "ethers";
import type {
  BunkerOrder,
  DeliveryRecord,
  DisputeManager,
  MockSGD,
  ParticipantRegistry,
  PaymentEscrow,
  QualityRecord,
} from "../typechain-types";
import { readDeployments } from "./lib/deployments";

/** Order status names, in BunkerTypes.Status order. */
const STATUS = [
  "Created",
  "Accepted",
  "Funded",
  "QuantityApproved",
  "Settled",
  "Disputed",
  "Resolved",
  "Cancelled",
];
const S = Object.fromEntries(STATUS.map((name, i) => [name, i])) as Record<string, number>;

/** DisputeReason names, in BunkerTypes.DisputeReason order. */
const REASONS = ["OUT_OF_TOLERANCE", "QUANTITY_MISMATCH", "QUALITY_FAIL", "MANUAL"];

/** Role names, used to label NotAuthorized(role, account) in the output. */
const ROLE_NAMES = ["ADMIN", "BANK", "BUYER", "SUPPLIER", "METER_ORACLE", "EBDN_ORACLE", "LAB", "ARBITER"];

const TOL = 50;
const RET = 1000;
const WINDOW = 120;
const DAY = 24 * 60 * 60;
const SHARE_SUPPLIER_BPS = 7000;
const PRICE = 980; // mSGD per tonne, SPEC 9 scenario 1
/** `Anchorage` enum values in BunkerTypes.sol. */
const ANCHORAGE = { WESTERN_PETROLEUM_A: 0, WESTERN_PETROLEUM_B: 1, EASTERN_PETROLEUM_A: 2, EASTERN_PETROLEUM_B: 3 };

/** Bank float restored by the admin when the bank drops below MIN_BANK_BALANCE. */
const BANK_FLOAT = 5_000_000;
const MIN_BANK_BALANCE = 2_000_000;

const h = (text: string) => ethers.keccak256(ethers.toUtf8Bytes(text));
const roleHash = (name: string) => h(name);
const tonnes = (t: number) => BigInt(Math.round(t * 1000));
const sgd = (n: number) => ethers.parseEther(String(n));

/** EIP-712 types for the signed oracle submissions (must match DeliveryRecord and QualityRecord). */
const METER_TYPES = {
  MeterReading: [
    { name: "id", type: "uint256" },
    { name: "qtyKg", type: "uint256" },
    { name: "ticketHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};
const EBDN_TYPES = {
  EBDN: [
    { name: "id", type: "uint256" },
    { name: "qtyKg", type: "uint256" },
    { name: "ebdnHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};
const LAB_TYPES = {
  LabResult: [
    { name: "id", type: "uint256" },
    { name: "passed", type: "bool" },
    { name: "reportHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

/** Formats an 18-decimal mSGD amount with thousands separators and 2 decimals, rounding half up. */
function fmt(value: bigint): string {
  const cents = (value + 5n * 10n ** 15n) / 10n ** 16n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Extracts a custom error name and args from an ethers v6 call failure, or null if it is not a known error. */
function decodeRevert(err: any, iface: Interface): { name: string; args: unknown[] } | null {
  if (err?.revert?.name) return { name: err.revert.name, args: [...err.revert.args] };
  // Hardhat's provider nests the revert bytes as err.data.data; ethers may use err.data or err.info.error.data.
  const candidates = [err?.data, err?.data?.data, err?.info?.error?.data, err?.error?.data];
  const data = candidates.find((c): c is string => typeof c === "string" && c.startsWith("0x"));
  if (!data) return null;
  try {
    const parsed = iface.parseError(data);
    return parsed ? { name: parsed.name, args: [...parsed.args] } : null;
  } catch {
    return null;
  }
}

const failures: string[] = [];
const summary: { scenario: string; orderId: bigint }[] = [];

async function main() {
  const dep = readDeployments();
  const addr = (name: string) => {
    const c = dep.contracts[name];
    if (!c) throw new Error(`deployments.json has no ${name}. Run "npm run deploy" first.`);
    return c.address;
  };
  const abi = (name: string) => dep.contracts[name].abi as InterfaceAbi;

  const [admin, bank, buyer, supplier, meterOracle, ebdnOracle, lab, arbiter, outsider] =
    await ethers.getSigners();

  const registry = new ethers.Contract(
    addr("ParticipantRegistry"),
    abi("ParticipantRegistry"),
    admin,
  ) as unknown as ParticipantRegistry;
  const token = new ethers.Contract(addr("MockSGD"), abi("MockSGD"), admin) as unknown as MockSGD;
  const escrow = new ethers.Contract(addr("PaymentEscrow"), abi("PaymentEscrow"), admin) as unknown as PaymentEscrow;
  const order = new ethers.Contract(addr("BunkerOrder"), abi("BunkerOrder"), admin) as unknown as BunkerOrder;
  const delivery = new ethers.Contract(addr("DeliveryRecord"), abi("DeliveryRecord"), admin) as unknown as DeliveryRecord;
  const quality = new ethers.Contract(addr("QualityRecord"), abi("QualityRecord"), admin) as unknown as QualityRecord;
  const dispute = new ethers.Contract(addr("DisputeManager"), abi("DisputeManager"), admin) as unknown as DisputeManager;
  const deliveryIface: Interface = delivery.interface;

  // Preflight: the seeded participants must hold their SPEC 9 roles.
  const expectedRoles: [string, string][] = [
    ["ADMIN", admin.address],
    ["BANK", bank.address],
    ["BUYER", buyer.address],
    ["SUPPLIER", supplier.address],
    ["METER_ORACLE", meterOracle.address],
    ["EBDN_ORACLE", ebdnOracle.address],
    ["LAB", lab.address],
    ["ARBITER", arbiter.address],
  ];
  for (const [role, account] of expectedRoles) {
    if (!(await registry.hasActiveRole(roleHash(role), account))) {
      throw new Error(`${account} does not hold ${role}. Run "npm run deploy" to seed the chain.`);
    }
  }

  // Keep the bank funded for repeated runs: each full run consumes roughly 1.8M mSGD.
  const bankBefore = await token.balanceOf(bank.address);
  if (bankBefore < ethers.parseEther(String(MIN_BANK_BALANCE))) {
    const amount = ethers.parseEther(String(BANK_FLOAT)) - bankBefore;
    await (await token.connect(admin).mint(bank.address, amount)).wait();
    console.log(`Topped up bank float by ${fmt(amount)} mSGD (was ${fmt(bankBefore)}).\n`);
  }

  const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;

  /** Short label for an address: "#n" for the demo accounts, the address otherwise. */
  const acct = (address: string) => {
    const i = [admin, bank, buyer, supplier, meterOracle, ebdnOracle, lab, arbiter, outsider].findIndex(
      (s) => s.address === address,
    );
    return i >= 0 ? `#${i}` : address;
  };

  /** EIP-712 domain of a SignedRoleGuard contract, read from its EIP-5267 eip712Domain(). */
  async function signingDomain(contract: DeliveryRecord | QualityRecord) {
    const d = await contract.eip712Domain();
    return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
  }

  /** Prints one compact line and checks the order status against the expected one. */
  async function snapshot(label: string, id: bigint, expected: string) {
    const o = await order.getOrder(id);
    const status = STATUS[Number(o.status)];
    const bankBal = await token.balanceOf(bank.address);
    const supplierBal = await token.balanceOf(supplier.address);
    const escrowBal = await escrow.balanceOf(id);
    console.log(
      `  ${label.padEnd(26)} order #${id}  ${status.padEnd(17)} bank ${fmt(bankBal).padStart(14)}  supplier ${fmt(supplierBal).padStart(14)}  escrow ${fmt(escrowBal).padStart(12)}`,
    );
    if (status !== expected) {
      const msg = `${label}: order #${id} expected ${expected}, got ${status}`;
      failures.push(msg);
      console.log(`    UNEXPECTED: ${msg}`);
    }
    return o;
  }

  /** Prints the dispute reason for an order and checks it. */
  async function checkDispute(label: string, id: bigint, expectedReason: string) {
    const o = await order.getOrder(id);
    const d = await dispute.getDispute(o.disputeId);
    const reason = REASONS[Number(d.reason)];
    console.log(`  ${label.padEnd(26)} dispute #${o.disputeId} reason ${reason}`);
    if (reason !== expectedReason) {
      const msg = `${label}: dispute reason expected ${expectedReason}, got ${reason}`;
      failures.push(msg);
      console.log(`    UNEXPECTED: ${msg}`);
    }
  }

  /** Creates a SPEC 9 order (500 t VLSFO @ 980 mSGD/t) at `anchorage`, with a deadline 7 days from chain time. */
  async function createOrder(label: string, anchorage: number): Promise<bigint> {
    const deadline = (await now()) + 7 * DAY;
    await (
      await order
        .connect(buyer)
        .createOrder({
          supplier: supplier.address,
          bank: bank.address,
          fuelGrade: "VLSFO",
          qtyKg: tonnes(500),
          pricePerTonne: sgd(PRICE),
          toleranceBps: TOL,
          retentionBps: RET,
          deliveryDeadline: deadline,
          retentionWindow: WINDOW,
          dscHash: h("DSC-DEMO"),
          anchorage,
        })
    ).wait();
    const id: bigint = await order.orderCount();
    await snapshot(`${label}: create`, id, "Created");
    return id;
  }

  async function acceptAndFund(label: string, id: bigint) {
    await (await order.connect(supplier).acceptOrder(id)).wait();
    await snapshot(`${label}: accept`, id, "Accepted");
    await (await order.connect(bank).fundOrder(id)).wait();
    await snapshot(`${label}: fund`, id, "Funded");
  }

  /** Runs one scenario; an unexpected exception is recorded as a failure so the rest still run. */
  async function runScenario(name: string, body: () => Promise<void>) {
    console.log(`\n=== ${name} ===`);
    try {
      await body();
    } catch (err) {
      const msg = `${name}: ${(err as Error).message}`;
      failures.push(msg);
      console.log(`  UNEXPECTED ERROR: ${msg}`);
    }
  }

  // Shared between scenario 2/3 and scenario 5.
  let shortOrder = 0n;
  let contaminatedOrder = 0n;

  await runScenario("Scenario 1: normal delivery", async () => {
    const id = await createOrder("S1", ANCHORAGE.EASTERN_PETROLEUM_B);
    summary.push({ scenario: "1 Normal", orderId: id });
    await acceptAndFund("S1", id);
    await (await delivery.connect(meterOracle).submitMeterReading(id, tonnes(500.2), h("BMT-001"))).wait();
    await snapshot("S1: meter 500.2 t", id, "Funded");
    await (await delivery.connect(ebdnOracle).submitEBDN(id, tonnes(500), h("BDN-001"))).wait();
    await snapshot("S1: eBDN 500.0 t (90%)", id, "QuantityApproved");
    await (await quality.connect(lab).submitLabResult(id, true, h("QTR-001"))).wait();
    await snapshot("S1: lab pass", id, "Settled");
  });

  await runScenario("Scenario 2: short delivery", async () => {
    shortOrder = await createOrder("S2", ANCHORAGE.WESTERN_PETROLEUM_A);
    summary.push({ scenario: "2 Short delivery", orderId: shortOrder });
    await acceptAndFund("S2", shortOrder);
    await (await delivery.connect(meterOracle).submitMeterReading(shortOrder, tonnes(480), h("BMT-002"))).wait();
    await (await delivery.connect(ebdnOracle).submitEBDN(shortOrder, tonnes(480), h("BDN-002"))).wait();
    await snapshot("S2: meter+eBDN 480 t", shortOrder, "Disputed");
    await checkDispute("S2: dispute", shortOrder, "OUT_OF_TOLERANCE");
  });

  await runScenario("Scenario 3: contaminated fuel", async () => {
    contaminatedOrder = await createOrder("S3", ANCHORAGE.EASTERN_PETROLEUM_A);
    summary.push({ scenario: "3 Contaminated fuel", orderId: contaminatedOrder });
    await acceptAndFund("S3", contaminatedOrder);
    await (await delivery.connect(meterOracle).submitMeterReading(contaminatedOrder, tonnes(500.2), h("BMT-003"))).wait();
    await (await delivery.connect(ebdnOracle).submitEBDN(contaminatedOrder, tonnes(500), h("BDN-003"))).wait();
    await snapshot("S3: normal delivery", contaminatedOrder, "QuantityApproved");
    await (await quality.connect(lab).submitLabResult(contaminatedOrder, false, h("QTR-003"))).wait();
    await snapshot("S3: lab fail", contaminatedOrder, "Disputed");
    await checkDispute("S3: dispute", contaminatedOrder, "QUALITY_FAIL");
  });

  await runScenario("Scenario 4: outsider", async () => {
    const id = await createOrder("S4", ANCHORAGE.WESTERN_PETROLEUM_B);
    summary.push({ scenario: "4 Outsider attempt", orderId: id });
    await acceptAndFund("S4", id);
    try {
      await (await delivery.connect(outsider).submitMeterReading(id, tonnes(500.2), h("BMT-X"))).wait();
      const msg = `S4: outsider meter submission succeeded`;
      failures.push(msg);
      console.log(`  UNEXPECTED: ${msg}`);
    } catch (err) {
      const decoded = decodeRevert(err, deliveryIface);
      if (decoded?.name === "NotAuthorized") {
        const [role, account] = decoded.args as [string, string];
        const roleName = ROLE_NAMES.find((r) => roleHash(r) === role) ?? role;
        console.log(`  outsider #8 meter submit -> NotAuthorized(${roleName}, ${account})`);
      } else {
        const msg = `S4: expected NotAuthorized, got ${decoded?.name ?? (err as Error).message}`;
        failures.push(msg);
        console.log(`  UNEXPECTED: ${msg}`);
      }
    }
    await snapshot("S4: after outsider", id, "Funded");
  });

  await runScenario("Scenario 5: arbiter resolution", async () => {
    for (const [label, id] of [
      ["S5: resolve S2 70/30", shortOrder],
      ["S5: resolve S3 70/30", contaminatedOrder],
    ] as const) {
      const disputeId = (await order.getOrder(id)).disputeId;
      await (await dispute.connect(arbiter).resolve(disputeId, SHARE_SUPPLIER_BPS)).wait();
      await snapshot(label, id, "Resolved");
    }
  });

  await runScenario("Scenario 6: signed oracle submissions (EIP-712)", async () => {
    const bank0 = await token.balanceOf(bank.address);
    const supplier0 = await token.balanceOf(supplier.address);
    const id = await createOrder("S6", ANCHORAGE.EASTERN_PETROLEUM_B);
    summary.push({ scenario: "6 Signed (EIP-712)", orderId: id });
    await acceptAndFund("S6", id);

    // The oracles sign off-chain; the unregistered outsider (#8) relays. The contract checks the signer's role.
    const deliveryDomain = await signingDomain(delivery);
    const qualityDomain = await signingDomain(quality);
    const deadline = (await now()) + 900;
    const meterQty = tonnes(500.2);
    const meterTicket = h("BMT-006");

    // Failing relay: #8 signs a meter reading itself. The recovered signer lacks METER_ORACLE.
    const badSig = await outsider.signTypedData(deliveryDomain, METER_TYPES, {
      id,
      qtyKg: meterQty,
      ticketHash: meterTicket,
      deadline,
    });
    try {
      await (
        await delivery.connect(outsider).submitMeterReadingBySig(id, meterQty, meterTicket, deadline, badSig)
      ).wait();
      const msg = `S6: non-oracle signature was accepted`;
      failures.push(msg);
      console.log(`  UNEXPECTED: ${msg}`);
    } catch (err) {
      const decoded = decodeRevert(err, deliveryIface);
      if (decoded?.name === "NotAuthorized") {
        const [role, account] = decoded.args as [string, string];
        const roleName = ROLE_NAMES.find((r) => roleHash(r) === role) ?? role;
        console.log(`  #8 signs meter as #8, relays -> NotAuthorized(${roleName}, ${account})`);
      } else {
        const msg = `S6: expected NotAuthorized, got ${decoded?.name ?? (err as Error).message}`;
        failures.push(msg);
        console.log(`  UNEXPECTED: ${msg}`);
      }
    }
    await snapshot("S6: after bad signature", id, "Funded");

    // Happy path: each oracle signs its payload, #8 relays it.
    const meterSig = await meterOracle.signTypedData(deliveryDomain, METER_TYPES, {
      id,
      qtyKg: meterQty,
      ticketHash: meterTicket,
      deadline,
    });
    await (
      await delivery.connect(outsider).submitMeterReadingBySig(id, meterQty, meterTicket, deadline, meterSig)
    ).wait();
    await snapshot("S6: meter 500.2 t (#4 signed)", id, "Funded");

    const ebdnQty = tonnes(500);
    const ebdnHash = h("BDN-006");
    const ebdnSig = await ebdnOracle.signTypedData(deliveryDomain, EBDN_TYPES, {
      id,
      qtyKg: ebdnQty,
      ebdnHash,
      deadline,
    });
    await (await delivery.connect(outsider).submitEBDNBySig(id, ebdnQty, ebdnHash, deadline, ebdnSig)).wait();
    await snapshot("S6: eBDN 500.0 t (#5 signed)", id, "QuantityApproved");

    const labHash = h("QTR-006");
    const labSig = await lab.signTypedData(qualityDomain, LAB_TYPES, {
      id,
      passed: true,
      reportHash: labHash,
      deadline,
    });
    await (await quality.connect(outsider).submitLabResultBySig(id, true, labHash, deadline, labSig)).wait();
    await snapshot("S6: lab pass (#6 signed)", id, "Settled");

    // The events record the recovered signer, not the relayer.
    const checks: [string, string, string, string][] = [];
    const meterLogs = await delivery.queryFilter(delivery.filters.MeterReadingSubmitted(id));
    const ebdnLogs = await delivery.queryFilter(delivery.filters.EBDNSubmitted(id));
    const labLogs = await quality.queryFilter(quality.filters.LabResultSubmitted(id));
    checks.push(["meter", "oracle", acct(meterLogs[meterLogs.length - 1]?.args.oracle ?? ""), acct(meterOracle.address)]);
    checks.push(["e-BDN", "oracle", acct(ebdnLogs[ebdnLogs.length - 1]?.args.oracle ?? ""), acct(ebdnOracle.address)]);
    checks.push(["lab", "lab", acct(labLogs[labLogs.length - 1]?.args.lab ?? ""), acct(lab.address)]);
    for (const [what, field, recorded, expected] of checks) {
      console.log(`  S6: ${what.padEnd(8)} event ${field} ${recorded}`);
      if (recorded !== expected) {
        const msg = `S6: ${what} event ${field} expected ${expected}, got ${recorded}`;
        failures.push(msg);
        console.log(`    UNEXPECTED: ${msg}`);
      }
    }

    // Same order terms and same quantities as scenario 1, so the payouts must match scenario 1's.
    const s1 = summary.find((r) => r.scenario === "1 Normal");
    if (s1) {
      const paid = (await order.getOrder(s1.orderId)).releasedAmount;
      const bankDelta = bank0 - (await token.balanceOf(bank.address));
      const supplierDelta = (await token.balanceOf(supplier.address)) - supplier0;
      const matches = bankDelta === paid && supplierDelta === paid;
      console.log(
        `  S6 payout ${fmt(supplierDelta)} to supplier, ${fmt(bankDelta)} from bank; S1 paid ${fmt(paid)} -> ${matches ? "match" : "MISMATCH"}`,
      );
      if (!matches) {
        const msg = `S6: payout does not match scenario 1 (${fmt(paid)})`;
        failures.push(msg);
        console.log(`    UNEXPECTED: ${msg}`);
      }
    }
  });

  console.log("\n=== Summary ===");
  console.log(`  ${"Order".padEnd(8)}${"Scenario".padEnd(24)}${"Final status"}`);
  for (const row of summary) {
    const o = await order.getOrder(row.orderId);
    console.log(`  ${`#${row.orderId}`.padEnd(8)}${row.scenario.padEnd(24)}${STATUS[Number(o.status)]}`);
  }

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll scenarios reached their expected statuses.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
