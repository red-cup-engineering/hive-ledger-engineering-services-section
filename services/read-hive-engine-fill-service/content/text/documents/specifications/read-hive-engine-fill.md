# read-hive-engine-fill
## Requirements
- `two-node-witness`: The operation must query `getTransactionInfo` at `<node>/rpc/blockchain` for every node in `input.nodes` (at least two) and carry each node's `databaseHash` forward as a witness.
- `exact-operation-resolution`: When a node's result is an array of operations sharing one underlying Hive transaction, the operation must resolve to the single entry whose own `transactionId` exactly equals `input.transactionId`, refusing with reason `ambiguous-result` when no such single entry exists.
- `account-scoped-transfer-legs`: The operation must read the paid leg from the `tokens.transferToContract` event whose `data.from` equals `input.account` and the received leg from the `tokens.transferFromContract` event whose `data.to` equals `input.account`, so a third party's leg in the same transaction (a market counterparty) is never mistaken for the queried account's own settlement.
- `contract-action-shape`: A `marketpools.swapTokens` or `market.buy` resolves to `side: "buy"` (base = received symbol, quote = paid symbol); a `market.sell` resolves to `side: "sell"` (base = paid symbol, quote = received symbol).
- `informational-pool-fee`: A `marketpools.swapTokens` event's `fee` data must be carried forward as `venuePoolFee`, informational only, never as `feeAmount`.
## Prohibitions
- `no-booking-on-disagreement`: The operation must return a `witness-disagreement` refusal, never a shaped fill, when any two queried nodes' `databaseHash` values differ.
- `no-unsupported-action-fill`: The operation must refuse with reason `unsupported-contract-action`, never shape a fill, for any contract/action other than `marketpools.swapTokens`, `market.sell`, or `market.buy`.
- `no-missing-transfer-fill`: The operation must refuse with reason `no-completed-transfer`, never shape a fill, when the resolved operation's logs carry no matching paid-and-received transfer pair for `input.account`.
## Laws
none
## Standards
- `hive-engine-rpc` | Hive-Engine sidechain JSON-RPC | live | https://api.hive-engine.com/rpc/blockchain | Applies to `two-node-witness` and `exact-operation-resolution`. | `getTransactionInfo` takes `{txid}` and returns either one operation object or an array of operations sharing the underlying Hive transaction id; each carries its own `databaseHash`, `blockNumber`, `contract`, `action`, and JSON-encoded `logs.events`.
- `node-esm-operation` | Node.js | v24.2.0+ | https://nodejs.org/docs/v24/api/esm.html | Applies to the .mjs operation. | The operation uses the global `fetch` (or an injected `input.fetchImpl` for tests) with no runtime dependencies.
## Open questions
none
## Package
```json
{"packageName":"@red-cup-engineering/read-hive-engine-fill-service","packageVersion":"0.1.0","license":"UNLICENSED","dependencies":{},"devDependencies":{}}
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
```json name="the real leg-one Hive-Engine marketpools swap resolves to a buy fill witnessed by two nodes"
{"input":{"transactionId":"a6308f23ba5026f1e670e61cea257eaf62524322-0","account":"michael561","date":"2026-09-05","nodes":["https://api.hive-engine.com","https://api2.hive-engine.com"]},"output":{"ok":true,"fill":{"venue":"hive-engine","account":"michael561","fillId":"a6308f23ba5026f1e670e61cea257eaf62524322-0","date":"2026-09-05","side":"buy","baseCommodity":"GLD","quoteCommodity":"SWAP.HIVE","baseQuantity":"4.1917","quoteAmount":"0.99502065","feeAmount":"0","mandateId":"manual","witnessBlock":"62583781","witnesses":[{"node":"https://api.hive-engine.com","databaseHash":"125f9476df1fcb03217e6dc705cbb1711aa253ef8d153ba7d50eb69ee10f3d58"},{"node":"https://api2.hive-engine.com","databaseHash":"125f9476df1fcb03217e6dc705cbb1711aa253ef8d153ba7d50eb69ee10f3d58"}],"venuePoolFee":{"symbol":"SWAP.HIVE","amount":"0.00249379"}}}}
```
## Traceability
- `two-node-witness` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`, `node-esm-operation`
- `exact-operation-resolution` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `account-scoped-transfer-legs` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `contract-action-shape` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `informational-pool-fee` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `no-booking-on-disagreement` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `no-unsupported-action-fill` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
- `no-missing-transfer-fill` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `hive-engine-rpc`
