import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployFixture, sgd, tonnes, DAY, ANCHORAGE, type Fixture } from "./helpers/fixtures";

/** BunkerTypes.Status values. */
const S = { Funded: 2n, QuantityApproved: 3n, Settled: 4n, Disputed: 5n, Resolved: 6n, Cancelled: 7n };

const h = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const ZERO = ethers.ZeroAddress;
const PRICE = sgd(980);
const TOL = 50;
const RET = 1000;
const FUNDED = ((tonnes(500) * PRICE) / 1000n) * (10_000n + BigInt(TOL)) / 10_000n;
const NOMINAL = (tonnes(500) * PRICE) / 1000n;
const payableOf = (kg: bigint) => (kg * PRICE) / 1000n;
const firstOf = (payable: bigint) => (payable * (10_000n - BigInt(RET))) / 10_000n;
const SALE = sgd(450_000);

async function createAccepted(f: Fixture): Promise<bigint> {
  const deadline = (await time.latest()) + 7 * DAY;
  await f.order.connect(f.buyer).createOrder({
    supplier: f.supplier.address,
    bank: f.bank.address,
    fuelGrade: "VLSFO",
    qtyKg: tonnes(500),
    pricePerTonne: PRICE,
    toleranceBps: TOL,
    retentionBps: RET,
    deliveryDeadline: deadline,
    retentionWindow: 120,
    dscHash: h("DSC"),
    anchorage: ANCHORAGE.EASTERN_PETROLEUM_B,
  });
  const id = await f.order.orderCount();
  await f.order.connect(f.supplier).acceptOrder(id);
  return id;
}

async function funded(f: Fixture): Promise<bigint> {
  const id = await createAccepted(f);
  await f.order.connect(f.bank).fundOrder(id);
  return id;
}

async function deliver(f: Fixture, id: bigint, meterKg: bigint, ebdnKg: bigint) {
  await f.delivery.connect(f.meterOracle).submitMeterReading(id, meterKg, h("BMT"));
  await f.delivery.connect(f.ebdnOracle).submitEBDN(id, ebdnKg, h("BDN"));
}

/** Funded order, supplier offers and the financier buys at SALE. */
async function sold(f: Fixture): Promise<bigint> {
  const id = await funded(f);
  await f.claim.connect(f.supplier).offer(id, SALE);
  await f.claim.connect(f.financier).buy(id, SALE);
  return id;
}

/** Registers the outsider as a second financier with funds and allowance. */
async function secondFinancier(f: Fixture) {
  await f.registry.register(f.outsider.address, f.roles.FINANCIER, "Second Finance");
  await f.token.mint(f.outsider.address, sgd(10_000_000));
  await f.token.connect(f.outsider).approve(await f.claim.getAddress(), ethers.MaxUint256);
}

