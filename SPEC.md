# BunkerSettle – Build Spec

Smart contract dApp for IS452 Assignment 2. A consortium-blockchain layer on top of Singapore's
electronic bunker delivery notes (e-BDNs) that links **delivery, fuel quality and payment**:
payment is held in escrow, released automatically when the evidence checks out, and a dispute
opens automatically when it doesn't.

This file is the source of truth for the build. If something here is ambiguous, pick the
simplest option that keeps every rule in §5 enforced **on-chain**, and note the choice in
`docs/DECISIONS.md`.

---

## 1. Goals and non-goals

**Goals (MVP)**
- Contracts that enforce the full order lifecycle (§4–§5) with role-based access and clear reverts.
- A Hardhat test suite covering every success path and every revert in §7, ≥ 90% line coverage.
- Deploy + seed script that sets up a demo-ready local chain in one command.
- A React UI that runs the whole demo (§9) through MetaMask, including a live activity log.
- A README with setup, deploy, test, and a Remix fallback (§11).

**Non-goals (do not build unless asked)**
- Real oracle integrations (meter loggers, e-BDN APIs, labs) – mocked by role accounts.
- Upgradeable proxies, Tessera privacy, Besu/QBFT network – described in the tech spec only.
- A backend server or database. The UI talks to the chain directly.

**Stretch (only after MVP acceptance, §12)**
- EIP-712 signed oracle submissions (relayer submits, contract verifies signer has the role).
- Sepolia deploy + Etherscan verification.
- Besu QBFT network in Docker (e.g. Quorum Developer Quickstart) with a `besu` network entry.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Language | Solidity `^0.8.24` |
| Framework | Hardhat 2.x + `@nomicfoundation/hardhat-toolbox` (ethers v6, chai, gas reporter, solidity-coverage) |
| Libraries | OpenZeppelin Contracts 5.x (`AccessControl`, `Pausable`, `ReentrancyGuard`, `ERC20`, `SafeERC20`) |
| Tests / scripts | TypeScript |
| UI | Vite + React + TypeScript, ethers v6, MetaMask |
| Chain (demo) | 4-validator Besu QBFT (chainId 4520, RPC 8550); tests use in-process Hardhat network |

Node 22 is installed. Editor is Zed; no Remix-specific code, but contracts must also compile in
Remix (only `@openzeppelin/...` and relative imports).

---

## 3. Repo layout

```
contracts/
  ParticipantRegistry.sol
  BunkerOrder.sol
  PaymentEscrow.sol
  DeliveryRecord.sol
  QualityRecord.sol
  DisputeManager.sol
  SettlementClaim.sol
  interfaces/        IParticipantRegistry.sol, IBunkerOrder.sol, IPaymentEscrow.sol, IDisputeManager.sol
  mocks/MockSGD.sol
scripts/
  deploy.ts          deploy all, wire permissions, write ui/src/deployments.json (addresses + ABIs)
  seed.ts            register demo participants, mint + approve MockSGD
  scenarios.ts       optional: run the 5 demo scenarios headless (for rehearsal / video)
  export-submission.ts  copy contracts/*.sol -> submission/*.txt, plus config, scripts, tests, README
test/
  claim.test.ts  registry.test.ts  order.test.ts  delivery.test.ts  quality.test.ts  dispute.test.ts  e2e.test.ts
  helpers/fixtures.ts   loadFixture-based deploy + seed
ui/                  Vite app (§8)
docs/DECISIONS.md    design choices made during the build
hardhat.config.ts  package.json  README.md  .gitignore  .env.example
```

`.gitignore`: `node_modules/ artifacts/ cache/ coverage/ typechain-types/ .env submission/ ui/dist/`

---

## 4. Domain model

**Units**
- Quantity: integer **kilograms** (`uint256 qtyKg`). 500 t = `500_000`.
- Price: MockSGD (18 decimals) **per tonne** (`uint256 pricePerTonne`).
- Amount payable = `qtyKg * pricePerTonne / 1000`.
- Percentages: **basis points** (`uint16`, 10_000 = 100%).
- Time: `block.timestamp` seconds.

