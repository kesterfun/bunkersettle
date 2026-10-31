# BunkerSettle

BunkerSettle is a smart contract dApp for IS452 Assignment 2. It sits on top of Singapore's electronic bunker delivery notes (e-BDNs) and links delivery, fuel quality and payment. The bank's payment is held in escrow. The contracts release it when the evidence checks out. They open a dispute automatically when it does not.

- `SPEC.md` is the source of truth for the build.
- `docs/DECISIONS.md` records the design choices the spec did not cover.

Everything runs on a local Hardhat chain. The oracles (meter logger, e-BDN provider, lab) are mocked by role accounts. The token is `MockSGD` (symbol `mSGD`, 18 decimals) and is for testing only.

## Prerequisites

- Node 22 (it also runs on Node 24) and npm
- MetaMask in any browser

## Install

```bash
npm install
cd ui && npm install
```

## Run order

Run these in order. Keep the node running in its own terminal.

| Step | Command | What it does |
|---|---|---|
| 1 | `npm run node` | Starts a local Hardhat chain at `http://127.0.0.1:8545` (chain ID 31337). Prints 20 test accounts and private keys. Leave it running. |
| 2 | `npm run deploy` | Deploys and wires the seven contracts and writes `ui/src/deployments.json`. Then it registers the demo participants, mints 5,000,000 mSGD to the bank and approves the escrow. |
| 3 (optional) | `npm run scenarios` | Runs demo scenarios 1 to 6 headless and prints balances after each step. Good for rehearsal. |
| 4 | `npm run ui` | Starts the Vite app at http://localhost:5173. |

The UI needs `npm run deploy` to have run first. It imports `ui/src/deployments.json`, which is git-ignored and changes on every deploy. If you restart the node, run `npm run deploy` again.

## All commands

| Command | What it does |
|---|---|
| `npm run compile` | Compiles the contracts (`hardhat compile`). |
| `npm test` | Runs the Hardhat test suite (196 tests). |
| `npm run coverage` | Runs solidity-coverage (99.3% lines). Report goes to `coverage/`. |
| `npm run gas` | Runs the tests with the gas reporter on. |
| `npm run node` | Starts the local chain. |
| `npm run deploy` | Deploys, wires and seeds (see above). |
| `npm run scenarios` | Runs the six demo scenarios headless (1 to 6). |
| `npm run ui` | Starts the Vite dev server. |
| `npm run fetch-sales` | Refreshes `ui/public/bunker-sales.json` from data.gov.sg (the fallback for the Market view). |
| `npm run submission` | Builds the submission bundle in `submission/` (see below). |

## MetaMask setup

1. Add a network with these values.

   | Field | Value |
   |---|---|
   | Network name | Hardhat localhost |
   | RPC URL | `http://127.0.0.1:8545` |
   | Chain ID | 31337 |
   | Currency symbol | ETH |

2. Import accounts #1 to #8 into MetaMask. Use the private keys printed by `npm run node`. Account #0 is the Port Operator (Admin) and is only needed if you want to act as admin; import it too if you do.
3. Open http://localhost:5173 and connect every imported account to the site.
4. Use the **Change account** button in the header to open MetaMask's account picker.

These are Hardhat's public test keys. Anyone can read them. Never use them, or send funds to them, on a real network.

After you restart the node, clear each account's activity in MetaMask (Settings, Advanced, Clear activity tab data). Otherwise MetaMask reuses stale nonces and transactions fail.

## Accounts and roles

The seed script registers these accounts. All names are fictional.

| Account | Name | Role | Address |
|---|---|---|---|
| #0 | Port Operator (Admin) | ADMIN | 0xf39F...2266 |
| #1 | Harbour Bank | BANK | 0x7099...79C8 |
| #2 | MV Kirana Shipping | BUYER | 0x3C44...93BC |
| #3 | Lion Bunkers | SUPPLIER | 0x90F7...b906 |
| #4 | Meter Oracle | METER_ORACLE | 0x15d3...6A65 |
| #5 | e-BDN Provider | EBDN_ORACLE | 0x9965...A4dc |
| #6 | Fuel Lab | LAB | 0x976E...0aa9 |
| #7 | Arbiter | ARBITER | 0x14dC...9955 |
| #8 | Outsider | none (unregistered) | 0x2361...1E8f |

## The UI

