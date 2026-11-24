# @red-cup-engineering/read-hive-engine-account-history-service

Reads a Hive-Engine account's operation history, paged (`limit`/`offset`) from two independent public REST indexers (`accounts.hive-engine.com` and `history.hive-engine.com` by default) and witnessed against each other, over an optional `[from, to)` time range. Token transfers, staking (`tokens_stake`), unstaking, delegation, curation rewards (`comments_curationReward`/`_stake`), pool distributions, and HIVE-peg buys/withdrawals are shaped directly as ledger entries; every market or pool-swap fill (`market_buy`/`sell`/`marketSell`/`buyRemaining`, `marketpools_swapTokens`) is resolved by its transaction id through `@red-cup-engineering/read-hive-engine-fill-service` rather than re-derived, so cost-basis and witness logic for a fill lives in exactly one place. Read-only; no key is ever required or accepted.

## Operation

~~~js
export async function readHiveEngineAccountHistory(input, options)
~~~

### Parameters

- input (`{ account: string, nodes?: readonly string[], fillNodes?: readonly string[], from?: { time?: string }, to?: { time?: string } }`): the account to read; `nodes` overrides the two default REST indexer base URLs; `fillNodes` overrides the two default Hive-Engine RPC nodes passed through to `read-hive-engine-fill-service`; `from`/`to` bound the window (ISO instants; omit both for the account's whole history).
- options (`{ fetchImpl?: typeof fetch, readFillImpl?: typeof readHiveEngineFill }`): for tests — an injectable `fetch` and an injectable fill reader. Default to the real network call and the real `read-hive-engine-fill-service` import.

### Returns

`{ account, nodesUsed, fillNodesUsed, from, to, entryCount, fillCount, entries, fills, refusals }`. Each direct `entries[]` row carries `{ transactionId, blockNumber, timestamp, operation, symbol, quantity, from, to, account, classification, witnessed }` with `timestamp` converted to an ISO instant and every quantity kept as the indexer's own exact decimal string. `fills[]` is exactly what `read-hive-engine-fill-service` returned per distinct fill transaction id (`{ ok: true, fill }` or `{ ok: false, refusal }`). `refusals[]` names a whole-history witness disagreement/fetch failure, or a per-row operation this service does not yet classify (never silently dropped).

### Refusals

- `TypeError`: when `input.account` is missing.

## Command

read-hive-engine-account-history reads one JSON value on stdin and writes one JSON value to stdout.