**Roles** (`bytes32`, held in ParticipantRegistry)
`ADMIN, BANK, BUYER, SUPPLIER, METER_ORACLE, EBDN_ORACLE, LAB, ARBITER, FINANCIER` (FINANCIER, stretch: buys settlement claims, §5.9)
An account can be **suspended**; a suspended account fails every role check.

**Order struct (BunkerOrder)**
```
id, buyer, supplier, bank,
fuelGrade (string, e.g. "VLSFO"), qtyKg, pricePerTonne,
toleranceBps (e.g. 50 = 0.5%), retentionBps (default 1000 = 10%),
deliveryDeadline, retentionWindow (seconds; demo 120, realistic 14 days),
fundedAmount, deliveredKg, payableAmount, releasedAmount,
approvedAt, status, disputeId,
dscHash, refundedAmount, anchorage (Anchorage enum, nominated place of delivery)
```

**Anchorage** (`enum Anchorage`): `WESTERN_PETROLEUM_A, WESTERN_PETROLEUM_B, EASTERN_PETROLEUM_A, EASTERN_PETROLEUM_B`.
The zone nominated for the delivery, not a live ship position.

**Status (state machine)**
```
Created -> Accepted -> Funded -> QuantityApproved -> Settled
                         |              |
                         |              +--(lab fail)------> Disputed -> Resolved
                         +--(mismatch / out of tolerance)--> Disputed -> Resolved
Created|Accepted -> Cancelled            (buyer cancels)
Funded -> Cancelled                      (deadline passed, no delivery; bank refunded)
```

---

## 5. Contracts

General rules for all contracts:
- Custom errors, not revert strings. One event per state change.
- NatSpec on every external function.
- `nonReentrant` on every function that moves tokens.
- Role checks go through `ParticipantRegistry.hasActiveRole(role, account)`.
- Cross-contract calls are restricted: only the addresses wired at deploy may call module hooks.

### 5.1 ParticipantRegistry
OZ `AccessControl`. Deployer gets `DEFAULT_ADMIN_ROLE` + `ADMIN`.
- `register(address account, bytes32 role, string name)` – ADMIN. Emits `ParticipantRegistered`.
- `revoke(address account, bytes32 role)` – ADMIN.
- `suspend(address account)` / `reinstate(address account)` – ADMIN. Emits `ParticipantSuspended` / `ParticipantReinstated`.
- `hasActiveRole(bytes32 role, address account) view returns (bool)` – has role AND not suspended.
- `nameOf(address) view returns (string)` – for the UI.

### 5.2 BunkerOrder  (owns the state machine)
`Pausable` (ADMIN pauses). Holds orders; is the **only** contract allowed to call PaymentEscrow.
- `createOrder(OrderParams p) returns (id)` – BUYER. `OrderParams = { supplier, bank, fuelGrade, qtyKg, pricePerTonne, toleranceBps, retentionBps, deliveryDeadline, retentionWindow, dscHash, uint8 anchorage }`. Validates: supplier has SUPPLIER, bank has BANK, fuelGrade not empty, qty > 0, price > 0, toleranceBps ≤ 500, retentionBps ≤ 5000, deadline in future, anchorage within the `Anchorage` enum. Emits `OrderCreated` (incl. `dscHash` and `anchorage`). → `Created`.
- `acceptOrder(id)` – that order's supplier. `Created` → `Accepted`.
- `fundOrder(id)` – that order's bank. Pulls `qtyKg * price / 1000 * (10_000 + toleranceBps) / 10_000` MockSGD (covers max allowed over-delivery) into PaymentEscrow. `Accepted` → `Funded`.
- `cancelOrder(id)` – buyer, while `Created`/`Accepted`. → `Cancelled`.
- `cancelExpired(id)` – anyone, if `Funded` and `block.timestamp > deliveryDeadline` and no delivery recorded. Refund bank. → `Cancelled`.
- **Hooks** (callable only by the wired module contracts):
  - `onDeliveryVerified(id, deliveredKg)` – from DeliveryRecord. Must be `Funded`.
    - If `|deliveredKg - qtyKg| > qtyKg * toleranceBps / 10_000` → open dispute `OUT_OF_TOLERANCE`.
    - Else: `payableAmount = deliveredKg * price / 1000`; release `payable * (10_000 - retentionBps) / 10_000` to supplier; `approvedAt = now` → `QuantityApproved`.
  - `onQuantityMismatch(id)` – from DeliveryRecord → open dispute `QUANTITY_MISMATCH`.
  - `onLabResult(id, passed)` – from QualityRecord. Must be `QuantityApproved`.
    - pass → release retention to supplier, refund `fundedAmount - payableAmount` to bank → `Settled`.
    - fail → open dispute `QUALITY_FAIL`.
  - `onDisputeResolved(id)` – from DisputeManager → `Resolved`.
