import * as fs from "fs";
import * as path from "path";

/** Generated manifest consumed by the UI and by scripts/seed.ts. */
export const DEPLOYMENTS_PATH = path.join(__dirname, "..", "..", "ui", "src", "deployments.json");

export interface DeployedContract {
  address: string;
  abi: unknown[];
}

export interface Deployments {
  chainId: number;
  deployedAt: string;
  deployer: string;
  contracts: Record<string, DeployedContract>;
}

/** Reads the deployment manifest written by scripts/deploy.ts. Throws if it is missing. */
export function readDeployments(): Deployments {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    throw new Error(`Missing ${DEPLOYMENTS_PATH}. Run "npm run deploy" first.`);
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8")) as Deployments;
}

/** Writes the deployment manifest, creating parent directories as needed. */
export function writeDeployments(deployments: Deployments): void {
  fs.mkdirSync(path.dirname(DEPLOYMENTS_PATH), { recursive: true });
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(deployments, null, 2) + "\n");
}
