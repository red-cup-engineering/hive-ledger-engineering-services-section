import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveHiveAccountLedger,
  plainDecimal,
  renderTransaction,
  splitClaimByAccrual,
} from "../scripts/derive-hive-account-ledger.mjs";

test("plainDecimal: expands a Hive-Engine indexer's scientific-notation quantity (decimal.mjs only accepts plain digits)", () => {
  assert.equal(plainDecimal("1e-8"), "0.00000001");
  assert.equal(plainDecimal("1.5e-6"), "0.0000015");
  assert.equal(plainDecimal("168.901"), "168.901"); // already plain: passed through unchanged
});

test("plainDecimal: adds a missing leading zero (a real indexer balance was seen as literal \".25\", which Beancount's lexer rejects)", () => {
  assert.equal(plainDecimal(".25"), "0.25");
  assert.equal(plainDecimal("-.25"), "-0.25");
  assert.equal(plainDecimal("0.25"), "0.25");
});

test("a Hive-Engine entry quantity in scientific notation is normalized before booking, not thrown", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineEntries: [
      { transactionId: "he8", timestamp: "2023-11-14T22:13:20.000Z", operation: "tokens_transfer", symbol: "VKBT", quantity: "1e-8", from: "someone", to: "michael561", account: "michael561" },
    ],
  });
  assert.ok(result.ledgerText.includes("0.00000001 VKBT"));
  assert.equal(result.refusals.length, 0);
});

const BASE_INPUT = {
  account: "michael561",
  rangeStart: "2026-06-01",
  rangeEnd: "2026-09-01",
  custodyAccount: "Assets:Digital-Assets:Hive:Custody:Michael561",
  hiveEngineCustodyAccount: "Assets:Digital-Assets:HiveEngine:Custody:Michael561",
  openingBalances: { hive: "0", hbd: "0", vests: "0", hiveEngine: {} },
  chainClosingBalances: { hive: "0", hbd: "0", vests: "0", hiveEngine: {} },
  hiveOperations: [],
  hiveEngineEntries: [],
  hiveEngineFills: [],
};

test("throws on missing account or custody account", () => {
  assert.throws(() => deriveHiveAccountLedger({}), TypeError);
  assert.throws(() => deriveHiveAccountLedger({ account: "a" }), TypeError);
});

test("splitClaimByAccrual: proportions a claim across author and curation pending accrual", () => {
  const result = splitClaimByAccrual("10", "2", "8");
  assert.equal(result.author, "2");
  assert.equal(result.curation, "8");
  assert.equal(result.attributedByFallback, false);
});

test("splitClaimByAccrual: falls back to curation when there is no recorded pending accrual", () => {
  const result = splitClaimByAccrual("5", "0", "0");
  assert.equal(result.author, "0");
  assert.equal(result.curation, "5");
  assert.equal(result.attributedByFallback, true);
});

test("renderTransaction: elides no posting; every amount is explicit", () => {
  const text = renderTransaction({
    date: "2026-09-01", narration: "x",
    postings: [{ account: "A", amount: "1", commodity: "HIVE" }, { account: "B", amount: "-1", commodity: "HIVE" }],
  });
  assert.equal(text, '2026-09-01 * "x"\n  A  1 HIVE\n  B  -1 HIVE');
});

test("renderTransaction: escapes embedded quotes in narration and metadata (a real Hive memo can carry a JSON blob)", () => {
  const text = renderTransaction({
    date: "2026-09-01", narration: 'say "hi"',
    metadata: { memo: '{"id":"riseofthepixels","action":"buy_license"}' },
    postings: [{ account: "A", amount: "1", commodity: "HIVE" }],
  });
  assert.ok(text.includes('say \\"hi\\"'));
  assert.ok(text.includes('memo: "{\\"id\\":\\"riseofthepixels\\",\\"action\\":\\"buy_license\\"}"'));
});

test("transfer_to_vesting_completed posts a price-linked HIVE-to-VESTS conversion (Beancount cannot balance two non-fungible units without one)", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "transfer_to_vesting_completed", trxId: "p1", timestamp: "2026-06-05T00:00:00", payload: { hive_vested: "28.889 HIVE", vesting_shares_received: "48908.188285 VESTS" } },
    ],
  });
  assert.ok(result.ledgerText.includes("-28.889 HIVE @"));
  assert.ok(result.ledgerText.includes("VESTS"));
});

test("fill_vesting_withdraw posts a price-linked VESTS-to-HIVE conversion", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "fill_vesting_withdraw", trxId: "p2", timestamp: "2026-06-05T00:00:00", payload: { withdrawn: "100.000000 VESTS", deposited: "0.058 HIVE" } },
    ],
  });
  assert.ok(result.ledgerText.includes("-100.000000 VESTS @"));
});

