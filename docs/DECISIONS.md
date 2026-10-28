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
