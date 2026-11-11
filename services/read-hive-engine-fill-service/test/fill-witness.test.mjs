import assert from "node:assert/strict";
import test from "node:test";
import { resolveOperation, witnessHashRefusal } from "../scripts/fill-witness.mjs";

// The transaction/hash pairs already retained by read-hive-engine-fill.test.mjs.
const transactionId = "a6308f23ba5026f1e670e61cea257eaf62524322-0";
const otherTransactionId = "5f6ff58a3be67498734d57ba0c9e5ef4230fa26f";
const databaseHash = "125f9476df1fcb03217e6dc705cbb1711aa253ef8d153ba7d50eb69ee10f3d58";
const otherHash = "5ad8af1f01723de5f634435c5a52e36470bb1b1195ba42b6e46defd48cdaf798";
const requested = { transactionId, databaseHash };
const unrelated = { transactionId: otherTransactionId, databaseHash: otherHash };

test("matching transaction identity is required even for singleton results", () => {
  assert.equal(resolveOperation(unrelated, transactionId), null);
  assert.equal(resolveOperation([unrelated], transactionId), null);
  assert.equal(resolveOperation({ databaseHash }, transactionId), null);
  assert.equal(resolveOperation([null], transactionId), null);
});

test("exactly one matching operation preserves the original record", () => {
  assert.equal(resolveOperation(requested, transactionId), requested);
  assert.equal(resolveOperation([requested], transactionId), requested);
  assert.equal(resolveOperation([unrelated, requested], transactionId), requested);
  assert.equal(resolveOperation([requested, { ...requested }], transactionId), null);
  assert.equal(resolveOperation([], transactionId), null);
});

test("absent, empty or non-string hashes cannot become a matching witness", () => {
  const missing = [{ node: "first" }, { node: "second" }];
  assert.equal(witnessHashRefusal(missing), "missing-witness-hash");
  for (const hash of [undefined, null, "", " ", 0]) {
    assert.equal(witnessHashRefusal([{ databaseHash: hash }, { databaseHash: hash }]), "missing-witness-hash");
    assert.equal(witnessHashRefusal([{ databaseHash }, { databaseHash: hash }]), "missing-witness-hash");
  }
  assert.deepEqual(missing, [{ node: "first" }, { node: "second" }], "missing evidence is never fabricated");
});

test("present matching hashes pass while a real disagreement stays distinct", () => {
  assert.equal(witnessHashRefusal([{ databaseHash }, { databaseHash }]), null);
  assert.equal(witnessHashRefusal([{ databaseHash }, { databaseHash: otherHash }]), "witness-disagreement");
});

test("fewer than two observations cannot establish witness agreement", () => {
  assert.throws(() => witnessHashRefusal([]), /at least two/);
  assert.throws(() => witnessHashRefusal([{ databaseHash }]), /at least two/);
});
