# @red-cup-engineering/derive-hive-account-ledger-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Pure transformation deriving a complete Beancount ledger for one Hive account from its mainchain operation history (`@red-cup-engineering/read-hive-account-history-service`), its Hive-Engine operation history (`@red-cup-engineering/read-hive-engine-account-history-service`), and the account's opening/closing chain balances. Reward income is booked exactly once, at the chain-confirmed `claim_reward_balance` (never at the still-pending `author_reward`/`curation_reward` accrual, which would double-count value that has not yet reached the tracked balance), split across `Income:Hive:Author` and `Income:Hive:Curation` in proportion to each kind's pending accrual since the last claim. `interest` books to `Income:Hive:Interest`. Hive-Engine distributions/token issuance book to `Income:Hive:Staking`; tribe curation rewards book to `Income:Hive:Curation`. Plain transfers (either chain) book to `Income:Hive:Other`/`Expenses:Hive:Other`. Vesting (power up/down) and HBD-savings and Hive-Engine staking lifecycles are booked as commodity conversions between the account's own sub-accounts, never as income. Venue fills (the Hive internal market's `fill_order`, and every Hive-Engine market or pool fill) are booked as exact conversions (`@@` total price) on the custody account that holds the assets, so the sold or bought tokens move in the account the Hive-Engine entries use; no FIFO lots or purchase history are required. Funds in flight (pending savings withdrawals, pending conversions, open market orders) are held outside the custody tree in `...:In-Flight:...`. Opening balances are booked at the range start and `balance` assertions are written from a live chain read at `balanceDate` (the day after the read; Beancount checks an assertion at the start of its date). Because Beancount counts an account together with every account beneath it, the custody account is asserted for its whole tree (liquid plus the chain's separate savings, staked, pending-unstake and delegated-out figures) and each sub-account is asserted on its own, alongside a computed-vs-chain comparison for the caller to act on.

## Limitation, stated plainly

Reward and transfer postings carry **no** per-unit cost-basis annotation (`{} @ price`): HIVE/HBD/VESTS and Hive-Engine tokens received as rewards or transfers are booked as plain quantities, valued later at report time from a separate price-directives file (as the main ledger already does for its own opening balances), not at the historical price on the day each reward landed. Building a historical HIVE/USD daily price series is out of this lot's scope (the org has no such series service yet); this is a known simplification, not silently pretended otherwise.

## Operation

~~~js
export function deriveHiveAccountLedger(input, options)
~~~

### Parameters

- input: `{ account, rangeStart, rangeEnd, balanceDate?, custodyAccount, hiveEngineCustodyAccount?, hiveOperations, hiveEngineEntries, hiveEngineFills, openingBalances, chainClosingBalances }`. `hiveOperations` is `read-hive-account-history-service`'s `.operations`; `hiveEngineEntries`/`hiveEngineFills` are `read-hive-engine-account-history-service`'s `.entries`/`.fills`.
- no options; run `npm test` for the fixture tests.

### Returns

`{ type: "HiveAccountLedgerSet", version: 1, account, rangeStart, rangeEnd, ledgerText, accountsOpened, transactionCount, fillsBooked, nativeRewardTotals, balanceComparison, refusals }`. `balanceComparison[]` is `{ account, commodity, computedClosing, chainClosing, match }` per tracked commodity. `refusals[]` names every unhandled operation kind, fill refusal, or unresolved savings withdrawal — nothing is silently dropped.

### Refusals

- `TypeError`: when `input.account` or `input.custodyAccount` is missing.
- A refused fill, an unhandled operation kind and an unresolved savings withdrawal are listed under `refusals`, never thrown past this service.

## Command

derive-hive-account-ledger reads one JSON value on stdin and writes one JSON value to stdout.