describe("SettlementClaim", () => {
  describe("wiring and minting", () => {
    it("mints the claim to the supplier on fund, with a Transfer event", async () => {
      const f = await loadFixture(deployFixture);
      const id = await createAccepted(f);
      await expect(f.order.connect(f.bank).fundOrder(id))
        .to.emit(f.claim, "Transfer")
        .withArgs(ZERO, f.supplier.address, id);
      expect(await f.claim.ownerOf(id)).to.equal(f.supplier.address);
      expect(await f.claim.payeeOf(id)).to.equal(f.supplier.address);
      expect(await f.order.payeeOf(id)).to.equal(f.supplier.address);
      expect(await f.claim.name()).to.equal("BunkerSettle Settlement Claim");
      expect(await f.claim.symbol()).to.equal("BSCLAIM");
    });

    it("setClaim is wired to the fixture claim and emits ClaimSet", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.order.claim()).to.equal(await f.claim.getAddress());
      const fresh = await ethers.deployContract("BunkerOrder", [
        await f.registry.getAddress(),
        await f.escrow.getAddress(),
      ]);
      await expect(fresh.setClaim(await f.claim.getAddress()))
        .to.emit(fresh, "ClaimSet")
        .withArgs(await f.claim.getAddress());
    });

    it("setClaim is admin only", async () => {
      const f = await loadFixture(deployFixture);
      const fresh = await ethers.deployContract("BunkerOrder", [
        await f.registry.getAddress(),
        await f.escrow.getAddress(),
      ]);
      await expect(fresh.connect(f.outsider).setClaim(f.admin.address))
        .to.be.revertedWithCustomError(fresh, "NotAuthorized")
        .withArgs(f.roles.ADMIN, f.outsider.address);
    });

    it("setClaim is once only", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.setClaim(f.admin.address)).to.be.revertedWithCustomError(f.order, "AlreadyWired");
    });

    it("setClaim rejects the zero address", async () => {
      const f = await loadFixture(deployFixture);
      const fresh = await ethers.deployContract("BunkerOrder", [
        await f.registry.getAddress(),
        await f.escrow.getAddress(),
      ]);
      await expect(fresh.setClaim(ZERO))
        .to.be.revertedWithCustomError(fresh, "InvalidParameter")
        .withArgs("claim");
    });

    it("fundOrder reverts ClaimNotSet while no claim is wired", async () => {
      const f = await loadFixture(deployFixture);
      const fresh = await ethers.deployContract("BunkerOrder", [
        await f.registry.getAddress(),
        await f.escrow.getAddress(),
      ]);
      await fresh.connect(f.buyer).createOrder({
        supplier: f.supplier.address,
        bank: f.bank.address,
        fuelGrade: "VLSFO",
        qtyKg: tonnes(500),
        pricePerTonne: PRICE,
        toleranceBps: TOL,
        retentionBps: RET,
        deliveryDeadline: (await time.latest()) + 7 * DAY,
        retentionWindow: 120,
        dscHash: h("DSC"),
        anchorage: 0,
      });
      await fresh.connect(f.supplier).acceptOrder(1);
      await expect(fresh.connect(f.bank).fundOrder(1)).to.be.revertedWithCustomError(fresh, "ClaimNotSet");
    });

    it("constructor rejects zero addresses", async () => {
      const f = await loadFixture(deployFixture);
      const reg = await f.registry.getAddress();
      const ord = await f.order.getAddress();
      const tok = await f.token.getAddress();
      const factory = await ethers.getContractFactory("SettlementClaim");
      await expect(factory.deploy(ZERO, ord, tok)).to.be.revertedWithCustomError(factory, "InvalidParameter");
      await expect(factory.deploy(reg, ZERO, tok))
        .to.be.revertedWithCustomError(factory, "InvalidParameter")
        .withArgs("order");
      await expect(factory.deploy(reg, ord, ZERO))
        .to.be.revertedWithCustomError(factory, "InvalidParameter")
        .withArgs("token");
    });

    it("mint and burn are callable only by BunkerOrder", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await expect(f.claim.connect(f.admin).mint(99, f.admin.address))
        .to.be.revertedWithCustomError(f.claim, "OnlyModule")
        .withArgs(f.admin.address);
      await expect(f.claim.connect(f.supplier).burn(id))
        .to.be.revertedWithCustomError(f.claim, "OnlyModule")
        .withArgs(f.supplier.address);
    });

    it("order.payeeOf rejects an unknown order id", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.order.payeeOf(5)).to.be.revertedWithCustomError(f.order, "InvalidParameter");
    });
  });

  describe("outstanding", () => {
    it("is the nominal order value while Funded", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      expect(await f.claim.outstanding(id)).to.equal(NOMINAL);
    });

    it("is the unpaid retention once QuantityApproved", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await deliver(f, id, 500_200n, 500_000n);
      const payable = payableOf(500_200n);
      expect(await f.claim.outstanding(id)).to.equal(payable - firstOf(payable));
    });

    it("is zero once Settled", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await deliver(f, id, 500_200n, 500_000n);
      await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR"));
      expect(await f.claim.outstanding(id)).to.equal(0n);
    });
  });

  describe("offer, cancelOffer and buy", () => {
    it("offer stores the offer and emits ClaimOffered", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await expect(f.claim.connect(f.supplier).offer(id, SALE))
        .to.emit(f.claim, "ClaimOffered")
        .withArgs(id, f.supplier.address, SALE, NOMINAL);
      const o = await f.claim.getOffer(id);
      expect(o.seller).to.equal(f.supplier.address);
      expect(o.price).to.equal(SALE);
    });

    it("a second offer overwrites the first", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await f.claim.connect(f.supplier).offer(id, SALE + 1n);
      expect((await f.claim.getOffer(id)).price).to.equal(SALE + 1n);
    });

    it("cancelOffer clears the offer and emits OfferCancelled", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await expect(f.claim.connect(f.supplier).cancelOffer(id))
        .to.emit(f.claim, "OfferCancelled")
        .withArgs(id, f.supplier.address);
      expect((await f.claim.getOffer(id)).seller).to.equal(ZERO);
    });

    it("cancelOffer reverts for a non-holder and when no offer exists", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await expect(f.claim.connect(f.financier).cancelOffer(id))
        .to.be.revertedWithCustomError(f.claim, "NotClaimHolder")
        .withArgs(id, f.financier.address);
      await expect(f.claim.connect(f.supplier).cancelOffer(id))
        .to.be.revertedWithCustomError(f.claim, "OfferNotActive")
        .withArgs(id);
    });

    it("buy moves price and token atomically and emits ClaimSold", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      const finBefore = await f.token.balanceOf(f.financier.address);
      await expect(f.claim.connect(f.financier).buy(id, SALE))
        .to.emit(f.claim, "ClaimSold")
        .withArgs(id, f.supplier.address, f.financier.address, SALE, NOMINAL);
      expect(await f.claim.ownerOf(id)).to.equal(f.financier.address);
      expect(await f.token.balanceOf(f.supplier.address)).to.equal(SALE);
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finBefore - SALE);
      expect((await f.claim.getOffer(id)).seller).to.equal(ZERO);
      expect(await f.order.payeeOf(id)).to.equal(f.financier.address);
    });
  });

  describe("offer reverts", () => {
    it("rejects a non-holder", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await expect(f.claim.connect(f.financier).offer(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "NotClaimHolder")
        .withArgs(id, f.financier.address);
    });

    it("rejects a zero price", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await expect(f.claim.connect(f.supplier).offer(id, 0))
        .to.be.revertedWithCustomError(f.claim, "InvalidParameter")
        .withArgs("price");
    });

    it("rejects a locked status (Disputed)", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.dispute.connect(f.buyer).openDispute(id, 3);
      await expect(f.claim.connect(f.supplier).offer(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "ClaimLocked")
        .withArgs(id, S.Disputed);
    });

    it("rejects an expired claim", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await time.increase(8 * DAY);
      await expect(f.claim.connect(f.supplier).offer(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "ClaimExpired")
        .withArgs(id);
    });

    it("rejects while the order is paused", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.order.pause();
      await expect(f.claim.connect(f.supplier).offer(id, SALE)).to.be.revertedWithCustomError(
        f.order,
        "EnforcedPause",
      );
    });
  });

  describe("buy reverts", () => {
    it("rejects an outsider (NotAuthorized)", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await expect(f.claim.connect(f.outsider).buy(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "NotAuthorized")
        .withArgs(f.roles.FINANCIER, f.outsider.address);
    });

    it("rejects a suspended financier (AccountSuspended)", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await f.registry.suspend(f.financier.address);
      await expect(f.claim.connect(f.financier).buy(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "AccountSuspended")
        .withArgs(f.financier.address);
    });

    it("rejects when there is no offer", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await expect(f.claim.connect(f.financier).buy(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "OfferNotActive")
        .withArgs(id);
    });

    it("rejects a stale offer after the token moved", async () => {
      const f = await loadFixture(deployFixture);
      await secondFinancier(f);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await f.claim.connect(f.supplier).transferFrom(f.supplier.address, f.financier.address, id);
      await expect(f.claim.connect(f.outsider).buy(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "OfferNotActive")
        .withArgs(id);
    });

    it("rejects a price that differs from the offer", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await expect(f.claim.connect(f.financier).buy(id, SALE - 1n))
        .to.be.revertedWithCustomError(f.claim, "PriceMismatch")
        .withArgs(id, SALE, SALE - 1n);
    });

    it("rejects buyer == seller", async () => {
      const f = await loadFixture(deployFixture);
      const id = await sold(f);
      await f.claim.connect(f.financier).offer(id, SALE);
      await expect(f.claim.connect(f.financier).buy(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "InvalidParameter")
        .withArgs("buyer");
    });

    it("rejects while the order is paused", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await f.order.pause();
      await expect(f.claim.connect(f.financier).buy(id, SALE)).to.be.revertedWithCustomError(
        f.order,
        "EnforcedPause",
      );
    });

    it("rejects an expired claim", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await time.increase(8 * DAY);
      await expect(f.claim.connect(f.financier).buy(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "ClaimExpired")
        .withArgs(id);
    });

    it("rejects a Disputed order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await f.dispute.connect(f.buyer).openDispute(id, 3);
      await expect(f.claim.connect(f.financier).buy(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "ClaimLocked")
        .withArgs(id, S.Disputed);
    });

    it("rejects a Settled order", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await deliver(f, id, 500_200n, 500_000n);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR"));
      await expect(f.claim.connect(f.financier).buy(id, SALE))
        .to.be.revertedWithCustomError(f.claim, "ClaimLocked")
        .withArgs(id, S.Settled);
    });

    it("stays tradable past the deadline once delivery evidence exists", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.delivery.connect(f.meterOracle).submitMeterReading(id, 500_200n, h("BMT"));
      await time.increase(8 * DAY);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await f.claim.connect(f.financier).buy(id, SALE);
      expect(await f.claim.ownerOf(id)).to.equal(f.financier.address);
    });
  });

  describe("transfer rules", () => {
    it("raw transferFrom to a non-financier reverts", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await expect(f.claim.connect(f.supplier).transferFrom(f.supplier.address, f.outsider.address, id))
        .to.be.revertedWithCustomError(f.claim, "NotAuthorized")
        .withArgs(f.roles.FINANCIER, f.outsider.address);
    });

    it("financier to financier resale in QuantityApproved gives the new holder only the retention", async () => {
      const f = await loadFixture(deployFixture);
      await secondFinancier(f);
      const id = await sold(f);
      await deliver(f, id, 500_200n, 500_000n);
      const payable = payableOf(500_200n);
      const first = firstOf(payable);
      const retention = payable - first;
      const finAfterFirst = await f.token.balanceOf(f.financier.address);
      await f.claim.connect(f.financier).transferFrom(f.financier.address, f.outsider.address, id);
      const secondBefore = await f.token.balanceOf(f.outsider.address);
      await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR"));
      expect(await f.token.balanceOf(f.outsider.address)).to.equal(secondBefore + retention);
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finAfterFirst);
    });

    it("transfer while Disputed reverts", async () => {
      const f = await loadFixture(deployFixture);
      await secondFinancier(f);
      const id = await sold(f);
      await f.dispute.connect(f.buyer).openDispute(id, 3);
      await expect(f.claim.connect(f.financier).transferFrom(f.financier.address, f.outsider.address, id))
        .to.be.revertedWithCustomError(f.claim, "ClaimLocked")
        .withArgs(id, S.Disputed);
    });

    it("a transfer clears the open offer", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await f.claim.connect(f.supplier).offer(id, SALE);
      await f.claim.connect(f.supplier).transferFrom(f.supplier.address, f.financier.address, id);
      expect((await f.claim.getOffer(id)).seller).to.equal(ZERO);
    });
  });

  describe("payouts reach the claim holder", () => {
    it("lab pass: first tranche and retention go to the financier, supplier keeps only the sale price", async () => {
      const f = await loadFixture(deployFixture);
      const id = await sold(f);
      const payable = payableOf(500_200n);
      const first = firstOf(payable);
      const finStart = await f.token.balanceOf(f.financier.address);
      const bankStart = await f.token.balanceOf(f.bank.address);
      await deliver(f, id, 500_200n, 500_000n);
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finStart + first);
      expect(await f.token.balanceOf(f.supplier.address)).to.equal(SALE);
      await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR"));
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finStart + payable);
      expect(await f.token.balanceOf(f.supplier.address)).to.equal(SALE);
      expect(await f.token.balanceOf(f.bank.address)).to.equal(bankStart + (FUNDED - payable));
      expect((await f.order.getOrder(id)).status).to.equal(S.Settled);
    });

    it("short delivery within tolerance pays pro rata to the financier", async () => {
      const f = await loadFixture(deployFixture);
      const id = await sold(f);
      const payable = payableOf(498_000n);
      const finStart = await f.token.balanceOf(f.financier.address);
      await deliver(f, id, 498_000n, 498_000n);
      await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR"));
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finStart + payable);
    });

    it("releaseAfterTimeout pays the retention to the financier", async () => {
      const f = await loadFixture(deployFixture);
      const id = await sold(f);
      const payable = payableOf(500_200n);
      const finStart = await f.token.balanceOf(f.financier.address);
      await deliver(f, id, 500_200n, 500_000n);
      await time.increase(121);
      await f.order.releaseAfterTimeout(id);
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finStart + payable);
      expect(await f.token.balanceOf(f.supplier.address)).to.equal(SALE);
    });

    it("out-of-tolerance dispute split goes to the financier", async () => {
      const f = await loadFixture(deployFixture);
      const id = await sold(f);
      const finStart = await f.token.balanceOf(f.financier.address);
      const bankStart = await f.token.balanceOf(f.bank.address);
      await deliver(f, id, 480_000n, 480_000n);
      expect((await f.order.getOrder(id)).status).to.equal(S.Disputed);
      await f.dispute.connect(f.arbiter).resolve(1, 7000);
      const supplierShare = (FUNDED * 7000n) / 10_000n;
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finStart + supplierShare);
      expect(await f.token.balanceOf(f.bank.address)).to.equal(bankStart + (FUNDED - supplierShare));
      expect(await f.token.balanceOf(f.supplier.address)).to.equal(SALE);
      expect((await f.order.getOrder(id)).status).to.equal(S.Resolved);
    });

    it("lab-fail dispute split of the retention goes to the financier", async () => {
      const f = await loadFixture(deployFixture);
      const id = await sold(f);
      const payable = payableOf(500_200n);
      const first = firstOf(payable);
      const retention = payable - first;
      await deliver(f, id, 500_200n, 500_000n);
      const finMid = await f.token.balanceOf(f.financier.address);
      await f.quality.connect(f.lab).submitLabResult(id, false, h("QTR"));
      await f.dispute.connect(f.arbiter).resolve(1, 5000);
      const held = FUNDED - first;
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finMid + (held * 5000n) / 10_000n);
      expect(retention).to.be.lessThan(held);
    });

    it("a suspended financier holding a claim is still paid at settlement", async () => {
      const f = await loadFixture(deployFixture);
      const id = await sold(f);
      const payable = payableOf(500_200n);
      const finStart = await f.token.balanceOf(f.financier.address);
      await deliver(f, id, 500_200n, 500_000n);
      await f.registry.suspend(f.financier.address);
      await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR"));
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finStart + payable);
    });

    it("an unsold claim pays the supplier as before", async () => {
      const f = await loadFixture(deployFixture);
      const id = await funded(f);
      await deliver(f, id, 500_200n, 500_000n);
      await f.quality.connect(f.lab).submitLabResult(id, true, h("QTR"));
      expect(await f.token.balanceOf(f.supplier.address)).to.equal(payableOf(500_200n));
    });
  });

  describe("cancelExpired", () => {
    it("burns the claim and refunds the bank fully; the financier receives nothing", async () => {
      const f = await loadFixture(deployFixture);
      const id = await sold(f);
      const finStart = await f.token.balanceOf(f.financier.address);
      const bankStart = await f.token.balanceOf(f.bank.address);
      await time.increase(8 * DAY);
      await expect(f.order.cancelExpired(id))
        .to.emit(f.claim, "Transfer")
        .withArgs(f.financier.address, ZERO, id);
      expect(await f.token.balanceOf(f.bank.address)).to.equal(bankStart + FUNDED);
      expect(await f.token.balanceOf(f.financier.address)).to.equal(finStart);
      expect(await f.claim.payeeOf(id)).to.equal(ZERO);
      await expect(f.claim.ownerOf(id)).to.be.revertedWithCustomError(f.claim, "ERC721NonexistentToken");
      expect((await f.order.getOrder(id)).status).to.equal(S.Cancelled);
    });
  });
});
