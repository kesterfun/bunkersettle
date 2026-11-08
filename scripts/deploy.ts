import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import type {
  BunkerOrder,
  DeliveryRecord,
  DisputeManager,
  MockSGD,
  ParticipantRegistry,
  PaymentEscrow,
  QualityRecord,
  SettlementClaim,
} from "../typechain-types";
import { BesuNode, Deployments, DeployedContract, writeDeployments, DEPLOYMENTS_PATH } from "./lib/deployments";

/** Reads besu/nodes/node{1..4}/key.pub: validator address and the host port 8550+n-1 of its JSON-RPC. */
function besuNodes(rpcUrl: string): BesuNode[] {
  const base = new URL(rpcUrl);
  const nodes: BesuNode[] = [];
  for (let n = 1; n <= 4; n++) {
    const pub = fs.readFileSync(path.join(__dirname, "..", "besu", "nodes", `node${n}`, "key.pub"), "utf8").trim();
    const validator = ethers.getAddress("0x" + ethers.keccak256("0x" + pub.replace(/^0x/, "")).slice(-40));
    base.port = String(8549 + n);
    nodes.push({ name: `Validator ${n}`, rpcUrl: base.origin, validator });
  }
  return nodes;
}

/** Deploys all contracts in SPEC 5.8 order, wires them, and writes ui/src/deployments.json. */
async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const rpcUrl = "url" in network.config ? network.config.url : "http://127.0.0.1:8545";

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

  const claim: SettlementClaim = await ethers.deployContract("SettlementClaim", [
    registryAddr,
    await order.getAddress(),
    await token.getAddress(),
  ]);
  await claim.waitForDeployment();

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

  await (await order.setClaim(await claim.getAddress())).wait();
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
    SettlementClaim: claim,
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
    networkName: network.name,
    rpcUrl,
    ...(network.name === "besu" ? { besuNodes: besuNodes(rpcUrl) } : {}),
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
