import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFixture, sgd, tonnes, DAY, ANCHORAGE } from "./helpers/fixtures";
import type { Fixture } from "./helpers/fixtures";

// Enum values from contracts/interfaces/BunkerTypes.sol
const Status = { Created: 0n, Accepted: 1n, Funded: 2n, QuantityApproved: 3n, Settled: 4n, Disputed: 5n, Resolved: 6n };
const Reason = { OUT_OF_TOLERANCE: 0n, QUALITY_FAIL: 2n, MANUAL: 3n };
const Doc = { BMT: 2n, BDN: 3n, QTR: 4n, NOPV: 6n, NOPB: 7n, SOF: 8n };

const h = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

// SPEC 9 scenario: 500 t VLSFO @ 980 mSGD/t, tolerance 50 bps, retention 1000 bps, window 120 s.
const QTY = tonnes(500);
const PRICE = sgd(980);
const TOL = 50;
const RET = 1000;
const WINDOW = 120;
// fundedAmount = 490,000 * (10000 + 50) / 10000
const FUNDED = sgd(492450);
// First tranche after a within-tolerance delivery = 90% of 490,000
const FIRST_TRANCHE = sgd(441000);

async function createOrderOnly(f: Fixture): Promise<number> {
  const deadline = (await time.latest()) + 7 * DAY;
  await f.order
    .connect(f.buyer)
    .createOrder({
      supplier: f.supplier.address,
      bank: f.bank.address,
      fuelGrade: "VLSFO",
      qtyKg: QTY,
      pricePerTonne: PRICE,
      toleranceBps: TOL,
      retentionBps: RET,
      deliveryDeadline: deadline,
      retentionWindow: WINDOW,
      dscHash: h("DSC-1"),
      anchorage: ANCHORAGE.EASTERN_PETROLEUM_B,
    });
  return deadline;
}

async function createAndFund(f: Fixture): Promise<number> {
  const deadline = await createOrderOnly(f);
  await f.order.connect(f.supplier).acceptOrder(1);
  await f.order.connect(f.bank).fundOrder(1);
  return deadline;
}

async function createdFixture() {
  const f = await deployFixture();
  await createOrderOnly(f);
  return f;
}

async function acceptedFixture() {
  const f = await createdFixture();
  await f.order.connect(f.supplier).acceptOrder(1);
  return f;
}

async function fundedFixture() {
  const f = await deployFixture();
  const deadline = await createAndFund(f);
  return { ...f, deadline };
}

async function qualityApprovedFixture() {
  const f = await fundedFixture();
  await f.delivery.connect(f.meterOracle).submitMeterReading(1, QTY, h("BMT-1"));
  await f.delivery.connect(f.ebdnOracle).submitEBDN(1, QTY, h("BDN-1"));
  return f;
}

async function settledFixture() {
  const f = await qualityApprovedFixture();
  await f.quality.connect(f.lab).submitLabResult(1, true, h("QTR-1"));
  return f;
}

/** Meter and e-BDN both 480 t: they agree, but 480 t is outside 0.5% of 500 t, so dispute 1 opens. */
async function outOfToleranceFixture() {
  const f = await fundedFixture();
  const short = tonnes(480);
  await f.delivery.connect(f.meterOracle).submitMeterReading(1, short, h("BMT-1"));
  await f.delivery.connect(f.ebdnOracle).submitEBDN(1, short, h("BDN-1"));
  return f;
}

/** Full 500 t delivery, then lab fail: only retention (51,450 mSGD) remains held. Dispute 1 opens. */
async function qualityFailFixture() {
  const f = await qualityApprovedFixture();
  await f.quality.connect(f.lab).submitLabResult(1, false, h("QTR-1"));
  return f;
}

/** Meter reading only, deadline passed. cancelExpired is blocked, so the order is stuck. */
async function stuckFixture() {
  const f = await fundedFixture();
  await f.delivery.connect(f.meterOracle).submitMeterReading(1, QTY, h("BMT-1"));
  await time.increaseTo(f.deadline + 1);
  return f;
}

