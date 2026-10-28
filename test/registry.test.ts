import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { PaymentEscrow } from "../typechain-types";
import { deployFixture, sgd, tonnes, DAY, ANCHORAGE, type Fixture } from "./helpers/fixtures";

const DSC_HASH = ethers.keccak256(ethers.toUtf8Bytes("DSC"));
const METER_HASH = ethers.keccak256(ethers.toUtf8Bytes("BMT"));
const EBDN_HASH = ethers.keccak256(ethers.toUtf8Bytes("BDN"));
const LAB_HASH = ethers.keccak256(ethers.toUtf8Bytes("QTR"));
const MANUAL_REASON = 3; // DisputeReason.MANUAL

/** Creates order 1 (buyer -> supplier, bank) and returns the transaction. */
async function createOrder(f: Fixture) {
  const deadline = (await time.latest()) + 7 * DAY;
  return f.order
    .connect(f.buyer)
    .createOrder({
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

/** Order 1 in `Funded` state. */
async function setupFunded(f: Fixture) {
  await createOrder(f);
  await f.order.connect(f.supplier).acceptOrder(1);
  await f.order.connect(f.bank).fundOrder(1);
}

/** Order 1 in `QuantityApproved` state (meter and e-BDN agree). */
async function setupQuantityApproved(f: Fixture) {
  await setupFunded(f);
  await f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500), METER_HASH);
  await f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500), EBDN_HASH);
}

/** Order 1 in `Disputed` state via a manual dispute opened by the buyer. */
async function setupDisputed(f: Fixture) {
  await setupFunded(f);
  await f.dispute.connect(f.buyer).openDispute(1, MANUAL_REASON);
}

