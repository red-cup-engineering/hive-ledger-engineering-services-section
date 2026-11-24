import assert from "node:assert/strict";
import test from "node:test";
import { deriveHiveAccountLedger, inFlightAccountFor } from "../scripts/derive-hive-account-ledger.mjs";

const ME = "alice";
const CUSTODY = "Assets:Digital-Assets:Hive:Custody:Alice";
const HE = "Assets:Digital-Assets:HiveEngine:Custody:Alice";

let sequence = 0;
function op(kind, timestamp, payload) {
  sequence += 1;
  return { index: sequence, trxId: `trx${sequence}`, timestamp, kind, payload };
}

/**
 * What `bean-check` does with balance directives: an assertion is checked at the start of its
 * date, against the named account together with every account beneath it.
 */
function failedAssertions(ledgerText) {
  const balances = new Map();
  const postings = [];
  const assertions = [];
  let date = null;
  for (const line of ledgerText.split("\n")) {
    const head = /^(\d{4}-\d{2}-\d{2}) (\*|balance)(?: (\S+) (-?[\d.]+) (\S+))?/u.exec(line);
    if (head) {
      date = head[1];
      if (head[2] === "balance") assertions.push({ date, account: head[3], amount: head[4], commodity: head[5] });
      continue;
    }
    const posting = /^ {2}(\S+)\s+(-?\d+(?:\.\d+)?)\s+(\S+)/u.exec(line);
    if (posting && date) postings.push({ date, account: posting[1], amount: Number(posting[2]), commodity: posting[3] });
  }
  for (const p of postings) void p;
  const failures = [];
  for (const a of assertions) {
    let total = 0;
    for (const p of postings) {
      if (p.date >= a.date || p.commodity !== a.commodity) continue;
      if (p.account === a.account || p.account.startsWith(`${a.account}:`)) total += p.amount;
    }
    if (Math.abs(total - Number(a.amount)) > 1e-9) failures.push({ ...a, accumulated: total });
  }
  void balances;
  return failures;
}

function derive(overrides) {
  return deriveHiveAccountLedger({
    account: ME, rangeStart: "2026-01-01", rangeEnd: "2026-03-01", balanceDate: "2026-03-02",
    custodyAccount: CUSTODY, hiveEngineCustodyAccount: HE,
    openingBalances: { hive: "0", hbd: "0", vests: "0", hiveEngine: {} },
    ...overrides,
  });
}

test("an in-flight account sits outside the custody tree", () => {
  assert.equal(inFlightAccountFor(CUSTODY), "Assets:Digital-Assets:Hive:In-Flight:Alice");
  assert.equal(inFlightAccountFor("Assets:Hive"), "Assets:Hive-In-Flight");
});

test("assertions cover the sub-accounts: savings and staked quantities do not break the liquid assertion", () => {
  const result = derive({
    hiveOperations: [
      op("transfer", "2026-01-02T00:00:00", { from: "bob", to: ME, amount: "10.000 HBD", memo: "" }),
      op("transfer_to_savings", "2026-01-03T00:00:00", { from: ME, to: ME, amount: "4.000 HBD", memo: "" }),
      op("interest", "2026-01-04T00:00:00", { owner: ME, interest: "0.100 HBD", is_saved_into_hbd_balance: true }),
    ],
    hiveEngineEntries: [
      { transactionId: "t1", timestamp: "2026-01-05T00:00:00.000Z", operation: "tokens_transfer", symbol: "TKN", quantity: "5.000", from: "bob", to: ME },
      { transactionId: "t2", timestamp: "2026-01-06T00:00:00.000Z", operation: "tokens_stake", symbol: "TKN", quantity: "2.000", from: ME, to: ME },
    ],
    chainClosingBalances: {
      hive: "0", hbd: "6.000", vests: "0", hiveSavings: "0", hbdSavings: "4.100",
      hiveEngine: { TKN: "3.000" }, hiveEngineStaked: { TKN: "2.000" },
    },
  });
  assert.ok(result.balanceComparison.every((row) => row.match), JSON.stringify(result.balanceComparison.filter((r) => !r.match)));
  assert.deepEqual(failedAssertions(result.ledgerText), []);
  assert.match(result.ledgerText, new RegExp(`2026-03-02 balance ${CUSTODY} 10\\.1 HBD`, "u"));
  assert.match(result.ledgerText, new RegExp(`2026-03-02 balance ${CUSTODY}:Savings 4\\.100 HBD`, "u"));
});

