import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRow,
  fetchAllPages,
  readHiveEngineAccountHistory,
  rowsAgree,
} from "../scripts/read-hive-engine-account-history.mjs";

function jsonResponse(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

/**
 * A fetchImpl returning `rows` for offset=0 and an empty page for any other offset
 * (fetchAllPages stops only on empty); keyed by URL offset rather than call count so it behaves
 * correctly even when readHiveEngineAccountHistory calls it independently for two nodes.
 */
function pagedFetchImpl(rows) {
  return async (url) => {
    const offset = new URL(url).searchParams.get("offset");
    return jsonResponse(offset === "0" ? rows : []);
  };
}

test("read-hive-engine-account-history: throws on missing account", async () => {
  await assert.rejects(() => readHiveEngineAccountHistory({}), TypeError);
});

test("classifyRow: fills, direct entries, informational order-lifecycle rows, and unclassified operations", () => {
  assert.equal(classifyRow("market_buy"), "fill");
  assert.equal(classifyRow("marketpools_swapTokens"), "fill");
  assert.equal(classifyRow("market_placeOrder"), "informational");
  assert.equal(classifyRow("market_closeOrder"), "informational");
  assert.equal(classifyRow("tokens_transfer"), "direct");
  assert.equal(classifyRow("comments_curationReward"), "direct");
  assert.equal(classifyRow("comments_authorReward"), "direct");
  assert.equal(classifyRow("comments_authorReward_stake"), "direct");
  assert.equal(classifyRow("comments_beneficiaryReward"), "direct");
  assert.equal(classifyRow("comments_beneficiaryReward_stake"), "direct");
  assert.equal(classifyRow("tokens_undelegateDone"), "direct");
  assert.equal(classifyRow("tokens_undelegateStart"), "informational");
  assert.equal(classifyRow("market_cancel"), "informational");
  assert.equal(classifyRow("market_expire"), "informational");
  assert.equal(classifyRow("market_sellRemaining"), "informational");
  assert.equal(classifyRow("some_future_op"), "unclassified");
});

test("rowsAgree: agrees on identical rows, disagrees on a differing quantity", () => {
  const a = [{ transactionId: "t1", operation: "tokens_transfer", symbol: "SWAP.HIVE", quantity: "1" }];
  const b = [{ transactionId: "t1", operation: "tokens_transfer", symbol: "SWAP.HIVE", quantity: "1" }];
  const c = [{ transactionId: "t1", operation: "tokens_transfer", symbol: "SWAP.HIVE", quantity: "2" }];
  assert.equal(rowsAgree(a, b), true);
  assert.equal(rowsAgree(a, c), false);
});

test("fetchAllPages: stops only on a genuinely empty page, never on a short page (the real indexer silently caps below the requested limit)", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // every page is SHORTER than the requested limit (simulating the real server-side cap),
    // yet more data follows until the third call, which is genuinely empty.
    if (calls === 1) return jsonResponse(new Array(2).fill({ transactionId: "x" }));
    if (calls === 2) return jsonResponse(new Array(2).fill({ transactionId: "y" }));
    return jsonResponse([]);
  };
  const rows = await fetchAllPages("https://example.test", "michael561", fetchImpl, 1000);
  assert.equal(rows.length, 4);
  assert.equal(calls, 3);
});

test("fetchAllPages: refuses rather than silently truncating if a page never comes back empty", async () => {
  const fetchImpl = async () => jsonResponse(new Array(1).fill({ transactionId: "x" }));
  await assert.rejects(() => fetchAllPages("https://example.test", "michael561", fetchImpl, 1), /exceeded/);
});

