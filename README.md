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

Prerequisite: Docker Desktop running. Run these in order.

| Step | Command | What it does |
|---|---|---|
| 1 | `npm run besu:up` | Starts 4 validator containers (`bunkersettle-validator1` to `4`, image `hyperledger/besu:26.10.2`): a Hyperledger Besu QBFT network, 2-second blocks, chain ID 4520. Wait about 20 seconds for them to peer. |
| 2 | `npm run deploy` | Deploys and wires the seven contracts and writes `ui/src/deployments.json`. Then it registers the demo participants, mints 5,000,000 mSGD to the bank and approves the escrow. |
| 3 (optional) | `npm run scenarios` | Runs demo runs A to C plus the signed-submission extra headless and prints balances after each step. Good for rehearsal. |
| 3b (for the live demo) | `npm run demo:orders` | Stages orders on a freshly deployed chain: 4 finished orders (3 settled, 1 resolved after a lab fail) so the supplier's track record has data, then order #5 for run A (Funded), #6 for run B (Funded) and #7 for run C (delivered, waiting for the lab). Prints a cheat sheet of the live steps. Run it instead of `scenarios`, not after it. |
| 4 | `npm run ui` | Starts the Vite app at http://localhost:5173. |

The UI needs `npm run deploy` to have run first. It imports `ui/src/deployments.json`, which is git-ignored and changes on every deploy. If you wipe the chain with `npm run besu:reset`, run `besu:up` and `deploy` again.

Other Besu commands: `npm run besu:logs` (follow logs), `npm run besu:down` (stop, keep the chain), `npm run besu:reset` (stop and wipe all chain state; clear MetaMask activity data afterwards).

JSON-RPC on the host: validator 1 on 8550 (the main endpoint), validators 2 to 4 on 8551 to 8553. Config, genesis and the dev-only keys are in `besu/` (see `besu/README.md`). Hardhat accounts #0 to #19 are prefunded and gas price is zero. The UI shows a Besu badge in the header and a Network panel on the Harbour view with the four validators.

Time-based paths cannot be shown live on a real chain. `cancelExpired` (after the 7-day delivery deadline) is covered by the tests. `releaseAfterTimeout` works live: the scenarios use a 120 s retention window, so wait for it to pass.

## All commands

| Command | What it does |
|---|---|
| `npm run compile` | Compiles the contracts (`hardhat compile`). |
| `npm test` | Runs the Hardhat test suite on the in-process Hardhat network. |
| `npm run coverage` | Runs solidity-coverage (99.4% lines). Report goes to `coverage/`. |
| `npm run gas` | Runs the tests with the gas reporter on. |
| `npm run deploy` | Deploys, wires and seeds on Besu (see above). |
| `npm run scenarios` | Runs demo runs A to C headless against Besu, plus the signed-submission extra. |
| `npm run demo:orders` | Stages the live-demo orders (history plus runs A to C, each stopped before its live step). |
| `npm run ui` | Starts the Vite dev server. |
| `npm run besu:up` / `besu:down` / `besu:reset` / `besu:logs` | Start, stop, wipe and follow the local Besu QBFT network (see Run order). |
| `npm run fetch-sales` | Refreshes `ui/public/bunker-sales.json` from data.gov.sg (the fallback for the Market view). |
| `npm run submission` | Builds the submission bundle in `submission/` (see below). |

## MetaMask setup

1. Add a network with these values.

   | Field | Value |
   |---|---|
   | Network name | Besu QBFT (BunkerSettle) |
   | RPC URL | `http://127.0.0.1:8550` |
   | Chain ID | 4520 |
   | Currency symbol | ETH |

