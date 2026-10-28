import { expect } from "chai";
import type { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFixture, sgd, tonnes, DAY } from "./helpers/fixtures";

// Status (BunkerTypes.sol)
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

// DocType (BunkerTypes.sol)
const DOC_BMT = 2n;
const DOC_BDN = 3n;

// DisputeReason (BunkerTypes.sol)
const REASON_OUT_OF_TOLERANCE = 0n;
const REASON_QUANTITY_MISMATCH = 1n;

const DSC_HASH = ethers.keccak256(ethers.toUtf8Bytes("DSC-1"));
const BMT_HASH = ethers.keccak256(ethers.toUtf8Bytes("BMT-1"));
const BDN_HASH = ethers.keccak256(ethers.toUtf8Bytes("BDN-1"));

/** SPEC 9 scenario 1 order: 500 t VLSFO @ 980 mSGD/t, tolerance 50 bps, retention 1000 bps, window 120 s. */
async function createdOrderFixture() {
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
  return { ...f, deadline };
}

async function acceptedOrderFixture() {
  const f = await createdOrderFixture();
  await f.order.connect(f.supplier).acceptOrder(1);
  return f;
}

async function fundedOrderFixture() {
  const f = await acceptedOrderFixture();
  await f.order.connect(f.bank).fundOrder(1);
  return f;
}

/** Funded amount = 500 t * 980 * 1.005 = 492,450 mSGD. */
const FUNDED = sgd(492450);

