import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { deployFixture, sgd, tonnes, DAY, type Fixture } from "./helpers/fixtures";

// Status enum (BunkerTypes.sol)
const STATUS = {
  Created: 0n,
  Accepted: 1n,
  Funded: 2n,
  QuantityApproved: 3n,
  Settled: 4n,
  Disputed: 5n,
  Resolved: 6n,
  Cancelled: 7n,
};

// DocType enum (BunkerTypes.sol)
const DOC = { QTR: 4n, DSI: 9n };

// DisputeReason enum (BunkerTypes.sol)
const REASON = { QUALITY_FAIL: 2n };

const DSC_HASH = ethers.keccak256(ethers.toUtf8Bytes("DSC"));
const BMT_HASH = ethers.keccak256(ethers.toUtf8Bytes("BMT"));
const BDN_HASH = ethers.keccak256(ethers.toUtf8Bytes("BDN"));
const QTR_HASH = ethers.keccak256(ethers.toUtf8Bytes("QTR"));

// SPEC 9 scenario 1: 500 t VLSFO @ 980 mSGD/t, tolerance 50 bps, retention 1000 bps, window 120 s.
// Meter 500.2 t, eBDN 500 t.
const ORDER_ID = 1;
const METER_KG = tonnes(500.2); // 500_200 kg
const PAYABLE = sgd(490196); // 500_200 kg * 980 / 1000
const FUNDED = sgd(492450); // 500_000 kg * 980 / 1000 * 1.005
const FIRST_TRANCHE = sgd("441176.4"); // payable * 90%
const RETENTION = sgd("49019.6"); // payable * 10%
const EXCESS = sgd(2254); // funded - payable
const ESCROW_AFTER_APPROVAL = sgd("51273.6"); // retention + excess
const BANK_MINT = sgd(100_000_000);

/** Create only (order 1 in Created). */
async function createdFixture(): Promise<Fixture> {
  const f = await deployFixture();
  const deadline = (await time.latest()) + 7 * DAY;
  await f.order
    .connect(f.buyer)
    .createOrder(
      f.supplier.address,
      f.bank.address,
      "VLSFO",
      tonnes(500),
      sgd(980),
      50,
      1000,
      deadline,
      120,
      DSC_HASH,
    );
  return f;
}

/** create -> accept -> fund (order 1 in Funded). */
async function fundedFixture(): Promise<Fixture> {
  const f = await createdFixture();
  await f.order.connect(f.supplier).acceptOrder(ORDER_ID);
  await f.order.connect(f.bank).fundOrder(ORDER_ID);
  return f;
}

/** create -> accept -> fund -> meter 500.2 t + eBDN 500 t (order 1 in QuantityApproved). */
async function approvedFixture(): Promise<Fixture> {
  const f = await fundedFixture();
  await f.delivery.connect(f.meterOracle).submitMeterReading(ORDER_ID, METER_KG, BMT_HASH);
  await f.delivery.connect(f.ebdnOracle).submitEBDN(ORDER_ID, tonnes(500), BDN_HASH);
  return f;
}