test("the assertion dated on the last covered day would miss that day's operations; balanceDate follows it", () => {
  const result = derive({
    rangeEnd: "2026-03-01", balanceDate: "2026-03-02",
    hiveOperations: [op("transfer", "2026-03-01T10:00:00", { from: "bob", to: ME, amount: "1.000 HIVE", memo: "" })],
    chainClosingBalances: { hive: "1.000", hbd: "0", vests: "0" },
  });
  assert.deepEqual(failedAssertions(result.ledgerText), []);
  const early = derive({
    rangeEnd: "2026-03-01", balanceDate: "2026-03-01",
    hiveOperations: [op("transfer", "2026-03-01T10:00:00", { from: "bob", to: ME, amount: "1.000 HIVE", memo: "" })],
    chainClosingBalances: { hive: "1.000", hbd: "0", vests: "0" },
  });
  assert.equal(failedAssertions(early.ledgerText).length, 1);
});

test("a savings withdrawal is completed by its fill and leaves nothing in flight", () => {
  const result = derive({
    hiveOperations: [
      op("transfer", "2026-01-02T00:00:00", { from: "bob", to: ME, amount: "10.000 HBD", memo: "" }),
      op("transfer_to_savings", "2026-01-03T00:00:00", { from: ME, to: ME, amount: "10.000 HBD", memo: "" }),
      op("transfer_from_savings", "2026-01-10T00:00:00", { from: ME, to: ME, request_id: 7, amount: "6.000 HBD", memo: "" }),
      op("fill_transfer_from_savings", "2026-01-13T00:00:00", { from: ME, to: ME, request_id: 7, amount: "6.000 HBD", memo: "" }),
    ],
    chainClosingBalances: { hive: "0", hbd: "6.000", vests: "0", hbdSavings: "4.000" },
  });
  assert.deepEqual(result.refusals, []);
  assert.ok(result.balanceComparison.every((row) => row.match));
  assert.equal(result.accountBalances[`${inFlightAccountFor(CUSTODY)}:Pending-Savings-Withdrawal`].HBD, "0");
  assert.deepEqual(failedAssertions(result.ledgerText), []);
});

test("conversions, power ups for another account, recurrent transfers and self transfers", () => {
  const result = derive({
    hiveOperations: [
      op("transfer", "2026-01-02T00:00:00", { from: "bob", to: ME, amount: "20.000 HBD", memo: "" }),
      op("transfer", "2026-01-02T01:00:00", { from: ME, to: ME, amount: "9.000 HBD", memo: "to myself" }),
      op("convert", "2026-01-03T00:00:00", { owner: ME, requestid: 1, amount: "5.000 HBD" }),
      op("fill_convert_request", "2026-01-06T12:00:00", { owner: ME, requestid: 1, amount_in: "5.000 HBD", amount_out: "20.000 HIVE" }),
      op("transfer_to_vesting_completed", "2026-01-07T00:00:00", { from_account: ME, to_account: ME, hive_vested: "10.000 HIVE", vesting_shares_received: "19000.123456 VESTS" }),
      op("transfer_to_vesting_completed", "2026-01-08T00:00:00", { from_account: ME, to_account: "carol", hive_vested: "3.000 HIVE", vesting_shares_received: "5700.000000 VESTS" }),
      op("transfer_to_vesting_completed", "2026-01-09T00:00:00", { from_account: "dave", to_account: ME, hive_vested: "1.000 HIVE", vesting_shares_received: "1900.000000 VESTS" }),
      op("fill_recurrent_transfer", "2026-01-10T00:00:00", { from: ME, to: "erin", amount: "2.000 HIVE", memo: "", remaining_executions: 3 }),
    ],
    chainClosingBalances: { hive: "5.000", hbd: "15.000", vests: "20900.123456" },
  });
  assert.deepEqual(result.refusals, []);
  assert.ok(result.balanceComparison.every((row) => row.match), JSON.stringify(result.balanceComparison.filter((r) => !r.match)));
  assert.deepEqual(failedAssertions(result.ledgerText), []);
  assert.match(result.ledgerText, /-10 HIVE @@ 19000\.123456 VESTS/u);
  assert.match(result.ledgerText, /-5 HBD @@ 20\.000 HIVE/u);
});