describe("ParticipantRegistry", () => {
  describe("register / revoke / suspend / reinstate", () => {
    it("register emits ParticipantRegistered and records the name", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.registry.register(f.outsider.address, f.roles.BUYER, "Test Buyer"))
        .to.emit(f.registry, "ParticipantRegistered")
        .withArgs(f.outsider.address, f.roles.BUYER, "Test Buyer");
      expect(await f.registry.nameOf(f.outsider.address)).to.equal("Test Buyer");
      expect(await f.registry.hasActiveRole(f.roles.BUYER, f.outsider.address)).to.equal(true);
    });

    it("nameOf returns an empty string for an unregistered account", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.registry.nameOf(f.outsider.address)).to.equal("");
    });

    it("revoke emits ParticipantRevoked and removes the role", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.registry.revoke(f.supplier.address, f.roles.SUPPLIER))
        .to.emit(f.registry, "ParticipantRevoked")
        .withArgs(f.supplier.address, f.roles.SUPPLIER);
      expect(await f.registry.hasActiveRole(f.roles.SUPPLIER, f.supplier.address)).to.equal(false);
    });

    it("revoked supplier fails acceptOrder with NotAuthorized", async () => {
      const f = await loadFixture(deployFixture);
      await createOrder(f);
      await f.registry.revoke(f.supplier.address, f.roles.SUPPLIER);
      await expect(f.order.connect(f.supplier).acceptOrder(1))
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.SUPPLIER, f.supplier.address);
    });

    it("suspend emits ParticipantSuspended and makes hasActiveRole false while hasRole stays true", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.registry.suspend(f.supplier.address))
        .to.emit(f.registry, "ParticipantSuspended")
        .withArgs(f.supplier.address);
      expect(await f.registry.isSuspended(f.supplier.address)).to.equal(true);
      expect(await f.registry.hasActiveRole(f.roles.SUPPLIER, f.supplier.address)).to.equal(false);
      expect(await f.registry.hasRole(f.roles.SUPPLIER, f.supplier.address)).to.equal(true);
    });

    it("reinstate emits ParticipantReinstated and restores hasActiveRole", async () => {
      const f = await loadFixture(deployFixture);
      await f.registry.suspend(f.supplier.address);
      await expect(f.registry.reinstate(f.supplier.address))
        .to.emit(f.registry, "ParticipantReinstated")
        .withArgs(f.supplier.address);
      expect(await f.registry.isSuspended(f.supplier.address)).to.equal(false);
      expect(await f.registry.hasActiveRole(f.roles.SUPPLIER, f.supplier.address)).to.equal(true);
    });

    it("hasActiveRole is false for an account that never held the role", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.registry.hasActiveRole(f.roles.ARBITER, f.outsider.address)).to.equal(false);
      expect(await f.registry.hasActiveRole(f.roles.BUYER, f.supplier.address)).to.equal(false);
    });

    it("deployer holds ADMIN and is named Admin", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.registry.hasActiveRole(f.roles.ADMIN, f.admin.address)).to.equal(true);
      expect(await f.registry.nameOf(f.admin.address)).to.equal("Admin");
    });
  });

  describe("admin-only functions", () => {
    it("register by an outsider reverts NotAuthorized", async () => {
      const f = await loadFixture(deployFixture);
      await expect(
        f.registry.connect(f.outsider).register(f.outsider.address, f.roles.BUYER, "Impostor"),
      )
        .to.be.revertedWithCustomError(f.registry, "NotAuthorized")
        .withArgs(f.roles.ADMIN, f.outsider.address);
    });

    it("revoke by a non-admin participant reverts NotAuthorized", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.registry.connect(f.buyer).revoke(f.supplier.address, f.roles.SUPPLIER))
        .to.be.revertedWithCustomError(f.registry, "NotAuthorized")
        .withArgs(f.roles.ADMIN, f.buyer.address);
    });

    it("suspend by an outsider reverts NotAuthorized", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.registry.connect(f.outsider).suspend(f.supplier.address))
        .to.be.revertedWithCustomError(f.registry, "NotAuthorized")
        .withArgs(f.roles.ADMIN, f.outsider.address);
    });

    it("reinstate by an outsider reverts NotAuthorized", async () => {
      const f = await loadFixture(deployFixture);
      await f.registry.suspend(f.supplier.address);
      await expect(f.registry.connect(f.outsider).reinstate(f.supplier.address))
        .to.be.revertedWithCustomError(f.registry, "NotAuthorized")
        .withArgs(f.roles.ADMIN, f.outsider.address);
    });

    it("a suspended admin reverts AccountSuspended", async () => {
      const f = await loadFixture(deployFixture);
      await f.registry.suspend(f.admin.address);
      await expect(
        f.registry.connect(f.admin).register(f.outsider.address, f.roles.BUYER, "Test"),
      )
        .to.be.revertedWithCustomError(f.registry, "AccountSuspended")
        .withArgs(f.admin.address);
    });
  });

  describe("suspension blocks every role", () => {
    it("suspended BUYER reverts AccountSuspended on createOrder", async () => {
      const f = await loadFixture(deployFixture);
      await f.registry.suspend(f.buyer.address);
      const deadline = (await time.latest()) + 7 * DAY;
      await expect(
        f.order
          .connect(f.buyer)
          .createOrder({
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
          }),
      )
        .to.be.revertedWithCustomError(f.order, "AccountSuspended")
        .withArgs(f.buyer.address);
    });

    it("suspended SUPPLIER reverts AccountSuspended on acceptOrder", async () => {
      const f = await loadFixture(deployFixture);
      await createOrder(f);
      await f.registry.suspend(f.supplier.address);
      await expect(f.order.connect(f.supplier).acceptOrder(1))
        .to.be.revertedWithCustomError(f.order, "AccountSuspended")
        .withArgs(f.supplier.address);
    });

    it("suspended BANK reverts AccountSuspended on fundOrder", async () => {
      const f = await loadFixture(deployFixture);
      await createOrder(f);
      await f.order.connect(f.supplier).acceptOrder(1);
      await f.registry.suspend(f.bank.address);
      await expect(f.order.connect(f.bank).fundOrder(1))
        .to.be.revertedWithCustomError(f.order, "AccountSuspended")
        .withArgs(f.bank.address);
    });

    it("suspended METER_ORACLE reverts AccountSuspended on submitMeterReading", async () => {
      const f = await loadFixture(deployFixture);
      await setupFunded(f);
      await f.registry.suspend(f.meterOracle.address);
      await expect(f.delivery.connect(f.meterOracle).submitMeterReading(1, tonnes(500), METER_HASH))
        .to.be.revertedWithCustomError(f.delivery, "AccountSuspended")
        .withArgs(f.meterOracle.address);
    });

    it("suspended EBDN_ORACLE reverts AccountSuspended on submitEBDN", async () => {
      const f = await loadFixture(deployFixture);
      await setupFunded(f);
      await f.registry.suspend(f.ebdnOracle.address);
      await expect(f.delivery.connect(f.ebdnOracle).submitEBDN(1, tonnes(500), EBDN_HASH))
        .to.be.revertedWithCustomError(f.delivery, "AccountSuspended")
        .withArgs(f.ebdnOracle.address);
    });

    it("suspended LAB reverts AccountSuspended on submitLabResult", async () => {
      const f = await loadFixture(deployFixture);
      await setupQuantityApproved(f);
      await f.registry.suspend(f.lab.address);
      await expect(f.quality.connect(f.lab).submitLabResult(1, true, LAB_HASH))
        .to.be.revertedWithCustomError(f.quality, "AccountSuspended")
        .withArgs(f.lab.address);
    });

    it("suspended ARBITER reverts AccountSuspended on resolve", async () => {
      const f = await loadFixture(deployFixture);
      await setupDisputed(f);
      await f.registry.suspend(f.arbiter.address);
      await expect(f.dispute.connect(f.arbiter).resolve(1, 7000))
        .to.be.revertedWithCustomError(f.dispute, "AccountSuspended")
        .withArgs(f.arbiter.address);
    });

    it("a reinstated SUPPLIER can accept the order again", async () => {
      const f = await loadFixture(deployFixture);
      await createOrder(f);
      await f.registry.suspend(f.supplier.address);
      await expect(f.order.connect(f.supplier).acceptOrder(1))
        .to.be.revertedWithCustomError(f.order, "AccountSuspended")
        .withArgs(f.supplier.address);

      await f.registry.reinstate(f.supplier.address);
      await expect(f.order.connect(f.supplier).acceptOrder(1)).to.emit(f.order, "OrderAccepted");
      expect((await f.order.getOrder(1)).status).to.equal(1n); // Accepted
    });

    it("a reinstated BUYER can create an order again", async () => {
      const f = await loadFixture(deployFixture);
      await f.registry.suspend(f.buyer.address);
      await f.registry.reinstate(f.buyer.address);
      await expect(createOrder(f)).to.emit(f.order, "OrderCreated");
      expect(await f.order.orderCount()).to.equal(1n);
    });
  });

  describe("outsider and wrong-role callers", () => {
    it("outsider createOrder reverts NotAuthorized(BUYER)", async () => {
      const f = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + 7 * DAY;
      await expect(
        f.order
          .connect(f.outsider)
          .createOrder({
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
          }),
      )
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.BUYER, f.outsider.address);
    });

    it("buyer calling acceptOrder reverts NotAuthorized(SUPPLIER)", async () => {
      const f = await loadFixture(deployFixture);
      await createOrder(f);
      await expect(f.order.connect(f.buyer).acceptOrder(1))
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.SUPPLIER, f.buyer.address);
    });

    it("outsider fundOrder reverts NotAuthorized(BANK)", async () => {
      const f = await loadFixture(deployFixture);
      await createOrder(f);
      await f.order.connect(f.supplier).acceptOrder(1);
      await expect(f.order.connect(f.outsider).fundOrder(1))
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.BANK, f.outsider.address);
    });

    it("outsider submitMeterReading reverts NotAuthorized(METER_ORACLE)", async () => {
      const f = await loadFixture(deployFixture);
      await setupFunded(f);
      await expect(f.delivery.connect(f.outsider).submitMeterReading(1, tonnes(500), METER_HASH))
        .to.be.revertedWithCustomError(f.delivery, "NotAuthorized")
        .withArgs(f.roles.METER_ORACLE, f.outsider.address);
    });

    it("outsider submitLabResult reverts NotAuthorized(LAB)", async () => {
      const f = await loadFixture(deployFixture);
      await setupQuantityApproved(f);
      await expect(f.quality.connect(f.outsider).submitLabResult(1, true, LAB_HASH))
        .to.be.revertedWithCustomError(f.quality, "NotAuthorized")
        .withArgs(f.roles.LAB, f.outsider.address);
    });

    it("outsider resolve reverts NotAuthorized(ARBITER)", async () => {
      const f = await loadFixture(deployFixture);
      await setupDisputed(f);
      await expect(f.dispute.connect(f.outsider).resolve(1, 7000))
        .to.be.revertedWithCustomError(f.dispute, "NotAuthorized")
        .withArgs(f.roles.ARBITER, f.outsider.address);
    });
  });
});

