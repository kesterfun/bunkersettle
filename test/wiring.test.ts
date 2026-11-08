import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFixture, sgd, tonnes, DAY, ANCHORAGE } from "./helpers/fixtures";

describe("wiring (milestone 2 smoke)", () => {
  it("wires the modules to the expected addresses", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.escrow.orderContract()).to.equal(await f.order.getAddress());
    expect(await f.escrow.disputeManager()).to.equal(await f.dispute.getAddress());
    expect(await f.order.deliveryRecord()).to.equal(await f.delivery.getAddress());
    expect(await f.order.qualityRecord()).to.equal(await f.quality.getAddress());
    expect(await f.order.disputeManager()).to.equal(await f.dispute.getAddress());
    expect(await f.delivery.order()).to.equal(await f.order.getAddress());
    expect(await f.order.claim()).to.equal(await f.claim.getAddress());
    expect(await f.claim.order()).to.equal(await f.order.getAddress());
    expect(await f.claim.token()).to.equal(await f.token.getAddress());
  });

  it("reverts AlreadyWired when a setter is called twice", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.escrow.setOrderContract(f.admin.address)).to.be.revertedWithCustomError(
      f.escrow,
      "AlreadyWired",
    );
    await expect(f.escrow.setDisputeManager(f.admin.address)).to.be.revertedWithCustomError(
      f.escrow,
      "AlreadyWired",
    );
    await expect(
      f.order.setModules(f.admin.address, f.admin.address, f.admin.address),
    ).to.be.revertedWithCustomError(f.order, "AlreadyWired");
  });

  it("registers the demo participants and leaves the outsider unregistered", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.registry.hasActiveRole(f.roles.BUYER, f.buyer.address)).to.equal(true);
    expect(await f.registry.hasActiveRole(f.roles.SUPPLIER, f.supplier.address)).to.equal(true);
    expect(await f.registry.hasActiveRole(f.roles.BANK, f.bank.address)).to.equal(true);
    expect(await f.registry.hasActiveRole(f.roles.ARBITER, f.arbiter.address)).to.equal(true);
    expect(await f.registry.nameOf(f.supplier.address)).to.equal("Lion Bunkers");
    expect(await f.registry.hasActiveRole(f.roles.BUYER, f.outsider.address)).to.equal(false);
  });

  it("rejects hook calls from an EOA with OnlyModule", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.order.connect(f.outsider).onQuantityMismatch(1))
      .to.be.revertedWithCustomError(f.order, "OnlyModule")
      .withArgs(f.outsider.address);
  });

  it("creates an order through the wired contracts (happy path)", async () => {
    const f = await loadFixture(deployFixture);
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
          dscHash: ethers.keccak256(ethers.toUtf8Bytes("DSC")),
          anchorage: ANCHORAGE.EASTERN_PETROLEUM_B,
        }),
    ).to.emit(f.order, "OrderCreated");
    expect(await f.order.orderCount()).to.equal(1n);
    const o = await f.order.getOrder(1);
    expect(o.status).to.equal(0n);
    expect(o.buyer).to.equal(f.buyer.address);
  });
});