describe("QualityRecord, onLabResult, releaseAfterTimeout", () => {
  describe("lab pass", () => {
    it("releases retention to supplier and refunds excess to bank, emptying escrow", async () => {
      const f = await loadFixture(approvedFixture);
      await expect(
        f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH),
      ).to.changeTokenBalances(
        f.token,
        [f.supplier, f.bank, f.escrow],
        [RETENTION, EXCESS, -ESCROW_AFTER_APPROVAL],
      );

      expect(await f.token.balanceOf(f.supplier.address)).to.equal(PAYABLE);
      expect(await f.token.balanceOf(f.bank.address)).to.equal(BANK_MINT - PAYABLE);
      expect(await f.escrow.balanceOf(ORDER_ID)).to.equal(0n);
      expect(await f.order.heldAmount(ORDER_ID)).to.equal(0n);

      const o = await f.order.getOrder(ORDER_ID);
      expect(o.status).to.equal(STATUS.Settled);
      expect(o.releasedAmount).to.equal(PAYABLE);
      expect(o.refundedAmount).to.equal(EXCESS);
    });

    it("emits LabResultSubmitted with the QTR doc type", async () => {
      const f = await loadFixture(approvedFixture);
      await expect(f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.emit(f.quality, "LabResultSubmitted")
        .withArgs(ORDER_ID, true, QTR_HASH, f.lab.address, DOC.QTR);
    });

    it("emits OrderSettled with the DSI invoice hash derived from settlement data", async () => {
      const f = await loadFixture(approvedFixture);
      const tx = f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH);
      await expect(tx).to.emit(f.order, "OrderSettled");

      const receipt = await (await tx).wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const expectedInvoiceHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "bytes32", "uint256", "uint256", "uint256"],
          [ORDER_ID, DSC_HASH, METER_KG, PAYABLE, block!.timestamp],
        ),
      );
      await expect(tx)
        .to.emit(f.order, "OrderSettled")
        .withArgs(ORDER_ID, PAYABLE, EXCESS, expectedInvoiceHash, DOC.DSI);
    });

    it("stores the result retrievable through getResult", async () => {
      const f = await loadFixture(approvedFixture);
      const before = await f.quality.getResult(ORDER_ID);
      expect(before.submitted).to.equal(false);

      await f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH);

      const r = await f.quality.getResult(ORDER_ID);
      expect(r.submitted).to.equal(true);
      expect(r.passed).to.equal(true);
      expect(r.reportHash).to.equal(QTR_HASH);
      expect(r.lab).to.equal(f.lab.address);
      expect(r.submittedAt).to.be.gt(0n);
    });
  });

  describe("lab fail", () => {
    it("opens a QUALITY_FAIL dispute and keeps retention held in escrow", async () => {
      const f = await loadFixture(approvedFixture);
      await expect(f.quality.connect(f.lab).submitLabResult(ORDER_ID, false, QTR_HASH))
        .to.emit(f.dispute, "DisputeOpened")
        .withArgs(1n, ORDER_ID, REASON.QUALITY_FAIL, await f.order.getAddress())
        .and.to.emit(f.order, "OrderDisputed")
        .withArgs(ORDER_ID, 1n);

      const o = await f.order.getOrder(ORDER_ID);
      expect(o.status).to.equal(STATUS.Disputed);
      expect(o.disputeId).to.equal(1n);

      // Retention still held: funded - first tranche released.
      expect(await f.escrow.balanceOf(ORDER_ID)).to.equal(ESCROW_AFTER_APPROVAL);
      expect(await f.order.heldAmount(ORDER_ID)).to.equal(ESCROW_AFTER_APPROVAL);
      expect(await f.order.heldAmount(ORDER_ID)).to.equal(FUNDED - FIRST_TRANCHE);
    });

    it("leaves the supplier balance unchanged after a failed lab result", async () => {
      const f = await loadFixture(approvedFixture);
      await expect(
        f.quality.connect(f.lab).submitLabResult(ORDER_ID, false, QTR_HASH),
      ).to.changeTokenBalances(f.token, [f.supplier], [0n]);
      expect(await f.token.balanceOf(f.supplier.address)).to.equal(FIRST_TRANCHE);
    });

    it("records the failed result through getResult", async () => {
      const f = await loadFixture(approvedFixture);
      await f.quality.connect(f.lab).submitLabResult(ORDER_ID, false, QTR_HASH);
      const r = await f.quality.getResult(ORDER_ID);
      expect(r.submitted).to.equal(true);
      expect(r.passed).to.equal(false);
    });
  });

  describe("guards", () => {
    it("reverts NotAuthorized for a registered non-LAB account (buyer)", async () => {
      const f = await loadFixture(approvedFixture);
      await expect(f.quality.connect(f.buyer).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.be.revertedWithCustomError(f.quality, "NotAuthorized")
        .withArgs(f.roles.LAB, f.buyer.address);
    });

    it("reverts NotAuthorized for an outsider", async () => {
      const f = await loadFixture(approvedFixture);
      await expect(f.quality.connect(f.outsider).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.be.revertedWithCustomError(f.quality, "NotAuthorized")
        .withArgs(f.roles.LAB, f.outsider.address);
    });

    it("reverts AccountSuspended for a suspended lab", async () => {
      const f = await loadFixture(approvedFixture);
      await f.registry.suspend(f.lab.address);
      await expect(f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.be.revertedWithCustomError(f.quality, "AccountSuspended")
        .withArgs(f.lab.address);
    });

    it("reverts AlreadySubmitted on a second lab submission after a pass", async () => {
      const f = await loadFixture(approvedFixture);
      await f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH);
      await expect(f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.be.revertedWithCustomError(f.quality, "AlreadySubmitted")
        .withArgs(ORDER_ID, "lab");
    });

    it("reverts AlreadySubmitted on a second lab submission after a fail", async () => {
      const f = await loadFixture(approvedFixture);
      await f.quality.connect(f.lab).submitLabResult(ORDER_ID, false, QTR_HASH);
      await expect(f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.be.revertedWithCustomError(f.quality, "AlreadySubmitted")
        .withArgs(ORDER_ID, "lab");
    });

    it("reverts InvalidState when the order is Funded", async () => {
      const f = await loadFixture(fundedFixture);
      await expect(f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.be.revertedWithCustomError(f.quality, "InvalidState")
        .withArgs(ORDER_ID, STATUS.QuantityApproved, STATUS.Funded);
    });

    it("reverts InvalidState when the order is Created", async () => {
      const f = await loadFixture(createdFixture);
      await expect(f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.be.revertedWithCustomError(f.quality, "InvalidState")
        .withArgs(ORDER_ID, STATUS.QuantityApproved, STATUS.Created);
    });
  });

  describe("releaseAfterTimeout", () => {
    it("reverts RetentionWindowOpen before approvedAt + retentionWindow", async () => {
      const f = await loadFixture(approvedFixture);
      const approvedAt = (await f.order.getOrder(ORDER_ID)).approvedAt;
      await expect(f.order.releaseAfterTimeout(ORDER_ID))
        .to.be.revertedWithCustomError(f.order, "RetentionWindowOpen")
        .withArgs(ORDER_ID, approvedAt + 120n);
    });

    it("settles after the window for any caller with the same balances as a lab pass", async () => {
      const f = await loadFixture(approvedFixture);
      await time.increase(121);

      await expect(
        f.order.connect(f.outsider).releaseAfterTimeout(ORDER_ID),
      ).to.changeTokenBalances(
        f.token,
        [f.supplier, f.bank, f.escrow],
        [RETENTION, EXCESS, -ESCROW_AFTER_APPROVAL],
      );

      expect(await f.token.balanceOf(f.supplier.address)).to.equal(PAYABLE);
      expect(await f.token.balanceOf(f.bank.address)).to.equal(BANK_MINT - PAYABLE);
      expect(await f.escrow.balanceOf(ORDER_ID)).to.equal(0n);
      expect(await f.order.heldAmount(ORDER_ID)).to.equal(0n);
      expect((await f.order.getOrder(ORDER_ID)).status).to.equal(STATUS.Settled);
    });

    it("emits OrderSettled when released after the window", async () => {
      const f = await loadFixture(approvedFixture);
      await time.increase(121);
      await expect(f.order.connect(f.outsider).releaseAfterTimeout(ORDER_ID))
        .to.emit(f.order, "OrderSettled")
        .withArgs(ORDER_ID, PAYABLE, EXCESS, anyValue, DOC.DSI);
    });

    it("reverts InvalidState when the order is Funded", async () => {
      const f = await loadFixture(fundedFixture);
      await expect(f.order.releaseAfterTimeout(ORDER_ID))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(ORDER_ID, STATUS.QuantityApproved, STATUS.Funded);
    });

    it("reverts InvalidState when the order is Disputed", async () => {
      const f = await loadFixture(approvedFixture);
      await f.quality.connect(f.lab).submitLabResult(ORDER_ID, false, QTR_HASH);
      await time.increase(121);
      await expect(f.order.releaseAfterTimeout(ORDER_ID))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(ORDER_ID, STATUS.QuantityApproved, STATUS.Disputed);
    });

    it("reverts InvalidState when the order is already Settled", async () => {
      const f = await loadFixture(approvedFixture);
      await time.increase(121);
      await f.order.releaseAfterTimeout(ORDER_ID);
      await expect(f.order.releaseAfterTimeout(ORDER_ID))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(ORDER_ID, STATUS.QuantityApproved, STATUS.Settled);
    });

    it("reverts a lab submission after the timeout release", async () => {
      const f = await loadFixture(approvedFixture);
      await time.increase(121);
      await f.order.releaseAfterTimeout(ORDER_ID);
      await expect(f.quality.connect(f.lab).submitLabResult(ORDER_ID, true, QTR_HASH))
        .to.be.revertedWithCustomError(f.quality, "InvalidState")
        .withArgs(ORDER_ID, STATUS.QuantityApproved, STATUS.Settled);
    });
  });
});
