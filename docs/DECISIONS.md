# Design Decisions

Choices made during the build that SPEC.md does not cover.

## Milestone 1

- **Solidity 0.8.24**: OpenZeppelin 5.7 contracts use `pragma solidity ^0.8.20`; 0.8.24 satisfies that and matches the project stubs' `^0.8.24`.
- **cross-env**: added as a devDependency so `npm run gas` (`REPORT_GAS=true`) works on Windows.
- **Node version**: SPEC targets Node 22; development machine runs Node v24.9.0 with Hardhat 2. See the compile/test result notes below.
- Result on Node v24.9.0: `hardhat compile` and `hardhat test` run without errors (0 tests, exit 0). No blocker found.
- **TypeScript 5.8 pinned**: unpinned install resolved TypeScript 7.0.2, which breaks ts-node 10.9.2 (`Cannot read properties of undefined (reading 'fileExists')`); pinned to `~5.8.3`.
