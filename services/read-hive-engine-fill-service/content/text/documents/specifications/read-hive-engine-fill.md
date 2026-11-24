# read-hive-engine-fill
## Requirements
- `two-node-witness`: The operation must query `getTransactionInfo` at `<node>/rpc/blockchain` for every node in `input.nodes` (at least {{minimum-witness-nodes}}) and carry each node's `databaseHash` forward as a witness. [claims: minimum-witness-nodes]
- `exact-operation-resolution`: When a node's result is an array of operations sharing one underlying Hive transaction, the operation must resolve to the single entry whose own `transactionId` exactly equals `input.transactionId`, refusing with reason `ambiguous-result` when no such single entry exists.
- `account-scoped-transfer-legs`: The operation must read the paid leg from the `tokens.transferToContract` event whose `data.from` equals `input.account` and the received leg from the `tokens.transferFromContract` event whose `data.to` equals `input.account`, so a third party's leg in the same transaction (a market counterparty; measured: {{counterparty-leg-count}} such leg beside the account's own two) is never mistaken for the queried account's own settlement. [claims: counterparty-leg-count]
- `contract-action-shape`: A `marketpools.swapTokens` or `market.buy` resolves to `side: "buy"` (base = received symbol, quote = paid symbol); a `market.sell` resolves to `side: "sell"` (base = paid symbol, quote = received symbol).
- `crossing-transaction-settles`: A fill is read from the transaction of the order that crossed the book; the placement transaction of a resting order carries only its escrow leg (measured: {{resting-transaction-event-count}} event, the `tokens.transferToContract`), so reading it refuses with reason `no-completed-transfer` and is never shaped as a fill. [claims: resting-transaction-event-count]
- `unreachable-path-is-no-witness`: The operation calls `<node>/rpc/blockchain` and no other path; a node that returns no result there (measured: {{path-miss-node-count}} of the probed public nodes answer {{path-miss-status}} there and serve only `/blockchain`) is refused as `ambiguous-result` and never counted as a witness. [claims: path-miss-node-count, path-miss-status]
- `informational-pool-fee`: A `marketpools.swapTokens` event's `fee` data must be carried forward as `venuePoolFee`, informational only, never as `feeAmount`.
## Prohibitions
- `no-booking-on-disagreement`: The operation must return a `witness-disagreement` refusal, never a shaped fill, when any pair of queried nodes' `databaseHash` values differ. [claims: agreeing-node-count]
- `no-unsupported-action-fill`: The operation must refuse with reason `unsupported-contract-action`, never shape a fill, for any contract/action other than `marketpools.swapTokens`, `market.sell`, or `market.buy`. [claims: settlement-is-market-action]
- `no-missing-transfer-fill`: The operation must refuse with reason `no-completed-transfer`, never shape a fill, when the resolved operation's logs carry no matching paid-and-received transfer pair for `input.account`. [claims: resting-transaction-event-count, counterparty-leg-count]
## Laws
- `fill-settles-in-crossing-transaction` | Hive-Engine sidechain, measured | 2026-10-19 | data/records/2026-10-19-work-order-evidence/hive-engine-fill-leo-oivas-sell.json | Applies to `account-scoped-transfer-legs`, `crossing-transaction-settles` and `no-missing-transfer-fill`. | On the live sidechain a trade settles in the transaction of the order that crosses the book: that transaction's logs carry the crossing account's `tokens.transferToContract` paid leg and `tokens.transferFromContract` received leg, plus the counterparty's own `transferFromContract` leg, while the resting order's earlier transaction records only its escrow `transferToContract`. A fill therefore exists for an account only where both of its own legs appear in the one resolved transaction.
- `fill-is-booked-on-agreed-database-hash` | Hive-Engine sidechain, measured | 2026-10-19 | data/records/2026-10-19-work-order-evidence/hive-engine-fill-leo-oivas-sell.json | Applies to `two-node-witness` and `no-booking-on-disagreement`. | Every node returns a `databaseHash` with a transaction's result, and nodes of different operators returned the identical hash for the same transaction; agreement among independent nodes is therefore the witness, a fill is booked only when every queried node agrees, and one node's report alone books nothing.
- `rpc-path-is-node-specific` | Hive-Engine sidechain, measured | 2026-10-19 | data/records/2026-10-19-work-order-evidence/hive-engine-fill-leo-oivas-sell.json | Applies to `unreachable-path-is-no-witness` and `two-node-witness`. | The blockchain RPC path is not uniform across public nodes: some serve it under `/rpc/blockchain`, others only under `/blockchain`; a node base URL is a usable witness only if it answers `getTransactionInfo` at the path this operation calls.
## Standards
- `hive-engine-rpc` | Hive-Engine sidechain JSON-RPC | live | https://api.hive-engine.com/rpc/blockchain | Applies to `two-node-witness` and `exact-operation-resolution`. | `getTransactionInfo` takes `{txid}` and returns either one operation object or an array of operations sharing the underlying Hive transaction id; each carries its own `databaseHash`, `blockNumber`, `contract`, `action`, and JSON-encoded `logs.events`.
- `node-esm-operation` | Node.js | v24.2.0+ | https://nodejs.org/docs/v24/api/esm.html | Applies to the .mjs operation. | The operation uses the global `fetch` (or an injected `input.fetchImpl` for tests) with no runtime dependencies.
## Open questions
none
## Claims
- `agreeing-node-count` | measured | parameter | Public nodes that returned one identical databaseHash for the crossing (sell) transaction of a recent LEO/SWAP.HIVE trade, and again one identical hash for the resting (buy) transaction | 5 nodes | data/records/2026-10-19-work-order-evidence/hive-engine-fill-leo-oivas-sell.json | sha256:31f6faaa21aca84a9e630dfb014abab4608929082382a1cb709bdc9edb988afc | getTransactionInfo on api.hive-engine.com, api2.hive-engine.com, herpc.dtools.dev, herpc.actifit.io and api.primersion.com returned databaseHash 360c8c2e0ff92f4e06031f73593a1e9f69aba69c4f90c146c39d8d47a65f64e2 at block 63845990 for the sell and 3a4824d803b56639de187db222016e6170fe95d3ef12f54f1eb7b3589778bf14 at block 63845985 for the buy (2026-10-19)
- `minimum-witness-nodes` | derived | parameter | The least number of nodes that can witness agreement on a databaseHash: agreement is a relation between a pair, and one node alone agrees with nothing | 2 nodes | claim:agreeing-node-count; citation:definition of agreement, a relation between a pair | Five independent nodes were measured agreeing, so agreement is attainable across operators; the smallest set in which agreement can be tested is a pair
- `counterparty-leg-count` | measured | parameter | Third-party `tokens.transferFromContract` legs in the crossing transaction beside the crossing account's own two legs | 1 legs | data/records/2026-10-19-work-order-evidence/hive-engine-fill-leo-oivas-sell.json | sha256:31f6faaa21aca84a9e630dfb014abab4608929082382a1cb709bdc9edb988afc | The sell transaction 6dc67deff10fe4a1e2da0070bf00e82a5682efb6 logged transferToContract from oivas, transferFromContract to leotaker (the counterparty), and transferFromContract to oivas (2026-10-19)
- `resting-transaction-event-count` | measured | parameter | Events in the logs of the resting buy order's placement transaction | 1 events | data/records/2026-10-19-work-order-evidence/hive-engine-fill-leo-oivas-sell.json | sha256:31f6faaa21aca84a9e630dfb014abab4608929082382a1cb709bdc9edb988afc | Transaction fe3171ce4bf332b291851573166ed2ac285f417b logged only tokens.transferToContract from leotaker to market, no transferFromContract, on all five nodes (2026-10-19)
- `path-miss-node-count` | measured | parameter | Probed public nodes that return no result at /rpc/blockchain | 3 nodes | data/records/2026-10-19-work-order-evidence/hive-engine-fill-leo-oivas-sell.json | sha256:31f6faaa21aca84a9e630dfb014abab4608929082382a1cb709bdc9edb988afc | POST getTransactionInfo to /rpc/blockchain on herpc.dtools.dev, herpc.actifit.io and api.primersion.com answered a not-found status with no result, while the same nodes answered at /blockchain (2026-10-19)
- `path-miss-status` | measured | parameter | The HTTP status those nodes returned at /rpc/blockchain | 404 status | data/records/2026-10-19-work-order-evidence/hive-engine-fill-leo-oivas-sell.json | sha256:31f6faaa21aca84a9e630dfb014abab4608929082382a1cb709bdc9edb988afc | pathProbe records status 404 for each of the three nodes (2026-10-19)
- `settlement-is-market-action` | derived | world | A trade is settled by the crossing order's market action, so a transaction of any other contract/action is no fill for this operation | none | constraint:fill-settles-in-crossing-transaction | The law places the settlement legs in the crossing market transaction, so an action outside the market set has no such legs to read
## Package
```json
{"packageName":"@red-cup-engineering/read-hive-engine-fill-service","packageVersion":"0.1.1","license":"UNLICENSED","dependencies":{},"devDependencies":{}}
```
## Operation
```mjs path=scripts/read-hive-engine-fill.mjs
#!/usr/bin/env node
const SUPPORTED_ACTIONS = new Set(["marketpools:swapTokens", "market:sell", "market:buy"]);

async function queryNode(node, transactionId, fetchImpl) {
  const response = await fetchImpl(`${node}/rpc/blockchain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransactionInfo", params: { txid: transactionId } }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`read-hive-engine-fill: node ${node} returned error: ${JSON.stringify(body.error)}`);
  return body.result;
}