describe("DeliveryRecord and BunkerOrder delivery outcomes", () => {
  describe("evidence submission", () => {
    it("emits MeterReadingSubmitted with the BMT doc type", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await expect(f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH))
        .to.emit(f.delivery, "MeterReadingSubmitted")
        .withArgs(1n, tonnes(500.2), BMT_HASH, DOC_BMT, f.meterOracle.address);
    });

    it("emits EBDNSubmitted with the BDN doc type", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await expect(f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH))
        .to.emit(f.delivery, "EBDNSubmitted")
        .withArgs(1n, tonnes(500.0), BDN_HASH, DOC_BDN, f.ebdnOracle.address);
    });

    it("getDelivery stores the meter reading and leaves the e-BDN unset", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH);
      const d = await f.delivery.getDelivery(1);
      expect(d.meterKg).to.equal(tonnes(500.2));
      expect(d.ticketHash).to.equal(BMT_HASH);
      expect(d.meterSubmitted).to.equal(true);
      expect(d.ebdnSubmitted).to.equal(false);
      expect(d.ebdnKg).to.equal(0n);
      expect(await f.delivery.hasEvidence(1)).to.equal(true);
    });

    it("getDelivery stores both pieces of evidence once both are submitted", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH);
      const d = await f.delivery.getDelivery(1);
      expect(d.meterKg).to.equal(tonnes(500.2));
      expect(d.ebdnKg).to.equal(tonnes(500.0));
      expect(d.ticketHash).to.equal(BMT_HASH);
      expect(d.ebdnHash).to.equal(BDN_HASH);
      expect(d.meterSubmitted).to.equal(true);
      expect(d.ebdnSubmitted).to.equal(true);
    });

    it("triggers verification when the e-BDN arrives second", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH);
      await expect(f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH))
        .to.emit(f.delivery, "DeliveryVerified")
        .withArgs(1n, tonnes(500.2));
      expect((await f.order.getOrder(1)).status).to.equal(STATUS.QuantityApproved);
    });

    it("triggers verification when the meter reading arrives second", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH);
      await expect(f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH))
        .to.emit(f.delivery, "DeliveryVerified")
        .withArgs(1n, tonnes(500.2));
      expect((await f.order.getOrder(1)).status).to.equal(STATUS.QuantityApproved);
    });
  });

  describe("verification within tolerance", () => {
    it("meter 500.2 t / eBDN 500.0 t: approves, pays 90% of 490,196 mSGD, holds the rest", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH);

      // payable = 500200 kg * 980 / 1000 = 490,196 mSGD; first tranche = 90% = 441,176.4 mSGD
      const payable = sgd(490196);
      const tranche = sgd("441176.4");

      let tx!: Promise<ContractTransactionResponse>;
      const send = () => {
        tx = f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH);
        return tx;
      };
      await expect(send).to.changeTokenBalances(f.token, [f.supplier, f.escrow], [tranche, -tranche]);
      await expect(tx)
        .to.emit(f.delivery, "DeliveryVerified")
        .withArgs(1n, tonnes(500.2));
      await expect(tx)
        .to.emit(f.order, "QuantityApproved")
        .withArgs(1n, tonnes(500.2), payable, tranche);

      const o = await f.order.getOrder(1);
      expect(o.status).to.equal(STATUS.QuantityApproved);
      expect(o.deliveredKg).to.equal(tonnes(500.2));
      expect(o.payableAmount).to.equal(payable);
      expect(o.releasedAmount).to.equal(tranche);
      expect(o.approvedAt).to.equal(BigInt(await time.latest()));
      expect(await f.order.heldAmount(1)).to.equal(FUNDED - tranche);
    });

    it("over-delivery of 502 t inside tolerance pays for the delivered quantity", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(502), BMT_HASH);
      // payable = 502000 * 980 / 1000 = 491,960 mSGD; tranche = 442,764 mSGD
      await expect(() =>
        f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(502), BDN_HASH),
      ).to.changeTokenBalances(f.token, [f.supplier], [sgd(442764)]);
      const o = await f.order.getOrder(1);
      expect(o.deliveredKg).to.equal(tonnes(502));
      expect(o.payableAmount).to.equal(sgd(491960));
      expect(o.releasedAmount).to.equal(sgd(442764));
      expect(await f.order.heldAmount(1)).to.equal(FUNDED - sgd(442764));
    });

    it("under-delivery of 498 t inside tolerance pays less", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(498), BMT_HASH);
      // payable = 498000 * 980 / 1000 = 488,040 mSGD; tranche = 439,236 mSGD
      await expect(() =>
        f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(498), BDN_HASH),
      ).to.changeTokenBalances(f.token, [f.supplier], [sgd(439236)]);
      const o = await f.order.getOrder(1);
      expect(o.deliveredKg).to.equal(tonnes(498));
      expect(o.payableAmount).to.equal(sgd(488040));
      expect(o.releasedAmount).to.equal(sgd(439236));
      expect(await f.order.heldAmount(1)).to.equal(FUNDED - sgd(439236));
    });
  });

  describe("dispute outcomes", () => {
    it("meter 480 t vs ordered 500 t: opens OUT_OF_TOLERANCE, nothing released", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(480), BMT_HASH);
      // eBDN must agree with the meter so the meter-vs-eBDN check passes and the order-vs-meter check fails.
      let tx!: Promise<ContractTransactionResponse>;
      const send = () => {
        tx = f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(480), BDN_HASH);
        return tx;
      };
      await expect(send).to.changeTokenBalances(f.token, [f.supplier, f.escrow], [0n, 0n]);
      await expect(tx)
        .to.emit(f.dispute, "DisputeOpened")
        .withArgs(1n, 1n, REASON_OUT_OF_TOLERANCE, await f.order.getAddress());
      await expect(tx).to.emit(f.order, "OrderDisputed").withArgs(1n, 1n);

      const o = await f.order.getOrder(1);
      expect(o.status).to.equal(STATUS.Disputed);
      expect(o.disputeId).to.equal(1n);
      expect(o.releasedAmount).to.equal(0n);
      expect(await f.order.heldAmount(1)).to.equal(FUNDED);
      expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(FUNDED);
    });

    it("meter 500 t vs eBDN 490 t: emits QuantityMismatch and opens QUANTITY_MISMATCH, nothing released", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500), BMT_HASH);
      let tx!: Promise<ContractTransactionResponse>;
      const send = () => {
        tx = f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(490), BDN_HASH);
        return tx;
      };
      await expect(send).to.changeTokenBalances(f.token, [f.supplier, f.escrow], [0n, 0n]);
      await expect(tx)
        .to.emit(f.delivery, "QuantityMismatch")
        .withArgs(1n, tonnes(500), tonnes(490));
      await expect(tx)
        .to.emit(f.dispute, "DisputeOpened")
        .withArgs(1n, 1n, REASON_QUANTITY_MISMATCH, await f.order.getAddress());

      const o = await f.order.getOrder(1);
      expect(o.status).to.equal(STATUS.Disputed);
      expect(o.releasedAmount).to.equal(0n);
      expect(await f.order.heldAmount(1)).to.equal(FUNDED);
    });
  });

  describe("duplicate submissions", () => {
    it("reverts AlreadySubmitted on a second meter reading", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH);
      await expect(f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH))
        .to.be.revertedWithCustomError(f.delivery, "AlreadySubmitted")
        .withArgs(1n, "meter");
    });

    it("reverts AlreadySubmitted on a second e-BDN", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH);
      await expect(f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH))
        .to.be.revertedWithCustomError(f.delivery, "AlreadySubmitted")
        .withArgs(1n, "ebdn");
    });

    it("reverts AlreadySubmitted on a repeat meter reading after verification (checked before state)", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH);
      await f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH);
      await expect(f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH))
        .to.be.revertedWithCustomError(f.delivery, "AlreadySubmitted")
        .withArgs(1n, "meter");
    });
  });

  describe("role checks", () => {
    it("reverts NotAuthorized when an outsider submits a meter reading", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await expect(f.delivery.connect(f.outsider).submitMeterReading(1, tonnes(500.2), BMT_HASH))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.METER_ORACLE, f.outsider.address);
    });

    it("reverts NotAuthorized when the lab submits a meter reading", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await expect(f.delivery.connect(f.lab).submitMeterReading(1, tonnes(500.2), BMT_HASH))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.METER_ORACLE, f.lab.address);
    });

    it("reverts NotAuthorized when the meter oracle submits an e-BDN", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await expect(f.delivery.connect(f.meterOracle).submitEBDN(1, tonnes(500.0), BDN_HASH))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.EBDN_ORACLE, f.meterOracle.address);
    });

    it("reverts NotAuthorized when an outsider submits an e-BDN", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await expect(f.delivery.connect(f.outsider).submitEBDN(1, tonnes(500.0), BDN_HASH))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.EBDN_ORACLE, f.outsider.address);
    });
  });

  describe("order state guards", () => {
    it("reverts InvalidState for a meter reading on a Created order", async () => {
      const f = await loadFixture(createdOrderFixture);
      await expect(f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH))
        .to.be.revertedWithCustomError(f.delivery, "InvalidState")
        .withArgs(1n, STATUS.Funded, STATUS.Created);
    });

    it("reverts InvalidState for an e-BDN on an Accepted order", async () => {
      const f = await loadFixture(acceptedOrderFixture);
      await expect(f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH))
        .to.be.revertedWithCustomError(f.delivery, "InvalidState")
        .withArgs(1n, STATUS.Funded, STATUS.Accepted);
    });

    it("reverts InvalidState for a meter reading on a Cancelled order", async () => {
      const f = await loadFixture(createdOrderFixture);
      await f.order.connect(f.buyer).cancelOrder(1);
      await expect(f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH))
        .to.be.revertedWithCustomError(f.delivery, "InvalidState")
        .withArgs(1n, STATUS.Funded, STATUS.Cancelled);
    });

    it("reverts AlreadySubmitted (checked before state) for a submission on a QuantityApproved order", async () => {
      // Both evidence items already exist, so the duplicate check fires before the state check.
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH);
      await f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH);
      expect((await f.order.getOrder(1)).status).to.equal(STATUS.QuantityApproved);
      await expect(f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH))
        .to.be.revertedWithCustomError(f.delivery, "AlreadySubmitted")
        .withArgs(1n, "ebdn");
    });
  });

  describe("single evidence item past deadline", () => {
    it("keeps the order Funded and blocks cancelExpired when only the meter reading exists", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500.2), BMT_HASH);
      await time.increaseTo(f.deadline + 1);
      expect((await f.order.getOrder(1)).status).to.equal(STATUS.Funded);
      await expect(f.order.cancelExpired(1))
        .to.be.revertedWithCustomError(f.order, "AlreadySubmitted")
        .withArgs(1n, "delivery");
    });

    it("keeps the order Funded and blocks cancelExpired when only the e-BDN exists", async () => {
      const f = await loadFixture(fundedOrderFixture);
      await f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500.0), BDN_HASH);
      await time.increaseTo(f.deadline + 1);
      expect((await f.order.getOrder(1)).status).to.equal(STATUS.Funded);
      await expect(f.order.cancelExpired(1))
        .to.be.revertedWithCustomError(f.order, "AlreadySubmitted")
        .withArgs(1n, "delivery");
    });
  });
});
