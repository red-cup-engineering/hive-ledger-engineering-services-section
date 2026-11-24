import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_OPERATION_KINDS, readHiveAccountHistory } from "../scripts/read-hive-account-history.mjs";

const NODES = ["https://node-a.invalid", "https://node-b.invalid"];

function fakeClient(rows) {
  return {
    getDynamicGlobalProperties: async () => ({ total_vesting_fund_hive: "1000.000 HIVE", total_vesting_shares: "2000000.000000 VESTS", head_block_number: 1 }),
    getAccountHistory: async (_account, start, limit) => {
      const upTo = start === -1 ? Math.max(...rows.map(([index]) => index)) : start;
      return rows.filter(([index]) => index <= upTo && index > upTo - limit);
    },
  };
}

function row(index, kind, payload) {
  return [index, { trx_id: `trx${index}`, block: 100 + index, trx_in_block: 0, op_in_trx: 0, virtual_op: false, timestamp: "2026-01-02T00:00:00", op: [kind, payload] }];
}

test("the kinds that move a balance and complete a pending movement are read", () => {
  // Each of these is booked by derive-hive-account-ledger-service; a kind the reader does not
  // fetch can never reach it (a savings withdrawal would stay pending for ever).
  for (const kind of ["fill_transfer_from_savings", "fill_recurrent_transfer", "limit_order_cancelled", "fill_convert_request", "convert", "fill_order", "limit_order_create"]) {
    assert.ok(DEFAULT_OPERATION_KINDS.includes(kind), kind);
  }
});

test("a completed savings withdrawal, a recurrent transfer and a closed order come back from the history", async () => {
  const rows = [
    row(1, "transfer_from_savings", { from: "alice", to: "alice", request_id: 7, amount: "6.000 HBD" }),
    row(2, "fill_transfer_from_savings", { from: "alice", to: "alice", request_id: 7, amount: "6.000 HBD" }),
    row(3, "fill_recurrent_transfer", { from: "alice", to: "bob", amount: "1.000 HIVE" }),
    row(4, "limit_order_cancelled", { seller: "alice", orderid: 1, amount_back: "5.000 HIVE" }),
    row(5, "vote", { voter: "alice" }),
  ];
  const result = await readHiveAccountHistory({ account: "alice", nodes: NODES }, { clientFactory: () => fakeClient(rows) });
  assert.deepEqual(result.operations.map((o) => o.kind), ["transfer_from_savings", "fill_transfer_from_savings", "fill_recurrent_transfer", "limit_order_cancelled"]);
  assert.deepEqual(result.refusals, []);
});
