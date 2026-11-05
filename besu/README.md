# Besu QBFT dev network

Four-validator Hyperledger Besu QBFT network for BunkerSettle (chain ID 4520, 2 s blocks). See the main README, section "Running on Besu QBFT".

- `docker-compose.yml`: the 4 validators (`bunkersettle-validator1` to `4`), image `hyperledger/besu:26.10.2`, JSON-RPC on host ports 8550 to 8553, named volumes `validator1-data` to `validator4-data`.
- `genesis.json`: generated genesis (QBFT config, validator set in `extraData`, prefunded Hardhat accounts #0 to #19).
- `qbftConfigFile.json`: input for `besu operator generate-blockchain-config`.
- `nodes/nodeN/key`, `key.pub`: validator node keys.

**The keys here are dev-only and public.** They are committed on purpose so the network can be reproduced. Never reuse them, or the prefunded Hardhat accounts, on any real network.

Regenerate (this changes the validator addresses; run `npm run besu:reset` and update the bootnode enodes in the compose file afterwards):

```bash
docker run --rm -v "$PWD:/work" -w /work hyperledger/besu:26.10.2 operator generate-blockchain-config --config-file=qbftConfigFile.json --to=networkFiles --private-key-file-name=key
```
