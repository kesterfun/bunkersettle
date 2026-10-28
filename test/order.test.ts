import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
  setBalance,
  impersonateAccount,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFixture, sgd, tonnes, DAY, ANCHORAGE } from "./helpers/fixtures";
import type { Fixture } from "./helpers/fixtures";

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

const DOC_DSC = 0n;
const QTY = tonnes(500); // 500_000 kg
const PRICE = sgd(980);
const TOL = 50;
const RET = 1000;
const WINDOW = 120;
// 500 t * 980 mSGD/t = 490_000 mSGD; * (10_000 + 50) / 10_000 = 492_450 mSGD
const FUNDED = sgd(492450);
const DSC_HASH = ethers.keccak256(ethers.toUtf8Bytes("DSC-1"));

type Overrides = Partial<{
  supplier: string;
  bank: string;
  fuelGrade: string;
  qtyKg: bigint;
  pricePerTonne: bigint;
  toleranceBps: number;
  retentionBps: number;
  deadline: number;
  anchorage: number;
}>;

/** Calls createOrder with the SPEC 9 defaults, overridden per field. Returns the tx promise. */
async function tryCreate(f: Fixture, o: Overrides = {}, caller = f.buyer) {
  const deadline = o.deadline ?? (await time.latest()) + 7 * DAY;
  return f.order
    .connect(caller)
    .createOrder({
      supplier: o.supplier ?? f.supplier.address,
      bank: o.bank ?? f.bank.address,
      fuelGrade: o.fuelGrade ?? "VLSFO",
      qtyKg: o.qtyKg ?? QTY,
      pricePerTonne: o.pricePerTonne ?? PRICE,
      toleranceBps: o.toleranceBps ?? TOL,
      retentionBps: o.retentionBps ?? RET,
      deliveryDeadline: deadline,
      retentionWindow: WINDOW,
      dscHash: DSC_HASH,
      anchorage: o.anchorage ?? ANCHORAGE.EASTERN_PETROLEUM_B,
    });
}

/** Creates a default order as the buyer and returns its id. */
async function createOrder(f: Fixture, deadline?: number): Promise<bigint> {
  const d = deadline ?? (await time.latest()) + 7 * DAY;
  await tryCreate(f, { deadline: d });
  return f.order.orderCount();
}

async function createAccepted(f: Fixture, deadline?: number): Promise<bigint> {
  const id = await createOrder(f, deadline);
  await f.order.connect(f.supplier).acceptOrder(id);
  return id;
}

async function createFunded(f: Fixture, deadline?: number): Promise<bigint> {
  const id = await createAccepted(f, deadline);
  await f.order.connect(f.bank).fundOrder(id);
  return id;
}

/** A fresh, funded EOA that is not part of the fixture. */
async function freshAccount() {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
  await setBalance(wallet.address, ethers.parseEther("10"));
  return wallet;
}

/** Impersonates a wired module contract so it can call the BunkerOrder hooks. */
async function asModule(address: string) {
  await impersonateAccount(address);
  await setBalance(address, ethers.parseEther("10"));
  return ethers.getSigner(address);
}

