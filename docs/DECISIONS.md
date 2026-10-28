# Design Decisions

Choices made during the build that SPEC.md does not cover.

## Milestone 1

- **Solidity 0.8.24**: OpenZeppelin 5.7 contracts use `pragma solidity ^0.8.20`; 0.8.24 satisfies that and matches the project stubs' `^0.8.24`.
- **cross-env**: added as a devDependency so `npm run gas` (`REPORT_GAS=true`) works on Windows.
- **Node version**: SPEC targets Node 22; development machine runs Node v24.9.0 with Hardhat 2. See the compile/test result notes below.
- Result on Node v24.9.0: `hardhat compile` and `hardhat test` run without errors (0 tests, exit 0). No blocker found.
- **TypeScript 5.8 pinned**: unpinned install resolved TypeScript 7.0.2, which breaks ts-node 10.9.2 (`Cannot read properties of undefined (reading 'fileExists')`); pinned to `~5.8.3`.

## Milestone 2

- **Shared types**: enums, `Order` struct, role constants and all SPEC section 6 errors live in `contracts/interfaces/BunkerTypes.sol` (file-level, relative imports only). Extra interface `IDeliveryRecord` added.
- **Role guard**: abstract `contracts/base/RoleGuard.sol` (holds `registry`). `_requireRole` reverts `AccountSuspended(account)` if the account holds the role but is suspended, else `NotAuthorized(role, account)`. Done per module (not a registry call) so the errors appear in each module ABI. The registry's own ADMIN functions use the same logic and `NotAuthorized` (not OZ `AccessControlUnauthorizedAccount`).
- **Check order**: pause, role, order exists (`InvalidParameter("orderId")`), party (`NotOrderParty`), state (`InvalidState`), deadline, then business checks. In DeliveryRecord/QualityRecord, `AlreadySubmitted` is checked BEFORE `InvalidState`, because the first submission usually moves the order out of the expected state.
- **Past deadline**: `createOrder` reverts `InvalidParameter("deliveryDeadline")`. `DeadlinePassed(id)` is used by `acceptOrder` and `fundOrder` after the deadline.
- **dscHash**: extra last `bytes32 dscHash` param on `createOrder`, stored on the order, emitted in `OrderCreated` with `DocType.DSC`. BRF omitted (optional).
- **invoiceHash**: derived on-chain in `_settle`: `keccak256(abi.encode(id, dscHash, deliveredKg, payableAmount, block.timestamp))`, emitted in `OrderSettled` with `DocType.DSI`.
- **Evidence events**: `MeterReadingSubmitted` carries `DocType.BMT`, `EBDNSubmitted` `DocType.BDN`, `LabResultSubmitted` `DocType.QTR`.
- **Dispute opening**: `DisputeManager.openDispute` is the single entry. Auto path (caller == BunkerOrder, any reason): creates the dispute, BunkerOrder stores `disputeId` and sets `Disputed` itself. Manual path (buyer/supplier, reason must be `MANUAL`, order `Funded`/`QuantityApproved`): after creating the dispute it calls hook `BunkerOrder.onDisputeOpened(id, disputeId)` (DisputeManager only). Outsiders: `NotAuthorized` if holding none of the eligible roles, `NotOrderParty` if registered but not on the order. Dispute ids start at 1.
- **Refund tracking**: `Order.refundedAmount` added. `heldAmount = funded - released - refunded`. `onDisputeResolved` signature extended to `(id, supplierAmount, bankAmount)` so the order books the split into released/refunded; DisputeManager computes the split from `order.heldAmount`.
- **Resolve when already Resolved**: reverts `InvalidState(orderId, Disputed, Resolved)`; also `InvalidParameter("supplierShareBps")` if share > 10000.
- **cancelExpired with evidence**: BunkerOrder reads `DeliveryRecord.hasEvidence(id)` (meter OR eBDN submitted); if true reverts `AlreadySubmitted(id, "delivery")`. Consequence: an order with only one evidence item past deadline stays `Funded`.
- **Payable cap**: `payableAmount` is capped at `fundedAmount` to guard 1-wei rounding.
- **Evidence permissions**: `submitEvidence` requires order status `Disputed` and an unresolved dispute; caller must be buyer, supplier or bank of the order with an active role.
- **MockSGD** takes the registry in its constructor; `mint` is ADMIN-only via `RoleGuard`.
- **Wiring order**: `setModules` rejects zero addresses (`InvalidParameter("module")`). Roles are exposed as registry constants (`registry.BUYER()` etc.).
- **No viaIR** needed; all contracts well under 24 KB (BunkerOrder about 9.8 KB).

