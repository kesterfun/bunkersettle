import { ethers } from "hardhat";
import type { MockSGD, ParticipantRegistry } from "../typechain-types";
import { readDeployments } from "./lib/deployments";

type RoleKey = "ADMIN" | "BANK" | "BUYER" | "SUPPLIER" | "METER_ORACLE" | "EBDN_ORACLE" | "LAB" | "ARBITER" | "FINANCIER";

/** SPEC 9 participants. Account #8 (Outsider) is intentionally left unregistered. */
const SEEDS: { index: number; role: RoleKey; name: string }[] = [
  { index: 0, role: "ADMIN", name: "Port Operator (Admin)" },
  { index: 1, role: "BANK", name: "Harbour Bank" },
  { index: 2, role: "BUYER", name: "MV Kirana Shipping" },
  { index: 3, role: "SUPPLIER", name: "Lion Bunkers" },
  { index: 4, role: "METER_ORACLE", name: "Meter Oracle" },
  { index: 5, role: "EBDN_ORACLE", name: "e-BDN Provider" },
  { index: 6, role: "LAB", name: "Fuel Lab" },
  { index: 7, role: "ARBITER", name: "Arbiter" },
  { index: 9, role: "FINANCIER", name: "Straits Trade Finance" },
];

const OUTSIDER_INDEX = 8;
const FINANCIER_INDEX = 9;

/** Bank float available to fund orders; covers all five SPEC 9 scenarios several times over. */
const BANK_FLOAT = ethers.parseEther("5000000");

/** Registers SPEC 9 participants, funds the bank and approves escrow. Safe to re-run. */
async function main() {
  const manifest = readDeployments();
  const { chainId } = await ethers.provider.getNetwork();
  if (Number(chainId) !== manifest.chainId) {
    throw new Error(`Network chainId ${chainId} does not match deployments.json (${manifest.chainId}).`);
  }

  const signers = await ethers.getSigners();
  const admin = signers[0];
  const bank = signers[1];
  const addr = (name: string) => manifest.contracts[name].address;

  const registry = (await ethers.getContractAt(
    "ParticipantRegistry",
    addr("ParticipantRegistry"),
  )) as ParticipantRegistry;
  const token = (await ethers.getContractAt("MockSGD", addr("MockSGD"))) as MockSGD;
  const escrowAddr = addr("PaymentEscrow");
  const claimAddr = addr("SettlementClaim");
  const financier = signers[FINANCIER_INDEX];

  const roles: Record<RoleKey, string> = {
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

  console.log("Registering participants:");
  for (const seed of SEEDS) {
    const account = signers[seed.index].address;
    const roleHash = roles[seed.role];
    const upToDate =
      (await registry.hasActiveRole(roleHash, account)) && (await registry.nameOf(account)) === seed.name;
    if (upToDate) {
      console.log(`  #${seed.index} ${seed.name}: already registered`);
      continue;
    }
    await (await registry.register(account, roleHash, seed.name)).wait();
    console.log(`  #${seed.index} ${seed.name}: registered as ${seed.role}`);
  }

  const bankBalance = await token.balanceOf(bank.address);
  if (bankBalance < BANK_FLOAT) {
    const amount = BANK_FLOAT - bankBalance;
    await (await token.connect(admin).mint(bank.address, amount)).wait();
    console.log(`Minted ${ethers.formatEther(amount)} mSGD to bank #1`);
  } else {
    console.log("Bank float already sufficient; no mint");
  }

  const allowance = await token.allowance(bank.address, escrowAddr);
  if (allowance < BANK_FLOAT) {
    await (await token.connect(bank).approve(escrowAddr, ethers.MaxUint256)).wait();
    console.log("Bank approved PaymentEscrow for max mSGD");
  } else {
    console.log("Escrow allowance already sufficient; no approve");
  }

  const financierBalance = await token.balanceOf(financier.address);
  if (financierBalance < BANK_FLOAT) {
    const amount = BANK_FLOAT - financierBalance;
    await (await token.connect(admin).mint(financier.address, amount)).wait();
    console.log(`Minted ${ethers.formatEther(amount)} mSGD to financier #9`);
  } else {
    console.log("Financier float already sufficient; no mint");
  }

  const financierAllowance = await token.allowance(financier.address, claimAddr);
  if (financierAllowance < BANK_FLOAT) {
    await (await token.connect(financier).approve(claimAddr, ethers.MaxUint256)).wait();
    console.log("Financier approved SettlementClaim for max mSGD");
  } else {
    console.log("Claim allowance already sufficient; no approve");
  }

  console.log("\nSummary:");
  console.log(`  ${"Acct".padEnd(6)}${"Name".padEnd(24)}${"Role".padEnd(14)}${"mSGD balance"}`);
  for (let i = 0; i <= FINANCIER_INDEX; i++) {
    const account = signers[i].address;
    const seed = SEEDS.find((s) => s.index === i);
    const name = (await registry.nameOf(account)) || "(unregistered)";
    const role = seed ? seed.role : "(none)";
    const balance = ethers.formatEther(await token.balanceOf(account));
    console.log(`  ${`#${i}`.padEnd(6)}${name.padEnd(24)}${role.padEnd(14)}${balance}`);
  }
  console.log(`\nEscrow: ${escrowAddr}`);
  console.log(`Claim:  ${claimAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