describe("MockSGD", () => {
  it("has 18 decimals and symbol mSGD", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.token.decimals()).to.equal(18n);
    expect(await f.token.symbol()).to.equal("mSGD");
  });

  it("admin can mint", async () => {
    const f = await loadFixture(deployFixture);
    const before = await f.token.balanceOf(f.outsider.address);
    await f.token.mint(f.outsider.address, sgd(250));
    expect(await f.token.balanceOf(f.outsider.address)).to.equal(before + sgd(250));
  });

  it("non-admin mint reverts NotAuthorized(ADMIN)", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.token.connect(f.buyer).mint(f.buyer.address, sgd(1)))
      .to.be.revertedWithCustomError(f.token, "NotAuthorized")
      .withArgs(f.roles.ADMIN, f.buyer.address);
  });

  it("suspended admin mint reverts AccountSuspended", async () => {
    const f = await loadFixture(deployFixture);
    await f.registry.suspend(f.admin.address);
    await expect(f.token.mint(f.admin.address, sgd(1)))
      .to.be.revertedWithCustomError(f.token, "AccountSuspended")
      .withArgs(f.admin.address);
  });
});

describe("PaymentEscrow access control", () => {
  it("deposit from an EOA reverts OnlyModule", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.escrow.connect(f.outsider).deposit(1, f.outsider.address, 1))
      .to.be.revertedWithCustomError(f.escrow, "OnlyModule")
      .withArgs(f.outsider.address);
  });

  it("release from an EOA reverts OnlyModule", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.escrow.connect(f.outsider).release(1, f.outsider.address, 1))
      .to.be.revertedWithCustomError(f.escrow, "OnlyModule")
      .withArgs(f.outsider.address);
  });

  it("refund from an EOA reverts OnlyModule", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.escrow.connect(f.outsider).refund(1, f.outsider.address, 1))
      .to.be.revertedWithCustomError(f.escrow, "OnlyModule")
      .withArgs(f.outsider.address);
  });

  it("split from an EOA reverts OnlyModule", async () => {
    const f = await loadFixture(deployFixture);
    await expect(
      f.escrow
        .connect(f.outsider)
        .split(1, f.supplier.address, 1, f.bank.address, 1),
    )
      .to.be.revertedWithCustomError(f.escrow, "OnlyModule")
      .withArgs(f.outsider.address);
  });

  it("setOrderContract by a non-admin reverts NotAuthorized on an unwired escrow", async () => {
    const f = await loadFixture(deployFixture);
    const fresh: PaymentEscrow = await ethers.deployContract("PaymentEscrow", [
      await f.registry.getAddress(),
      await f.token.getAddress(),
    ]);
    await expect(fresh.connect(f.outsider).setOrderContract(f.outsider.address))
      .to.be.revertedWithCustomError(fresh, "NotAuthorized")
      .withArgs(f.roles.ADMIN, f.outsider.address);
  });

  it("setDisputeManager by a non-admin reverts NotAuthorized on an unwired escrow", async () => {
    const f = await loadFixture(deployFixture);
    const fresh: PaymentEscrow = await ethers.deployContract("PaymentEscrow", [
      await f.registry.getAddress(),
      await f.token.getAddress(),
    ]);
    await expect(fresh.connect(f.buyer).setDisputeManager(f.buyer.address))
      .to.be.revertedWithCustomError(fresh, "NotAuthorized")
      .withArgs(f.roles.ADMIN, f.buyer.address);
  });

  it("setOrderContract by admin wires once, then reverts AlreadyWired", async () => {
    const f = await loadFixture(deployFixture);
    const fresh: PaymentEscrow = await ethers.deployContract("PaymentEscrow", [
      await f.registry.getAddress(),
      await f.token.getAddress(),
    ]);
    await expect(fresh.setOrderContract(await f.order.getAddress()))
      .to.emit(fresh, "OrderContractSet")
      .withArgs(await f.order.getAddress());
    await expect(fresh.setOrderContract(f.outsider.address)).to.be.revertedWithCustomError(
      fresh,
      "AlreadyWired",
    );
  });

  it("setDisputeManager by admin wires once, then reverts AlreadyWired", async () => {
    const f = await loadFixture(deployFixture);
    const fresh: PaymentEscrow = await ethers.deployContract("PaymentEscrow", [
      await f.registry.getAddress(),
      await f.token.getAddress(),
    ]);
    await expect(fresh.setDisputeManager(await f.dispute.getAddress()))
      .to.emit(fresh, "DisputeManagerSet")
      .withArgs(await f.dispute.getAddress());
    await expect(fresh.setDisputeManager(f.outsider.address)).to.be.revertedWithCustomError(
      fresh,
      "AlreadyWired",
    );
  });

  it("wired escrow rejects a second setOrderContract and setDisputeManager with AlreadyWired", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.escrow.setOrderContract(f.admin.address)).to.be.revertedWithCustomError(
      f.escrow,
      "AlreadyWired",
    );
    await expect(f.escrow.setDisputeManager(f.admin.address)).to.be.revertedWithCustomError(
      f.escrow,
      "AlreadyWired",
    );
  });

  it("zero-address wiring reverts InvalidParameter", async () => {
    const f = await loadFixture(deployFixture);
    const fresh: PaymentEscrow = await ethers.deployContract("PaymentEscrow", [
      await f.registry.getAddress(),
      await f.token.getAddress(),
    ]);
    await expect(fresh.setOrderContract(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(fresh, "InvalidParameter")
      .withArgs("orderContract");
  });
});