2. Import accounts #1 to #9 into MetaMask (#9 is the financier, needed for run A). The accounts come from the standard Hardhat test mnemonic (`test test test test test test test test test test test junk`), which the Besu config also uses. Account #N is the Nth address of that mnemonic. Account #0 is the Port Operator (Admin) and is only needed if you want to act as admin; import it too if you do.

   **If MetaMask won't import #9** (for example a Google/Apple-login wallet whose key backup fails), use your own account as the financier instead: in MetaMask click **Add account** (not Add wallet), rename it "Financier", copy its address into `.env` as `DEMO_FINANCIER=0x...` (see `.env.example`), and run `npm run deploy`. The seed registers it as Straits Trade Finance with 5,000,000 mSGD and 10 ETH, on every deploy. Its first claim purchase asks for two confirmations (approve, then buy); #9 is pre-approved, this account can't be because only your MetaMask holds its key. The UI shows it without a `#N` number. `npm run scenarios` still uses #9.
3. Open http://localhost:5173 and connect every imported account to the site.
4. Use the **Change account** button in the header to open MetaMask's account picker.

These are Hardhat's public test keys. Anyone can read them. Never use them, or send funds to them, on a real network.

After `npm run besu:reset`, clear each account's activity in MetaMask (Settings, Advanced, Clear activity tab data). Otherwise MetaMask reuses stale nonces and transactions fail.

## Fault tolerance demo

QBFT with 4 validators needs 3 of 4 to agree: it survives 1 failed validator and halts at 2. With the UI open on the Harbour view:

1. `docker stop bunkersettle-validator4`. Card 4 turns red; blocks keep coming and transactions still confirm.
2. `docker stop bunkersettle-validator3`. Only 2 of 4 are left: the panel shows "Halted — needs 3 of 4 validators" within a few seconds and new transactions stay pending.
3. `docker start bunkersettle-validator3 bunkersettle-validator4`. The validators rejoin and blocks resume. QBFT backs off its round timer while halted, so allow up to about 2 minutes for the first new block.

Do not stop `bunkersettle-validator1` for the demo: the UI and MetaMask read through it (port 8550).

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
| #9 | Straits Trade Finance | FINANCIER | 0xa0Ee...9720 |

## The UI

| View | What it shows |
|---|---|
| Harbour | Chart home. Each order is a pin at its delivery anchorage. Click a pin to open the order. |
| Order | Status pipeline, status stamp, escrow tank, scenario stepper, payment claim panel (offer, withdraw, buy, supplier track record) and actions. Your own actions come first. Other parties' actions are collapsed, so you can demo reverts. |
| New order | The buyer's create-order form with prefilled demo values and an anchorage dropdown. |
| Oracle console | Demo only. Submits the meter reading, e-BDN and lab result. Has quick-fill buttons for runs A to C. |
| Disputes | Evidence list and the arbiter's split slider. |
| Activity | Every contract event, decoded, newest first. |
| Market | Monthly Singapore bunker sales from data.gov.sg (thousand tonnes). Live, with a saved fallback. |

Header controls:

- **Change account** opens the MetaMask picker.
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

1. Create, accept and fund an order first, as in run A below. Then, as #4, open Oracle console, pick the funded order, fill in the meter reading and press **Sign only (no gas)**. MetaMask asks for a signature, not a transaction.
2. Repeat as #5 for the e-BDN and as #6 for the lab result. Each signed item appears under **Signed submissions (EIP-712)**.
3. Click **Change account** and switch to #8 (unregistered).
4. In **Signed submissions (EIP-712)**, press **Relay** for each item. Each relay is a normal transaction from #8. The event shows #4, #5 or #6 as the signer.

`npm run scenarios` runs the same flow headless as the extra at the end, including one rejected relay.

## Demo scenarios in the UI

All runs use the same base order: 500 t VLSFO at 980 mSGD per tonne, tolerance 50 bps, retention 1000 bps, retention window 120 s. The New order form is prefilled with these values. You pick the anchorage in the form. Suggested choices: run B Western Petroleum A, run C Eastern Petroleum A (run A can use any). Run C is optional in the live demo.

### Run A: financed delivery

