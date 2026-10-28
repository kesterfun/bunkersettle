import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFixture, sgd, tonnes, DAY, ANCHORAGE, type Fixture } from "./helpers/fixtures";

/** Order status values (BunkerTypes.Status). */
const S = {
  Created: 0n,
  Accepted: 1n,
  Funded: 2n,
  QuantityApproved: 3n,
  Settled: 4n,
  Disputed: 5n,
  Resolved: 6n,
  Cancelled: 7n,
};

/** DisputeReason values (BunkerTypes.DisputeReason). */
const REASON = { OUT_OF_TOLERANCE: 0n, QUALITY_FAIL: 2n };

const TOL = 50;
const RET = 1000;
const WINDOW = 120;
const TOTAL = sgd(100_000_000);
const DSC = ethers.keccak256(ethers.toUtf8Bytes("DSC"));
const h = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

/** SPEC 4 / 5.2 math, mirrored exactly as the contract computes it. */
const fundedOf = (qtyKg: bigint, price: bigint, tol: number) =>
  ((qtyKg * price) / 1000n) * (10_000n + BigInt(tol)) / 10_000n;
const payableOf = (deliveredKg: bigint, price: bigint) => (deliveredKg * price) / 1000n;
const upfrontOf = (payable: bigint, ret: number) => (payable * (10_000n - BigInt(ret))) / 10_000n;

type Expected = {
  bank: bigint;
  supplier: bigint;
  escrow: bigint;
  escrowOf: bigint;
  held: bigint;
  status: bigint;
};

/** Asserts every balance and the order state, and that total supply is conserved. */
async function expectBalances(f: Fixture, id: bigint, exp: Expected) {
  const escrowAddr = await f.escrow.getAddress();
  const bank = await f.token.balanceOf(f.bank.address);
  const buyer = await f.token.balanceOf(f.buyer.address);
  const supplier = await f.token.balanceOf(f.supplier.address);
  const escrow = await f.token.balanceOf(escrowAddr);

  expect(bank, "bank").to.equal(exp.bank);
  expect(buyer, "buyer").to.equal(0n);
  expect(supplier, "supplier").to.equal(exp.supplier);
  expect(escrow, "escrow token balance").to.equal(exp.escrow);
  expect(await f.escrow.balanceOf(id), "escrow balanceOf(id)").to.equal(exp.escrowOf);
  expect(await f.order.heldAmount(id), "heldAmount(id)").to.equal(exp.held);
  expect((await f.order.getOrder(id)).status, "status").to.equal(exp.status);
  expect(bank + buyer + supplier + escrow, "supply conservation").to.equal(TOTAL);
}

/** Creates an order as the buyer and returns its id. */
async function createOrderFor(
  f: Fixture,
  qtyKg: bigint,
  price: bigint,
  deadline?: number,
): Promise<bigint> {
  const dl = deadline ?? (await time.latest()) + 7 * DAY;
  await f.order
    .connect(f.buyer)
    .createOrder({
      supplier: f.supplier.address,
      bank: f.bank.address,
      fuelGrade: "VLSFO",
      qtyKg: qtyKg,
      pricePerTonne: price,
      toleranceBps: TOL,
      retentionBps: RET,
      deliveryDeadline: dl,
      retentionWindow: WINDOW,
      dscHash: DSC,
      anchorage: ANCHORAGE.EASTERN_PETROLEUM_B,
    });
  return await f.order.orderCount();
}

