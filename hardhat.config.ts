import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

dotenv.config();

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    // Local 4-validator Besu QBFT network (npm run besu:up). Node 1 JSON-RPC; see besu/README.md.
    besu: {
      url: "http://127.0.0.1:8550",
      chainId: 4520,
      accounts: { mnemonic: HARDHAT_MNEMONIC, count: 20 },
      timeout: 120000,
    },
  },
  gasReporter: {
    enabled: !!process.env.REPORT_GAS,
  },
};

export default config;
