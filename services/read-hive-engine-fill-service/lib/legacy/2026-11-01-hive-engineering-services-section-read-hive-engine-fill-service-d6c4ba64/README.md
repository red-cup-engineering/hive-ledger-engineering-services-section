# @red-cup-engineering/read-hive-engine-fill-service

Reads one Hive-Engine `marketpools.swapTokens`, `market.sell`, or `market.buy` fill by transaction id from at least two public nodes, read-only, shaping it into the standard venue-fill record or refusing (never shaping a fill) when the nodes disagree on `databaseHash`, the operation cannot be resolved unambiguously, its contract/action is unsupported, or its logs carry no completed transfer to and from the queried account.

## Operation

~~~js
export async function readHiveEngineFill(input)
~~~

### Parameters

- input ({ transactionId: string, account: string, date: string, nodes: readonly string[], mandateId?: string, fetchImpl?: typeof fetch }): The exact Hive-Engine transaction id to query, the account whose transfer legs identify the fill, the Beancount date to stamp on it (`getTransactionInfo` carries no timestamp), and at least two independent node base URLs.

### Returns

`{ ok: true, fill: object } | { ok: false, refusal: object }`, never a thrown error for a disagreement or an unsupported action — only for a malformed `input`.

### Refusals

- TypeError: When `input.nodes` has fewer than two entries or a required field is missing.
- `{ ok: false, refusal: { reason: "ambiguous-result" } }`: when a node's result is an array of operations and none (or more than one) carries a `transactionId` exactly matching the request.
- `{ ok: false, refusal: { reason: "witness-disagreement" } }`: when the queried nodes' `databaseHash` values disagree.
- `{ ok: false, refusal: { reason: "unsupported-contract-action" } }`: for any contract/action other than `marketpools.swapTokens`, `market.sell`, or `market.buy`.
- `{ ok: false, refusal: { reason: "no-completed-transfer" } }`: when the resolved operation's logs carry no paid-and-received transfer pair for `input.account`.

## Command

read-hive-engine-fill reads one JSON value on stdin and writes one JSON value to stdout.

## Examples

### the real leg-one Hive-Engine marketpools swap, witnessed live against api.hive-engine.com and api2.hive-engine.com

~~~json
{
  "input": {
    "transactionId": "a6308f23ba5026f1e670e61cea257eaf62524322-0",
    "account": "michael561",
    "date": "2026-09-05",
    "nodes": ["https://api.hive-engine.com", "https://api2.hive-engine.com"]
  },
  "output": {
    "ok": true,
    "fill": {
      "venue": "hive-engine",
      "account": "michael561",
      "fillId": "a6308f23ba5026f1e670e61cea257eaf62524322-0",
      "date": "2026-09-05",
      "side": "buy",
      "baseCommodity": "GLD",
      "quoteCommodity": "SWAP.HIVE",
      "baseQuantity": "4.1917",
      "quoteAmount": "0.99502065",
      "feeAmount": "0",
      "mandateId": "manual",
      "witnessBlock": "62583781",
      "witnesses": [
        { "node": "https://api.hive-engine.com", "databaseHash": "125f9476df1fcb03217e6dc705cbb1711aa253ef8d153ba7d50eb69ee10f3d58" },
        { "node": "https://api2.hive-engine.com", "databaseHash": "125f9476df1fcb03217e6dc705cbb1711aa253ef8d153ba7d50eb69ee10f3d58" }
      ],
      "venuePoolFee": { "symbol": "SWAP.HIVE", "amount": "0.00249379" }
    }
  }
}
~~~