- `releaseAfterTimeout(id)` – anyone, if `QuantityApproved` and `now ≥ approvedAt + retentionWindow` and no lab result → same as lab pass → `Settled`.
- Views: `getOrder(id)`, `orderCount()`, `heldAmount(id)` (= funded − released − refunded).

### 5.3 PaymentEscrow
Holds MockSGD per order. Only BunkerOrder (and DisputeManager for `split`) may call.
- `deposit(id, from, amount)` – `safeTransferFrom(from → escrow)`. Bank must have approved escrow.
- `release(id, to, amount)`, `refund(id, to, amount)`, `split(id, supplier, supplierAmt, bank, bankAmt)`.
- Tracks `balanceOf(id)`; reverts `InsufficientEscrow` if any payout exceeds it.
- Events: `Deposited, Released, Refunded, Split`.

### 5.4 DeliveryRecord
Stores evidence; the comparison logic lives here.
- `submitMeterReading(id, qtyKg, bytes32 ticketHash)` – METER_ORACLE. Once per order.
- `submitEBDN(id, qtyKg, bytes32 ebdnHash)` – EBDN_ORACLE. Once per order.
- When **both** exist: if `|meter - ebdn| > meter * order.toleranceBps / 10_000` → `order.onQuantityMismatch(id)`; else → `order.onDeliveryVerified(id, meter)` (meter reading is the quantity of record).
- Order must be `Funded`. Events: `MeterReadingSubmitted, EBDNSubmitted, DeliveryVerified, QuantityMismatch`.
- View `getDelivery(id)`.

### 5.5 QualityRecord
- `submitLabResult(id, bool passed, bytes32 reportHash)` – LAB. Once per order. Order must be `QuantityApproved`. Calls `order.onLabResult`.
- Event `LabResultSubmitted(id, passed, reportHash, lab)`. View `getResult(id)`.

### 5.6 DisputeManager
- `openDispute(orderId, reason)` – called by BunkerOrder (auto), **or** manually by the order's buyer or supplier while `Funded` or `QuantityApproved` (reason `MANUAL`). Order → `Disputed`.
- `submitEvidence(disputeId, DocType docType, bytes32 docHash, string note)` – order's buyer, supplier, or bank (see §13).
- `resolve(disputeId, uint16 supplierShareBps)` – ARBITER. Splits `heldAmount` via escrow: supplier gets `held * share / 10_000`, bank gets the rest. Calls `order.onDisputeResolved`.
- Reasons enum: `OUT_OF_TOLERANCE, QUANTITY_MISMATCH, QUALITY_FAIL, MANUAL`.
- Events: `DisputeOpened, EvidenceSubmitted, DisputeResolved`.

### 5.7 MockSGD
OZ ERC20, 18 decimals, symbol `mSGD`. `mint(to, amount)` restricted to ADMIN. Clearly marked test-only.

### 5.9 SettlementClaim  (stretch: receivable financing)
ERC-721 (`BSCLAIM`), `tokenId == orderId`, minted to the supplier when `fundOrder` succeeds. The holder receives every payout that used to go to `o.supplier` (first tranche, retention, dispute split). `BunkerOrder.payeeOf(id)` returns the holder. No recourse: a financier who buys the claim carries delivery and quality risk.
- `mint(orderId, supplier)` / `burn(orderId)` – BunkerOrder only (`OnlyModule`). `cancelExpired` burns the claim.
- `offer(orderId, price)` – holder; price > 0; claim tradable. `cancelOffer(orderId)` – holder. `getOffer(orderId)`.
- `buy(orderId, price)` – FINANCIER (`NotAuthorized` / `AccountSuspended`); `price` must equal the offer (`PriceMismatch`); pays the seller in MockSGD and receives the token atomically. Buyer must have approved the claim contract.
- `payeeOf(orderId)`, `outstanding(orderId)` (nominal value while `Funded`, unpaid retention while `QuantityApproved`, else 0).
- Tradable = order not paused, status `Funded` or `QuantityApproved` (else `ClaimLocked`), and not past the deadline with no delivery evidence (`ClaimExpired`). Any transfer (including raw `transferFrom`) needs a tradable claim and a FINANCIER receiver; any transfer clears the open offer.
- A suspended financier who already holds a claim is still paid; they just cannot buy or receive claims.
- Events: `ClaimOffered, OfferCancelled, ClaimSold` plus ERC-721 `Transfer`. `BunkerOrder` adds `ClaimSet`.

