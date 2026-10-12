# @red-cup-engineering/derive-hive-account-ledger-service

Pure transformation deriving a complete Beancount ledger for one Hive account from its mainchain operation history (`@red-cup-engineering/read-hive-account-history-service`), its Hive-Engine operation history (`@red-cup-engineering/read-hive-engine-account-history-service`), and the account's opening/closing chain balances. Reward income is booked exactly once, at the chain-confirmed `claim_reward_balance` (never at the still-pending `author_reward`/`curation_reward` accrual, which would double-count value that has not yet reached the tracked balance), split across `Income:Hive:Author` and `Income:Hive:Curation` in proportion to each kind's pending accrual since the last claim. `interest` books to `Income:Hive:Interest`. Hive-Engine distributions/token issuance book to `Income:Hive:Staking`; tribe curation rewards book to `Income:Hive:Curation`. Plain transfers (either chain) book to `Income:Hive:Other`/`Expenses:Hive:Other`. Vesting (power up/down) and HBD-savings and Hive-Engine staking lifecycles are booked as commodity conversions between the account's own sub-accounts, never as income. Every venue fill — the Hive base-layer internal market (`fill_order`) and every Hive-Engine market/pool fill — is rendered by composing `@red-cup-engineering/derive-set-of-fill-transactions-service`, isolated to a dedicated `:Trading` sub-account so FIFO cost tracking never mixes with the plain (uncosted) reward/transfer flow held in the main custody account. Opening balances are booked at the range start and a `balance` assertion is written at the range end from a live chain read, alongside a computed-vs-chain comparison for the caller to act on.

## Limitation, stated plainly

Reward and transfer postings carry **no** per-unit cost-basis annotation (`{} @ price`): HIVE/HBD/VESTS and Hive-Engine tokens received as rewards or transfers are booked as plain quantities, valued later at report time from a separate price-directives file (as the main ledger already does for its own opening balances), not at the historical price on the day each reward landed. Building a historical HIVE/USD daily price series is out of this lot's scope (the org has no such series service yet); this is a known simplification, not silently pretended otherwise.

## Operation

~~~js
export function deriveHiveAccountLedger(input, options)
~~~

### Parameters

- input: `{ account, rangeStart, rangeEnd, custodyAccount, hiveEngineCustodyAccount?, hiveOperations, hiveEngineEntries, hiveEngineFills, openingBalances, chainClosingBalances }`. `hiveOperations` is `read-hive-account-history-service`'s `.operations`; `hiveEngineEntries`/`hiveEngineFills` are `read-hive-engine-account-history-service`'s `.entries`/`.fills`.
- options: `{ deriveFillsImpl? }` — for tests, an injectable replacement for `deriveSetOfFillTransactions`.

### Returns

`{ type: "HiveAccountLedgerSet", version: 1, account, rangeStart, rangeEnd, ledgerText, accountsOpened, transactionCount, fillsBooked, nativeRewardTotals, balanceComparison, refusals }`. `balanceComparison[]` is `{ account, commodity, computedClosing, chainClosing, match }` per tracked commodity. `refusals[]` names every unhandled operation kind, fill refusal, or unresolved savings withdrawal — nothing is silently dropped.

### Refusals

- `TypeError`: when `input.account` or `input.custodyAccount` is missing.
- A fill that `derive-set-of-fill-transactions-service` cannot book (insufficient FIFO inventory, a witness disagreement) is caught and listed under `refusals`, never thrown past this service.

## Command

derive-hive-account-ledger reads one JSON value on stdin and writes one JSON value to stdout.
