# Design memo: Hive accounting bridge, hive-engine-topology, rewards math

Produced 2026-06-11 by a design-recon pass over `lib/ledger-topology`,
`lib/financial-topology`, `lib/meme-topology`, `lib/hive-topology`, and
`apps/waggle` (`topology.mts`, `chain.mts`). Condensed; decisions preserved.

## A. Accounting bridge — proposed `lib/hive-account-ledger`

Hive account history (`condenser_api.get_account_history`) is a time-ordered
append-only op log. The bridge maps each op to double-entry postings in
`ledger-topology`, with the chain op kept as provenance.

### Chart of accounts (sketch)

- `Assets:Hive:Liquid`, `Assets:Hive:Vested` (VESTS), `Assets:Hbd:Liquid`,
  `Assets:Hbd:Savings`
- `Liabilities:Hive:PendingWithdraw`, `Liabilities:Hbd:ConversionRequests`,
  delegations-out
- `Income:Rewards:Author`, `Income:Rewards:Curation`,
  `Income:Rewards:VestingMint`, `Income:Interest:Hbd`
- `Expenses:*`, `Equity:OpeningBalance`

### Op → posting mapping (core set)

| Hive op | Postings |
|---|---|
| transfer | Liquid −X / counterparty +X |
| transfer_to_vesting | Liquid −X / Vested +X (at fetch-time rate, rate in provenance) |
| withdraw_vesting | Vested −X / PendingWithdraw +X (13-week queue) |
| fill_vesting_withdraw | PendingWithdraw −X / Liquid +X |
| transfer_to/from_savings | Liquid ↔ Savings |
| convert / fill_convert_request | Hbd −X / ConversionRequest, then resolve at feed price with gain/loss posting |
| claim_reward_balance | Income:Rewards:{Author,Curation,VestingMint} → asset accounts |
| delegate_vesting_shares | bilateral delegation accounts |

### Key decisions

- **VESTS as native unit** (strategy 1): store `Assets:Hive:Vested` in VESTS,
  not pre-converted HP. Conversion rate
  (`total_vesting_fund_hive / total_vesting_shares`) is time-varying; storing
  native VESTS allows revaluation without ledger rewrites.
- **Idempotency**: deterministic posting id
  `hive:<blockNum>:<txIndex>:<opIndex>`; resume sync via `fromTrxIndex`;
  dedupe by id; ledger balance checks flag double-booking.
- **Reconciliation**: report module compares ledger totals against live chain
  account state (balance, hbd_balance, vesting_shares, savings).
- Module layout: `account-ledger.mts`, `chart.mts`, `operation-mapper.mts`,
  `vests-conversion.mts`, `idempotency.mts`, `report/{account-summary,reconciliation}.mts`.
- Amounts via `ledger-codecs` exact rational `Amount` — no float drift.

## B. `lib/hive-engine-topology`

HE exposes **state** (contracts API: balances, stakes, delegations, orders,
NFT ownership — snapshot) and **history** (event log — append-only). Both
become `meme-topology` attestations, mirroring `hive-topology`'s
term/predicate/attestation/carrier pattern:

- Terms: `hive-engine.token.<SYM>`, `hive-engine.balance.<acct>.<SYM>`,
  `hive-engine.stake.…`, `hive-engine.delegation.<from>.<to>.<SYM>`,
  `hive-engine.order.<id>`, `hive-engine.nft.<contract>.<id>`.
- Predicates: `holds`, `staked`, `delegated`, `open-order`, `nft-owned`.
- State snapshots → `affirm` attestations; events that end a state
  (transfer out, fill, cancel) → `deny` attestations.
- Provenance carries `{source: "state-api"|"event-api", timestamp, blockNum,
  eventNum, transactionHash}`.
- **Quantities do not live in the topology** — balances as exact strings in
  provenance; the topology models existence/polarity of holdings. Quantities
  belong to the accounting bridge.
- Branded carrier + section helpers (`hiveEngineHoldsCharge`,
  `hiveEngineAllHoldersOfToken`, …) parallel to `hive-section.mts`.

## C. Rewards/curation math — proposed `lib/hive-rewards-math`

`apps/waggle/src/chain.mts` has reads but no formulas; `topology.mts` models
relationships, not quantities. Centralize the math, pure and testable:

- `vote-value.mts`: `voteValue(rshares, rewardFund, recentClaims)`;
  voting-power decay (1/50 per full vote) and regen (full in 5 days).
- `curation.mts`: curation-window eligibility, eligible-vote filtering,
  proportional curation share.
- `vesting.mts`: vests↔HP with exact rational rate, historical rate cache.
- `reward-pool.mts` / `chain-state.mts`: assemble reward fund, recent claims,
  median price, DGP into one fetched state object (waggle now exposes
  `getRewardFund`, `getCurrentMedianHistoryPrice`, `getFeedHistory`).

Missing formulas to add: author/curation payout split, inflation drift,
13-week power-down vesting schedule, conversion fee, delegation impact on
vote power.

## Existing code that already half-does these jobs

- `ledger-topology/src/ledger.mts` — orchestration model for the bridge.
- `hive-topology` — financial-topology layer already models HIVE/HP/HBD
  holdings; HE topology should mirror it.
- `meme-topology` attestation dedup — helps idempotency.
- `ledger-codecs` rational arithmetic — foundation for all reward math.