### 5.8 Wiring at deploy
1. Registry → MockSGD → Escrow(registry, token) → BunkerOrder(registry, escrow) → SettlementClaim(registry, order, token) → DeliveryRecord(registry, order) → QualityRecord(registry, order) → DisputeManager(registry, order, escrow).
2. `escrow.setOrderContract(order)`, `escrow.setDisputeManager(dispute)`; `order.setModules(delivery, quality, dispute)`, `order.setClaim(claim)`. Each setter ADMIN-only and callable **once**.

---

## 6. Custom errors (minimum set)
```
NotAuthorized(bytes32 role, address account)
AccountSuspended(address account)
InvalidState(uint256 id, Status expected, Status actual)
InvalidParameter(string name)
DeadlinePassed(uint256 id)
DeadlineNotReached(uint256 id)
AlreadySubmitted(uint256 id, string what)
NotOrderParty(uint256 id, address account)
RetentionWindowOpen(uint256 id, uint256 releasableAt)
InsufficientEscrow(uint256 id, uint256 requested, uint256 available)
OnlyModule(address caller)
AlreadyWired()
ClaimNotSet()
NotClaimHolder(uint256 id, address account)
OfferNotActive(uint256 id)
PriceMismatch(uint256 id, uint256 offered, uint256 given)
ClaimLocked(uint256 id, Status status)
ClaimExpired(uint256 id)
```

---

## 7. Tests (each bullet = at least one test)

**Happy paths**
- Full flow: create → accept → fund → meter + eBDN within tolerance → 90% to supplier → lab pass → retention to supplier, excess refunded to bank → `Settled`. Assert every balance.
- Same flow but lab never reports → `releaseAfterTimeout` after the retention window → `Settled`.
- Over-delivery inside tolerance pays for delivered qty; under-delivery inside tolerance pays less and refunds the rest.
- Cancel before funding; `cancelExpired` after deadline refunds bank.
- Dispute resolved 70/30 → balances split correctly → `Resolved`.

**Reverts / guards**
- Unregistered or wrong-role account calls each restricted function → `NotAuthorized`.
- Suspended account (any role) → `AccountSuspended`.
- Non-supplier accepts; non-designated bank funds → `NotOrderParty`.
- Every function called in the wrong state → `InvalidState`.
- Meter or eBDN submitted twice; lab submitted twice → `AlreadySubmitted`.
- Meter 480 t vs ordered 500 t at 0.5% → dispute `OUT_OF_TOLERANCE`, nothing released.
- Meter 500 t vs eBDN 490 t → dispute `QUANTITY_MISMATCH`.
- Lab fail → dispute `QUALITY_FAIL`, retention still held.
- `releaseAfterTimeout` before window ends → `RetentionWindowOpen`.
- `cancelExpired` before deadline → `DeadlineNotReached`.
- Calling hooks directly from an EOA → `OnlyModule`.
- Wiring setters called twice → `AlreadyWired`.
- Paused → `createOrder` / `fundOrder` revert.
- Bad params (qty 0, tolerance > 500 bps, past deadline) → `InvalidParameter` / `DeadlinePassed`.