test("plain transfer in and out books custody vs Income/Expenses:Hive:Other", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "transfer", trxId: "t1", timestamp: "2026-06-05T00:00:00", payload: { from: "someone", to: "michael561", amount: "1.000 HIVE", memo: "" } },
      { index: 2, kind: "transfer", trxId: "t2", timestamp: "2026-06-06T00:00:00", payload: { from: "michael561", to: "someone", amount: "0.500 HIVE", memo: "" } },
    ],
  });
  assert.ok(result.ledgerText.includes("Income:Hive:Other"));
  assert.ok(result.ledgerText.includes("Expenses:Hive:Other"));
  assert.equal(result.refusals.length, 0);
});

test("overlapping history is idempotent and reports the highest observed resume index", () => {
  const transfer = { index: 7, kind: "transfer", trxId: "t-overlap", timestamp: "2026-06-05T00:00:00", payload: { from: "someone", to: "michael561", amount: "1.000 HIVE", memo: "" } };
  const result = deriveHiveAccountLedger({ ...BASE_INPUT, hiveOperations: [transfer, transfer] });
  assert.equal(result.transactionCount, 1);
  assert.equal(result.lastHiveOperationIndex, 7);
});

test("curation reward accrues silently, then claim_reward_balance books it as Income:Hive:Curation", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "curation_reward", trxId: "c1", timestamp: "2026-06-05T00:00:00", payload: { curator: "michael561", reward: "10.000000 VESTS", author: "x", permlink: "y" } },
      { index: 2, kind: "claim_reward_balance", trxId: "cl1", timestamp: "2026-06-06T00:00:00", payload: { account: "michael561", reward_hbd: "0.000 HBD", reward_hive: "0.000 HIVE", reward_vests: "10.000000 VESTS" } },
    ],
  });
  assert.equal(result.transactionCount, 1); // curation_reward books nothing on its own
  assert.ok(result.ledgerText.includes("Income:Hive:Curation"));
  assert.equal(result.nativeRewardTotals.curation.VESTS, "10");
  assert.ok(!("author" in result.nativeRewardTotals.author) || Object.keys(result.nativeRewardTotals.author).length === 0);
});

test("a claim with no recorded pending accrual is still booked, attributed to curation", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "claim_reward_balance", trxId: "cl1", timestamp: "2026-06-06T00:00:00", payload: { account: "michael561", reward_hbd: "1.000 HBD", reward_hive: "0.000 HIVE", reward_vests: "0.000 VESTS" } },
    ],
  });
  assert.equal(result.transactionCount, 1);
  assert.equal(result.nativeRewardTotals.curation.HBD, "1");
});

test("interest posts to custody or savings depending on is_saved_into_hbd_balance", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "interest", trxId: "i1", timestamp: "2026-06-06T00:00:00", payload: { owner: "michael561", interest: "1.845 HBD", is_saved_into_hbd_balance: false } },
    ],
  });
  assert.ok(result.ledgerText.includes("Income:Hive:Interest"));
  assert.equal(result.nativeRewardTotals.interest.HBD, "1.845");
});

test("savings lifecycle: transfer_to_savings, transfer_from_savings, and its fill net to zero across the three accounts", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "transfer_to_savings", trxId: "s1", timestamp: "2026-06-01T00:00:00", payload: { from: "michael561", to: "michael561", amount: "1.000 HBD" } },
      { index: 2, kind: "transfer_from_savings", trxId: "s2", timestamp: "2026-06-10T00:00:00", payload: { from: "michael561", to: "michael561", amount: "1.000 HBD", request_id: 42 } },
      { index: 3, kind: "fill_transfer_from_savings", trxId: "s3", timestamp: "2026-06-13T00:00:00", payload: { from: "michael561", to: "michael561", amount: "1.000 HBD", request_id: 42 } },
    ],
  });
  assert.equal(result.refusals.length, 0); // the pending withdrawal was completed before range end
  assert.equal(result.balanceComparison.find((b) => b.commodity === "HBD").computedClosing, "0");
});

test("an in-flight savings withdrawal at range end is a named refusal, not a silent drop", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "transfer_from_savings", trxId: "s2", timestamp: "2026-06-10T00:00:00", payload: { from: "michael561", to: "michael561", amount: "1.000 HBD", request_id: 42 } },
    ],
  });
  assert.ok(result.refusals.some((r) => r.reason === "savings-withdrawal-still-pending-at-range-end"));
});