describe("BunkerOrder admin guards", () => {
  it("setModules by a non-admin reverts NotAuthorized", async () => {
    const f = await loadFixture(deployFixture);
    await expect(
      f.order
        .connect(f.outsider)
        .setModules(f.outsider.address, f.outsider.address, f.outsider.address),
    )
      .to.be.revertedWithCustomError(f.order, "NotAuthorized")
      .withArgs(f.roles.ADMIN, f.outsider.address);
  });

  it("pause by a non-admin reverts NotAuthorized", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.order.connect(f.buyer).pause())
      .to.be.revertedWithCustomError(f.order, "NotAuthorized")
      .withArgs(f.roles.ADMIN, f.buyer.address);
  });

  it("unpause by a non-admin reverts NotAuthorized", async () => {
    const f = await loadFixture(deployFixture);
    await f.order.pause();
    await expect(f.order.connect(f.outsider).unpause())
      .to.be.revertedWithCustomError(f.order, "NotAuthorized")
      .withArgs(f.roles.ADMIN, f.outsider.address);
  });

  it("admin pause blocks createOrder and unpause restores it", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.order.pause()).to.emit(f.order, "Paused").withArgs(f.admin.address);
    await expect(createOrder(f)).to.be.revertedWithCustomError(f.order, "EnforcedPause");
    await expect(f.order.unpause()).to.emit(f.order, "Unpaused").withArgs(f.admin.address);
    await expect(createOrder(f)).to.emit(f.order, "OrderCreated");
  });
});
