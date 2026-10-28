import { artifacts, ethers } from "hardhat";
import type {
  BunkerOrder,
  DeliveryRecord,
  DisputeManager,
  MockSGD,
  ParticipantRegistry,
  PaymentEscrow,
  QualityRecord,
} from "../typechain-types";
import { Deployments, DeployedContract, writeDeployments, DEPLOYMENTS_PATH } from "./lib/deployments";

/** Deploys all contracts in SPEC 5.8 order, wires them, and writes ui/src/deployments.json. */
async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();

  const registry: ParticipantRegistry = await ethers.deployContract("ParticipantRegistry");
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();

  const token: MockSGD = await ethers.deployContract("MockSGD", [registryAddr]);
  await token.waitForDeployment();

  const escrow: PaymentEscrow = await ethers.deployContract("PaymentEscrow", [
    registryAddr,
    await token.getAddress(),
  ]);
  await escrow.waitForDeployment();

  const order: BunkerOrder = await ethers.deployContract("BunkerOrder", [
    registryAddr,
    await escrow.getAddress(),
  ]);
  await order.waitForDeployment();

  const delivery: DeliveryRecord = await ethers.deployContract("DeliveryRecord", [
    registryAddr,
    await order.getAddress(),
  ]);
  await delivery.waitForDeployment();

  const quality: QualityRecord = await ethers.deployContract("QualityRecord", [
    registryAddr,
    await order.getAddress(),
  ]);
  await quality.waitForDeployment();

  const dispute: DisputeManager = await ethers.deployContract("DisputeManager", [
    registryAddr,
    await order.getAddress(),
    await escrow.getAddress(),
  ]);
  await dispute.waitForDeployment();

  await (await escrow.setOrderContract(await order.getAddress())).wait();
  await (await escrow.setDisputeManager(await dispute.getAddress())).wait();
  await (
    await order.setModules(
      await delivery.getAddress(),
      await quality.getAddress(),
      await dispute.getAddress(),
    )
  ).wait();

  const deployed: Record<string, { getAddress(): Promise<string> }> = {
    ParticipantRegistry: registry,
    MockSGD: token,
    PaymentEscrow: escrow,
    BunkerOrder: order,
    DeliveryRecord: delivery,
    QualityRecord: quality,
    DisputeManager: dispute,
  };

  const contracts: Record<string, DeployedContract> = {};
  for (const [name, contract] of Object.entries(deployed)) {
    const artifact = await artifacts.readArtifact(name);
    contracts[name] = { address: await contract.getAddress(), abi: artifact.abi };
  }

  const manifest: Deployments = {
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts,
  };
  writeDeployments(manifest);

  console.log(`Deployed on chainId ${manifest.chainId} by ${manifest.deployer}`);
  for (const [name, c] of Object.entries(contracts)) {
    console.log(`  ${name.padEnd(20)} ${c.address}`);
  }
  console.log(`Wrote ${DEPLOYMENTS_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