test("cancel_transfer_from_savings returns a requested withdrawal to savings, clearing the pending flag", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "transfer_from_savings", trxId: "s2", timestamp: "2026-06-10T00:00:00", payload: { from: "michael561", to: "michael561", amount: "1.000 HBD", request_id: 42 } },
      { index: 2, kind: "cancel_transfer_from_savings", trxId: "s4", timestamp: "2026-06-11T00:00:00", payload: { from: "michael561", request_id: 42 } },
    ],
  });
  assert.equal(result.refusals.length, 0);
  assert.ok(result.ledgerText.includes("cancelled (returned to savings)"));
});

test("cancel_transfer_from_savings with no matching request is a named refusal", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [
      { index: 1, kind: "cancel_transfer_from_savings", trxId: "s4", timestamp: "2026-06-11T00:00:00", payload: { from: "michael561", request_id: 999 } },
    ],
  });
  assert.ok(result.refusals.some((r) => r.reason === "cancel-transfer-from-savings-no-matching-request"));
});

test("an unhandled Hive operation kind is a named refusal", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveOperations: [{ index: 1, kind: "some_new_op", trxId: "z1", timestamp: "2026-06-01T00:00:00", payload: {} }],
  });
  assert.ok(result.refusals.some((r) => r.reason === "unhandled-operation-kind" && r.kind === "some_new_op"));
});

test("Hive-Engine tokens_transfer, distribution, curation, stake, and unstake are booked and named", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineEntries: [
      { transactionId: "he1", timestamp: "2023-11-14T22:13:20.000Z", operation: "tokens_transfer", symbol: "GLD", quantity: "1.0000", from: "someone", to: "michael561", account: "michael561" },
      { transactionId: "he2", timestamp: "2023-11-14T22:13:21.000Z", operation: "distribution_checkPendingDistributions", symbol: "SIM", quantity: "168.901", from: "contract_distribution", to: "michael561", account: "michael561" },
      { transactionId: "he3", timestamp: "2023-11-14T22:13:22.000Z", operation: "comments_curationReward", symbol: "LEO", quantity: "0.500", from: null, to: "michael561", account: "michael561" },
      { transactionId: "he4", timestamp: "2023-11-14T22:13:23.000Z", operation: "tokens_stake", symbol: "GLD", quantity: "1.0000", from: "michael561", to: "michael561", account: "michael561" },
      { transactionId: "he5", timestamp: "2023-11-14T22:13:24.000Z", operation: "tokens_unstakeStart", symbol: "GLD", quantity: "1.0000", from: "michael561", to: "michael561", account: "michael561" },
    ],
  });
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Staked"));
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Pending-Unstake"));
  assert.equal(result.nativeRewardTotals.staking.SIM, "168.901");
  assert.equal(result.nativeRewardTotals.curation.LEO, "0.5");
  assert.equal(result.refusals.length, 0);
});

test("comments_authorReward and comments_beneficiaryReward book to Income:Hive:Author; their _stake variants credit :Staked, not liquid custody", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineEntries: [
      { transactionId: "he10", timestamp: "2023-11-14T22:13:20.000Z", operation: "comments_authorReward", symbol: "LEO", quantity: "1.000", account: "michael561" },
      { transactionId: "he11", timestamp: "2023-11-14T22:13:21.000Z", operation: "comments_authorReward_stake", symbol: "LEO", quantity: "2.000", account: "michael561" },
      { transactionId: "he12", timestamp: "2023-11-14T22:13:22.000Z", operation: "comments_beneficiaryReward", symbol: "LEO", quantity: "0.500", account: "michael561" },
      { transactionId: "he13", timestamp: "2023-11-14T22:13:23.000Z", operation: "comments_curationReward_stake", symbol: "LEO", quantity: "3.000", account: "michael561" },
    ],
  });
  assert.equal(result.nativeRewardTotals.author.LEO, "3.5"); // author (1) + author_stake (2) + beneficiary (0.5): gross income regardless of where it landed
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Staked  2.000 LEO"));
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Staked  3.000 LEO"));
  assert.equal(result.refusals.length, 0);
});

test("tokens_undelegateDone returns a delegated quantity to :Staked", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineEntries: [
      { transactionId: "he14", timestamp: "2023-11-14T22:13:20.000Z", operation: "tokens_undelegateDone", symbol: "WORKERBEE", quantity: "3.66758", account: "michael561" },
    ],
  });
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Staked  3.66758 WORKERBEE"));
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Delegated-Out  -3.66758 WORKERBEE"));
  assert.equal(result.refusals.length, 0);
});