describe("e2e flows (milestone 3)", () => {
  it("sanity: SPEC 9 scenario 1 math gives the expected SGD amounts", async () => {
    const funded = fundedOf(tonnes(500), sgd(980), TOL);
    const payable = payableOf(tonnes(500.2), sgd(980));
    expect(funded).to.equal(sgd("492450"));
    expect(payable).to.equal(sgd("490196"));
    expect(upfrontOf(payable, RET)).to.equal(sgd("441176.4"));
  });

  it("full flow: create -> accept -> fund -> meter + eBDN -> 90% -> lab pass -> Settled", async () => {
    const f = await loadFixture(deployFixture);
    const qty = tonnes(500);
    const price = sgd(980);
    const funded = fundedOf(qty, price, TOL);
    const deliveredKg = tonnes(500.2);
    const payable = payableOf(deliveredKg, price);
    const upfront = upfrontOf(payable, RET);
    const excess = funded - payable;

    const deadline = (await time.latest()) + 7 * DAY;
    await f.order
      .connect(f.buyer)
      .createOrder({
        supplier: f.supplier.address,
        bank: f.bank.address,
        fuelGrade: "VLSFO",
        qtyKg: qty,
        pricePerTonne: price,
        toleranceBps: TOL,
        retentionBps: RET,
        deliveryDeadline: deadline,
        retentionWindow: WINDOW,
        dscHash: DSC,
        anchorage: ANCHORAGE.EASTERN_PETROLEUM_B,
      });
    const id = 1n;
    await expectBalances(f, id, {
      bank: TOTAL,
      supplier: 0n,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Created,
    });

    await f.order.connect(f.supplier).acceptOrder(id);
    await expectBalances(f, id, {
      bank: TOTAL,
      supplier: 0n,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Accepted,
    });

    await f.order.connect(f.bank).fundOrder(id);
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: 0n,
      escrow: funded,
      escrowOf: funded,
      held: funded,
      status: S.Funded,
    });

    await f.delivery.connect(f.meterOracle).submitMeterReading(id, deliveredKg, h("BMT-1"));
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: 0n,
      escrow: funded,
      escrowOf: funded,
      held: funded,
      status: S.Funded,
    });

    await f.delivery.connect(f.ebdnOracle).submitEBDN(id, tonnes(500), h("BDN-1"));
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: upfront,
      escrow: funded - upfront,
      escrowOf: funded - upfront,
      held: funded - upfront,
      status: S.QuantityApproved,
    });

    await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR-1"));
    await expectBalances(f, id, {
      bank: TOTAL - payable,
      supplier: payable,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Settled,
    });
    expect(excess).to.equal(sgd("2254"));
  });

  it("timeout flow: lab silent, releaseAfterTimeout after the window -> same final balances", async () => {
    const f = await loadFixture(deployFixture);
    const qty = tonnes(500);
    const price = sgd(980);
    const funded = fundedOf(qty, price, TOL);
    const deliveredKg = tonnes(500.2);
    const payable = payableOf(deliveredKg, price);
    const upfront = upfrontOf(payable, RET);

    const id = await createOrderFor(f, qty, price);
    await f.order.connect(f.supplier).acceptOrder(id);
    await f.order.connect(f.bank).fundOrder(id);
    await f.delivery.connect(f.meterOracle).submitMeterReading(id, deliveredKg, h("BMT-1"));
    await f.delivery.connect(f.ebdnOracle).submitEBDN(id, tonnes(500), h("BDN-1"));
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: upfront,
      escrow: funded - upfront,
      escrowOf: funded - upfront,
      held: funded - upfront,
      status: S.QuantityApproved,
    });

    const approvedAt = (await f.order.getOrder(id)).approvedAt;
    await expect(f.order.connect(f.buyer).releaseAfterTimeout(id))
      .to.be.revertedWithCustomError(f.order, "RetentionWindowOpen")
      .withArgs(id, approvedAt + BigInt(WINDOW));
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: upfront,
      escrow: funded - upfront,
      escrowOf: funded - upfront,
      held: funded - upfront,
      status: S.QuantityApproved,
    });

    await time.increase(121);
    await f.order.connect(f.buyer).releaseAfterTimeout(id);
    await expectBalances(f, id, {
      bank: TOTAL - payable,
      supplier: payable,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Settled,
    });
  });

  it("short delivery: meter 480 t -> OUT_OF_TOLERANCE -> arbiter 70/30 -> Resolved", async () => {
    const f = await loadFixture(deployFixture);
    const qty = tonnes(500);
    const price = sgd(980);
    const funded = fundedOf(qty, price, TOL);

    const id = await createOrderFor(f, qty, price);
    await f.order.connect(f.supplier).acceptOrder(id);
    await f.order.connect(f.bank).fundOrder(id);
    await f.delivery.connect(f.meterOracle).submitMeterReading(id, tonnes(480), h("BMT-2"));
    await f.delivery.connect(f.ebdnOracle).submitEBDN(id, tonnes(480), h("BDN-2"));

    expect((await f.dispute.getDispute(1)).reason).to.equal(REASON.OUT_OF_TOLERANCE);
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: 0n,
      escrow: funded,
      escrowOf: funded,
      held: funded,
      status: S.Disputed,
    });

    await f.dispute.connect(f.arbiter).resolve(1, 7000);
    const supplierAmt = (funded * 7000n) / 10_000n;
    const bankAmt = funded - supplierAmt;
    expect(supplierAmt).to.equal(sgd("344715"));
    await expectBalances(f, id, {
      bank: TOTAL - supplierAmt,
      supplier: supplierAmt,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Resolved,
    });
    expect(bankAmt).to.equal(sgd("147735"));
  });

  it("contaminated fuel: lab fail -> QUALITY_FAIL, retention held -> arbiter 70/30 -> Resolved", async () => {
    const f = await loadFixture(deployFixture);
    const qty = tonnes(500);
    const price = sgd(980);
    const funded = fundedOf(qty, price, TOL);
    const payable = payableOf(qty, price);
    const upfront = upfrontOf(payable, RET);
    const held = funded - upfront;

    const id = await createOrderFor(f, qty, price);
    await f.order.connect(f.supplier).acceptOrder(id);
    await f.order.connect(f.bank).fundOrder(id);
    await f.delivery.connect(f.meterOracle).submitMeterReading(id, qty, h("BMT-3"));
    await f.delivery.connect(f.ebdnOracle).submitEBDN(id, qty, h("BDN-3"));
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: upfront,
      escrow: held,
      escrowOf: held,
      held,
      status: S.QuantityApproved,
    });

    await f.quality.connect(f.lab).submitLabResult(id, false, h("QTR-3"));
    expect((await f.dispute.getDispute(1)).reason).to.equal(REASON.QUALITY_FAIL);
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: upfront,
      escrow: held,
      escrowOf: held,
      held,
      status: S.Disputed,
    });

    await f.dispute.connect(f.arbiter).resolve(1, 7000);
    const supplierAmt = (held * 7000n) / 10_000n;
    await expectBalances(f, id, {
      bank: TOTAL - upfront - supplierAmt,
      supplier: upfront + supplierAmt,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Resolved,
    });
  });

  it("outsider meter submission reverts NotAuthorized and leaves the order unaffected", async () => {
    const f = await loadFixture(deployFixture);
    const qty = tonnes(500);
    const price = sgd(980);
    const funded = fundedOf(qty, price, TOL);
    const deliveredKg = tonnes(500.2);
    const payable = payableOf(deliveredKg, price);
    const upfront = upfrontOf(payable, RET);

    const id = await createOrderFor(f, qty, price);
    await f.order.connect(f.supplier).acceptOrder(id);
    await f.order.connect(f.bank).fundOrder(id);

    const before: Expected = {
      bank: TOTAL - funded,
      supplier: 0n,
      escrow: funded,
      escrowOf: funded,
      held: funded,
      status: S.Funded,
    };
    await expect(f.delivery.connect(f.outsider).submitMeterReading(id, deliveredKg, h("BMT-X")))
      .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
      .withArgs(f.roles.METER_ORACLE, f.outsider.address);
    await expectBalances(f, id, before);

    // The failed call must not consume the one-time meter slot.
    await f.delivery.connect(f.meterOracle).submitMeterReading(id, deliveredKg, h("BMT-1"));
    await f.delivery.connect(f.ebdnOracle).submitEBDN(id, tonnes(500), h("BDN-1"));
    await expectBalances(f, id, {
      bank: TOTAL - funded,
      supplier: upfront,
      escrow: funded - upfront,
      escrowOf: funded - upfront,
      held: funded - upfront,
      status: S.QuantityApproved,
    });
    await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR-1"));
    await expectBalances(f, id, {
      bank: TOTAL - payable,
      supplier: payable,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Settled,
    });
  });

  it("two concurrent orders settle independently with no escrow leakage", async () => {
    const f = await loadFixture(deployFixture);

    // Order A: 500 t @ 980; delivered 500.2 t, eBDN 500.0 t.
    const qtyA = tonnes(500);
    const priceA = sgd(980);
    const fA = fundedOf(qtyA, priceA, TOL);
    const deliveredA = tonnes(500.2);
    const payA = payableOf(deliveredA, priceA);
    const upA = upfrontOf(payA, RET);

    // Order B: 200 t @ 1000; delivered 199.9 t, eBDN 200.0 t.
    const qtyB = tonnes(200);
    const priceB = sgd(1000);
    const fB = fundedOf(qtyB, priceB, TOL);
    const deliveredB = tonnes(199.9);
    const payB = payableOf(deliveredB, priceB);
    const upB = upfrontOf(payB, RET);

    const idA = await createOrderFor(f, qtyA, priceA);
    const idB = await createOrderFor(f, qtyB, priceB);
    await f.order.connect(f.supplier).acceptOrder(idA);
    await f.order.connect(f.supplier).acceptOrder(idB);
    await f.order.connect(f.bank).fundOrder(idA);
    await f.order.connect(f.bank).fundOrder(idB);

    const aFunded = { escrowOf: fA, held: fA, status: S.Funded };
    await expectBalances(f, idA, { bank: TOTAL - fA - fB, supplier: 0n, escrow: fA + fB, ...aFunded });
    await expectBalances(f, idB, { bank: TOTAL - fA - fB, supplier: 0n, escrow: fA + fB, escrowOf: fB, held: fB, status: S.Funded });

    // B's eBDN first, then B's meter triggers B's first tranche.
    await f.delivery.connect(f.ebdnOracle).submitEBDN(idB, tonnes(200), h("BDN-B"));
    await expectBalances(f, idB, { bank: TOTAL - fA - fB, supplier: 0n, escrow: fA + fB, escrowOf: fB, held: fB, status: S.Funded });
    await f.delivery.connect(f.meterOracle).submitMeterReading(idB, deliveredB, h("BMT-B"));
    await expectBalances(f, idB, {
      bank: TOTAL - fA - fB,
      supplier: upB,
      escrow: fA + fB - upB,
      escrowOf: fB - upB,
      held: fB - upB,
      status: S.QuantityApproved,
    });
    // A untouched by B's delivery.
    await expectBalances(f, idA, { bank: TOTAL - fA - fB, supplier: upB, escrow: fA + fB - upB, ...aFunded });

    // A's meter first, then A's eBDN triggers A's first tranche.
    await f.delivery.connect(f.meterOracle).submitMeterReading(idA, deliveredA, h("BMT-A"));
    await expectBalances(f, idA, { bank: TOTAL - fA - fB, supplier: upB, escrow: fA + fB - upB, ...aFunded });
    await f.delivery.connect(f.ebdnOracle).submitEBDN(idA, tonnes(500), h("BDN-A"));
    await expectBalances(f, idA, {
      bank: TOTAL - fA - fB,
      supplier: upA + upB,
      escrow: fA + fB - upA - upB,
      escrowOf: fA - upA,
      held: fA - upA,
      status: S.QuantityApproved,
    });
    await expectBalances(f, idB, {
      bank: TOTAL - fA - fB,
      supplier: upA + upB,
      escrow: fA + fB - upA - upB,
      escrowOf: fB - upB,
      held: fB - upB,
      status: S.QuantityApproved,
    });

    // Settle B first: retention and excess for B only.
    await f.quality.connect(f.lab).submitLabResult(idB, true, h("QTR-B"));
    const bankAfterB = TOTAL - fA - fB + (fB - payB);
    await expectBalances(f, idB, {
      bank: bankAfterB,
      supplier: upA + payB,
      escrow: fA - upA,
      escrowOf: 0n,
      held: 0n,
      status: S.Settled,
    });
    await expectBalances(f, idA, {
      bank: bankAfterB,
      supplier: upA + payB,
      escrow: fA - upA,
      escrowOf: fA - upA,
      held: fA - upA,
      status: S.QuantityApproved,
    });

    // Then settle A.
    await f.quality.connect(f.lab).submitLabResult(idA, true, h("QTR-A"));
    const bankFinal = TOTAL - payA - payB;
    await expectBalances(f, idA, {
      bank: bankFinal,
      supplier: payA + payB,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Settled,
    });
    await expectBalances(f, idB, {
      bank: bankFinal,
      supplier: payA + payB,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Settled,
    });
  });

  it("cancel before funding moves no tokens; cancelExpired refunds the bank in full", async () => {
    const f = await loadFixture(deployFixture);
    const qty = tonnes(500);
    const price = sgd(980);

    // Cancel from Created.
    const idCreated = await createOrderFor(f, qty, price);
    await f.order.connect(f.buyer).cancelOrder(idCreated);
    await expectBalances(f, idCreated, {
      bank: TOTAL,
      supplier: 0n,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Cancelled,
    });

    // Cancel from Accepted.
    const idAccepted = await createOrderFor(f, qty, price);
    await f.order.connect(f.supplier).acceptOrder(idAccepted);
    await f.order.connect(f.buyer).cancelOrder(idAccepted);
    await expectBalances(f, idAccepted, {
      bank: TOTAL,
      supplier: 0n,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Cancelled,
    });

    // Funded order with no delivery: cancelExpired after the deadline refunds everything.
    const deadline = (await time.latest()) + DAY;
    const idExpired = await createOrderFor(f, qty, price, deadline);
    await f.order.connect(f.supplier).acceptOrder(idExpired);
    await f.order.connect(f.bank).fundOrder(idExpired);
    const funded = fundedOf(qty, price, TOL);
    await expectBalances(f, idExpired, {
      bank: TOTAL - funded,
      supplier: 0n,
      escrow: funded,
      escrowOf: funded,
      held: funded,
      status: S.Funded,
    });

    await expect(f.order.connect(f.outsider).cancelExpired(idExpired))
      .to.be.revertedWithCustomError(f.order, "DeadlineNotReached")
      .withArgs(idExpired);

    await time.increase(DAY + 1);
    await f.order.connect(f.outsider).cancelExpired(idExpired);
    await expectBalances(f, idExpired, {
      bank: TOTAL,
      supplier: 0n,
      escrow: 0n,
      escrowOf: 0n,
      held: 0n,
      status: S.Cancelled,
    });
  });
});
