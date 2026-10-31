import { expect } from "chai";
import { ethers } from "hardhat";
import type { HDNodeWallet } from "ethers";
import type { Signer } from "ethers";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFixture, sgd, tonnes, DAY, ANCHORAGE, type Fixture } from "./helpers/fixtures";

// Status (BunkerTypes.sol)
const STATUS = {
  Created: 0n,
  Accepted: 1n,
  Funded: 2n,
  QuantityApproved: 3n,
  Settled: 4n,
  Disputed: 5n,
};

const DOC = { BMT: 2n, BDN: 3n, QTR: 4n };
const REASON_QUALITY_FAIL = 2n;

const DSC_HASH = ethers.keccak256(ethers.toUtf8Bytes("DSC-S"));
const BMT_HASH = ethers.keccak256(ethers.toUtf8Bytes("BMT-S"));
const BDN_HASH = ethers.keccak256(ethers.toUtf8Bytes("BDN-S"));
const QTR_HASH = ethers.keccak256(ethers.toUtf8Bytes("QTR-S"));
const OTHER_HASH = ethers.keccak256(ethers.toUtf8Bytes("OTHER"));

// SPEC 9 scenario 1 numbers (same as quality.test.ts).
const ID = 1;
const METER_KG = tonnes(500.2);
const EBDN_KG = tonnes(500);
const PAYABLE = sgd(490196);
const RETENTION = sgd("49019.6");
const EXCESS = sgd(2254);
const ESCROW_AFTER_APPROVAL = sgd("51273.6");
const FIRST_TRANCHE = sgd("441176.4");

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

type Signable = Signer | HDNodeWallet;

/** Reads the EIP-712 domain from the contract itself. */
async function domainOf(c: { eip712Domain(): Promise<any>; getAddress(): Promise<string> }) {
  const d = await c.eip712Domain();
  return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
}

async function futureDeadline(secs = 3600) {
  return (await time.latest()) + secs;
}

async function signMeter(f: Fixture, signer: Signable, id: number, qty: bigint, hash: string, deadline: number) {
  const domain = await domainOf(f.delivery);
  return (signer as any).signTypedData(domain, METER_TYPES, { id, qtyKg: qty, ticketHash: hash, deadline });
}
async function signEbdn(f: Fixture, signer: Signable, id: number, qty: bigint, hash: string, deadline: number) {
  const domain = await domainOf(f.delivery);
  return (signer as any).signTypedData(domain, EBDN_TYPES, { id, qtyKg: qty, ebdnHash: hash, deadline });
}
async function signLab(f: Fixture, signer: Signable, id: number, passed: boolean, hash: string, deadline: number) {
  const domain = await domainOf(f.quality);
  return (signer as any).signTypedData(domain, LAB_TYPES, { id, passed, reportHash: hash, deadline });
}

async function createOrder(f: Fixture) {
  const deadline = (await time.latest()) + 7 * DAY;
  await f.order.connect(f.buyer).createOrder({
    supplier: f.supplier.address,
    bank: f.bank.address,
    fuelGrade: "VLSFO",
    qtyKg: tonnes(500),
    pricePerTonne: sgd(980),
    toleranceBps: 50,
    retentionBps: 1000,
    deliveryDeadline: deadline,
    retentionWindow: 120,
    dscHash: DSC_HASH,
    anchorage: ANCHORAGE.EASTERN_PETROLEUM_B,
  });
}

async function createdFixture(): Promise<Fixture> {
  const f = await deployFixture();
  await createOrder(f);
  return f;
}

async function acceptedFixture(): Promise<Fixture> {
  const f = await createdFixture();
  await f.order.connect(f.supplier).acceptOrder(ID);
  return f;
}

async function fundedFixture(): Promise<Fixture> {
  const f = await createdFixture();
  await f.order.connect(f.supplier).acceptOrder(ID);
  await f.order.connect(f.bank).fundOrder(ID);
  return f;
}