## Milestone 3 – Tests

- **Out-of-tolerance test data.** `DeliveryRecord` compares meter vs eBDN before BunkerOrder compares meter vs ordered qty. So the OUT_OF_TOLERANCE scenario (§7, §9 #2) uses meter = eBDN = 480 t; meter 480 t vs eBDN 500 t would raise QUANTITY_MISMATCH instead.
- **`InvalidState` "expected" for multi-state guards.** Where a function accepts more than one state (e.g. `cancelOrder` accepts Created or Accepted), the error reports the first allowed state (`Created`) as `expected`. Tests assert this as written.
- **Delivery submission after approval.** Submitting meter/eBDN on a `QuantityApproved` order reverts `AlreadySubmitted` (both items already exist and that check runs first), not `InvalidState`.
- **Non-party callers in disputes.** Accounts that hold neither BUYER nor SUPPLIER (or BANK, for evidence) get `NotAuthorized`; a registered buyer/supplier who is not on the order gets `NotOrderParty`.
- **Coverage.** 194 tests, 99.33% lines / 83.64% branches (`npm run coverage`). Branch gaps are mostly defensive checks (zero-address and rounding guards).

## Milestone 4 – Scripts

- **Deployment manifest.** `ui/src/deployments.json` is generated by `scripts/deploy.ts` (chainId, deployer, addresses, ABIs) and is git-ignored. Each `npm run deploy` deploys fresh contracts, so addresses change per run. The UI reads the file at build time.
- **Shared script helper.** `scripts/lib/deployments.ts` holds the manifest path and read/write helpers, shared by `deploy.ts` and `seed.ts`.
- **Admin name.** `ParticipantRegistry` supports naming, so account #0 is registered as ADMIN with the name "Port Operator (Admin)". `register` on an already-held role only updates the name.
- **Seed idempotency.** An account is skipped when it already holds its role and carries the expected name. Otherwise `register` runs. The bank mints only the shortfall up to a 5,000,000 mSGD float. Escrow approval is set to `MaxUint256` when the allowance is below the float.
- **Unregistered outsider.** Account #8 is left unregistered by the seed, per SPEC 9.

## Milestone 4 – Submission export

- **Clean rebuild.** `npm run submission` deletes and recreates `submission/` on every run, so the output never holds stale files.
- **Excluded names apply at any depth.** `node_modules`, `dist`, `artifacts`, `cache`, `coverage` and `typechain-types` are skipped wherever they appear. `.env` and `ui/src/deployments.json` are never copied.
- **Core vs optional files.** Config and source files (`hardhat.config.ts`, `package.json`, `tsconfig.json`, `.env.example`, `SPEC.md`, `docs/DECISIONS.md`, `contracts/`) abort the export if missing. `README.md` and `ui/` only print a warning, so the export still runs before they exist.
- **UI scope.** Everything under `ui/src/` is copied, plus `ui/index.html`, `ui/package.json`, `ui/vite.config.ts` and any `ui/tsconfig*.json`.
- **Manifest.** `submission/MANIFEST.txt` lists each exported file and its original path, with a note that `contracts/*.txt` are Solidity sources to be renamed back to `.sol`.
- **Built-ins only.** The script uses only `fs` and `path`, so it adds no dependency.

## Milestone 4 – Scenarios

- **Scenario 4 order stays `Funded`.** The outsider's meter reading reverts, so that order is left funded on purpose; it shows the failed call did not consume the meter slot. Each `npm run scenarios` run therefore locks ~492k mSGD of the bank's float.
- **Bank top-up in scenarios.** Each run uses ~1.8M mSGD, so `scenarios.ts` mints the bank back up to 5,000,000 mSGD (admin mint) when its balance falls below 2,000,000. Repeat runs on the same chain keep working. Script-only; contracts unchanged.
- **Error decoding.** Reverts are decoded with the contract interface's `parseError`; the Hardhat provider nests revert data at `err.data.data`, so the script checks both locations.

## Pre-milestone 5 – Delivery anchorage

- **Why.** The UI home view is a harbour chart with one pin per order, so each order needs a place of delivery. Bunker delivery notes record where the delivery took place, so the anchorage is stored on-chain with the order terms, not in the UI.
- **Anchorage enum.** `Anchorage { WESTERN_PETROLEUM_A, WESTERN_PETROLEUM_B, EASTERN_PETROLEUM_A, EASTERN_PETROLEUM_B }` in `BunkerTypes.sol`, stored as `Order.anchorage` and emitted as the last field of `OrderCreated`. It is the nominated delivery zone, not a live ship position. Live AIS positions would need another oracle role and stay out of scope (SPEC 1).
- **`createOrder(OrderParams)`.** `createOrder` now takes one `OrderParams` struct instead of 10 positional arguments, leaving room for the new field without stack-too-deep risk. Field names and validation are unchanged from SPEC 5.2.
- **Anchorage validation.** `OrderParams.anchorage` is a raw `uint8`, checked against `type(Anchorage).max`, so a bad value reverts `InvalidParameter("anchorage")` instead of a bare ABI decode revert.
- **Scenario anchorages.** `scripts/scenarios.ts` places S1 at Eastern Petroleum B, S2 at Western Petroleum A, S3 at Eastern Petroleum A and S4 at Western Petroleum B, so the chart shows the demo orders spread out.
- **Tests.** 196 tests (2 new: anchorage stored and emitted; out-of-range anchorage reverts), 99.33% lines.

## Milestone 5 – UI

- **Stack versions.** React 18.3, ethers 6.13, Vite 5.4, TypeScript pinned `~5.8.3` like the root package.
- **Reads go to the node, writes go through MetaMask.** Reads use a `JsonRpcProvider` on `http://127.0.0.1:8545` (`VITE_RPC_URL` overrides), so the board, chart and activity log work before a wallet connects. Only `send()` uses MetaMask's signer.
- **One poll per block.** On every new block the UI reads all orders, disputes, balances and the connected account's roles, then fetches the new logs from all seven contracts with one `getLogs` call and decodes them with each contract's ABI. That keeps the activity log and on-screen state in step, instead of running separate `contract.on` listeners that could arrive before the state read.
- **Participants come from events.** The participant list (names and roles for dropdowns and labels) is built from `ParticipantRegistered` / `ParticipantRevoked` events, since the registry has no enumeration function.
- **Chain time.** Countdowns use an estimated chain clock: wall clock plus the largest `block.timestamp − now` offset seen. That follows `evm_increaseTime` from the Fast-forward buttons.
- **Errors.** Every custom error from every ABI (including OpenZeppelin's) is merged into one `Interface`. A failed transaction's revert data is searched for anywhere in the ethers/MetaMask error object and shown as `ErrorName(arg=value, …)`, with role hashes shown by name.
- **No hidden reverts.** Actions are shown to every account. The "UI checks" toggle (default off, saved in localStorage) is the only thing that disables buttons.
- **Single light theme.** The UI deliberately has one high-contrast light theme for projectors (SPEC 8); "Projector mode" raises the root font size from 16 px to 20 px and everything scales in rem.
- **Market panel source.** The data.gov.sg API answers browser calls, so the panel loads live data and falls back to `ui/public/bunker-sales.json` (written by `npm run fetch-sales`) when the call fails. Field names: `month`, `bunker_type`, `bunker_sales`.
- **Market panel unit.** The dataset metadata says "tonnes", but monthly totals around 4,700 only match Singapore's real sales (about 4.7 million tonnes a month) if they are thousand tonnes, which is how MPA publishes these figures. The panel labels the values "thousand tonnes".
- **Contract names in the UI.** Addresses that belong to a deployed contract show as "BunkerOrder contract" etc., so automatic disputes read as opened by BunkerOrder.
- **Browser end-to-end check.** Scenarios 1–5, evidence submission, Fast-forward and `cancelExpired` were run through the UI in a headless browser with a stand-in for MetaMask that forwards to the Hardhat node's unlocked accounts. The resulting balances matched `npm run scenarios` exactly. A real MetaMask run is still the acceptance step.
- **Actions by party.** The order screen lists the connected account's own actions first. Other parties' actions sit in a collapsed "Other parties' actions" section, still clickable, so the demo can show a `NotOrderParty` / `NotAuthorized` revert (SPEC 8 forbids hiding reverts). "Anyone" actions (`cancelExpired`, `releaseAfterTimeout`) count as the connected account's own.
- **Change account.** The header's "Change account" button calls `wallet_requestPermissions` for `eth_accounts`, opening MetaMask's picker so another demo account can be connected and selected without leaving the app.