describe("BunkerOrder lifecycle before delivery", () => {
  describe("createOrder", () => {
    it("emits OrderCreated and stores every field with status Created", async () => {
      const f = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + 7 * DAY;
      await expect(
        f.order
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
            dscHash: DSC_HASH,
            anchorage: ANCHORAGE.EASTERN_PETROLEUM_B,
          }),
      )
        .to.emit(f.order, "OrderCreated")
        .withArgs(1n, f.buyer.address, f.supplier.address, f.bank.address, QTY, PRICE, DSC_HASH, DOC_DSC, ANCHORAGE.EASTERN_PETROLEUM_B);

      const o = await f.order.getOrder(1);
      expect(o.id).to.equal(1n);
      expect(o.buyer).to.equal(f.buyer.address);
      expect(o.supplier).to.equal(f.supplier.address);
      expect(o.bank).to.equal(f.bank.address);
      expect(o.fuelGrade).to.equal("VLSFO");
      expect(o.qtyKg).to.equal(QTY);
      expect(o.pricePerTonne).to.equal(PRICE);
      expect(o.toleranceBps).to.equal(BigInt(TOL));
      expect(o.retentionBps).to.equal(BigInt(RET));
      expect(o.deliveryDeadline).to.equal(BigInt(deadline));
      expect(o.retentionWindow).to.equal(BigInt(WINDOW));
      expect(o.fundedAmount).to.equal(0n);
      expect(o.deliveredKg).to.equal(0n);
      expect(o.payableAmount).to.equal(0n);
      expect(o.releasedAmount).to.equal(0n);
      expect(o.approvedAt).to.equal(0n);
      expect(o.status).to.equal(S.Created);
      expect(o.disputeId).to.equal(0n);
      expect(o.dscHash).to.equal(DSC_HASH);
      expect(o.refundedAmount).to.equal(0n);
      expect(o.anchorage).to.equal(BigInt(ANCHORAGE.EASTERN_PETROLEUM_B));
      expect(await f.order.orderCount()).to.equal(1n);
    });

    it("increments ids for successive orders", async () => {
      const f = await loadFixture(deployFixture);
      await tryCreate(f);
      await expect(tryCreate(f))
        .to.emit(f.order, "OrderCreated")
        .withArgs(2n, f.buyer.address, f.supplier.address, f.bank.address, QTY, PRICE, DSC_HASH, DOC_DSC, ANCHORAGE.EASTERN_PETROLEUM_B);
      expect(await f.order.orderCount()).to.equal(2n);
    });

    it("accepts the boundary values tolerance 500 bps and retention 5000 bps", async () => {
      const f = await loadFixture(deployFixture);
      await tryCreate(f, { toleranceBps: 500, retentionBps: 5000 });
      const o = await f.order.getOrder(1);
      expect(o.toleranceBps).to.equal(500n);
      expect(o.retentionBps).to.equal(5000n);
    });

    it("stores and emits each anchorage, including the last enum value", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { anchorage: ANCHORAGE.WESTERN_PETROLEUM_A }))
        .to.emit(f.order, "OrderCreated")
        .withArgs(
          1n, f.buyer.address, f.supplier.address, f.bank.address, QTY, PRICE, DSC_HASH, DOC_DSC,
          ANCHORAGE.WESTERN_PETROLEUM_A,
        );
      await tryCreate(f, { anchorage: ANCHORAGE.EASTERN_PETROLEUM_B });
      expect((await f.order.getOrder(1)).anchorage).to.equal(BigInt(ANCHORAGE.WESTERN_PETROLEUM_A));
      expect((await f.order.getOrder(2)).anchorage).to.equal(BigInt(ANCHORAGE.EASTERN_PETROLEUM_B));
    });

    it("reverts InvalidParameter(anchorage) for a value outside the Anchorage enum", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { anchorage: ANCHORAGE.EASTERN_PETROLEUM_B + 1 }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("anchorage");
    });

    it("reverts InvalidParameter(qtyKg) when quantity is zero", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { qtyKg: 0n }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("qtyKg");
    });

    it("reverts InvalidParameter(pricePerTonne) when price is zero", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { pricePerTonne: 0n }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("pricePerTonne");
    });

    it("reverts InvalidParameter(toleranceBps) when tolerance exceeds 500 bps", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { toleranceBps: 501 }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("toleranceBps");
    });

    it("reverts InvalidParameter(retentionBps) when retention exceeds 5000 bps", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { retentionBps: 5001 }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("retentionBps");
    });

    it("reverts InvalidParameter(fuelGrade) when the fuel grade is empty", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { fuelGrade: "" }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("fuelGrade");
    });

    it("reverts InvalidParameter(supplier) when the supplier lacks the SUPPLIER role", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { supplier: f.outsider.address }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("supplier");
    });

    it("reverts InvalidParameter(bank) when the bank lacks the BANK role", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, { bank: f.supplier.address }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("bank");
    });

    it("reverts InvalidParameter(deliveryDeadline) when the deadline is already past", async () => {
      const f = await loadFixture(deployFixture);
      const past = (await time.latest()) - DAY;
      await expect(tryCreate(f, { deadline: past }))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("deliveryDeadline");
    });

    it("reverts NotAuthorized when an outsider (unregistered) creates an order", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, {}, f.outsider))
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.BUYER, f.outsider.address);
    });

    it("reverts NotAuthorized when a supplier (non-buyer) creates an order", async () => {
      const f = await loadFixture(deployFixture);
      await expect(tryCreate(f, {}, f.supplier))
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.BUYER, f.supplier.address);
    });
  });

  describe("acceptOrder", () => {
    it("moves Created to Accepted and emits OrderAccepted", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await expect(f.order.connect(f.supplier).acceptOrder(id))
        .to.emit(f.order, "OrderAccepted")
        .withArgs(id, f.supplier.address);
      expect((await f.order.getOrder(id)).status).to.equal(S.Accepted);
    });

    it("reverts NotAuthorized when a buyer (non-supplier) accepts", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await expect(f.order.connect(f.buyer).acceptOrder(id))
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.SUPPLIER, f.buyer.address);
    });

    it("reverts NotOrderParty when a second registered supplier accepts", async () => {
      const f = await loadFixture(deployFixture);
      const signers = await ethers.getSigners();
      const otherSupplier = signers[9];
      await f.registry.register(otherSupplier.address, f.roles.SUPPLIER, "Other Supplier");
      const id = await createOrder(f);
      await expect(f.order.connect(otherSupplier).acceptOrder(id))
        .to.be.revertedWithCustomError(f.order, "NotOrderParty")
        .withArgs(id, otherSupplier.address);
    });

    it("reverts InvalidState when accepting twice", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await expect(f.order.connect(f.supplier).acceptOrder(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Created, S.Accepted);
    });

    it("reverts InvalidState when accepting a cancelled order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await f.order.connect(f.buyer).cancelOrder(id);
      await expect(f.order.connect(f.supplier).acceptOrder(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Created, S.Cancelled);
    });

    it("reverts DeadlinePassed when accepting after the deadline", async () => {
      const f = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + DAY;
      const id = await createOrder(f, deadline);
      await time.increaseTo(deadline + 1);
      await expect(f.order.connect(f.supplier).acceptOrder(id))
        .to.be.revertedWithCustomError(f.order, "DeadlinePassed")
        .withArgs(id);
    });

    it("reverts InvalidParameter(orderId) for an unknown order id", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.connect(f.supplier).acceptOrder(99))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("orderId");
    });
  });

  describe("fundOrder", () => {
    it("pulls the tolerance-adjusted amount from the bank into escrow", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await expect(f.order.connect(f.bank).fundOrder(id)).to.changeTokenBalances(
        f.token,
        [f.bank, f.escrow],
        [-FUNDED, FUNDED],
      );
      expect(await f.escrow.balanceOf(id)).to.equal(FUNDED);
      const o = await f.order.getOrder(id);
      expect(o.fundedAmount).to.equal(FUNDED);
      expect(o.status).to.equal(S.Funded);
    });

    it("emits OrderFunded with the escrowed amount", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await expect(f.order.connect(f.bank).fundOrder(id))
        .to.emit(f.order, "OrderFunded")
        .withArgs(id, f.bank.address, FUNDED);
    });

    it("reverts NotAuthorized when a supplier (non-bank) funds", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await expect(f.order.connect(f.supplier).fundOrder(id))
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.BANK, f.supplier.address);
    });

    it("reverts NotOrderParty when a second registered bank funds", async () => {
      const f = await loadFixture(deployFixture);
      const otherBank = await freshAccount();
      await f.registry.register(otherBank.address, f.roles.BANK, "Other Bank");
      const id = await createAccepted(f);
      await expect(f.order.connect(otherBank).fundOrder(id))
        .to.be.revertedWithCustomError(f.order, "NotOrderParty")
        .withArgs(id, otherBank.address);
    });

    it("reverts InvalidState when funding before acceptance", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await expect(f.order.connect(f.bank).fundOrder(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Accepted, S.Created);
    });

    it("reverts InvalidState when funding twice", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      await expect(f.order.connect(f.bank).fundOrder(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Accepted, S.Funded);
    });

    it("reverts InvalidState when funding a cancelled order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await f.order.connect(f.buyer).cancelOrder(id);
      await expect(f.order.connect(f.bank).fundOrder(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Accepted, S.Cancelled);
    });

    it("reverts DeadlinePassed when funding after the deadline", async () => {
      const f = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + DAY;
      const id = await createAccepted(f, deadline);
      await time.increaseTo(deadline + 1);
      await expect(f.order.connect(f.bank).fundOrder(id))
        .to.be.revertedWithCustomError(f.order, "DeadlinePassed")
        .withArgs(id);
    });
  });

  describe("cancelOrder (buyer)", () => {
    it("cancels a Created order and emits OrderCancelled with zero refund", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await expect(f.order.connect(f.buyer).cancelOrder(id))
        .to.emit(f.order, "OrderCancelled")
        .withArgs(id, f.buyer.address, 0n);
      expect((await f.order.getOrder(id)).status).to.equal(S.Cancelled);
    });

    it("cancels an Accepted order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await expect(f.order.connect(f.buyer).cancelOrder(id))
        .to.emit(f.order, "OrderCancelled")
        .withArgs(id, f.buyer.address, 0n);
      expect((await f.order.getOrder(id)).status).to.equal(S.Cancelled);
    });

    it("reverts InvalidState when cancelling a Funded order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      await expect(f.order.connect(f.buyer).cancelOrder(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Created, S.Funded);
    });

    it("reverts InvalidState when cancelling an already cancelled order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await f.order.connect(f.buyer).cancelOrder(id);
      await expect(f.order.connect(f.buyer).cancelOrder(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Created, S.Cancelled);
    });

    it("reverts NotAuthorized when an outsider cancels", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await expect(f.order.connect(f.outsider).cancelOrder(id))
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.BUYER, f.outsider.address);
    });

    it("reverts NotOrderParty when a second registered buyer cancels", async () => {
      const f = await loadFixture(deployFixture);
      const otherBuyer = await freshAccount();
      await f.registry.register(otherBuyer.address, f.roles.BUYER, "Other Buyer");
      const id = await createOrder(f);
      await expect(f.order.connect(otherBuyer).cancelOrder(id))
        .to.be.revertedWithCustomError(f.order, "NotOrderParty")
        .withArgs(id, otherBuyer.address);
    });
  });

  describe("cancelExpired", () => {
    it("reverts DeadlineNotReached before the deadline", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      await expect(f.order.connect(f.outsider).cancelExpired(id))
        .to.be.revertedWithCustomError(f.order, "DeadlineNotReached")
        .withArgs(id);
    });

    it("cancels after the deadline with no evidence and refunds the bank in full", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      const deadline = (await f.order.getOrder(id)).deliveryDeadline;
      await time.increaseTo(deadline + 1n);
      await expect(f.order.connect(f.outsider).cancelExpired(id)).to.changeTokenBalances(
        f.token,
        [f.bank, f.escrow],
        [FUNDED, -FUNDED],
      );
      expect(await f.escrow.balanceOf(id)).to.equal(0n);
      expect(await f.order.heldAmount(id)).to.equal(0n);
      expect((await f.order.getOrder(id)).status).to.equal(S.Cancelled);
    });

    it("emits OrderCancelled with the refunded amount and the caller", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      const deadline = (await f.order.getOrder(id)).deliveryDeadline;
      await time.increaseTo(deadline + 1n);
      await expect(f.order.connect(f.outsider).cancelExpired(id))
        .to.emit(f.order, "OrderCancelled")
        .withArgs(id, f.outsider.address, FUNDED);
    });

    it("reverts InvalidState when the order is Accepted, not Funded", async () => {
      const f = await loadFixture(deployFixture);
      const deadline = (await time.latest()) + DAY;
      const id = await createAccepted(f, deadline);
      await time.increaseTo(deadline + 1);
      await expect(f.order.connect(f.outsider).cancelExpired(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Funded, S.Accepted);
    });

    it("reverts InvalidState when the order is only Created", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await expect(f.order.connect(f.outsider).cancelExpired(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Funded, S.Created);
    });
  });

  describe("releaseAfterTimeout and other wrong-state calls", () => {
    it("reverts InvalidState when releaseAfterTimeout is called on a Funded order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      await expect(f.order.connect(f.outsider).releaseAfterTimeout(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.QuantityApproved, S.Funded);
    });

    it("reverts InvalidState when releaseAfterTimeout is called on a Created order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      await expect(f.order.connect(f.outsider).releaseAfterTimeout(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.QuantityApproved, S.Created);
    });

    it("reverts InvalidParameter(orderId) for an unknown order in cancelExpired", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.connect(f.outsider).cancelExpired(42))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("orderId");
    });
  });

  describe("module hooks in the wrong state (called as a wired module)", () => {
    it("onDeliveryVerified on a Created order reverts InvalidState", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      const delivery = await asModule(await f.delivery.getAddress());
      await expect(f.order.connect(delivery).onDeliveryVerified(id, QTY))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Funded, S.Created);
    });

    it("onQuantityMismatch on a Created order reverts InvalidState", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      const delivery = await asModule(await f.delivery.getAddress());
      await expect(f.order.connect(delivery).onQuantityMismatch(id))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Funded, S.Created);
    });

    it("onLabResult on a Funded order reverts InvalidState", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      const quality = await asModule(await f.quality.getAddress());
      await expect(f.order.connect(quality).onLabResult(id, true))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.QuantityApproved, S.Funded);
    });

    it("onDisputeOpened on a Created order reverts InvalidState", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createOrder(f);
      const dispute = await asModule(await f.dispute.getAddress());
      await expect(f.order.connect(dispute).onDisputeOpened(id, 1))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Funded, S.Created);
    });

    it("onDisputeResolved on a Funded order reverts InvalidState", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      const dispute = await asModule(await f.dispute.getAddress());
      await expect(f.order.connect(dispute).onDisputeResolved(id, 0, 0))
        .to.be.revertedWithCustomError(f.order, "InvalidState")
        .withArgs(id, S.Disputed, S.Funded);
    });
  });

  describe("hooks called directly from an EOA", () => {
    it("onDeliveryVerified reverts OnlyModule", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.connect(f.outsider).onDeliveryVerified(1, QTY))
        .to.be.revertedWithCustomError(f.order, "OnlyModule")
        .withArgs(f.outsider.address);
    });

    it("onQuantityMismatch reverts OnlyModule", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.connect(f.outsider).onQuantityMismatch(1))
        .to.be.revertedWithCustomError(f.order, "OnlyModule")
        .withArgs(f.outsider.address);
    });

    it("onLabResult reverts OnlyModule", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.connect(f.outsider).onLabResult(1, true))
        .to.be.revertedWithCustomError(f.order, "OnlyModule")
        .withArgs(f.outsider.address);
    });

    it("onDisputeOpened reverts OnlyModule", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.connect(f.outsider).onDisputeOpened(1, 1))
        .to.be.revertedWithCustomError(f.order, "OnlyModule")
        .withArgs(f.outsider.address);
    });

    it("onDisputeResolved reverts OnlyModule", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.connect(f.outsider).onDisputeResolved(1, 0, 0))
        .to.be.revertedWithCustomError(f.order, "OnlyModule")
        .withArgs(f.outsider.address);
    });
  });

  describe("pause", () => {
    it("reverts NotAuthorized when a non-admin pauses", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.connect(f.buyer).pause())
        .to.be.revertedWithCustomError(f.order, "NotAuthorized")
        .withArgs(f.roles.ADMIN, f.buyer.address);
    });

    it("blocks createOrder and fundOrder while paused", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await f.order.connect(f.admin).pause();
      await expect(tryCreate(f)).to.be.revertedWithCustomError(f.order, "EnforcedPause");
      await expect(f.order.connect(f.bank).fundOrder(id)).to.be.revertedWithCustomError(
        f.order,
        "EnforcedPause",
      );
    });

    it("restores createOrder and fundOrder after unpause", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await f.order.connect(f.admin).pause();
      await f.order.connect(f.admin).unpause();
      await tryCreate(f);
      expect(await f.order.orderCount()).to.equal(2n);
      await f.order.connect(f.bank).fundOrder(id);
      expect((await f.order.getOrder(id)).status).to.equal(S.Funded);
    });
  });

  describe("views", () => {
    it("orderCount is zero before any order and tracks creations", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.order.orderCount()).to.equal(0n);
      await createOrder(f);
      expect(await f.order.orderCount()).to.equal(1n);
    });

    it("getOrder reverts InvalidParameter(orderId) for ids 0 and beyond the count", async () => {
      const f = await loadFixture(deployFixture);
      await createOrder(f);
      await expect(f.order.getOrder(0))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("orderId");
      await expect(f.order.getOrder(2))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("orderId");
    });

    it("heldAmount equals the funded amount while Funded and zero after cancelExpired", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createFunded(f);
      expect(await f.order.heldAmount(id)).to.equal(FUNDED);
      const deadline = (await f.order.getOrder(id)).deliveryDeadline;
      await time.increaseTo(deadline + 1n);
      await f.order.connect(f.outsider).cancelExpired(id);
      expect(await f.order.heldAmount(id)).to.equal(0n);
    });

    it("heldAmount reverts InvalidParameter(orderId) for an unknown order", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.heldAmount(1))
        .to.be.revertedWithCustomError(f.order, "InvalidParameter")
        .withArgs("orderId");
    });
  });
});