**Receivable financing** (`test/claim.test.ts`)
- Claim minted on fund; `setClaim` admin-only, once-only, non-zero; `fundOrder` reverts `ClaimNotSet`; mint/burn only by BunkerOrder.
- `outstanding` in Funded, QuantityApproved, Settled.
- offer / cancelOffer / buy happy path; buy reverts (outsider, suspended, no offer, stale offer, `PriceMismatch`, buyer == seller, paused, expired, Disputed, Settled); offer reverts (non-holder, price 0, locked, expired).
- Transfer rules: raw transfer to a non-financier reverts, financier resale in `QuantityApproved`, locked while `Disputed`, offer cleared on transfer.
- Payouts reach the holder: lab pass, short delivery, `releaseAfterTimeout`, out-of-tolerance and lab-fail dispute splits, suspended holder still paid; `cancelExpired` burns the claim and refunds the bank.

**Reports**: `npx hardhat coverage` (target ≥ 90% lines, report in `coverage/`); `REPORT_GAS=true npx hardhat test` for the cost section.

---

## 8. UI (`ui/`)

Single-page Vite app. Reads `ui/src/deployments.json` written by `deploy.ts`.

- **Header**: connected account, its registry name and role(s), network check (4520), "Connect MetaMask".
- **Home – harbour chart**: every order pinned at its anchorage, coloured by state, with an order list beside it (filterable by anchorage). More than ~6 orders at one anchorage collapse into a cluster marker with a count and state ring. Selecting an order opens its order screen.
- **Order screen**: status pipeline, status stamp, escrow tank (held / retention), activity for that order, and the actions the connected account may take.
- **Buyer view**: create order form (prefilled demo values, anchorage dropdown), list of own orders with a status timeline.
- **Supplier view**: accept orders, see released / pending amounts.
- **Bank view**: approve + fund orders, total exposure (sum of held amounts).
- **Oracle console** (labelled *demo only*): submit meter reading, eBDN, lab result for an order; hashes generated from a text input with `keccak256`.
- **Arbiter view**: open disputes with evidence list; resolve with a share slider.
- **Activity log**: live feed of all contract events (`contract.on`), newest first, with tx hash, block number, decoded args.
- **Market panel**: monthly Singapore bunker sales chart from data.gov.sg dataset `d_4f5abbf4486bf8e52bbed3be56dde562` (datastore_search API). If CORS blocks the browser call, add `scripts/fetch-sales.ts` that saves the data to `ui/public/bunker-sales.json` and read that instead.
- **Errors**: never pre-validate in a way that hides contract reverts. Send the tx and show the decoded custom error (name + args) in a toast. A "UI checks" toggle may add client-side checks, default **off**.

Keep styling plain and readable on a projector (large type, high contrast). Visual direction: "signal board" (white, thick black rules, signal-flag colours) with a chart-style home view; a projector-mode toggle enlarges type. A demo scenario stepper lists the §9 steps and which account acts next.

---

## 9. Demo scenarios (seed data must support all three runs)

Accounts (Hardhat defaults): #0 Admin/Operator, #1 Bank ("Harbour Bank"), #2 Buyer ("MV Kirana Shipping"), #3 Supplier ("Lion Bunkers"), #4 Meter oracle, #5 e-BDN provider, #6 Lab, #7 Arbiter, #8 Outsider (unregistered), #9 Financier ("Straits Trade Finance", stretch). Names are fictional.

Base order: 500 t VLSFO @ 980 mSGD/t, tolerance 50 bps, retention 1000 bps, window 120 s. Funding locks 492,450.00 mSGD.