test("readHiveEngineAccountHistory: a fill read that keeps throwing (e.g. a rate-limited node's HTML error page) is retried, then reported as a refusal instead of crashing the run", async () => {
  const rows = [
    { transactionId: "t-swap", operation: "marketpools_swapTokens", symbol: "GLD", quantity: "4.1917", account: "michael561", timestamp: 1788592100, blockNumber: 2 },
  ];
  const fetchImpl = pagedFetchImpl(rows);
  let calls = 0;
  const readFillImpl = async () => { calls += 1; throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"); };
  const result = await readHiveEngineAccountHistory({ account: "michael561" }, { fetchImpl, readFillImpl });
  assert.equal(calls, 4); // one try plus 3 retries
  assert.equal(result.fillCount, 1);
  assert.equal(result.fills[0].ok, false);
  assert.equal(result.fills[0].refusal.reason, "fill-read-failed");
});

test("readHiveEngineAccountHistory: classifies a transfer as direct and a swap as a resolved fill", async () => {
  const rows = [
    { transactionId: "t-transfer", operation: "tokens_transfer", symbol: "SWAP.HIVE", quantity: "1", from: "a", to: "michael561", account: "michael561", timestamp: 1788592032, blockNumber: 1 },
    { transactionId: "t-swap", operation: "marketpools_swapTokens", symbol: "GLD", quantity: "4.1917", account: "michael561", timestamp: 1788592100, blockNumber: 2 },
  ];
  const fetchImpl = pagedFetchImpl(rows);
  const readFillImpl = async ({ transactionId }) => ({ ok: true, fill: { fillId: transactionId, venue: "hive-engine" } });
  const result = await readHiveEngineAccountHistory({ account: "michael561" }, { fetchImpl, readFillImpl });
  assert.equal(result.entryCount, 1);
  assert.equal(result.entries[0].operation, "tokens_transfer");
  assert.equal(result.fillCount, 1);
  assert.equal(result.fills[0].fill.fillId, "t-swap");
  assert.equal(result.refusals.length, 0); // both node fetches used the same fetchImpl and agree
});

test("readHiveEngineAccountHistory: an unclassified operation is a named refusal, not a silent drop", async () => {
  const rows = [{ transactionId: "t-mystery", operation: "some_future_op", account: "michael561", timestamp: 1788592032, blockNumber: 1 }];
  const fetchImpl = pagedFetchImpl(rows);
  const result = await readHiveEngineAccountHistory({ account: "michael561" }, { fetchImpl });
  assert.equal(result.entries[0].classification, "unclassified");
  assert.ok(result.refusals.some((r) => r.reason === "unclassified-operation"));
});

test("readHiveEngineAccountHistory: market_placeOrder/closeOrder are informational (no entry, no refusal); the fill still books", async () => {
  const rows = [
    { transactionId: "tr1", operation: "market_placeOrder", symbol: "GLD", account: "michael561", timestamp: 1700000000 },
    { transactionId: "tr1", operation: "market_sell", symbol: "GLD", quantityTokens: "1", account: "michael561", timestamp: 1700000000 },
    { transactionId: "tr1", operation: "market_closeOrder", symbol: "GLD", account: "michael561", timestamp: 1700000000 },
  ];
  const fetchImpl = pagedFetchImpl(rows);
  const readFillImpl = async ({ transactionId }) => ({ ok: true, fill: { fillId: transactionId } });
  const result = await readHiveEngineAccountHistory({ account: "michael561" }, { fetchImpl, readFillImpl });
  assert.equal(result.entryCount, 0);
  assert.equal(result.fillCount, 1);
  assert.equal(result.refusals.length, 0);
});

test("readHiveEngineAccountHistory: a from/to window excludes rows outside it", async () => {
  const rows = [
    { transactionId: "old", operation: "tokens_transfer", account: "michael561", timestamp: 1000, blockNumber: 1 },
    { transactionId: "new", operation: "tokens_transfer", account: "michael561", timestamp: 5000, blockNumber: 2 },
  ];
  const fetchImpl = pagedFetchImpl(rows);
  const result = await readHiveEngineAccountHistory(
    { account: "michael561", from: { time: new Date(4000000).toISOString() } },
    { fetchImpl },
  );
  assert.equal(result.entryCount, 1);
  assert.equal(result.entries[0].transactionId, "new");
});
