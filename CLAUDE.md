# CLAUDE.md

Read `SPEC.md` first; it is the source of truth for this project (IS452 Assignment 2 – BunkerSettle dApp).

- Build milestone by milestone (SPEC §12). Don't start the UI before tests pass.
- Every business rule is enforced in the contracts, never only in the UI.
- Custom errors, events on every state change, NatSpec on external functions.
- Record any design choice not covered by the spec in `docs/DECISIONS.md`.
- Run `npm test` before every commit. Commit after each milestone.
- Contracts must also compile in Remix (only `@openzeppelin/...` and relative imports).
- Never commit `node_modules/`, `artifacts/`, `cache/`, `coverage/`, `.env`.