- **Run A, financed delivery** (any anchorage): create, accept, fund, so the claim is minted to the supplier (#3). #3 offers the claim at 99% of the outstanding amount (485,100.00 against 490,000.00). Outsider #8 tries to buy and gets `NotAuthorized`. Financier #9 buys. Meter 500.2 t, e-BDN 500.0 t, so 90% (441,176.40) goes to the financier. Lab pass, so the retention (49,019.60) goes to the financier and 2,254.00 returns to the bank.
- **Run B, short delivery to resolution** (Western Petroleum A): meter and e-BDN 480 t, so dispute OUT_OF_TOLERANCE. Optional evidence. Arbiter #7 resolves 70/30. The claim was not sold, so the supplier receives 344,715.00 and the bank 147,735.00.
- **Run C, contaminated fuel** (Eastern Petroleum A, optional live): normal delivery, lab fail, so dispute QUALITY_FAIL with the retention (51,273.60) held.

`scripts/scenarios.ts` runs A to C headless (plus the signed-submission extra), prints balances including the financier after each step, and asserts the outsider revert.

---

## 10. Commands (package.json scripts)
```
npm run compile     hardhat compile
npm test            hardhat test
npm run coverage    hardhat coverage
npm run gas         REPORT_GAS=true hardhat test
npm run besu:up     docker compose -f besu/docker-compose.yml up -d   (also besu:down, besu:reset, besu:logs)
npm run deploy      hardhat run scripts/deploy.ts --network besu && hardhat run scripts/seed.ts --network besu
npm run scenarios   hardhat run scripts/scenarios.ts --network besu
npm run ui          cd ui && npm run dev
npm run submission  hardhat run scripts/export-submission.ts
npm run fetch-sales ts-node scripts/fetch-sales.ts   (refreshes ui/public/bunker-sales.json)
```

---

## 11. README must include
- Prereqs, install, the commands above in order, MetaMask setup (add Besu 8550 / 4520, import accounts #0–#8 from the Hardhat test mnemonic).
- **Run in Remix** fallback: deploy order and constructor args (§5.8), wiring calls, which account plays which role, and the 5 scenarios as click steps.
- Submission note: assignment wants source + config only, with `.sol` renamed `.txt` – produced by `npm run submission` into `submission/`.

---

## 12. Milestones and acceptance

| # | Milestone | Done when |
|---|---|---|
| 1 | Scaffold | Hardhat + TS + OZ installed, `npm run compile` passes on empty contracts |
| 2 | Contracts | All §5 contracts compile; wiring works in a fixture |
| 3 | Tests | Every §7 bullet has a passing test; coverage ≥ 90% lines |
| 4 | Scripts | `npm run besu:up` + `npm run deploy` gives a seeded chain; `npm run scenarios` runs 1–5 cleanly |
| 5 | UI | Demo runs A to C can be run end to end in the browser with MetaMask; activity log shows every event |
| 6 | Docs | README complete; `npm run submission` produces the bundle; `docs/DECISIONS.md` up to date |

Work milestone by milestone. Commit after each one with a clear message. Do not start the UI
until milestone 3 passes.

---

## 13. Alignment with SS 709:2024 (Singapore digital bunkering documents)

SS 709 defines 16 digital bunkering document (DBD) types, each a human-readable document with
machine-readable JSON data, plus rules for signatures, verifiability (incl. computer-to-computer
verification) and dispute situations (§10 of the standard). Only the preview (contents + scope) is
available to us; field-level definitions (Annex A) are not, so field names below are ours.

Use the SS 709 document types as the evidence model: every hash stored on-chain is the hash of one
named DBD, stored off-chain.

| SS 709 document | Abbrev. | Where it goes in our contracts |
|---|---|---|
| Sales confirmation – Delivered | DSC | `BunkerOrder.createOrder` / `acceptOrder` (order terms incl. delivery anchorage; store `dscHash`) |
| Bunker requisition form | BRF | optional: `createOrder` (`brfHash`) |
| Bunker metering ticket | BMT | `DeliveryRecord.submitMeterReading` (`ticketHash` = BMT hash) |
| Bunker delivery note | BDN | `DeliveryRecord.submitEBDN` (`ebdnHash` = BDN hash) |
| Quality test report / Certificate of quality | QTR / CoQ | `QualityRecord.submitLabResult` (`reportHash`) |
| Note of protest (Vessel / Bunker tanker) | NOPV / NOPB | `DisputeManager.openDispute` (manual) and `submitEvidence` |
| Statement of fact | SOF | `DisputeManager.submitEvidence` |
| Sales invoice – Delivered | DSI | emitted reference at settlement (`invoiceHash` in `OrderSettled`) |

Implementation:
- Add `enum DocType { DSC, BRF, BMT, BDN, QTR, COQ, NOPV, NOPB, SOF, DSI }`.
- `DisputeManager.submitEvidence(disputeId, DocType docType, bytes32 docHash, string note)`.
- Events carry `DocType` so the UI activity log shows e.g. "BMT submitted".
- UI oracle console: a "document" dropdown using these names; hash = `keccak256` of the pasted
  JSON or text.
- Note in the standard: the structured data for the quality documents (CoQ, QTR) is still under
  development, so the lab result stays a simple pass/fail + report hash.