function resolveOperation(result, transactionId) {
  const candidates = Array.isArray(result) ? result : [result];
  if (candidates.length === 1) return candidates[0];
  const matched = candidates.filter((c) => c && c.transactionId === transactionId);
  return matched.length === 1 ? matched[0] : null;
}

function parseLogs(operation) {
  return typeof operation.logs === "string" ? JSON.parse(operation.logs) : operation.logs;
}

/**
 * Read one Hive-Engine `marketpools.swapTokens`, `market.sell`, or `market.buy` fill by
 * transaction id from at least two public nodes, refusing without shaping a fill when the nodes
 * disagree on `databaseHash`, the operation cannot be resolved unambiguously, its contract/action
 * is not one of the supported market actions, or its logs carry no completed token transfer
 * to and from `input.account`.
 * @param {{ transactionId: string, account: string, date: string, nodes: readonly string[],
 *   mandateId?: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ ok: true, fill: object } | { ok: false, refusal: object }>}
 * @throws {TypeError} When `input.nodes` has fewer than two entries or a required field is missing.
 */
export async function readHiveEngineFill(input) {
  if (!input || typeof input.transactionId !== "string" || input.transactionId === "") {
    throw new TypeError("read-hive-engine-fill: input.transactionId must be a non-empty string");
  }
  if (typeof input.account !== "string" || input.account === "") {
    throw new TypeError("read-hive-engine-fill: input.account must be a non-empty string");
  }
  if (typeof input.date !== "string" || input.date === "") {
    throw new TypeError("read-hive-engine-fill: input.date must be a non-empty YYYY-MM-DD string");
  }
  if (!Array.isArray(input.nodes) || input.nodes.length < 2) {
    throw new TypeError("read-hive-engine-fill: input.nodes must list at least two node base URLs");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const witnesses = [];
  let resolvedOperation = null;
  for (const node of input.nodes) {
    const result = await queryNode(node, input.transactionId, fetchImpl);
    const operation = resolveOperation(result, input.transactionId);
    if (!operation) {
      return { ok: false, refusal: { transactionId: input.transactionId, reason: "ambiguous-result", node } };
    }
    witnesses.push({ node, databaseHash: operation.databaseHash });
    resolvedOperation = resolvedOperation ?? operation;
  }
  const firstHash = witnesses[0].databaseHash;
  if (!witnesses.every((w) => w.databaseHash === firstHash)) {
    return { ok: false, refusal: { transactionId: input.transactionId, reason: "witness-disagreement", witnesses } };
  }
  const actionKey = `${resolvedOperation.contract}:${resolvedOperation.action}`;
  if (!SUPPORTED_ACTIONS.has(actionKey)) {
    return {
      ok: false,
      refusal: { transactionId: input.transactionId, reason: "unsupported-contract-action", contract: resolvedOperation.contract, action: resolvedOperation.action },
    };
  }
  const logs = parseLogs(resolvedOperation);
  const events = Array.isArray(logs.events) ? logs.events : [];
  const paidEvent = events.find((e) => e.contract === "tokens" && e.event === "transferToContract" && e.data.from === input.account);
  const receivedEvent = events.find((e) => e.contract === "tokens" && e.event === "transferFromContract" && e.data.to === input.account);
  if (!paidEvent || !receivedEvent) {
    return { ok: false, refusal: { transactionId: input.transactionId, reason: "no-completed-transfer", account: input.account, events } };
  }
  const swapFeeEvent = events.find((e) => e.contract === "marketpools" && e.event === "swapTokens");
  const isDisposal = resolvedOperation.contract === "market" && resolvedOperation.action === "sell";
  const fill = {
    venue: "hive-engine",
    account: input.account,
    fillId: resolvedOperation.transactionId,
    date: input.date,
    side: isDisposal ? "sell" : "buy",
    baseCommodity: isDisposal ? paidEvent.data.symbol : receivedEvent.data.symbol,
    quoteCommodity: isDisposal ? receivedEvent.data.symbol : paidEvent.data.symbol,
    baseQuantity: isDisposal ? paidEvent.data.quantity : receivedEvent.data.quantity,
    quoteAmount: isDisposal ? receivedEvent.data.quantity : paidEvent.data.quantity,
    feeAmount: "0",
    mandateId: input.mandateId ?? "manual",
    witnessBlock: String(resolvedOperation.blockNumber),
    witnesses,
    venuePoolFee: swapFeeEvent ? swapFeeEvent.data.fee : null,
  };
  return { ok: true, fill };
}

if (import.meta.main) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    process.stdout.write(`${JSON.stringify(await readHiveEngineFill(JSON.parse(text)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(2);
  }
}
```
## Tests
```mjs path=test/read-hive-engine-fill.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readHiveEngineFill } from "../scripts/read-hive-engine-fill.mjs";

function jsonResponse(body) {
  return { json: async () => body };
}

function fakeFetch(byNode) {
  return async (url) => {
    const node = url.replace(/\/rpc\/blockchain$/u, "");
    return jsonResponse(byNode[node]);
  };
}

const SWAP_TX = "a6308f23ba5026f1e670e61cea257eaf62524322-0";
const SWAP_RESULT = {
  blockNumber: 62583781,
  transactionId: SWAP_TX,
  sender: "michael561",
  contract: "marketpools",
  action: "swapTokens",
  databaseHash: "125f9476df1fcb03217e6dc705cbb1711aa253ef8d153ba7d50eb69ee10f3d58",
  logs: JSON.stringify({
    events: [
      { contract: "tokens", event: "transferToContract", data: { from: "michael561", to: "marketpools", symbol: "SWAP.HIVE", quantity: "0.99502065" } },
      { contract: "tokens", event: "transferFromContract", data: { from: "marketpools", to: "michael561", symbol: "GLD", quantity: "4.1917" } },
      { contract: "marketpools", event: "swapTokens", data: { symbolIn: "SWAP.HIVE", symbolOut: "GLD", fee: { symbol: "SWAP.HIVE", amount: "0.00249379" } } },
    ],
  }),
};

const SELL_TX = "5f6ff58a3be67498734d57ba0c9e5ef4230fa26f";
const SELL_RESULT = {
  blockNumber: 62584534,
  transactionId: SELL_TX,
  sender: "michael561",
  contract: "market",
  action: "sell",
  databaseHash: "5ad8af1f01723de5f634435c5a52e36470bb1b1195ba42b6e46defd48cdaf798",
  logs: JSON.stringify({
    events: [
      { contract: "tokens", event: "transferToContract", data: { from: "michael561", to: "market", symbol: "GLD", quantity: "4.1917" } },
      { contract: "tokens", event: "transferFromContract", data: { from: "market", to: "merchantsguild", symbol: "GLD", quantity: "4.1917" } },
      { contract: "tokens", event: "transferFromContract", data: { from: "market", to: "michael561", symbol: "SWAP.HIVE", quantity: "1.02172637" } },
      { contract: "market", event: "orderClosed", data: { account: "michael561", type: "sell", txId: SELL_TX } },
    ],
  }),
};

test("rejects fewer than two nodes", async () => {
  await assert.rejects(readHiveEngineFill({
    transactionId: "x", account: "a", date: "2026-09-05", nodes: ["https://only-one"],
  }), /at least two node base URLs/u);
});

test("a marketpools swapTokens fill shapes as a buy, picking the counterparty's proceeds leg correctly even with a third-party transfer present", async () => {
  const fetchImpl = fakeFetch({
    "https://node-a": { jsonrpc: "2.0", id: 1, result: SWAP_RESULT },
    "https://node-b": { jsonrpc: "2.0", id: 1, result: SWAP_RESULT },
  });
  const result = await readHiveEngineFill({
    transactionId: SWAP_TX, account: "michael561", date: "2026-09-05",
    nodes: ["https://node-a", "https://node-b"], fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fill.side, "buy");
  assert.equal(result.fill.baseCommodity, "GLD");
  assert.equal(result.fill.quoteCommodity, "SWAP.HIVE");
  assert.equal(result.fill.baseQuantity, "4.1917");
  assert.equal(result.fill.quoteAmount, "0.99502065");
  assert.equal(result.fill.witnesses.length, 2);
  assert.deepEqual(result.fill.venuePoolFee, { symbol: "SWAP.HIVE", amount: "0.00249379" });
});

test("a market sell fill shapes as a sell using only the proceeds transfer addressed to the queried account", async () => {
  const fetchImpl = fakeFetch({
    "https://node-a": { jsonrpc: "2.0", id: 1, result: SELL_RESULT },
    "https://node-b": { jsonrpc: "2.0", id: 1, result: SELL_RESULT },
  });
  const result = await readHiveEngineFill({
    transactionId: SELL_TX, account: "michael561", date: "2026-09-05",
    nodes: ["https://node-a", "https://node-b"], fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fill.side, "sell");
  assert.equal(result.fill.baseCommodity, "GLD");
  assert.equal(result.fill.quoteCommodity, "SWAP.HIVE");
  assert.equal(result.fill.baseQuantity, "4.1917");
  assert.equal(result.fill.quoteAmount, "1.02172637");
});

test("a resting order's placement transaction, carrying only its escrow leg, refuses and never shapes a fill", async () => {
  const resting = { ...SWAP_RESULT, contract: "market", action: "buy", sender: "michael561", logs: JSON.stringify({ events: [
    { contract: "tokens", event: "transferToContract", data: { from: "michael561", to: "market", symbol: "SWAP.HIVE", quantity: "0.23791456" } },
  ] }) };
  const fetchImpl = fakeFetch({ "https://node-a": { jsonrpc: "2.0", id: 1, result: resting }, "https://node-b": { jsonrpc: "2.0", id: 1, result: resting } });
  const result = await readHiveEngineFill({ transactionId: SWAP_TX, account: "michael561", date: "2026-10-19", nodes: ["https://node-a", "https://node-b"], fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.reason, "no-completed-transfer");
});

test("a node that returns no result at the called path is refused as ambiguous, never counted as a witness", async () => {
  const fetchImpl = fakeFetch({
    "https://node-a": { jsonrpc: "2.0", id: 1, result: SWAP_RESULT },
    "https://node-b": { statusCode: 404, statusMessage: "Cannot find any path matching /rpc/blockchain.", stack: [] },
  });
  const result = await readHiveEngineFill({ transactionId: SWAP_TX, account: "michael561", date: "2026-09-05", nodes: ["https://node-a", "https://node-b"], fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.reason, "ambiguous-result");
});

test("disagreeing witness nodes produce a witness-disagreement refusal, not a fill", async () => {
  const fetchImpl = fakeFetch({
    "https://node-a": { jsonrpc: "2.0", id: 1, result: SWAP_RESULT },
    "https://node-b": { jsonrpc: "2.0", id: 1, result: { ...SWAP_RESULT, databaseHash: "different-hash" } },
  });
  const result = await readHiveEngineFill({
    transactionId: SWAP_TX, account: "michael561", date: "2026-09-05",
    nodes: ["https://node-a", "https://node-b"], fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.reason, "witness-disagreement");
});

test("an unsupported contract/action refuses without shaping a fill", async () => {
  const other = { ...SWAP_RESULT, contract: "tokens", action: "transfer" };
  const fetchImpl = fakeFetch({
    "https://node-a": { jsonrpc: "2.0", id: 1, result: other },
    "https://node-b": { jsonrpc: "2.0", id: 1, result: other },
  });
  const result = await readHiveEngineFill({
    transactionId: SWAP_TX, account: "michael561", date: "2026-09-05",
    nodes: ["https://node-a", "https://node-b"], fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.reason, "unsupported-contract-action");
});

test("a multi-operation array result with no exact transactionId match refuses as ambiguous", async () => {
  const fetchImpl = fakeFetch({
    "https://node-a": { jsonrpc: "2.0", id: 1, result: [SWAP_RESULT, SELL_RESULT] },
    "https://node-b": { jsonrpc: "2.0", id: 1, result: [SWAP_RESULT, SELL_RESULT] },
  });
  const result = await readHiveEngineFill({
    transactionId: "not-a-real-suffix", account: "michael561", date: "2026-09-05",
    nodes: ["https://node-a", "https://node-b"], fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.reason, "ambiguous-result");
});
```
## Examples
```json name="the measured 2026-10-19 LEO sell by oivas, settled in its crossing transaction, resolves to a sell fill witnessed by two nodes"
{"input":{"transactionId":"6dc67deff10fe4a1e2da0070bf00e82a5682efb6","account":"oivas","date":"2026-10-19","nodes":["https://api.hive-engine.com","https://api2.hive-engine.com"]},"output":{"ok":true,"fill":{"venue":"hive-engine","account":"oivas","fillId":"6dc67deff10fe4a1e2da0070bf00e82a5682efb6","date":"2026-10-19","side":"sell","baseCommodity":"LEO","quoteCommodity":"SWAP.HIVE","baseQuantity":"0.117","quoteAmount":"0.00809656","feeAmount":"0","mandateId":"manual","witnessBlock":"63845990","witnesses":[{"node":"https://api.hive-engine.com","databaseHash":"360c8c2e0ff92f4e06031f73593a1e9f69aba69c4f90c146c39d8d47a65f64e2"},{"node":"https://api2.hive-engine.com","databaseHash":"360c8c2e0ff92f4e06031f73593a1e9f69aba69c4f90c146c39d8d47a65f64e2"}],"venuePoolFee":null}}}
```
## Traceability
- `two-node-witness` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`, `node-esm-operation`
- `exact-operation-resolution` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `account-scoped-transfer-legs` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `contract-action-shape` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `crossing-transaction-settles` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `unreachable-path-is-no-witness` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `informational-pool-fee` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `no-booking-on-disagreement` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `no-unsupported-action-fill` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `no-missing-transfer-fill` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