test("tokens_delegate (out) moves balance from :Staked to :Delegated-Out; the Hive-Engine tokens contract only delegates staked balance, never liquid", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineEntries: [
      { transactionId: "he6", timestamp: "2023-11-14T22:13:20.000Z", operation: "tokens_delegate", symbol: "WORKERBEE", quantity: "3.66758", from: "michael561", to: "someoneelse", account: "michael561" },
    ],
  });
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Delegated-Out"));
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Staked  -3.66758 WORKERBEE"));
  assert.equal(result.refusals.length, 0);
});

test("tokens_undelegate reverses a prior delegation, returning the quantity to staked (not liquid custody)", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineEntries: [
      { transactionId: "he7", timestamp: "2023-11-14T22:13:20.000Z", operation: "tokens_undelegate", symbol: "WORKERBEE", quantity: "3.66758", from: "michael561", to: "someoneelse", account: "michael561" },
    ],
  });
  assert.ok(result.ledgerText.includes("Assets:Digital-Assets:HiveEngine:Custody:Michael561:Staked  3.66758 WORKERBEE"));
  assert.equal(result.refusals.length, 0);
});

test("an unclassified Hive-Engine operation is a named refusal", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineEntries: [{ transactionId: "he9", timestamp: "2023-11-14T22:13:20.000Z", operation: "some_future_op", symbol: "X", quantity: "1", account: "michael561" }],
  });
  assert.ok(result.refusals.some((r) => r.reason === "unhandled-hive-engine-operation"));
});

test("venue fills compose the real derive-set-of-fill-transactions-service", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineFills: [
      { ok: true, fill: { venue: "hive-engine", account: "michael561", fillId: "buy1", date: "2026-06-01", side: "buy", baseCommodity: "GLD", quoteCommodity: "SWAP.HIVE", baseQuantity: "4.1917", quoteAmount: "0.99502065", mandateId: "manual" } },
      { ok: true, fill: { venue: "hive-engine", account: "michael561", fillId: "sell1", date: "2026-06-02", side: "sell", baseCommodity: "GLD", quoteCommodity: "SWAP.HIVE", baseQuantity: "4.1917", quoteAmount: "1.02172637", mandateId: "manual" } },
    ],
  });
  assert.equal(result.fillsBooked, 2);
  assert.ok(result.ledgerText.includes("Trading"));
  assert.equal(result.refusals.length, 0);
});

test("a fill refusal from read-hive-engine-fill-service is carried through, not silently dropped", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    hiveEngineFills: [{ ok: false, refusal: { reason: "witness-disagreement" } }],
  });
  assert.ok(result.refusals.some((r) => r.reason === "fill-refused"));
});

test("a fill-transactions RangeError (insufficient inventory) is caught and reported, not thrown", () => {
  const deriveFillsImpl = () => { throw new RangeError("insufficient inventory"); };
  const result = deriveHiveAccountLedger(
    { ...BASE_INPUT, hiveEngineFills: [{ ok: true, fill: { venue: "hive-engine", account: "michael561", fillId: "sell-only", date: "2026-06-02", side: "sell", baseCommodity: "GLD", quoteCommodity: "SWAP.HIVE", baseQuantity: "1", quoteAmount: "1", mandateId: "manual" } }] },
    { deriveFillsImpl },
  );
  assert.ok(result.refusals.some((r) => r.reason === "fill-transactions-derivation-failed"));
});

test("opening balances and a matching chain closing balance report as matched", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    openingBalances: { hive: "10", hbd: "0", vests: "0", hiveEngine: {} },
    chainClosingBalances: { hive: "10", hbd: "0", vests: "0", hiveEngine: {} },
  });
  const hiveRow = result.balanceComparison.find((b) => b.commodity === "HIVE");
  assert.equal(hiveRow.match, true);
  assert.ok(result.ledgerText.includes("balance Assets:Digital-Assets:Hive:Custody:Michael561"));
});

test("a real chain mismatch is reported as a non-matching balanceComparison row", () => {
  const result = deriveHiveAccountLedger({
    ...BASE_INPUT,
    openingBalances: { hive: "10", hbd: "0", vests: "0", hiveEngine: {} },
    chainClosingBalances: { hive: "11", hbd: "0", vests: "0", hiveEngine: {} },
  });
  const hiveRow = result.balanceComparison.find((b) => b.commodity === "HIVE");
  assert.equal(hiveRow.match, false);
  assert.equal(hiveRow.computedClosing, "10");
  assert.equal(hiveRow.chainClosing, "11");
});