describe("DisputeManager - manual openDispute", () => {
  it("buyer opens while Funded: DisputeOpened(MANUAL), order Disputed, disputeId set", async () => {
    const f = await loadFixture(fundedFixture);
    const tx = f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL);
    await expect(tx).to.emit(f.dispute, "DisputeOpened").withArgs(1n, 1n, Reason.MANUAL, f.buyer.address);
    await expect(tx).to.emit(f.order, "OrderDisputed").withArgs(1n, 1n);
    const o = await f.order.getOrder(1);
    expect(o.status).to.equal(Status.Disputed);
    expect(o.disputeId).to.equal(1n);
  });

  it("supplier opens while Funded", async () => {
    const f = await loadFixture(fundedFixture);
    await expect(f.dispute.connect(f.supplier).openDispute(1, Reason.MANUAL))
      .to.emit(f.dispute, "DisputeOpened")
      .withArgs(1n, 1n, Reason.MANUAL, f.supplier.address);
    expect((await f.order.getOrder(1)).status).to.equal(Status.Disputed);
  });

  it("buyer opens while QuantityApproved", async () => {
    const f = await loadFixture(qualityApprovedFixture);
    await expect(f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL))
      .to.emit(f.dispute, "DisputeOpened")
      .withArgs(1n, 1n, Reason.MANUAL, f.buyer.address);
    const o = await f.order.getOrder(1);
    expect(o.status).to.equal(Status.Disputed);
    expect(o.disputeId).to.equal(1n);
  });

  it("supplier opens while QuantityApproved", async () => {
    const f = await loadFixture(qualityApprovedFixture);
    await expect(f.dispute.connect(f.supplier).openDispute(1, Reason.MANUAL))
      .to.emit(f.dispute, "DisputeOpened")
      .withArgs(1n, 1n, Reason.MANUAL, f.supplier.address);
    expect((await f.order.getOrder(1)).status).to.equal(Status.Disputed);
  });

  it("bank cannot open manually: NotAuthorized (bank holds neither eligible role on the order)", async () => {
    const f = await loadFixture(fundedFixture);
    await expect(f.dispute.connect(f.bank).openDispute(1, Reason.MANUAL))
      .to.be.revertedWithCustomError(f.dispute, "NotAuthorized")
      .withArgs(f.roles.BUYER, f.bank.address);
  });

  it("outsider cannot open manually: NotAuthorized", async () => {
    const f = await loadFixture(fundedFixture);
    await expect(f.dispute.connect(f.outsider).openDispute(1, Reason.MANUAL))
      .to.be.revertedWithCustomError(f.dispute, "NotAuthorized")
      .withArgs(f.roles.BUYER, f.outsider.address);
  });

  it("registered buyer who is not on the order gets NotOrderParty", async () => {
    const f = await loadFixture(fundedFixture);
    await f.registry.register(f.outsider.address, f.roles.BUYER, "Other Buyer");
    await expect(f.dispute.connect(f.outsider).openDispute(1, Reason.MANUAL))
      .to.be.revertedWithCustomError(f.dispute, "NotOrderParty")
      .withArgs(1n, f.outsider.address);
  });

  it("rejects a non-MANUAL reason from a party with InvalidParameter(reason)", async () => {
    const f = await loadFixture(fundedFixture);
    await expect(f.dispute.connect(f.buyer).openDispute(1, Reason.OUT_OF_TOLERANCE))
      .to.be.revertedWithCustomError(f.dispute, "InvalidParameter")
      .withArgs("reason");
  });

  it("buyer cannot open while Created: InvalidState", async () => {
    const f = await loadFixture(createdFixture);
    await expect(f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL))
      .to.be.revertedWithCustomError(f.dispute, "InvalidState")
      .withArgs(1n, Status.Funded, Status.Created);
  });

  it("buyer cannot open while Accepted: InvalidState", async () => {
    const f = await loadFixture(acceptedFixture);
    await expect(f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL))
      .to.be.revertedWithCustomError(f.dispute, "InvalidState")
      .withArgs(1n, Status.Funded, Status.Accepted);
  });

  it("buyer cannot open while Settled: InvalidState", async () => {
    const f = await loadFixture(settledFixture);
    await expect(f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL))
      .to.be.revertedWithCustomError(f.dispute, "InvalidState")
      .withArgs(1n, Status.Funded, Status.Settled);
  });

  it("buyer cannot open while already Disputed: InvalidState", async () => {
    const f = await loadFixture(fundedFixture);
    await f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL);
    await expect(f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL))
      .to.be.revertedWithCustomError(f.dispute, "InvalidState")
      .withArgs(1n, Status.Funded, Status.Disputed);
  });
});