| View | What it shows |
|---|---|
| Harbour | Chart home. Each order is a pin at its delivery anchorage. Click a pin to open the order. |
| Order | Status pipeline, status stamp, escrow tank, scenario stepper and actions. Your own actions come first. Other parties' actions are collapsed, so you can demo reverts. |
| New order | The buyer's create-order form with prefilled demo values and an anchorage dropdown. |
| Oracle console | Demo only. Submits the meter reading, e-BDN and lab result. Has quick-fill buttons for scenarios 1 to 3. |
| Disputes | Evidence list and the arbiter's split slider. |
| Activity | Every contract event, decoded, newest first. |
| Market | Monthly Singapore bunker sales from data.gov.sg (thousand tonnes). Live, with a saved fallback. |

Header controls:

- **Change account** opens the MetaMask picker.
- **Fast-forward** moves chain time by +2 min, +1 day or +8 days. It only shows on chain 31337.
- **UI checks** toggle adds client-side checks. It is off by default so contract reverts stay visible.
- **Projector mode** enlarges the type.

A failed transaction shows the decoded custom error in a toast, for example `NotAuthorized(role=METER_ORACLE, account=0x2361...)`.

## Signed oracle submissions (EIP-712)

The meter oracle, e-BDN provider and lab can sign their submission off-chain instead of sending it. Signing costs no gas. Any account then relays the signature on-chain. The contract recovers the signer, checks that the signer holds the oracle's role, and records the signer in the event. Changing any field after signing breaks the signature, so the relayer cannot alter the submission. A signature from an account without the role reverts with `NotAuthorized`, and one past its deadline reverts with `SignatureExpired`.