1. As #2 (buyer), open New order, check the prefilled values, and create the order.
2. As #3 (supplier), open the order and click Accept order.
3. As #1 (bank), click Fund order. The escrow pulls 500 t x 980 x 1.005 = 492,450.00 mSGD, and the payment claim is issued to the supplier.
4. As #3, open the Payment claim panel. The outstanding amount is 490,000.00 mSGD and the asking price is prefilled at 99% (485,100.00 mSGD, a 1.00 % discount). Click Offer for sale.
5. Switch to #8 (outsider). Open "Other parties' claim actions" and press Buy claim. The transaction reverts with `NotAuthorized(role=FINANCIER, account=0x2361...)`.
6. Switch to #9 (Straits Trade Finance). The supplier's track record appears above Buy claim (no completed orders yet on a fresh chain). Click Buy claim for 485,100.00 mSGD. If the claim contract is not yet approved to spend mSGD, the button runs approve then buy (two MetaMask prompts). The supplier receives 485,100.00 mSGD at once, and the panel shows the financier as holder.
7. As #4 (meter oracle), submit 500.2 t (500,200 kg). As #5 (e-BDN provider), submit 500.0 t (500,000 kg).
8. The order moves to QuantityApproved and 90% of the payable amount, 441,176.40 mSGD, goes to the financier (#9), not the supplier.
9. As #6 (lab), submit a lab result: passed. The order is Settled. The retention, 49,019.60 mSGD, goes to the financier, and the 2,254.00 mSGD of unused funding returns to the bank.
10. Net result: the supplier got 485,100.00 mSGD up front, the financier collected 490,196.00 mSGD for the 485,100.00 it paid (5,096.00 mSGD earned), and the bank paid 490,196.00 mSGD for the fuel.

### Run B: short delivery to resolution

1. Create a second order (anchorage Western Petroleum A). Accept it as #3 and fund it as #1. Do not sell the claim.
2. As #4, submit a meter reading of 480 t (480,000 kg). As #5, submit an e-BDN of 480 t.
3. The delivery is outside tolerance. A dispute opens with reason OUT_OF_TOLERANCE and nothing is released. The claim is locked while the order is in dispute.
4. Optional: open Disputes and, as #2 or #3, add evidence (pick a document type, paste the document text to hash it, add a note). Evidence does not move funds.
5. As #7 (arbiter), find the dispute, leave the slider at 70% for the supplier and click Resolve dispute.
6. The claim was not sold, so the supplier (#3) receives 344,715.00 mSGD and the bank receives 147,735.00 mSGD from the held amount. The order is Resolved.

### Run C: contaminated fuel (optional)

1. Create a third order (anchorage Eastern Petroleum A). Accept as #3, fund as #1.
2. As #4 and #5, submit a normal delivery (500,200 kg and 500,000 kg). 90% (441,176.40 mSGD) is released to the claim holder, here the supplier.
3. As #6, submit a lab result: failed.
4. A dispute opens with reason QUALITY_FAIL. The retention, 51,273.60 mSGD, stays held until the arbiter decides.

After `npm run scenarios` on a fresh chain (runs A to C plus the signed extra) the final balances are: bank 3,182,443.00, supplier 1,761,187.40 and financier 5,005,096.00 mSGD.

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

Remix VM accounts stand in for the Hardhat accounts. Use the first ten in the Account dropdown.

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
| 10th | #9 Financier ("Straits Trade Finance") |

### 3. Deploy in this order

Deploy as the first account. Paste the previous addresses as arguments.

| # | Contract | Constructor arguments |
|---|---|---|
| 1 | `ParticipantRegistry` | none |
| 2 | `MockSGD` | `registry` |
| 3 | `PaymentEscrow` | `registry`, `token` |
| 4 | `BunkerOrder` | `registry`, `escrow` |
| 5 | `SettlementClaim` | `registry`, `order`, `token` |
| 6 | `DeliveryRecord` | `registry`, `order` |
| 7 | `QualityRecord` | `registry`, `order` |
| 8 | `DisputeManager` | `registry`, `order`, `escrow` |

### 4. Wire (as admin, each once)

1. `escrow.setOrderContract(order)`
2. `escrow.setDisputeManager(dispute)`
3. `order.setModules(delivery, quality, dispute)`
4. `order.setClaim(claim)` (without it `fundOrder` reverts `ClaimNotSet`)

A second call to any of these reverts with `AlreadyWired`.

### 5. Seed (as admin)

1. For each participant, call `registry.register(account, role, name)`. Read the role hash from the registry's getters: `BANK()`, `BUYER()`, `SUPPLIER()`, `METER_ORACLE()`, `EBDN_ORACLE()`, `LAB()`, `ARBITER()`, and register the 10th account (name 'Straits Trade Finance') with the FINANCIER role. The registry has no getter for it; the hash is `keccak256("FINANCIER")` = `0xd98906aba10a86d1b86eb7b3c4e8a69a629f7761a44cfbcb18171e927b37c602`. Copy the returned `bytes32` into the call. Use any name string, such as "Harbour Bank".
2. `token.mint(bank, 5000000000000000000000000)` (5,000,000 mSGD).
3. Switch to the bank account. Call `token.approve(escrow, 5000000000000000000000000)` (or a larger amount).
4. Optional (receivable financing): `token.mint(financier, 5000000000000000000000000)`, then as the financier `token.approve(claim, 5000000000000000000000000)`.

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

### 7. The demo runs in Remix

Order IDs start at 1. Amounts are mSGD with 18 decimals, so 485,100 mSGD is `485100000000000000000000`.

1. **Run A: financed delivery.** Buyer: `createOrder`. Supplier: `acceptOrder(1)`. Bank: `fundOrder(1)`; the claim for order 1 is minted to the supplier (`SettlementClaim.ownerOf(1)`). Supplier: `SettlementClaim.offer(1, 485100000000000000000000)`. Switch to the outsider (account #8) and call `buy(1, 485100000000000000000000)`: it reverts with `NotAuthorized` (FINANCIER). Financier (#9): `MockSGD.approve(<SettlementClaim>, 485100000000000000000000)`, then `buy(1, 485100000000000000000000)`. Meter oracle: `submitMeterReading(1, 500200, 0x<32 bytes>)`. e-BDN provider: `submitEBDN(1, 500000, 0x<32 bytes>)`; the 90% tranche goes to the financier. Lab: `submitLabResult(1, true, 0x<32 bytes>)`. Status Settled; the retention also goes to the financier.
2. **Run B: short delivery to resolution.** New order 2, accept, fund. Meter oracle: `submitMeterReading(2, 480000, ...)`. e-BDN: `submitEBDN(2, 480000, ...)`. A dispute opens (OUT_OF_TOLERANCE). Arbiter: `DisputeManager.resolve(1, 7000)`. The claim was not sold, so the supplier gets 70% of the held amount and the bank gets 30%.
3. **Run C: contaminated fuel.** New order 3, accept, fund. Submit 500200 and 500000. Lab: `submitLabResult(3, false, ...)`. A dispute opens (QUALITY_FAIL) and the retention stays held.

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
besu/           Docker Compose, genesis and dev keys for the Besu QBFT network
docs/DECISIONS.md   design choices not covered by the spec
SPEC.md         source of truth
```

## Troubleshooting

| Problem | Fix |
|---|---|
| UI shows the node is not reachable | Start Docker Desktop, run `npm run besu:up`, wait about 20 seconds, then `npm run deploy`. |
| UI says wrong network | Switch MetaMask to "Besu QBFT (BunkerSettle)" (chain ID 4520). |
| UI cannot find contracts, or calls fail after `besu:reset` | Run `npm run deploy` again. The addresses in `ui/src/deployments.json` change on every deploy. |
| `NotAuthorized` for an account you expected to work | The account is not registered for that role, or you picked the wrong MetaMask account. Account #8 is unregistered on purpose. Re-run `npm run deploy` to re-seed. |
| MetaMask transactions fail with nonce errors | You ran `npm run besu:reset`. Clear each account's activity tab data in MetaMask (Settings, Advanced, Clear activity tab data). |
