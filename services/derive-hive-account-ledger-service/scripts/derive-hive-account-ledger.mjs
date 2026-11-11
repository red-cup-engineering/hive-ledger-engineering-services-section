#!/usr/bin/env node
/**
 * derive-hive-account-ledger — turns one Hive account's mainchain and Hive-Engine
 * operation history plus price directives into a complete Beancount ledger: reward
 * income booked once at the chain-confirmed claim, transfers, vesting/savings
 * conversions, venue fills composed through derive-set-of-fill-transactions-service,
 * and a closing balance assertion from the chain.
 */
import { renderFile, renderBalanceDirective } from "@red-cup-engineering/farolfi/ledger/maintenance/beancount-render";
import {
  addDecimalStrings,
  compareDecimalStrings,
  divideDecimalStrings,
  multiplyDecimalStrings,
  negateDecimalString,
  stripUnitSuffix,
} from "@red-cup-engineering/exact-number-data-service/decimal-string";
import { deriveSetOfFillTransactions } from "@red-cup-engineering/farolfi/ledger/maintenance/venue-fills";

const ZERO = "0";

function isZero(text) {
  return /^0(\.0+)?$/u.test(String(text ?? "0").replace(/^-/u, ""));
}

/**
 * Normalize a Hive-Engine indexer quantity to a plain decimal string Beancount can lex: the
 * indexer's JSON can render a tiny value in scientific notation (e.g. "1e-8", which decimal.mjs's
 * parser rejects) or drop the leading zero (e.g. ".25", which Beancount's own lexer rejects).
 * @param {string | number} text
 * @returns {string}
 * @throws {TypeError} if the text is not a finite quantity
 */
export function plainDecimal(text) {
  const raw = String(text);
  if (/^-?\.\d/u.test(raw)) return raw.replace(/^(-?)\./u, "$10.");
  if (!/e/iu.test(raw)) return raw;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new TypeError(`derive-hive-account-ledger: not a finite quantity: ${JSON.stringify(text)}`);
  return value.toFixed(20).replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "");
}

function splitAmount(text) {
  const match = /^(-?\d+(?:\.\d+)?)\s+(\S+)$/u.exec(String(text).trim());
  if (!match) throw new TypeError(`derive-hive-account-ledger: not a chain amount string: ${JSON.stringify(text)}`);
  return { amount: match[1], commodity: match[2] };
}

function dateOf(isoTimestamp) {
  return isoTimestamp.slice(0, 10);
}

