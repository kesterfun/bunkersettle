import { ethers } from "hardhat";
import type {
  ParticipantRegistry,
  MockSGD,
  PaymentEscrow,
  BunkerOrder,
  DeliveryRecord,
  QualityRecord,
  DisputeManager,
  SettlementClaim,
} from "../../typechain-types";

/** 18-decimal token units. */
export const sgd = (n: number | string) => ethers.parseEther(n.toString());

/** Quantity in kilograms from tonnes. */
export const tonnes = (t: number) => BigInt(Math.round(t * 1000));

export const DAY = 24 * 60 * 60;

/** `Anchorage` enum values in BunkerTypes.sol. */
export const ANCHORAGE = {
  WESTERN_PETROLEUM_A: 0,
  WESTERN_PETROLEUM_B: 1,
  EASTERN_PETROLEUM_A: 2,
  EASTERN_PETROLEUM_B: 3,
} as const;

/** Deploys all contracts in SPEC 5.8 order, wires them, and seeds the SPEC 9 demo participants. */
export async function deployFixture() {
  const [admin, bank, buyer, supplier, meterOracle, ebdnOracle, lab, arbiter, outsider, financier] =
    await ethers.getSigners();

  const registry: ParticipantRegistry = await ethers.deployContract("ParticipantRegistry");
  const token: MockSGD = await ethers.deployContract("MockSGD", [await registry.getAddress()]);
  const escrow: PaymentEscrow = await ethers.deployContract("PaymentEscrow", [
    await registry.getAddress(),
    await token.getAddress(),
  ]);
  const order: BunkerOrder = await ethers.deployContract("BunkerOrder", [
    await registry.getAddress(),
    await escrow.getAddress(),
  ]);
  const claim: SettlementClaim = await ethers.deployContract("SettlementClaim", [
    await registry.getAddress(),
    await order.getAddress(),
    await token.getAddress(),
  ]);
  const delivery: DeliveryRecord = await ethers.deployContract("DeliveryRecord", [
    await registry.getAddress(),
    await order.getAddress(),
  ]);
  const quality: QualityRecord = await ethers.deployContract("QualityRecord", [
    await registry.getAddress(),
    await order.getAddress(),
  ]);
  const dispute: DisputeManager = await ethers.deployContract("DisputeManager", [
    await registry.getAddress(),
    await order.getAddress(),
    await escrow.getAddress(),
  ]);

  await order.setClaim(await claim.getAddress());
  await escrow.setOrderContract(await order.getAddress());
  await escrow.setDisputeManager(await dispute.getAddress());
  await order.setModules(
    await delivery.getAddress(),
    await quality.getAddress(),
    await dispute.getAddress(),
  );

  const roles = {
    ADMIN: await registry.ADMIN(),
    BANK: await registry.BANK(),
    BUYER: await registry.BUYER(),
    SUPPLIER: await registry.SUPPLIER(),
    METER_ORACLE: await registry.METER_ORACLE(),
    EBDN_ORACLE: await registry.EBDN_ORACLE(),
    LAB: await registry.LAB(),
    ARBITER: await registry.ARBITER(),
    FINANCIER: ethers.id("FINANCIER"),
  };

  await registry.register(bank.address, roles.BANK, "Harbour Bank");
  await registry.register(buyer.address, roles.BUYER, "MV Kirana Shipping");
  await registry.register(supplier.address, roles.SUPPLIER, "Lion Bunkers");
  await registry.register(meterOracle.address, roles.METER_ORACLE, "Meter Oracle");
  await registry.register(ebdnOracle.address, roles.EBDN_ORACLE, "e-BDN Provider");
  await registry.register(lab.address, roles.LAB, "Fuel Lab");
  await registry.register(arbiter.address, roles.ARBITER, "Arbiter");
  await registry.register(financier.address, roles.FINANCIER, "Straits Trade Finance");

  await token.mint(bank.address, sgd(100_000_000));
  await token.connect(bank).approve(await escrow.getAddress(), ethers.MaxUint256);
  await token.mint(financier.address, sgd(100_000_000));
  await token.connect(financier).approve(await claim.getAddress(), ethers.MaxUint256);

  return {
    registry,
    token,
    escrow,
    order,
    delivery,
    quality,
    dispute,
    claim,
    roles,
    admin,
    bank,
    buyer,
    supplier,
    meterOracle,
    ebdnOracle,
    lab,
    arbiter,
    outsider,
    financier,
  };
}

export type Fixture = Awaited<ReturnType<typeof deployFixture>>;
