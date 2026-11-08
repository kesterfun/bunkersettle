import { ethers } from "hardhat";
import type { InterfaceAbi } from "ethers";
import type { BunkerOrder, DeliveryRecord, DisputeManager, QualityRecord } from "../typechain-types";
import { readDeployments } from "./lib/deployments";

/**
 * Stages orders for the live demo on a freshly deployed chain (run after `npm run deploy`).
 *
 * History (finished, so the supplier's track record has data): three settled orders and one
 * resolved after a failed lab test. Then one order per demo run, stopped just before the step
 * the presenter performs live:
 *   Run A  Funded            supplier offers the claim, financier buys, oracles, lab pass
 *   Run B  Funded            meter + e-BDN submit 480 t, dispute, arbiter resolves
 *   Run C  QuantityApproved  lab submits a fail, QUALITY_FAIL dispute
 */

const STATUS = ["Created", "Accepted", "Funded", "QuantityApproved", "Settled", "Disputed", "Resolved", "Cancelled"];
const ANCHORAGE = { WESTERN_PETROLEUM_A: 0, WESTERN_PETROLEUM_B: 1, EASTERN_PETROLEUM_A: 2, EASTERN_PETROLEUM_B: 3 };
const ANCHORAGE_NAME = ["Western Petroleum A", "Western Petroleum B", "Eastern Petroleum A", "Eastern Petroleum B"];
const DAY = 24 * 60 * 60;

const h = (text: string) => ethers.keccak256(ethers.toUtf8Bytes(text));
const tonnes = (t: number) => BigInt(Math.round(t * 1000));

async function main() {
  const dep = readDeployments();
  const contract = <T>(name: string) => {
    const c = dep.contracts[name];
    if (!c) throw new Error(`deployments.json has no ${name}. Run "npm run besu:up" then "npm run deploy" first.`);
    return new ethers.Contract(c.address, c.abi as InterfaceAbi, ethers.provider) as unknown as T;
  };
  const order = contract<BunkerOrder>("BunkerOrder");
  const delivery = contract<DeliveryRecord>("DeliveryRecord");
  const quality = contract<QualityRecord>("QualityRecord");
  const dispute = contract<DisputeManager>("DisputeManager");

  const [, bank, buyer, supplier, meterOracle, ebdnOracle, lab, arbiter] = await ethers.getSigners();

  if ((await order.orderCount()) > 0n) {
    console.log(
      `Note: ${await order.orderCount()} orders already exist. New ones are added after them. ` +
        `For a clean demo, run "npm run deploy" first.\n`,
    );
  }

  const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;

  /** SPEC 9 base order: 500 t VLSFO at 980 mSGD/t, 50 bps tolerance, 10% retention. */
  async function create(label: string, anchorage: number, retentionWindow = 120): Promise<bigint> {
    await (
      await order.connect(buyer).createOrder({
        supplier: supplier.address,
        bank: bank.address,
        fuelGrade: "VLSFO",
        qtyKg: tonnes(500),
        pricePerTonne: ethers.parseEther("980"),
        toleranceBps: 50,
        retentionBps: 1000,
        deliveryDeadline: (await now()) + 7 * DAY,
        retentionWindow,
        dscHash: h(`DSC-${label}`),
        anchorage,
      })
    ).wait();
    const id = await order.orderCount();
    await (await order.connect(supplier).acceptOrder(id)).wait();
    await (await order.connect(bank).fundOrder(id)).wait();
    return id;
  }

  async function deliver(id: bigint, label: string, meterT: number, ebdnT: number) {
    await (await delivery.connect(meterOracle).submitMeterReading(id, tonnes(meterT), h(`BMT-${label}`))).wait();
    await (await delivery.connect(ebdnOracle).submitEBDN(id, tonnes(ebdnT), h(`BDN-${label}`))).wait();
  }

  const rows: { id: bigint; what: string; anchorage: number; next: string }[] = [];
  const note = async (id: bigint, what: string, anchorage: number, next: string) => {
    rows.push({ id, what, anchorage, next });
    const o = await order.getOrder(id);
    console.log(`  order #${id}  ${STATUS[Number(o.status)].padEnd(17)} ${what}`);
  };

  console.log("History (supplier track record):");
  for (const [i, anchorage] of [ANCHORAGE.WESTERN_PETROLEUM_B, ANCHORAGE.EASTERN_PETROLEUM_B, ANCHORAGE.WESTERN_PETROLEUM_A].entries()) {
    const label = `H${i + 1}`;
    const id = await create(label, anchorage);
    await deliver(id, label, 500.1, 500);
    await (await quality.connect(lab).submitLabResult(id, true, h(`QTR-${label}`))).wait();
    await note(id, "past delivery, settled cleanly", anchorage, "-");
  }
  {
    const id = await create("H4", ANCHORAGE.EASTERN_PETROLEUM_A);
    await deliver(id, "H4", 500.1, 500);
    await (await quality.connect(lab).submitLabResult(id, false, h("QTR-H4"))).wait();
    const disputeId = (await order.getOrder(id)).disputeId;
    await (await dispute.connect(arbiter).resolve(disputeId, 5000)).wait();
    await note(id, "past delivery, lab fail, resolved 50/50", ANCHORAGE.EASTERN_PETROLEUM_A, "-");
  }

  console.log("\nStaged for the live demo:");
  {
    const id = await create("A", ANCHORAGE.EASTERN_PETROLEUM_B);
    await note(id, "Run A, financed delivery", ANCHORAGE.EASTERN_PETROLEUM_B,
      "Supplier offers the claim; #8 tries to buy (reverts); Financier buys; meter 500.2 t, e-BDN 500.0 t; lab pass");
  }
  {
    const id = await create("B", ANCHORAGE.WESTERN_PETROLEUM_A);
    await note(id, "Run B, short delivery", ANCHORAGE.WESTERN_PETROLEUM_A,
      "Meter 480 t, e-BDN 480 t; dispute opens; Arbiter resolves 70/30");
  }
  {
    // Long retention window so the order can't be released by timeout before the lab result.
    const id = await create("C", ANCHORAGE.EASTERN_PETROLEUM_A, DAY);
    await deliver(id, "C", 500.2, 500);
    await note(id, "Run C, contaminated fuel", ANCHORAGE.EASTERN_PETROLEUM_A, "Lab submits a fail; QUALITY_FAIL dispute");
  }

  console.log("\nDemo cheat sheet:");
  for (const r of rows.filter((x) => x.next !== "-")) {
    console.log(`  Order #${r.id} (${ANCHORAGE_NAME[r.anchorage]}): ${r.next}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