| Function | Signed by | Contract |
|---|---|---|
| `submitMeterReadingBySig(id, qtyKg, ticketHash, deadline, signature)` | Meter oracle (#4) | `DeliveryRecord` |
| `submitEBDNBySig(id, qtyKg, ebdnHash, deadline, signature)` | e-BDN provider (#5) | `DeliveryRecord` |
| `submitLabResultBySig(id, passed, reportHash, deadline, signature)` | Fuel lab (#6) | `QualityRecord` |

`deadline` is a Unix time in seconds. The demo uses the latest block time plus 900 s. The direct functions (`submitMeterReading`, `submitEBDN`, `submitLabResult`) work as before.

To try it in the UI (Oracle console):

1. As #4, open Oracle console, pick a funded order, fill in the meter reading and press **Sign only (no gas)**. MetaMask asks for a signature, not a transaction.
2. Repeat as #5 for the e-BDN and as #6 for the lab result. Each signed item appears under **Signed submissions (EIP-712)**.
3. Click **Change account** and switch to #8 (unregistered).
4. In **Signed submissions (EIP-712)**, press **Relay** for each item. Each relay is a normal transaction from #8. The event shows #4, #5 or #6 as the signer.

`npm run scenarios` runs the same flow headless as scenario 6, including one rejected relay.

## Demo scenarios in the UI

All scenarios use the same base order: 500 t VLSFO at 980 mSGD per tonne, tolerance 50 bps, retention 1000 bps, retention window 120 s. The New order form is prefilled with these values. You pick the anchorage in the form. Suggested choices: scenario 2 Western Petroleum A, scenario 3 Eastern Petroleum A, scenario 4 Western Petroleum B (scenario 1 can use any).

### Scenario 1: normal delivery

1. As #2 (buyer), open New order, check the prefilled values, and create the order.
2. As #3 (supplier), open the order and click Accept.
3. As #1 (bank), click Fund. The escrow pulls 500 t x 980 x 1.005 = 492,450.00 mSGD.
4. As #4 (meter oracle), submit a meter reading of 500.2 t (500,200 kg).
5. As #5 (e-BDN provider), submit an e-BDN of 500.0 t (500,000 kg).
6. The order moves to QuantityApproved and 90% of the payable amount goes to the supplier.
7. As #6 (lab), submit a lab result: passed.
8. The order is Settled. The retention goes to the supplier and the unused funding returns to the bank.
9. Optional variant: skip step 7. Wait for the retention window to end (Fast-forward +2 min). Then anyone clicks Release after timeout.

### Scenario 2: short delivery

1. Create a second order (anchorage Western Petroleum A). Accept it as #3 and fund it as #1.
2. As #4, submit a meter reading of 480 t (480,000 kg).
3. As #5, submit an e-BDN of 480 t.
4. The order is outside tolerance. A dispute opens with reason OUT_OF_TOLERANCE and nothing is released.

### Scenario 3: contaminated fuel

1. Create a third order (anchorage Eastern Petroleum A). Accept as #3, fund as #1.
2. As #4 and #5, submit a normal delivery (500,200 kg and 500,000 kg). 90% is released.
3. As #6, submit a lab result: failed.
4. A dispute opens with reason QUALITY_FAIL. The retention stays held.

### Scenario 4: outsider

1. Create a fourth order (anchorage Western Petroleum B). Accept as #3, fund as #1.
2. Switch MetaMask to #8 (unregistered; the header shows "Unregistered account"). Open Oracle console, pick the order, click the Scenario 1 quick-fill and submit a meter reading.
3. The transaction reverts and the toast shows `NotAuthorized(role=METER_ORACLE, account=...)`.

### Scenario 5: resolution

1. Optional: open Disputes and, as #2 or #3, add evidence to dispute #1 (pick a document type, paste the document text to hash it, add a note). Evidence does not move funds.
2. As #7 (arbiter), find dispute #1 (order 2, out of tolerance), leave the slider at 70% for the supplier and click Resolve dispute.
3. The supplier receives 344,715.00 mSGD and the bank receives 147,735.00 mSGD from the held amount. The order is Resolved.

After the full run the final balances are: bank 3,180,189.00 and supplier 1,276,087.40 mSGD.

## Delivery anchorage

The delivery place is an on-chain order term. `createOrder` takes an `anchorage` value from the `Anchorage` enum, stores it with the order and emits it in `OrderCreated`. It is the nominated zone, not a live ship position.

| Value | Anchorage |
|---|---|
| 0 | WESTERN_PETROLEUM_A |
| 1 | WESTERN_PETROLEUM_B |
| 2 | EASTERN_PETROLEUM_A |
| 3 | EASTERN_PETROLEUM_B |

An out-of-range value reverts with `InvalidParameter("anchorage")`.

## Alignment with SS 709:2024

Every hash stored on-chain is the hash of one named digital bunkering document from SS 709:2024, kept off-chain. The sales confirmation (DSC) hash is stored on the order. The bunker metering ticket (BMT) hash goes with the meter reading. The bunker delivery note (BDN) hash goes with the e-BDN. The lab report hash is the quality test report or certificate of quality. Dispute evidence carries a `DocType` such as NOPV, NOPB or SOF. See SPEC section 13 for the full mapping. Only the standard's preview was available, so field names are ours.

## Run in Remix

Use this if you cannot run Node. Remix has no time travel, so show the retention-timeout and expiry paths with the Hardhat UI instead.

### 1. Set up the files

1. Create the same folder layout in Remix: `contracts/`, `contracts/interfaces/`, `contracts/base/`, `contracts/mocks/`. Copy each `.sol` file into the matching folder.
2. OpenZeppelin imports resolve automatically from npm in Remix.
3. Compile with Solidity 0.8.24 and the optimizer on (200 runs). Set the EVM version to `cancun`.

### 2. Pick accounts

Remix VM accounts stand in for the Hardhat accounts. Use the first nine in the Account dropdown.

| Remix account | Plays |
|---|---|
| 1st (deployer) | #0 Admin |
| 2nd | #1 Bank |
| 3rd | #2 Buyer |
| 4th | #3 Supplier |
| 5th | #4 Meter oracle |
| 6th | #5 e-BDN provider |
| 7th | #6 Lab |
| 8th | #7 Arbiter |
| 9th | #8 Outsider (leave unregistered) |

### 3. Deploy in this order

Deploy as the first account. Paste the previous addresses as arguments.

| # | Contract | Constructor arguments |
|---|---|---|
| 1 | `ParticipantRegistry` | none |
| 2 | `MockSGD` | `registry` |
| 3 | `PaymentEscrow` | `registry`, `token` |
| 4 | `BunkerOrder` | `registry`, `escrow` |
| 5 | `DeliveryRecord` | `registry`, `order` |
| 6 | `QualityRecord` | `registry`, `order` |
| 7 | `DisputeManager` | `registry`, `order`, `escrow` |

### 4. Wire (as admin, each once)

1. `escrow.setOrderContract(order)`
2. `escrow.setDisputeManager(dispute)`
3. `order.setModules(delivery, quality, dispute)`

A second call to any of these reverts with `AlreadyWired`.

### 5. Seed (as admin)

1. For each participant, call `registry.register(account, role, name)`. Read the role hash from the registry's getters: `BANK()`, `BUYER()`, `SUPPLIER()`, `METER_ORACLE()`, `EBDN_ORACLE()`, `LAB()`, `ARBITER()`. Copy the returned `bytes32` into the call. Use any name string, such as "Harbour Bank".
2. `token.mint(bank, 5000000000000000000000000)` (5,000,000 mSGD).
3. Switch to the bank account. Call `token.approve(escrow, 5000000000000000000000000)` (or a larger amount).

### 6. Create an order

`createOrder` takes one tuple. As the buyer, enter it in Remix as a JSON array in `OrderParams` order:

```
[supplier, bank, "VLSFO", 500000, "980000000000000000000", 50, 1000, <deadline>, 120, "0x<any 32-byte hex>", 3]
```

For example, with the 4th Remix account as supplier and the 2nd as bank (put addresses and the hash in quotes):

```
["0x<supplier address>", "0x<bank address>", "VLSFO", 500000, "980000000000000000000", 50, 1000, 1893456000, 120, "0x1111111111111111111111111111111111111111111111111111111111111111", 3]
```

Fields in order: `supplier`, `bank`, `fuelGrade`, `qtyKg`, `pricePerTonne`, `toleranceBps`, `retentionBps`, `deliveryDeadline`, `retentionWindow`, `dscHash`, `anchorage`.

- Quantities are kilograms. 500,000 kg is 500 t.
- Prices are 18-decimal mSGD per tonne. 980 mSGD is `980000000000000000000`.
- `<deadline>` is a Unix timestamp in seconds, in the future (1893456000 is 1 Jan 2030).
- `anchorage` 0 is Western Petroleum A and 3 is Eastern Petroleum B.

### 7. The five scenarios in Remix

Order IDs start at 1. Use a new order for each scenario.

1. **Normal.** Buyer: `createOrder`. Supplier: `acceptOrder(1)`. Bank: `fundOrder(1)`. Meter oracle: `submitMeterReading(1, 500200, 0x<32 bytes>)`. e-BDN provider: `submitEBDN(1, 500000, 0x<32 bytes>)`. Lab: `submitLabResult(1, true, 0x<32 bytes>)`. Check `getOrder(1)`: status Settled.
2. **Short delivery.** New order 2, accept, fund. Meter oracle: `submitMeterReading(2, 480000, ...)`. e-BDN: `submitEBDN(2, 480000, ...)`. A dispute opens (OUT_OF_TOLERANCE).
3. **Contaminated fuel.** New order 3, accept, fund. Submit 500200 and 500000. Lab: `submitLabResult(3, false, ...)`. A dispute opens (QUALITY_FAIL).
4. **Outsider.** New order 4, accept, fund. Switch to the 9th account and call `submitMeterReading(4, 500200, ...)`. It reverts with `NotAuthorized`.
5. **Resolution.** Arbiter: `resolve(1, 7000)` on dispute 1 (the first dispute, from scenario 2). Supplier gets 70% of the held amount and the bank gets 30%.

The `...BySig` functions need an EIP-712 signature from the oracle's key. Remix has no simple way to make one, so produce it with a script or with MetaMask (the UI's **Sign only** button). The direct functions above work as before.

## Submission bundle

The assignment wants source and config only, with `.sol` files renamed to `.txt`. Run:

```bash
npm run submission
```

It writes the bundle to `submission/` (git-ignored), with a `MANIFEST.txt` listing the files.

## Project layout

```
contracts/
  ParticipantRegistry.sol  BunkerOrder.sol  PaymentEscrow.sol
  DeliveryRecord.sol  QualityRecord.sol  DisputeManager.sol
  base/         shared role guard
  interfaces/   BunkerTypes.sol (enums, structs, errors) and contract interfaces
  mocks/        MockSGD.sol (test token)
scripts/
  deploy.ts  seed.ts  scenarios.ts  export-submission.ts  fetch-sales.ts
  lib/          deployments helper
test/           Hardhat tests (TypeScript) and helpers/fixtures.ts
ui/             Vite + React + TypeScript app (ethers v6)
docs/DECISIONS.md   design choices not covered by the spec
SPEC.md         source of truth
```

## Troubleshooting

| Problem | Fix |
|---|---|
| UI shows the node is not reachable | Start `npm run node` and keep it running. Then run `npm run deploy`. |
| UI says wrong network | Switch MetaMask to "Hardhat localhost" (chain ID 31337). |
| UI cannot find contracts, or calls fail after a node restart | Run `npm run deploy` again. The addresses in `ui/src/deployments.json` change on every deploy. |
| `NotAuthorized` for an account you expected to work | The account is not registered for that role, or you picked the wrong MetaMask account. Account #8 is unregistered on purpose. Re-run `npm run deploy` to re-seed. |
| MetaMask transactions hang or fail with nonce errors | You restarted the node. Clear each account's activity tab data in MetaMask (Settings, Advanced). |
| `npm run node` fails with "address already in use" on port 8545 | Another node is running. Stop it, or close the old terminal, then start again. |