/** Escape a string for placement inside a Beancount double-quoted string literal. */
function quoteEscape(text) {
  return String(text).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

function renderPosting({ account, amount, commodity, price }) {
  if (amount === undefined) return `  ${account}`;
  const priceSuffix = price ? ` @ ${price}` : "";
  return `  ${account}  ${amount} ${commodity}${priceSuffix}`;
}

/**
 * Render one Beancount transaction with quoted-string metadata (matching the ledger's own
 * metadata convention, with embedded quotes/backslashes escaped) and explicit posting amounts
 * (never elided; every weight is computed by this service before it is written). A posting may
 * carry a `price` (a rendered "<amount> <commodity>" string) linking its weight to a different
 * commodity, required whenever a transaction converts between two non-fungible units (Beancount
 * cannot otherwise infer that e.g. a HIVE decrease and a VESTS increase net to zero).
 * @param {{ date: string, narration: string, metadata?: Record<string, string>,
 *   postings: { account: string, amount?: string, commodity?: string, price?: string }[] }} input
 * @returns {string}
 */
export function renderTransaction({ date, narration, metadata = {}, postings }) {
  const lines = [`${date} * "${quoteEscape(narration)}"`];
  for (const [key, value] of Object.entries(metadata)) lines.push(`  ${key}: "${quoteEscape(value)}"`);
  for (const posting of postings) lines.push(renderPosting(posting));
  return lines.join("\n");
}

/** A running per-commodity accrual bucket, keyed by commodity symbol -> exact decimal string. */
function bucketAdd(bucket, commodity, amount) {
  bucket[commodity] = addDecimalStrings([bucket[commodity] ?? ZERO, amount]);
}

function bucketTakeAll(bucket, commodity) {
  const value = bucket[commodity] ?? ZERO;
  bucket[commodity] = ZERO;
  return value;
}

/**
 * Split a chain-confirmed claim amount for one commodity across Income:Hive:Author and
 * Income:Hive:Curation in proportion to each kind's pending accrual since the last claim
 * (comment_benefactor_reward folds into curation); when neither kind has recorded a pending
 * accrual for this commodity, the whole amount is attributed to curation with a note, since a
 * claim always empties the account's entire pending balance for that commodity.
 * @param {string} claimAmount
 * @param {string} pendingAuthor
 * @param {string} pendingCuration
 * @returns {{ author: string, curation: string, attributedByFallback: boolean }}
 */
export function splitClaimByAccrual(claimAmount, pendingAuthor, pendingCuration) {
  const totalPending = addDecimalStrings([pendingAuthor, pendingCuration]);
  if (isZero(totalPending)) return { author: ZERO, curation: claimAmount, attributedByFallback: true };
  const authorRatio = divideDecimalStrings(pendingAuthor, totalPending, 12);
  const author = multiplyDecimalStrings(claimAmount, authorRatio, 12);
  const curation = addDecimalStrings([claimAmount, negateDecimalString(author)]);
  return { author, curation, attributedByFallback: false };
}

/**
 * Derive a complete Beancount ledger for one Hive account.
 * @param {{ account: string, rangeStart: string, rangeEnd: string, hiveOperations: object[],
 *   hiveEngineEntries: object[], hiveEngineFills: object[], custodyAccount: string,
 *   hiveEngineCustodyAccount: string,
 *   openingBalances: { hive: string, hbd: string, vests: string, hiveEngine: Record<string, string> },
 *   chainClosingBalances: { hive: string, hbd: string, vests: string, hiveEngine: Record<string, string> } }} input
 * @param {{ deriveFillsImpl?: typeof deriveSetOfFillTransactions }} [options]
 * @returns {object}
 * @throws {TypeError} When a required field is missing.
 */
export function deriveHiveAccountLedger(input, { deriveFillsImpl = deriveSetOfFillTransactions } = {}) {
  if (!input || typeof input.account !== "string" || input.account === "") {
    throw new TypeError("derive-hive-account-ledger: input.account must be a non-empty string");
  }
  if (typeof input.custodyAccount !== "string" || input.custodyAccount === "") {
    throw new TypeError("derive-hive-account-ledger: input.custodyAccount must be a non-empty string");
  }
  const {
    account, rangeStart, rangeEnd, custodyAccount, hiveEngineCustodyAccount,
    hiveOperations = [], hiveEngineEntries = [], hiveEngineFills = [],
    openingBalances = { hive: ZERO, hbd: ZERO, vests: ZERO, hiveEngine: {} },
    chainClosingBalances = { hive: ZERO, hbd: ZERO, vests: ZERO, hiveEngine: {} },
  } = input;

  const savingsAccount = `${custodyAccount}:Savings`;
  const pendingSavingsWithdrawalAccount = `${custodyAccount}:Pending-Savings-Withdrawal`;
  const tradingAccount = `${custodyAccount}:Trading`;
  const heStakedAccount = hiveEngineCustodyAccount ? `${hiveEngineCustodyAccount}:Staked` : null;
  const hePendingUnstakeAccount = hiveEngineCustodyAccount ? `${hiveEngineCustodyAccount}:Pending-Unstake` : null;
  const heDelegatedOutAccount = hiveEngineCustodyAccount ? `${hiveEngineCustodyAccount}:Delegated-Out` : null;

  const AUTHOR = "Income:Hive:Author";
  const CURATION = "Income:Hive:Curation";
  const INTEREST = "Income:Hive:Interest";
  const STAKING = "Income:Hive:Staking";
  const OTHER_INCOME = "Income:Hive:Other";
  const OTHER_EXPENSE = "Expenses:Hive:Other";

  const accountsOpened = new Set();
  const openAccount = (a) => accountsOpened.add(a);
  const transactions = [];
  const refusals = [];
  const nativeRewardTotals = { author: {}, curation: {}, interest: {}, staking: {} };
  const pendingAuthor = {};
  const pendingCuration = {};
  const pendingWithdrawalsByRequestId = new Map();

  // History readers commonly overlap their windows.  A chain operation is identified by the
  // transaction and its operation position, so process it once rather than booking it twice.
  // Keep the highest observed sequence so a caller can use it as its next resume point.
  const seenOperationIds = new Set();
  let lastHiveOperationIndex = -1;
  const sortedOps = [...hiveOperations]
    .sort((a, b) => a.index - b.index)
    .filter((op) => {
      if (Number.isFinite(op.index)) lastHiveOperationIndex = Math.max(lastHiveOperationIndex, op.index);
      const operationId = `${op.trxId}-${op.index}`;
      if (seenOperationIds.has(operationId)) return false;
      seenOperationIds.add(operationId);
      return true;
    });
  const fillOrderOps = [];

  for (const op of sortedOps) {
    const { kind, payload, timestamp, trxId, index } = op;
    const date = dateOf(timestamp);
    switch (kind) {
      case "transfer": {
        const { amount, commodity } = splitAmount(payload.amount);
        const incoming = payload.to === account;
        const outgoing = payload.from === account;
        if (!incoming && !outgoing) break;
        openAccount(custodyAccount);
        const custodyAmount = incoming ? amount : negateDecimalString(amount);
        const counterAccount = incoming ? OTHER_INCOME : OTHER_EXPENSE;
        openAccount(counterAccount);
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: `Hive transfer ${incoming ? "from" : "to"} ${incoming ? payload.from : payload.to}`,
            metadata: { op_id: `${trxId}-${index}`, memo: payload.memo ?? "" },
            postings: [
              { account: custodyAccount, amount: custodyAmount, commodity },
              { account: counterAccount, amount: negateDecimalString(custodyAmount), commodity },
            ],
          }),
        });
        break;
      }
      case "transfer_to_vesting_completed": {
        const hive = stripUnitSuffix(payload.hive_vested);
        const vests = stripUnitSuffix(payload.vesting_shares_received);
        openAccount(custodyAccount);
        // Beancount cannot infer that a HIVE decrease and a VESTS increase net to zero without
        // a price link; the disposed (HIVE) leg carries the exact per-unit VESTS rate this
        // conversion actually settled at, so the transaction balances on the chain's own numbers.
        const priceVestsPerHive = isZero(hive) ? null : divideDecimalStrings(vests, hive, 12);
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: "Power up (HIVE to VESTS)",
            metadata: { op_id: `${trxId}-${index}` },
            postings: [
              { account: custodyAccount, amount: negateDecimalString(hive), commodity: "HIVE", price: priceVestsPerHive ? `${priceVestsPerHive} VESTS` : undefined },
              { account: custodyAccount, amount: vests, commodity: "VESTS" },
            ],
          }),
        });
        break;
      }
      case "fill_vesting_withdraw": {
        const withdrawn = splitAmount(payload.withdrawn);
        const deposited = splitAmount(payload.deposited);
        if (withdrawn.commodity !== "VESTS") { refusals.push({ reason: "unexpected-fill-vesting-withdraw-shape", opId: `${trxId}-${index}` }); break; }
        openAccount(custodyAccount);
        const priceDepositedPerVests = isZero(withdrawn.amount) ? null : divideDecimalStrings(deposited.amount, withdrawn.amount, 12);
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: "Power down (VESTS to HIVE)",
            metadata: { op_id: `${trxId}-${index}` },
            postings: [
              { account: custodyAccount, amount: negateDecimalString(withdrawn.amount), commodity: "VESTS", price: priceDepositedPerVests ? `${priceDepositedPerVests} ${deposited.commodity}` : undefined },
              { account: custodyAccount, amount: deposited.amount, commodity: deposited.commodity },
            ],
          }),
        });
        break;
      }
      case "author_reward": {
        for (const [field, commodity] of [["hbd_payout", "HBD"], ["hive_payout", "HIVE"], ["vesting_payout", "VESTS"]]) {
          const raw = payload[field];
          if (typeof raw !== "string") continue;
          const amount = stripUnitSuffix(raw);
          if (isZero(amount)) continue;
          bucketAdd(pendingAuthor, commodity, amount);
        }
        break;
      }
      case "curation_reward":
      case "comment_benefactor_reward": {
        const raw = payload.reward;
        if (typeof raw === "string" && !isZero(stripUnitSuffix(raw))) {
          const { amount, commodity } = splitAmount(raw);
          bucketAdd(pendingCuration, commodity, amount);
        }
        break;
      }
      case "claim_reward_balance": {
        const postings = [];
        for (const [field, commodity] of [["reward_hive", "HIVE"], ["reward_hbd", "HBD"], ["reward_vests", "VESTS"]]) {
          const raw = payload[field];
          if (typeof raw !== "string") continue;
          const claimAmount = stripUnitSuffix(raw);
          if (isZero(claimAmount)) continue;
          const pA = bucketTakeAll(pendingAuthor, commodity);
          const pC = bucketTakeAll(pendingCuration, commodity);
          const split = splitClaimByAccrual(claimAmount, pA, pC);
          openAccount(custodyAccount);
          postings.push({ account: custodyAccount, amount: claimAmount, commodity });
          if (!isZero(split.author)) {
            openAccount(AUTHOR);
            postings.push({ account: AUTHOR, amount: negateDecimalString(split.author), commodity });
            bucketAdd(nativeRewardTotals.author, commodity, split.author);
          }
          if (!isZero(split.curation)) {
            openAccount(CURATION);
            postings.push({ account: CURATION, amount: negateDecimalString(split.curation), commodity });
            bucketAdd(nativeRewardTotals.curation, commodity, split.curation);
          }
        }
        if (postings.length > 0) {
          transactions.push({
            date,
            tx: renderTransaction({ date, narration: "Claim reward balance", metadata: { op_id: `${trxId}-${index}` }, postings }),
          });
        }
        break;
      }
      case "interest": {
        const amount = stripUnitSuffix(payload.interest);
        if (isZero(amount)) break;
        const destination = payload.is_saved_into_hbd_balance ? savingsAccount : custodyAccount;
        openAccount(destination);
        openAccount(INTEREST);
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: "HBD savings interest",
            metadata: { op_id: `${trxId}-${index}` },
            postings: [
              { account: destination, amount, commodity: "HBD" },
              { account: INTEREST, amount: negateDecimalString(amount), commodity: "HBD" },
            ],
          }),
        });
        bucketAdd(nativeRewardTotals.interest, "HBD", amount);
        break;
      }
      case "transfer_to_savings": {
        if (payload.to !== account) break;
        const { amount, commodity } = splitAmount(payload.amount);
        openAccount(custodyAccount);
        openAccount(savingsAccount);
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: "Transfer to savings",
            metadata: { op_id: `${trxId}-${index}` },
            postings: [
              { account: custodyAccount, amount: negateDecimalString(amount), commodity },
              { account: savingsAccount, amount, commodity },
            ],
          }),
        });
        break;
      }
      case "transfer_from_savings": {
        if (payload.from !== account) break;
        const { amount, commodity } = splitAmount(payload.amount);
        openAccount(savingsAccount);
        openAccount(pendingSavingsWithdrawalAccount);
        pendingWithdrawalsByRequestId.set(String(payload.request_id), { amount, commodity });
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: "Transfer from savings (requested; 3-day delay)",
            metadata: { op_id: `${trxId}-${index}`, request_id: String(payload.request_id ?? "") },
            postings: [
              { account: savingsAccount, amount: negateDecimalString(amount), commodity },
              { account: pendingSavingsWithdrawalAccount, amount, commodity },
            ],
          }),
        });
        break;
      }
      case "fill_transfer_from_savings": {
        if (payload.from !== account) break;
        const { amount, commodity } = splitAmount(payload.amount);
        openAccount(pendingSavingsWithdrawalAccount);
        openAccount(custodyAccount);
        pendingWithdrawalsByRequestId.delete(String(payload.request_id));
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: "Transfer from savings completed",
            metadata: { op_id: `${trxId}-${index}`, request_id: String(payload.request_id ?? "") },
            postings: [
              { account: pendingSavingsWithdrawalAccount, amount: negateDecimalString(amount), commodity },
              { account: custodyAccount, amount, commodity },
            ],
          }),
        });
        break;
      }
      case "fill_order": {
        if (payload.current_owner !== account && payload.open_owner !== account) break;
        fillOrderOps.push(op);
        break;
      }
      case "cancel_transfer_from_savings": {
        if (payload.from !== account) break;
        const requestId = String(payload.request_id ?? "");
        const pending = pendingWithdrawalsByRequestId.get(requestId);
        if (!pending) { refusals.push({ reason: "cancel-transfer-from-savings-no-matching-request", opId: `${trxId}-${index}`, requestId }); break; }
        pendingWithdrawalsByRequestId.delete(requestId);
        openAccount(pendingSavingsWithdrawalAccount);
        openAccount(savingsAccount);
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: "Transfer from savings cancelled (returned to savings)",
            metadata: { op_id: `${trxId}-${index}`, request_id: requestId },
            postings: [
              { account: pendingSavingsWithdrawalAccount, amount: negateDecimalString(pending.amount), commodity: pending.commodity },
              { account: savingsAccount, amount: pending.amount, commodity: pending.commodity },
            ],
          }),
        });
        break;
      }
      // informational only: no balance change to a tracked account.
      case "transfer_to_vesting":
      case "withdraw_vesting":
      case "delegate_vesting_shares":
      case "limit_order_create":
      case "limit_order_cancel":
        break;
      case "proposal_pay": {
        if (payload.receiver !== account) break;
        const { amount, commodity } = splitAmount(payload.payment);
        openAccount(custodyAccount);
        openAccount(OTHER_INCOME);
        transactions.push({
          date,
          tx: renderTransaction({
            date,
            narration: "DHF proposal payment",
            metadata: { op_id: `${trxId}-${index}` },
            postings: [
              { account: custodyAccount, amount, commodity },
              { account: OTHER_INCOME, amount: negateDecimalString(amount), commodity },
            ],
          }),
        });
        break;
      }
      default:
        refusals.push({ reason: "unhandled-operation-kind", kind, opId: `${trxId}-${index}` });
    }
  }

  // fill_order: rendered as a standard venue fill on the Hive base-layer internal market,
  // isolated to a dedicated :Trading sub-account so its FIFO cost tracking never mixes with
  // the plain (uncosted) reward/transfer flow in the main custody account.
  const hiveFills = [];
  for (const op of fillOrderOps) {
    const { payload, timestamp, trxId, index } = op;
    const isSeller = payload.current_owner === account;
    const disposed = splitAmount(isSeller ? payload.current_pays : payload.open_pays);
    const acquired = splitAmount(isSeller ? payload.open_pays : payload.current_pays);
    const side = disposed.commodity === "HIVE" ? "sell" : "buy";
    hiveFills.push({
      venue: "hive-internal-market", account, fillId: `${trxId}-${index}`, date: dateOf(timestamp), side,
      baseCommodity: "HIVE", quoteCommodity: "HBD",
      baseQuantity: side === "sell" ? disposed.amount : acquired.amount,
      quoteAmount: side === "sell" ? acquired.amount : disposed.amount,
      custodyAccount: tradingAccount, mandateId: "chain-history",
    });
  }

  for (const fillResult of hiveEngineFills) {
    if (!fillResult.ok) { refusals.push({ reason: "fill-refused", refusal: fillResult.refusal }); continue; }
    hiveFills.push({
      ...fillResult.fill,
      baseQuantity: plainDecimal(fillResult.fill.baseQuantity),
      quoteAmount: plainDecimal(fillResult.fill.quoteAmount),
      custodyAccount: tradingAccount,
    });
  }

  // Grouped by base commodity: derive-set-of-fill-transactions-service tracks FIFO lot state
  // independently per (custody account, base commodity), so one commodity's insufficient-
  // inventory RangeError must not block every OTHER commodity's otherwise-valid fills from
  // booking (a real bug found 2026-09-05: a single bad fill zeroed out all 316 real fills).
  let fillsBooked = 0;
  const fillsByCommodity = new Map();
  for (const fill of hiveFills) {
    const list = fillsByCommodity.get(fill.baseCommodity) ?? [];
    list.push(fill);
    fillsByCommodity.set(fill.baseCommodity, list);
  }
  if (hiveFills.length > 0) openAccount(tradingAccount);
  for (const [baseCommodity, fills] of fillsByCommodity) {
    try {
      const derived = deriveFillsImpl({ fills, openAccounts: [tradingAccount, "Income:Investment:Realized-Gains", "Expenses:Investment:Realized-Losses"] });
      for (const t of derived.transactions) {
        transactions.push({ date: t.date, tx: t.directive });
        fillsBooked += 1;
      }
      for (const a of derived.accountsToOpen) openAccount(a.account ?? a);
      for (const r of derived.refusals) refusals.push({ reason: "fill-transaction-refusal", detail: r });
    } catch (error) {
      refusals.push({ reason: "fill-transactions-derivation-failed", baseCommodity, fillCount: fills.length, error: String(error?.message ?? error) });
    }
  }

  // Hive-Engine direct (non-fill) entries.
  for (const rawEntry of hiveEngineEntries) {
    const entry = rawEntry.quantity == null ? rawEntry : { ...rawEntry, quantity: plainDecimal(rawEntry.quantity) };
    const date = dateOf(entry.timestamp);
    const opId = entry.transactionId;
    switch (entry.operation) {
      case "tokens_transfer": {
        const incoming = entry.to === account;
        const outgoing = entry.from === account;
        if (!incoming && !outgoing) break;
        if (!hiveEngineCustodyAccount) break;
        openAccount(hiveEngineCustodyAccount);
        const custodyAmount = incoming ? entry.quantity : negateDecimalString(entry.quantity);
        const counterAccount = incoming ? OTHER_INCOME : OTHER_EXPENSE;
        openAccount(counterAccount);
        transactions.push({
          date,
          tx: renderTransaction({
            date, narration: `Hive-Engine transfer ${incoming ? "from" : "to"} ${incoming ? entry.from : entry.to}`,
            metadata: { op_id: opId },
            postings: [
              { account: hiveEngineCustodyAccount, amount: custodyAmount, commodity: entry.symbol },
              { account: counterAccount, amount: negateDecimalString(custodyAmount), commodity: entry.symbol },
            ],
          }),
        });
        break;
      }
      case "tokens_issue":
      case "distribution_checkPendingDistributions": {
        if (!hiveEngineCustodyAccount) break;
        openAccount(hiveEngineCustodyAccount);
        openAccount(STAKING);
        transactions.push({
          date, tx: renderTransaction({
            date, narration: "Hive-Engine distribution", metadata: { op_id: opId },
            postings: [
              { account: hiveEngineCustodyAccount, amount: entry.quantity, commodity: entry.symbol },
              { account: STAKING, amount: negateDecimalString(entry.quantity), commodity: entry.symbol },
            ],
          }),
        });
        bucketAdd(nativeRewardTotals.staking, entry.symbol, entry.quantity);
        break;
      }
      case "comments_curationReward":
      case "comments_curationReward_stake":
      case "comments_authorReward":
      case "comments_authorReward_stake":
      case "comments_beneficiaryReward":
      case "comments_beneficiaryReward_stake": {
        // A "_stake" variant pays directly into the STAKED balance (as tokens_delegate sources
        // from staked, never liquid custody, per the tokens contract) — verified 2026-09-05
        // against michael561's real history, where treating every variant as a liquid credit
        // produced a real, chain-disprovable balance mismatch. Author and benefactor rewards
        // fold into Income:Hive:Author (this section has no separate benefactor account); tribe
        // curation rewards book to Income:Hive:Curation.
        if (!hiveEngineCustodyAccount) break;
        const isStaked = entry.operation.endsWith("_stake");
        const destination = isStaked ? heStakedAccount : hiveEngineCustodyAccount;
        if (isStaked && !destination) break;
        const incomeAccount = entry.operation.startsWith("comments_curationReward") ? CURATION : AUTHOR;
        const totalsBucket = incomeAccount === CURATION ? nativeRewardTotals.curation : nativeRewardTotals.author;
        openAccount(destination);
        openAccount(incomeAccount);
        transactions.push({
          date, tx: renderTransaction({
            date, narration: `Hive-Engine tribe reward${isStaked ? " (staked)" : ""}`, metadata: { op_id: opId },
            postings: [
              { account: destination, amount: entry.quantity, commodity: entry.symbol },
              { account: incomeAccount, amount: negateDecimalString(entry.quantity), commodity: entry.symbol },
            ],
          }),
        });
        bucketAdd(totalsBucket, entry.symbol, entry.quantity);
        break;
      }
      case "tokens_undelegateDone": {
        // Completes a prior delegate-out's cooldown (tokens_undelegateStart is informational,
        // filtered upstream): the quantity returns to the staked position it was delegated from.
        if (!heStakedAccount || !heDelegatedOutAccount) break;
        openAccount(heDelegatedOutAccount);
        openAccount(heStakedAccount);
        transactions.push({
          date, tx: renderTransaction({
            date, narration: "Hive-Engine undelegate completed (returns to staked)", metadata: { op_id: opId },
            postings: [
              { account: heDelegatedOutAccount, amount: negateDecimalString(entry.quantity), commodity: entry.symbol },
              { account: heStakedAccount, amount: entry.quantity, commodity: entry.symbol },
            ],
          }),
        });
        break;
      }
      case "tokens_stake": {
        if (!heStakedAccount) break;
        openAccount(hiveEngineCustodyAccount);
        openAccount(heStakedAccount);
        transactions.push({
          date, tx: renderTransaction({
            date, narration: "Hive-Engine stake", metadata: { op_id: opId },
            postings: [
              { account: hiveEngineCustodyAccount, amount: negateDecimalString(entry.quantity), commodity: entry.symbol },
              { account: heStakedAccount, amount: entry.quantity, commodity: entry.symbol },
            ],
          }),
        });
        break;
      }
      case "tokens_unstakeStart": {
        if (!heStakedAccount || !hePendingUnstakeAccount) break;
        openAccount(heStakedAccount);
        openAccount(hePendingUnstakeAccount);
        transactions.push({
          date, tx: renderTransaction({
            date, narration: "Hive-Engine unstake started", metadata: { op_id: opId },
            postings: [
              { account: heStakedAccount, amount: negateDecimalString(entry.quantity), commodity: entry.symbol },
              { account: hePendingUnstakeAccount, amount: entry.quantity, commodity: entry.symbol },
            ],
          }),
        });
        break;
      }
      case "tokens_unstakeDone": {
        if (!hePendingUnstakeAccount) break;
        openAccount(hePendingUnstakeAccount);
        openAccount(hiveEngineCustodyAccount);
        transactions.push({
          date, tx: renderTransaction({
            date, narration: "Hive-Engine unstake completed", metadata: { op_id: opId },
            postings: [
              { account: hePendingUnstakeAccount, amount: negateDecimalString(entry.quantity), commodity: entry.symbol },
              { account: hiveEngineCustodyAccount, amount: entry.quantity, commodity: entry.symbol },
            ],
          }),
        });
        break;
      }
      case "tokens_delegate": {
        // The Hive-Engine tokens contract's delegate action always sources from the STAKED
        // balance (mirroring Hive-native VESTS delegation): only staked tokens can be delegated,
        // so this moves Staked -> Delegated-Out, never the liquid custody account. Only book a
        // movement when this account is the delegator (an incoming delegation is not this
        // account's own balance to track a reduction of).
        if (entry.from !== account || !heDelegatedOutAccount || !heStakedAccount) break;
        openAccount(heStakedAccount);
        openAccount(heDelegatedOutAccount);
        transactions.push({
          date, tx: renderTransaction({
            date, narration: "Hive-Engine delegate out (from staked)", metadata: { op_id: opId },
            postings: [
              { account: heStakedAccount, amount: negateDecimalString(entry.quantity), commodity: entry.symbol },
              { account: heDelegatedOutAccount, amount: entry.quantity, commodity: entry.symbol },
            ],
          }),
        });
        break;
      }
      case "tokens_undelegate": {
        if (entry.from !== account || !heDelegatedOutAccount || !heStakedAccount) break;
        openAccount(heStakedAccount);
        openAccount(heDelegatedOutAccount);
        transactions.push({
          date, tx: renderTransaction({
            date, narration: "Hive-Engine undelegate (returns to staked)", metadata: { op_id: opId },
            postings: [
              { account: heDelegatedOutAccount, amount: negateDecimalString(entry.quantity), commodity: entry.symbol },
              { account: heStakedAccount, amount: entry.quantity, commodity: entry.symbol },
            ],
          }),
        });
        break;
      }
      case "hivepegged_buy":
      case "hivepegged_withdraw": {
        // The mainchain side of this bridge is already booked by its own `transfer` operation;
        // this posts only the Hive-Engine side, washed against a bridge account.
        if (!hiveEngineCustodyAccount) break;
        openAccount(hiveEngineCustodyAccount);
        openAccount("Equity:Hive-Peg-Bridge");
        const sign = entry.operation === "hivepegged_buy" ? "" : "-";
        transactions.push({
          date, tx: renderTransaction({
            date, narration: "HIVE-peg bridge (mainchain leg booked separately)", metadata: { op_id: opId },
            postings: [
              { account: hiveEngineCustodyAccount, amount: `${sign}${entry.quantity}`, commodity: entry.symbol },
              { account: "Equity:Hive-Peg-Bridge", amount: `${sign === "-" ? "" : "-"}${entry.quantity}`, commodity: entry.symbol },
            ],
          }),
        });
        break;
      }
      default:
        refusals.push({ reason: "unhandled-hive-engine-operation", operation: entry.operation, opId });
    }
  }

  if (pendingWithdrawalsByRequestId.size > 0) {
    for (const [requestId, { amount, commodity }] of pendingWithdrawalsByRequestId) {
      refusals.push({ reason: "savings-withdrawal-still-pending-at-range-end", requestId, amount, commodity });
    }
  }

  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const openDirectives = [...accountsOpened].sort().map((a) => `${rangeStart} open ${a}`);
  const openingPostings = [];
  if (!isZero(openingBalances.hive)) openingPostings.push({ account: custodyAccount, amount: openingBalances.hive, commodity: "HIVE" });
  if (!isZero(openingBalances.hbd)) openingPostings.push({ account: custodyAccount, amount: openingBalances.hbd, commodity: "HBD" });
  if (!isZero(openingBalances.vests)) openingPostings.push({ account: custodyAccount, amount: openingBalances.vests, commodity: "VESTS" });
  for (const [symbol, amount] of Object.entries(openingBalances.hiveEngine ?? {})) {
    if (hiveEngineCustodyAccount && !isZero(amount)) openingPostings.push({ account: hiveEngineCustodyAccount, amount, commodity: symbol });
  }
  const openingBlock = [];
  if (openingPostings.length > 0) {
    openAccount("Equity:Opening-Balances");
    openingBlock.push(renderTransaction({
      date: rangeStart,
      narration: `Opening evidenced Hive balances for ${account}`,
      metadata: { source_id: `HIVE-LEDGER-OPEN-${account.toUpperCase()}-${rangeStart}` },
      postings: [
        ...openingPostings,
        ...openingPostings.map((p) => ({ account: "Equity:Opening-Balances", amount: negateDecimalString(p.amount), commodity: p.commodity })),
      ],
    }));
  }

  const balanceComparison = [];
  const closingBlock = [];
  const computedClosing = (() => {
    // fold every posting to custodyAccount/hiveEngineCustodyAccount by commodity, starting
    // from the opening balances, to arrive at the ledger's own computed closing position.
    const running = {
      [custodyAccount]: { HIVE: openingBalances.hive, HBD: openingBalances.hbd, VESTS: openingBalances.vests },
    };
    if (hiveEngineCustodyAccount) running[hiveEngineCustodyAccount] = { ...openingBalances.hiveEngine };
    const postingLine = /^ {2}(\S+)\s+(-?\d+(?:\.\d+)?)\s+(\S+)(?:\s+@\s+\S+\s+\S+)?$/u;
    for (const { tx } of transactions) {
      for (const line of tx.split("\n")) {
        const m = postingLine.exec(line);
        if (!m) continue;
        const [, acct, amt, sym] = m;
        if (!running[acct]) continue;
        running[acct][sym] = addDecimalStrings([running[acct][sym] ?? ZERO, amt]);
      }
    }
    return running;
  })();

  for (const [commodity, chainValue] of [["HIVE", chainClosingBalances.hive], ["HBD", chainClosingBalances.hbd], ["VESTS", chainClosingBalances.vests]]) {
    const computed = computedClosing[custodyAccount]?.[commodity] ?? ZERO;
    const match = compareDecimalStrings(computed, chainValue) === 0;
    balanceComparison.push({ account: custodyAccount, commodity, computedClosing: computed, chainClosing: chainValue, match });
    openAccount(custodyAccount);
    closingBlock.push(renderBalanceDirective({ date: rangeEnd, account: custodyAccount, amount: chainValue, commodity, metadata: { source: "chain-live-read" } }));
  }
  if (hiveEngineCustodyAccount) {
    for (const [symbol, chainValue] of Object.entries(chainClosingBalances.hiveEngine ?? {})) {
      const computed = computedClosing[hiveEngineCustodyAccount]?.[symbol] ?? ZERO;
      const match = compareDecimalStrings(computed, chainValue) === 0;
      balanceComparison.push({ account: hiveEngineCustodyAccount, commodity: symbol, computedClosing: computed, chainClosing: chainValue, match });
      closingBlock.push(renderBalanceDirective({ date: rangeEnd, account: hiveEngineCustodyAccount, amount: chainValue, commodity: symbol, metadata: { source: "chain-live-read" } }));
    }
  }

  const header = `; Hive account ledger for ${account}, range [${rangeStart}, ${rangeEnd}]. Generated by @red-cup-engineering/derive-hive-account-ledger-service. Do not hand-edit.`;
  const ledgerText = renderFile(header, [...openDirectives, ...openingBlock, ...transactions.map((t) => t.tx), ...closingBlock]);

  return {
    type: "HiveAccountLedgerSet",
    version: 1,
    account,
    rangeStart,
    rangeEnd,
    ledgerText,
    accountsOpened: [...accountsOpened].sort(),
    transactionCount: openingBlock.length + transactions.length,
    lastHiveOperationIndex,
    fillsBooked,
    nativeRewardTotals,
    balanceComparison,
    refusals,
  };
}

if (import.meta.main) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const result = deriveHiveAccountLedger(JSON.parse(text));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(2);
  }
}
