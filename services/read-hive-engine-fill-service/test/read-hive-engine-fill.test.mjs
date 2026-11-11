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