/** Two funded orders (ids 1 and 2). */
async function twoFundedFixture(): Promise<Fixture> {
  const f = await fundedFixture();
  await createOrder(f);
  await f.order.connect(f.supplier).acceptOrder(2);
  await f.order.connect(f.bank).fundOrder(2);
  return f;
}

/** Order 1 QuantityApproved via the direct functions. */
async function approvedFixture(): Promise<Fixture> {
  const f = await fundedFixture();
  await f.delivery.connect(f.meterOracle).submitMeterReading(ID, METER_KG, BMT_HASH);
  await f.delivery.connect(f.ebdnOracle).submitEBDN(ID, EBDN_KG, BDN_HASH);
  return f;
}

describe("EIP-712 signed oracle submissions (BySig)", () => {
  describe("domain", () => {
    it("exposes distinct per-contract domains with version 1", async () => {
      const f = await loadFixture(fundedFixture);
      const dd = await domainOf(f.delivery);
      const qd = await domainOf(f.quality);
      expect(dd.name).to.equal("BunkerSettle DeliveryRecord");
      expect(qd.name).to.equal("BunkerSettle QualityRecord");
      expect(dd.version).to.equal("1");
      expect(qd.version).to.equal("1");
      expect(dd.verifyingContract).to.equal(await f.delivery.getAddress());
      expect(qd.verifyingContract).to.equal(await f.quality.getAddress());
    });
  });

  describe("submitMeterReadingBySig", () => {
    it("lets an unregistered relayer submit; oracle in event is the signer; state matches the direct path", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);

      await expect(
        f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig),
      )
        .to.emit(f.delivery, "MeterReadingSubmitted")
        .withArgs(ID, METER_KG, BMT_HASH, DOC.BMT, f.meterOracle.address);

      const d = await f.delivery.getDelivery(ID);
      expect(d.meterKg).to.equal(METER_KG);
      expect(d.ticketHash).to.equal(BMT_HASH);
      expect(d.meterSubmitted).to.equal(true);
      expect(d.ebdnSubmitted).to.equal(false);
      expect(await f.delivery.hasEvidence(ID)).to.equal(true);
    });

    it("reverts NotAuthorized when the signer is a registered non-oracle (buyer)", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.buyer, ID, METER_KG, BMT_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.METER_ORACLE, f.buyer.address);
    });

    it("reverts NotAuthorized when the signer is the wrong oracle (e-BDN oracle)", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.ebdnOracle, ID, METER_KG, BMT_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.METER_ORACLE, f.ebdnOracle.address);
    });

    it("reverts NotAuthorized when the signer is an unregistered account", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const stranger = ethers.Wallet.createRandom();
      const sig = await signMeter(f, stranger, ID, METER_KG, BMT_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.METER_ORACLE, stranger.address);
    });

    it("reverts AccountSuspended when the signer is suspended", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await f.registry.suspend(f.meterOracle.address);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "AccountSuspended")
        .withArgs(f.meterOracle.address);
    });

    it("reverts SignatureExpired for a deadline already in the past", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = (await time.latest()) - 10;
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "SignatureExpired")
        .withArgs(deadline);
    });

    it("reverts SignatureExpired once time passes the deadline", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline(60);
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await time.increaseTo(deadline + 1);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "SignatureExpired")
        .withArgs(deadline);
    });

    it("reverts NotAuthorized when the quantity is tampered", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await expect(
        f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, tonnes(400), BMT_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
      expect(await f.delivery.hasEvidence(ID)).to.equal(false);
    });

    it("reverts NotAuthorized when the ticket hash is tampered", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await expect(
        f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, OTHER_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
    });

    it("reverts NotAuthorized when the deadline is tampered (extended)", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await expect(
        f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline + 1000, sig),
      ).to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
    });

    it("reverts AlreadySubmitted when the same signature is sent twice", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "AlreadySubmitted")
        .withArgs(ID, "meter");
    });

    it("rejects an e-BDN signature replayed on submitMeterReadingBySig (NotAuthorized)", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, METER_KG, BMT_HASH, deadline);
      await expect(
        f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
    });

    it("reverts ECDSAInvalidSignatureLength for a malformed 10-byte signature", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      await expect(
        f.delivery
          .connect(f.outsider)
          .submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, ethers.hexlify(ethers.randomBytes(10))),
      )
        .to.be.revertedWithCustomError(f.delivery, "ECDSAInvalidSignatureLength")
        .withArgs(10);
    });

    it("reverts InvalidState for a valid signature on a Created order", async () => {
      const f = await loadFixture(createdFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "InvalidState")
        .withArgs(ID, STATUS.Funded, STATUS.Created);
    });

    it("rejects a signature made for order 1 when sent for order 2 (NotAuthorized)", async () => {
      const f = await loadFixture(twoFundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, 1, METER_KG, BMT_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(2, METER_KG, BMT_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
      expect(await f.delivery.hasEvidence(2)).to.equal(false);
      // and it still works for the id it was signed for
      await f.delivery.connect(f.outsider).submitMeterReadingBySig(1, METER_KG, BMT_HASH, deadline, sig);
      expect(await f.delivery.hasEvidence(1)).to.equal(true);
    });
  });

  describe("submitEBDNBySig", () => {
    it("lets an unregistered relayer submit; oracle in event is the signer; state matches the direct path", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);

      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.emit(f.delivery, "EBDNSubmitted")
        .withArgs(ID, EBDN_KG, BDN_HASH, DOC.BDN, f.ebdnOracle.address);

      const d = await f.delivery.getDelivery(ID);
      expect(d.ebdnKg).to.equal(EBDN_KG);
      expect(d.ebdnHash).to.equal(BDN_HASH);
      expect(d.ebdnSubmitted).to.equal(true);
      expect(d.meterSubmitted).to.equal(false);
      expect(await f.delivery.hasEvidence(ID)).to.equal(true);
    });

    it("reverts NotAuthorized when the signer is a registered non-oracle (buyer)", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.buyer, ID, EBDN_KG, BDN_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.EBDN_ORACLE, f.buyer.address);
    });

    it("reverts NotAuthorized when the signer is the wrong oracle (meter oracle)", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.meterOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.EBDN_ORACLE, f.meterOracle.address);
    });

    it("reverts AccountSuspended when the signer is suspended", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await f.registry.suspend(f.ebdnOracle.address);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "AccountSuspended")
        .withArgs(f.ebdnOracle.address);
    });

    it("reverts SignatureExpired for a deadline already in the past", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = (await time.latest()) - 10;
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "SignatureExpired")
        .withArgs(deadline);
    });

    it("reverts SignatureExpired once time passes the deadline", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline(60);
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await time.increaseTo(deadline + 1);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "SignatureExpired")
        .withArgs(deadline);
    });

    it("reverts NotAuthorized when the quantity is tampered", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await expect(
        f.delivery.connect(f.outsider).submitEBDNBySig(ID, tonnes(400), BDN_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
      expect(await f.delivery.hasEvidence(ID)).to.equal(false);
    });

    it("reverts NotAuthorized when the e-BDN hash is tampered", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await expect(
        f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, OTHER_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
    });

    it("reverts AlreadySubmitted when the same signature is sent twice", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "AlreadySubmitted")
        .withArgs(ID, "ebdn");
    });

    it("rejects a meter signature replayed on submitEBDNBySig (NotAuthorized)", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await expect(
        f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
    });

    it("reverts ECDSAInvalidSignatureLength for a malformed 10-byte signature", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      await expect(
        f.delivery
          .connect(f.outsider)
          .submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, ethers.hexlify(ethers.randomBytes(10))),
      )
        .to.be.revertedWithCustomError(f.delivery, "ECDSAInvalidSignatureLength")
        .withArgs(10);
    });

    it("reverts InvalidState for a valid signature on an Accepted order", async () => {
      const f = await loadFixture(acceptedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "InvalidState")
        .withArgs(ID, STATUS.Funded, STATUS.Accepted);
    });

    it("rejects a signature made for order 1 when sent for order 2 (NotAuthorized)", async () => {
      const f = await loadFixture(twoFundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, 1, EBDN_KG, BDN_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(2, EBDN_KG, BDN_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized");
      expect(await f.delivery.hasEvidence(2)).to.equal(false);
    });
  });

  describe("mixed signed and direct paths", () => {
    it("meter by signature then e-BDN direct, within tolerance: DeliveryVerified and tranche released", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig);

      await expect(() =>
        f.delivery.connect(f.ebdnOracle).submitEBDN(ID, EBDN_KG, BDN_HASH),
      ).to.changeTokenBalances(f.token, [f.supplier], [FIRST_TRANCHE]);
      const o = await f.order.getOrder(ID);
      expect(o.status).to.equal(STATUS.QuantityApproved);
      expect(o.deliveredKg).to.equal(METER_KG);
      expect(o.payableAmount).to.equal(PAYABLE);
    });

    it("e-BDN direct then meter by signature, within tolerance: DeliveryVerified", async () => {
      const f = await loadFixture(fundedFixture);
      await f.delivery.connect(f.ebdnOracle).submitEBDN(ID, EBDN_KG, BDN_HASH);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, sig))
        .to.emit(f.delivery, "DeliveryVerified")
        .withArgs(ID, METER_KG);
      expect((await f.order.getOrder(ID)).status).to.equal(STATUS.QuantityApproved);
    });

    it("meter by signature then e-BDN direct, outside tolerance: QuantityMismatch and dispute", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, tonnes(500), BMT_HASH, deadline);
      await f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, tonnes(500), BMT_HASH, deadline, sig);
      await expect(f.delivery.connect(f.ebdnOracle).submitEBDN(ID, tonnes(490), BDN_HASH))
        .to.emit(f.delivery, "QuantityMismatch")
        .withArgs(ID, tonnes(500), tonnes(490));
      expect((await f.order.getOrder(ID)).status).to.equal(STATUS.Disputed);
    });

    it("e-BDN direct then meter by signature, outside tolerance: QuantityMismatch and dispute", async () => {
      const f = await loadFixture(fundedFixture);
      await f.delivery.connect(f.ebdnOracle).submitEBDN(ID, tonnes(490), BDN_HASH);
      const deadline = await futureDeadline();
      const sig = await signMeter(f, f.meterOracle, ID, tonnes(500), BMT_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, tonnes(500), BMT_HASH, deadline, sig))
        .to.emit(f.delivery, "QuantityMismatch")
        .withArgs(ID, tonnes(500), tonnes(490));
      expect((await f.order.getOrder(ID)).status).to.equal(STATUS.Disputed);
    });

    it("meter direct then e-BDN by signature, within tolerance: DeliveryVerified", async () => {
      const f = await loadFixture(fundedFixture);
      await f.delivery.connect(f.meterOracle).submitMeterReading(ID, METER_KG, BMT_HASH);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await expect(f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, sig))
        .to.emit(f.delivery, "DeliveryVerified")
        .withArgs(ID, METER_KG);
      expect((await f.order.getOrder(ID)).status).to.equal(STATUS.QuantityApproved);
    });

    it("e-BDN by signature then meter direct, outside tolerance: QuantityMismatch and dispute", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signEbdn(f, f.ebdnOracle, ID, tonnes(490), BDN_HASH, deadline);
      await f.delivery.connect(f.outsider).submitEBDNBySig(ID, tonnes(490), BDN_HASH, deadline, sig);
      await expect(f.delivery.connect(f.meterOracle).submitMeterReading(ID, tonnes(500), BMT_HASH))
        .to.emit(f.delivery, "QuantityMismatch")
        .withArgs(ID, tonnes(500), tonnes(490));
      expect((await f.order.getOrder(ID)).status).to.equal(STATUS.Disputed);
    });

    it("both submitted by signature through one relayer: verified, same balances as direct", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const mSig = await signMeter(f, f.meterOracle, ID, METER_KG, BMT_HASH, deadline);
      const eSig = await signEbdn(f, f.ebdnOracle, ID, EBDN_KG, BDN_HASH, deadline);
      await f.delivery.connect(f.outsider).submitMeterReadingBySig(ID, METER_KG, BMT_HASH, deadline, mSig);
      await expect(() =>
        f.delivery.connect(f.outsider).submitEBDNBySig(ID, EBDN_KG, BDN_HASH, deadline, eSig),
      ).to.changeTokenBalances(f.token, [f.supplier, f.escrow], [FIRST_TRANCHE, -FIRST_TRANCHE]);
      expect((await f.order.getOrder(ID)).status).to.equal(STATUS.QuantityApproved);
    });
  });

  describe("submitLabResultBySig", () => {
    it("lets an unregistered relayer submit a pass; lab is the signer; retention released like the direct path", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, ID, true, QTR_HASH, deadline);

      const tx = f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig);
      await expect(tx)
        .to.emit(f.quality, "LabResultSubmitted")
        .withArgs(ID, true, QTR_HASH, f.lab.address, DOC.QTR);
      await expect(tx).to.changeTokenBalances(
        f.token,
        [f.supplier, f.bank, f.escrow, f.outsider],
        [RETENTION, EXCESS, -ESCROW_AFTER_APPROVAL, 0n],
      );

      const r = await f.quality.getResult(ID);
      expect(r.submitted).to.equal(true);
      expect(r.passed).to.equal(true);
      expect(r.reportHash).to.equal(QTR_HASH);
      expect(r.lab).to.equal(f.lab.address);
      expect(r.submittedAt).to.be.gt(0n);

      const o = await f.order.getOrder(ID);
      expect(o.status).to.equal(STATUS.Settled);
      expect(o.releasedAmount).to.equal(PAYABLE);
      expect(o.refundedAmount).to.equal(EXCESS);
      expect(await f.escrow.balanceOf(ID)).to.equal(0n);
    });

    it("signed fail opens a QUALITY_FAIL dispute and keeps retention held, like the direct path", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, ID, false, QTR_HASH, deadline);

      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, false, QTR_HASH, deadline, sig))
        .to.emit(f.quality, "LabResultSubmitted")
        .withArgs(ID, false, QTR_HASH, f.lab.address, DOC.QTR)
        .and.to.emit(f.dispute, "DisputeOpened")
        .withArgs(1n, ID, REASON_QUALITY_FAIL, await f.order.getAddress())
        .and.to.emit(f.order, "OrderDisputed")
        .withArgs(ID, 1n);

      const o = await f.order.getOrder(ID);
      expect(o.status).to.equal(STATUS.Disputed);
      expect(o.disputeId).to.equal(1n);
      expect(await f.escrow.balanceOf(ID)).to.equal(ESCROW_AFTER_APPROVAL);
      expect(await f.token.balanceOf(f.supplier.address)).to.equal(FIRST_TRANCHE);
      const r = await f.quality.getResult(ID);
      expect(r.passed).to.equal(false);
      expect(r.lab).to.equal(f.lab.address);
    });

    it("reverts NotAuthorized when the signer is a registered non-lab (buyer)", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.buyer, ID, true, QTR_HASH, deadline);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "NotAuthorized")
        .withArgs(f.roles.LAB, f.buyer.address);
    });

    it("reverts NotAuthorized when the signer is an oracle rather than the lab", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.meterOracle, ID, true, QTR_HASH, deadline);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "NotAuthorized")
        .withArgs(f.roles.LAB, f.meterOracle.address);
    });

    it("reverts AccountSuspended when the signer is suspended", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, ID, true, QTR_HASH, deadline);
      await f.registry.suspend(f.lab.address);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "AccountSuspended")
        .withArgs(f.lab.address);
    });

    it("reverts SignatureExpired for a deadline already in the past", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = (await time.latest()) - 10;
      const sig = await signLab(f, f.lab, ID, true, QTR_HASH, deadline);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "SignatureExpired")
        .withArgs(deadline);
    });

    it("reverts SignatureExpired once time passes the deadline", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline(60);
      const sig = await signLab(f, f.lab, ID, true, QTR_HASH, deadline);
      await time.increaseTo(deadline + 1);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "SignatureExpired")
        .withArgs(deadline);
    });

    it("reverts NotAuthorized when the pass flag is flipped (signed fail sent as pass)", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, ID, false, QTR_HASH, deadline);
      await expect(
        f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.quality, "NotAuthorized");
      expect((await f.quality.getResult(ID)).submitted).to.equal(false);
    });

    it("reverts NotAuthorized when the report hash is tampered", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, ID, true, QTR_HASH, deadline);
      await expect(
        f.quality.connect(f.outsider).submitLabResultBySig(ID, true, OTHER_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.quality, "NotAuthorized");
    });

    it("reverts AlreadySubmitted when the same signature is sent twice", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, ID, true, QTR_HASH, deadline);
      await f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "AlreadySubmitted")
        .withArgs(ID, "lab");
    });

    it("reverts AlreadySubmitted when a signed result follows a direct one", async () => {
      const f = await loadFixture(approvedFixture);
      await f.quality.connect(f.lab).submitLabResult(ID, false, QTR_HASH);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, ID, true, QTR_HASH, deadline);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "AlreadySubmitted")
        .withArgs(ID, "lab");
    });

    it("reverts ECDSAInvalidSignatureLength for a malformed 10-byte signature", async () => {
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      await expect(
        f.quality
          .connect(f.outsider)
          .submitLabResultBySig(ID, true, QTR_HASH, deadline, ethers.hexlify(ethers.randomBytes(10))),
      )
        .to.be.revertedWithCustomError(f.quality, "ECDSAInvalidSignatureLength")
        .withArgs(10);
    });

    it("reverts InvalidState for a valid signature while the order is Funded", async () => {
      const f = await loadFixture(fundedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, ID, true, QTR_HASH, deadline);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "InvalidState")
        .withArgs(ID, STATUS.QuantityApproved, STATUS.Funded);
    });

    it("rejects a signature made for order 1 when sent for order 2 (NotAuthorized)", async () => {
      const f = await loadFixture(twoFundedFixture);
      const deadline = await futureDeadline();
      const sig = await signLab(f, f.lab, 1, true, QTR_HASH, deadline);
      await expect(f.quality.connect(f.outsider).submitLabResultBySig(2, true, QTR_HASH, deadline, sig))
        .to.be.revertedWithCustomError(f.quality, "NotAuthorized");
    });

    it("rejects a DeliveryRecord-domain signature sent to QualityRecord (NotAuthorized)", async () => {
      // Same struct shape is not needed: a lab signature built for the wrong verifying contract recovers another address.
      const f = await loadFixture(approvedFixture);
      const deadline = await futureDeadline();
      const wrongDomain = await domainOf(f.delivery);
      const sig = await (f.lab as any).signTypedData(wrongDomain, LAB_TYPES, {
        id: ID,
        passed: true,
        reportHash: QTR_HASH,
        deadline,
      });
      await expect(
        f.quality.connect(f.outsider).submitLabResultBySig(ID, true, QTR_HASH, deadline, sig),
      ).to.be.revertedWithCustomError(f.quality, "NotAuthorized");
    });
  });
});