test("market orders: funds are held by the order, fills draw on it, a closed order returns the rest", () => {
  const result = derive({
    hiveOperations: [
      op("transfer", "2026-01-02T00:00:00", { from: "bob", to: ME, amount: "100.000 HIVE", memo: "" }),
      op("limit_order_create", "2026-01-03T00:00:00", { owner: ME, orderid: 1, amount_to_sell: "60.000 HIVE", min_to_receive: "12.000 HBD" }),
      op("fill_order", "2026-01-03T00:10:00", { current_owner: "zed", current_orderid: 9, current_pays: "10.000 HBD", open_owner: ME, open_orderid: 1, open_pays: "50.000 HIVE" }),
      op("limit_order_cancelled", "2026-01-04T00:00:00", { seller: ME, orderid: 1, amount_back: "10.000 HIVE" }),
      op("limit_order_create", "2026-01-05T00:00:00", { owner: ME, orderid: 2, amount_to_sell: "20.000 HIVE", min_to_receive: "4.000 HBD" }),
      op("fill_order", "2026-01-05T00:00:01", { current_owner: ME, current_orderid: 2, current_pays: "20.000 HIVE", open_owner: "zed", open_orderid: 10, open_pays: "4.000 HBD" }),
    ],
    chainClosingBalances: { hive: "30.000", hbd: "14.000", vests: "0" },
  });
  assert.deepEqual(result.refusals, []);
  assert.equal(result.fillsBooked, 2);
  assert.ok(result.balanceComparison.every((row) => row.match), JSON.stringify(result.balanceComparison.filter((r) => !r.match)));
  assert.deepEqual(failedAssertions(result.ledgerText), []);
});

test("a Hive-Engine fill settles on the Hive-Engine custody account holding the tokens, without prior purchase lots", () => {
  const sellFill = {
    ok: true,
    fill: {
      venue: "hive-engine", account: ME, fillId: "fill-1", date: "2026-01-20", side: "sell",
      baseCommodity: "TKN", quoteCommodity: "SWAP.HIVE", baseQuantity: "40.000", quoteAmount: "8.00000000",
      custodyAccount: CUSTODY, mandateId: "chain-history",
    },
  };
  const result = derive({
    hiveEngineEntries: [
      { transactionId: "t1", timestamp: "2026-01-05T00:00:00.000Z", operation: "distribution_checkPendingDistributions", symbol: "TKN", quantity: "100.000", from: null, to: null },
    ],
    hiveEngineFills: [sellFill],
    chainClosingBalances: { hive: "0", hbd: "0", vests: "0", hiveEngine: { TKN: "60.000", "SWAP.HIVE": "8.00000000" } },
  });
  assert.deepEqual(result.refusals, []);
  assert.equal(result.fillsBooked, 1);
  assert.ok(result.balanceComparison.every((row) => row.match), JSON.stringify(result.balanceComparison.filter((r) => !r.match)));
  assert.deepEqual(failedAssertions(result.ledgerText), []);
  assert.match(result.ledgerText, new RegExp(`${HE} {2}-40 TKN @@ 8\\.00000000 SWAP\\.HIVE`, "u"));
  assert.doesNotMatch(result.ledgerText, /Trading/u);
});

test("an unhandled operation is a refusal, never silently dropped", () => {
  const result = derive({
    hiveOperations: [op("collateralized_convert", "2026-01-02T00:00:00", { owner: ME, requestid: 1, amount: "5.000 HIVE" })],
  });
  assert.equal(result.refusals.length, 1);
  assert.equal(result.refusals[0].reason, "unhandled-operation-kind");
});

test("a duplicated operation from overlapping history pages is booked once", () => {
  const dup = op("transfer", "2026-01-02T00:00:00", { from: "bob", to: ME, amount: "1.000 HIVE", memo: "" });
  const result = derive({ hiveOperations: [dup, { ...dup }], chainClosingBalances: { hive: "1.000", hbd: "0", vests: "0" } });
  assert.deepEqual(failedAssertions(result.ledgerText), []);
});