describe("DisputeManager - submitEvidence", () => {
  it("buyer submits NOPV: EvidenceSubmitted carries DocType", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.buyer).submitEvidence(1, Doc.NOPV, h("NOPV-1"), "vessel protest"))
      .to.emit(f.dispute, "EvidenceSubmitted")
      .withArgs(1n, 1n, Doc.NOPV, h("NOPV-1"), "vessel protest", f.buyer.address);
    expect((await f.dispute.getDispute(1)).evidenceCount).to.equal(1n);
  });

  it("supplier submits NOPB: EvidenceSubmitted carries DocType", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.supplier).submitEvidence(1, Doc.NOPB, h("NOPB-1"), "barge protest"))
      .to.emit(f.dispute, "EvidenceSubmitted")
      .withArgs(1n, 1n, Doc.NOPB, h("NOPB-1"), "barge protest", f.supplier.address);
  });

  it("bank submits SOF: EvidenceSubmitted carries DocType", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.bank).submitEvidence(1, Doc.SOF, h("SOF-1"), "statement of fact"))
      .to.emit(f.dispute, "EvidenceSubmitted")
      .withArgs(1n, 1n, Doc.SOF, h("SOF-1"), "statement of fact", f.bank.address);
  });

  it("evidence works on a manually opened dispute too", async () => {
    const f = await loadFixture(fundedFixture);
    await f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL);
    await expect(f.dispute.connect(f.bank).submitEvidence(1, Doc.SOF, h("SOF-2"), ""))
      .to.emit(f.dispute, "EvidenceSubmitted")
      .withArgs(1n, 1n, Doc.SOF, h("SOF-2"), "", f.bank.address);
  });

  it("outsider cannot submit evidence: NotAuthorized", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.outsider).submitEvidence(1, Doc.NOPV, h("NOPV-1"), ""))
      .to.be.revertedWithCustomError(f.dispute, "NotAuthorized")
      .withArgs(f.roles.BUYER, f.outsider.address);
  });

  it("arbiter cannot submit evidence: NotAuthorized (arbiter is not a party)", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.arbiter).submitEvidence(1, Doc.NOPV, h("NOPV-1"), ""))
      .to.be.revertedWithCustomError(f.dispute, "NotAuthorized")
      .withArgs(f.roles.BUYER, f.arbiter.address);
  });

  it("reverts on a resolved dispute: InvalidState(Disputed, Resolved)", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await f.dispute.connect(f.arbiter).resolve(1, 7000);
    await expect(f.dispute.connect(f.supplier).submitEvidence(1, Doc.NOPB, h("NOPB-1"), ""))
      .to.be.revertedWithCustomError(f.dispute, "InvalidState")
      .withArgs(1n, Status.Disputed, Status.Resolved);
  });

  it("unknown disputeId reverts InvalidParameter(disputeId)", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.buyer).submitEvidence(99, Doc.NOPV, h("NOPV-1"), ""))
      .to.be.revertedWithCustomError(f.dispute, "InvalidParameter")
      .withArgs("disputeId");
  });
});

describe("DisputeManager - resolve", () => {
  it("70/30 on OUT_OF_TOLERANCE: exact split, events, order Resolved, escrow empty", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    const escrowAddr = await f.escrow.getAddress();
    expect(await f.order.heldAmount(1)).to.equal(FUNDED);

    const tx = f.dispute.connect(f.arbiter).resolve(1, 7000);
    await expect(tx).to.changeTokenBalances(
      f.token,
      [f.supplier, f.bank, escrowAddr],
      [sgd(344715), sgd(147735), -FUNDED],
    );
    await expect(tx).to.emit(f.dispute, "DisputeResolved").withArgs(1n, 1n, 7000n, sgd(344715), sgd(147735));
    await expect(tx).to.emit(f.order, "OrderResolved").withArgs(1n, sgd(344715), sgd(147735));

    expect((await f.order.getOrder(1)).status).to.equal(Status.Resolved);
    expect(await f.order.heldAmount(1)).to.equal(0n);
    expect(await f.escrow.balanceOf(1)).to.equal(0n);
    expect(await f.token.balanceOf(f.supplier.address)).to.equal(sgd(344715));
    const d = await f.dispute.getDispute(1);
    expect(d.resolved).to.equal(true);
    expect(d.supplierShareBps).to.equal(7000n);
  });

  it("70/30 on QUALITY_FAIL: only retention held; supplier total = 90% upfront + 70% of held", async () => {
    const f = await loadFixture(qualityFailFixture);
    const escrowAddr = await f.escrow.getAddress();
    expect(await f.token.balanceOf(f.supplier.address)).to.equal(FIRST_TRANCHE);
    expect(await f.order.heldAmount(1)).to.equal(sgd(51450));

    const tx = f.dispute.connect(f.arbiter).resolve(1, 7000);
    await expect(tx).to.changeTokenBalances(
      f.token,
      [f.supplier, f.bank, escrowAddr],
      [sgd(36015), sgd(15435), -sgd(51450)],
    );
    await expect(tx).to.emit(f.dispute, "DisputeResolved").withArgs(1n, 1n, 7000n, sgd(36015), sgd(15435));

    expect(await f.token.balanceOf(f.supplier.address)).to.equal(sgd(477015));
    expect((await f.order.getOrder(1)).status).to.equal(Status.Resolved);
    expect(await f.order.heldAmount(1)).to.equal(0n);
    expect(await f.escrow.balanceOf(1)).to.equal(0n);
  });

  it("share 0: supplier gets nothing, bank gets all held", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    const escrowAddr = await f.escrow.getAddress();
    await expect(f.dispute.connect(f.arbiter).resolve(1, 0)).to.changeTokenBalances(
      f.token,
      [f.supplier, f.bank, escrowAddr],
      [0n, FUNDED, -FUNDED],
    );
    expect(await f.order.heldAmount(1)).to.equal(0n);
    expect(await f.escrow.balanceOf(1)).to.equal(0n);
  });

  it("share 10000: supplier gets all held, bank gets nothing", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    const escrowAddr = await f.escrow.getAddress();
    await expect(f.dispute.connect(f.arbiter).resolve(1, 10_000)).to.changeTokenBalances(
      f.token,
      [f.supplier, f.bank, escrowAddr],
      [FUNDED, 0n, -FUNDED],
    );
    expect(await f.order.heldAmount(1)).to.equal(0n);
    expect(await f.escrow.balanceOf(1)).to.equal(0n);
  });

  it("non-arbiter (buyer) cannot resolve: NotAuthorized(ARBITER)", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.buyer).resolve(1, 7000))
      .to.be.revertedWithCustomError(f.dispute, "NotAuthorized")
      .withArgs(f.roles.ARBITER, f.buyer.address);
  });

  it("share above 10000 reverts InvalidParameter(supplierShareBps)", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.arbiter).resolve(1, 10_001))
      .to.be.revertedWithCustomError(f.dispute, "InvalidParameter")
      .withArgs("supplierShareBps");
  });

  it("resolving twice reverts InvalidState(Disputed, Resolved)", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await f.dispute.connect(f.arbiter).resolve(1, 7000);
    await expect(f.dispute.connect(f.arbiter).resolve(1, 7000))
      .to.be.revertedWithCustomError(f.dispute, "InvalidState")
      .withArgs(1n, Status.Disputed, Status.Resolved);
  });

  it("unknown disputeId reverts InvalidParameter(disputeId)", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.dispute.connect(f.arbiter).resolve(99, 7000))
      .to.be.revertedWithCustomError(f.dispute, "InvalidParameter")
      .withArgs("disputeId");
    await expect(f.dispute.connect(f.arbiter).resolve(0, 7000))
      .to.be.revertedWithCustomError(f.dispute, "InvalidParameter")
      .withArgs("disputeId");
  });

  it("rescues a stuck single-evidence order: buyer manual dispute after deadline, arbiter resolves", async () => {
    const f = await loadFixture(stuckFixture);
    const escrowAddr = await f.escrow.getAddress();

    // Only the meter reading exists, so cancelExpired is blocked and the bank cannot be refunded.
    await expect(f.order.cancelExpired(1))
      .to.be.revertedWithCustomError(f.order, "AlreadySubmitted")
      .withArgs(1n, "delivery");

    await expect(f.dispute.connect(f.buyer).openDispute(1, Reason.MANUAL))
      .to.emit(f.dispute, "DisputeOpened")
      .withArgs(1n, 1n, Reason.MANUAL, f.buyer.address);
    expect(await f.order.heldAmount(1)).to.equal(FUNDED);

    await expect(f.dispute.connect(f.arbiter).resolve(1, 7000)).to.changeTokenBalances(
      f.token,
      [f.supplier, f.bank, escrowAddr],
      [sgd(344715), sgd(147735), -FUNDED],
    );
    expect((await f.order.getOrder(1)).status).to.equal(Status.Resolved);
    expect(await f.order.heldAmount(1)).to.equal(0n);
  });
});

describe("BunkerOrder - dispute hooks", () => {
  it("onDisputeOpened from an EOA reverts OnlyModule", async () => {
    const f = await loadFixture(fundedFixture);
    await expect(f.order.connect(f.outsider).onDisputeOpened(1, 1))
      .to.be.revertedWithCustomError(f.order, "OnlyModule")
      .withArgs(f.outsider.address);
  });

  it("onDisputeResolved from an EOA reverts OnlyModule", async () => {
    const f = await loadFixture(outOfToleranceFixture);
    await expect(f.order.connect(f.arbiter).onDisputeResolved(1, 0, 0))
      .to.be.revertedWithCustomError(f.order, "OnlyModule")
      .withArgs(f.arbiter.address);
  });
});
