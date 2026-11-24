#!/usr/bin/env node
/**
 * derive-hive-account-ledger — turns one Hive account's mainchain and Hive-Engine
 * operation history plus price directives into a complete Beancount ledger: reward
 * income booked once at the chain-confirmed claim, transfers, vesting/savings
 * conversions, venue fills booked as conversions on the custody accounts that hold the
 * assets, and closing balance assertions from the chain.
 *
 * A Beancount balance assertion on an account includes every sub-account beneath it, so the
 * assertions written here are stated for the whole tree (liquid plus the chain-evidenced
 * sub-accounts) and again for each sub-account, and funds in flight (pending savings
 * withdrawals, conversions, open orders) are held outside the custody tree.
 */
import { renderFile, renderBalanceDirective } from "@red-cup-engineering/farolfi/ledger/maintenance/beancount-render";
import {
  addDecimalStrings,
  compareDecimalStrings,
  divideDecimalStrings,
  multiplyDecimalStrings,
  negateDecimalString,
  stripUnitSuffix,
} from "@red-cup-engineering/exact-number-codec/decimal-string";

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

function renderPosting({ account, amount, commodity, price, totalPrice }) {
  if (amount === undefined) return `  ${account}`;
  const priceSuffix = totalPrice ? ` @@ ${totalPrice}` : price ? ` @ ${price}` : "";
  return `  ${account}  ${amount} ${commodity}${priceSuffix}`;
}

/**
 * Render one Beancount transaction with quoted-string metadata (matching the ledger's own
 * metadata convention, with embedded quotes/backslashes escaped) and explicit posting amounts
 * (never elided; every weight is computed by this service before it is written). A posting may
 * carry a `price` (a rendered "<amount> <commodity>" string) linking its weight to a different
 * commodity, required whenever a transaction converts between two non-fungible units (Beancount
 * cannot otherwise infer that e.g. a HIVE decrease and a VESTS increase net to zero). A posting
 * may instead carry a `totalPrice` (rendered `@@`), the exact total in the other commodity,
 * which needs no per-unit rounding.
 * @param {{ date: string, narration: string, metadata?: Record<string, string>,
 *   postings: { account: string, amount?: string, commodity?: string, price?: string, totalPrice?: string }[] }} input
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
 * The account that holds funds in flight for a custody account, outside the custody tree so that
 * the chain's liquid-plus-savings figure is directly comparable to an assertion on the tree.
 * @param {string} custodyAccount
 * @returns {string}
 */
export function inFlightAccountFor(custodyAccount) {
  return custodyAccount.includes(":Custody:")
    ? custodyAccount.replace(":Custody:", ":In-Flight:")
    : `${custodyAccount}-In-Flight`;
}

const SELF_OWNED = Object.freeze({ hive: ZERO, hbd: ZERO, vests: ZERO, hiveEngine: {} });

/**
 * Derive a complete Beancount ledger for one Hive account.
 *
 * Balance assertions follow Beancount's rule that an assertion on an account covers the account
 * and everything beneath it: the custody account is asserted for its whole tree (liquid balance
 * plus savings, and for Hive-Engine plus staked, pending-unstake and delegated-out), and each
 * sub-account is asserted on its own from the chain's separate figure for it.
 * @param {{ account: string, rangeStart: string, rangeEnd: string, balanceDate?: string,
 *   hiveOperations: object[], hiveEngineEntries: object[], hiveEngineFills: object[],
 *   custodyAccount: string, hiveEngineCustodyAccount: string,
 *   openingBalances: ChainBalances, chainClosingBalances: ChainBalances }} input
 *   `balanceDate` is the date of the closing assertions; it must be after the last day of
 *   operations the history covers (Beancount checks an assertion at the start of its date).
 *   It defaults to `rangeEnd`.
 *   ChainBalances: `{ hive, hbd, vests, hiveSavings?, hbdSavings?, hiveEngine: {SYMBOL: liquid},
 *   hiveEngineStaked?, hiveEnginePendingUnstake?, hiveEngineDelegatedOut?: {SYMBOL: amount} }`.
 * @returns {object}
 * @throws {TypeError} When a required field is missing.
 */
export function deriveHiveAccountLedger(input) {
  if (!input || typeof input.account !== "string" || input.account === "") {
    throw new TypeError("derive-hive-account-ledger: input.account must be a non-empty string");
  }
  if (typeof input.custodyAccount !== "string" || input.custodyAccount === "") {
    throw new TypeError("derive-hive-account-ledger: input.custodyAccount must be a non-empty string");
  }
  const {
    account, rangeStart, rangeEnd, custodyAccount, hiveEngineCustodyAccount,
    hiveOperations = [], hiveEngineEntries = [], hiveEngineFills = [],
    openingBalances = SELF_OWNED,
    chainClosingBalances = SELF_OWNED,
  } = input;
  const balanceDate = input.balanceDate ?? rangeEnd;

  const savingsAccount = `${custodyAccount}:Savings`;
  const inFlightAccount = inFlightAccountFor(custodyAccount);
  const pendingSavingsWithdrawalAccount = `${inFlightAccount}:Pending-Savings-Withdrawal`;
  const pendingConversionAccount = `${inFlightAccount}:Pending-Conversion`;
  const openOrdersAccount = `${inFlightAccount}:Open-Orders`;
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
  let internalMarketFills = 0;

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

  const book = (date, narration, metadata, postings) => {
    for (const p of postings) openAccount(p.account);
    transactions.push({ date, tx: renderTransaction({ date, narration, metadata, postings }) });
  };

  /**
   * One asset exchanged for another inside a single account tree: the disposed leg leaves
   * `fromAccount` carrying the exact total of the acquired leg as its price, so the transaction
   * balances on the venue's own numbers and needs no cost-basis lots.
   */
  const bookConversion = ({ date, narration, metadata, fromAccount, toAccount, disposed, acquired }) => {
    book(date, narration, metadata, [
      { account: fromAccount, amount: negateDecimalString(disposed.amount), commodity: disposed.commodity, totalPrice: `${acquired.amount} ${acquired.commodity}` },
      { account: toAccount, amount: acquired.amount, commodity: acquired.commodity },
    ]);
  };

  /** A plain move of one asset between two accounts. */
  const bookMove = ({ date, narration, metadata, fromAccount, toAccount, amount, commodity }) => {
    book(date, narration, metadata, [
      { account: fromAccount, amount: negateDecimalString(amount), commodity },
      { account: toAccount, amount, commodity },
    ]);
  };

  const bookTransfer = ({ date, opId, payload, narrationPrefix }) => {
    const { amount, commodity } = splitAmount(payload.amount);
    const incoming = payload.to === account;
    const outgoing = payload.from === account;
    if (incoming === outgoing) return; // not ours, or a transfer to oneself that changes nothing
    book(date, `${narrationPrefix} ${incoming ? "from" : "to"} ${incoming ? payload.from : payload.to}`, { op_id: opId, memo: payload.memo ?? "" },
      incoming
        ? [{ account: custodyAccount, amount, commodity }, { account: OTHER_INCOME, amount: negateDecimalString(amount), commodity }]
        : [{ account: custodyAccount, amount: negateDecimalString(amount), commodity }, { account: OTHER_EXPENSE, amount, commodity }]);
  };

  for (const op of sortedOps) {
    const { kind, payload, timestamp, trxId, index } = op;
    const date = dateOf(timestamp);
    const opId = `${trxId}-${index}`;
    switch (kind) {
      case "transfer":
        bookTransfer({ date, opId, payload, narrationPrefix: "Hive transfer" });
        break;
      case "fill_recurrent_transfer":
        // The recurrent_transfer operation only schedules; each execution is this virtual operation.
        bookTransfer({ date, opId, payload, narrationPrefix: "Hive recurrent transfer" });
        break;
      case "transfer_to_vesting_completed": {
        const hive = stripUnitSuffix(payload.hive_vested);
        const vests = stripUnitSuffix(payload.vesting_shares_received);
        const from = payload.from_account ?? account;
        const to = payload.to_account ?? account;
        const hiveLeaves = from === account;
        const vestsArrive = to === account;
        if (!hiveLeaves && !vestsArrive) break;
        if (hiveLeaves && vestsArrive) {
          bookConversion({ date, narration: "Power up (HIVE to VESTS)", metadata: { op_id: opId }, fromAccount: custodyAccount, toAccount: custodyAccount, disposed: { amount: hive, commodity: "HIVE" }, acquired: { amount: vests, commodity: "VESTS" } });
        } else if (hiveLeaves) {
          book(date, `Power up for ${to}`, { op_id: opId }, [{ account: custodyAccount, amount: negateDecimalString(hive), commodity: "HIVE" }, { account: OTHER_EXPENSE, amount: hive, commodity: "HIVE" }]);
        } else {
          book(date, `Power up from ${from}`, { op_id: opId }, [{ account: custodyAccount, amount: vests, commodity: "VESTS" }, { account: OTHER_INCOME, amount: negateDecimalString(vests), commodity: "VESTS" }]);
        }
        break;
      }
      case "fill_vesting_withdraw": {
        const withdrawn = splitAmount(payload.withdrawn);
        const deposited = splitAmount(payload.deposited);
        if (withdrawn.commodity !== "VESTS") { refusals.push({ reason: "unexpected-fill-vesting-withdraw-shape", opId }); break; }
        const from = payload.from_account ?? account;
        const to = payload.to_account ?? account;
        if (from === account && to === account) {
          bookConversion({ date, narration: "Power down (VESTS to HIVE)", metadata: { op_id: opId }, fromAccount: custodyAccount, toAccount: custodyAccount, disposed: withdrawn, acquired: deposited });
        } else if (from === account) {
          book(date, `Power down routed to ${to}`, { op_id: opId }, [{ account: custodyAccount, amount: negateDecimalString(withdrawn.amount), commodity: "VESTS" }, { account: OTHER_EXPENSE, amount: withdrawn.amount, commodity: "VESTS" }]);
        } else if (to === account) {
          book(date, `Power down routed from ${from}`, { op_id: opId }, [{ account: custodyAccount, amount: deposited.amount, commodity: deposited.commodity }, { account: OTHER_INCOME, amount: negateDecimalString(deposited.amount), commodity: deposited.commodity }]);
        }
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
          postings.push({ account: custodyAccount, amount: claimAmount, commodity });
          if (!isZero(split.author)) {
            postings.push({ account: AUTHOR, amount: negateDecimalString(split.author), commodity });
            bucketAdd(nativeRewardTotals.author, commodity, split.author);
          }
          if (!isZero(split.curation)) {
            postings.push({ account: CURATION, amount: negateDecimalString(split.curation), commodity });
            bucketAdd(nativeRewardTotals.curation, commodity, split.curation);
          }
        }
        if (postings.length > 0) book(date, "Claim reward balance", { op_id: opId }, postings);
        break;
      }
      case "interest": {
        const amount = stripUnitSuffix(payload.interest);
        if (isZero(amount)) break;
        const destination = payload.is_saved_into_hbd_balance ? savingsAccount : custodyAccount;
        book(date, "HBD savings interest", { op_id: opId }, [
          { account: destination, amount, commodity: "HBD" },
          { account: INTEREST, amount: negateDecimalString(amount), commodity: "HBD" },
        ]);
        bucketAdd(nativeRewardTotals.interest, "HBD", amount);
        break;
      }
      case "transfer_to_savings": {
        const { amount, commodity } = splitAmount(payload.amount);
        const fromUs = payload.from === account;
        const toUs = payload.to === account;
        if (fromUs && toUs) bookMove({ date, narration: "Transfer to savings", metadata: { op_id: opId }, fromAccount: custodyAccount, toAccount: savingsAccount, amount, commodity });
        else if (fromUs) book(date, `Transfer to ${payload.to}'s savings`, { op_id: opId }, [{ account: custodyAccount, amount: negateDecimalString(amount), commodity }, { account: OTHER_EXPENSE, amount, commodity }]);
        else if (toUs) book(date, `Transfer to savings from ${payload.from}`, { op_id: opId }, [{ account: savingsAccount, amount, commodity }, { account: OTHER_INCOME, amount: negateDecimalString(amount), commodity }]);
        break;
      }
      case "transfer_from_savings": {
        if (payload.from !== account) break;
        const { amount, commodity } = splitAmount(payload.amount);
        pendingWithdrawalsByRequestId.set(String(payload.request_id), { amount, commodity });
        bookMove({ date, narration: "Transfer from savings (requested; 3-day delay)", metadata: { op_id: opId, request_id: String(payload.request_id ?? "") }, fromAccount: savingsAccount, toAccount: pendingSavingsWithdrawalAccount, amount, commodity });
        break;
      }
      case "fill_transfer_from_savings": {
        if (payload.from !== account) break;
        const { amount, commodity } = splitAmount(payload.amount);
        pendingWithdrawalsByRequestId.delete(String(payload.request_id));
        const metadata = { op_id: opId, request_id: String(payload.request_id ?? "") };
        if (payload.to === account || payload.to === undefined) {
          bookMove({ date, narration: "Transfer from savings completed", metadata, fromAccount: pendingSavingsWithdrawalAccount, toAccount: custodyAccount, amount, commodity });
        } else {
          book(date, `Transfer from savings completed to ${payload.to}`, metadata, [{ account: pendingSavingsWithdrawalAccount, amount: negateDecimalString(amount), commodity }, { account: OTHER_EXPENSE, amount, commodity }]);
        }
        break;
      }
      case "cancel_transfer_from_savings": {
        if (payload.from !== account) break;
        const requestId = String(payload.request_id ?? "");
        const pending = pendingWithdrawalsByRequestId.get(requestId);
        if (!pending) { refusals.push({ reason: "cancel-transfer-from-savings-no-matching-request", opId, requestId }); break; }
        pendingWithdrawalsByRequestId.delete(requestId);
        bookMove({ date, narration: "Transfer from savings cancelled (returned to savings)", metadata: { op_id: opId, request_id: requestId }, fromAccount: pendingSavingsWithdrawalAccount, toAccount: savingsAccount, amount: pending.amount, commodity: pending.commodity });
        break;
      }
      case "convert": {
        // HBD leaves the balance when the request is made; the HIVE arrives at the fill 3.5 days later.
        if (payload.owner !== account) break;
        const { amount, commodity } = splitAmount(payload.amount);
        bookMove({ date, narration: "Conversion requested", metadata: { op_id: opId, request_id: String(payload.requestid ?? "") }, fromAccount: custodyAccount, toAccount: pendingConversionAccount, amount, commodity });
        break;
      }
      case "fill_convert_request": {
        if (payload.owner !== account) break;
        bookConversion({
          date, narration: "Conversion completed", metadata: { op_id: opId, request_id: String(payload.requestid ?? "") },
          fromAccount: pendingConversionAccount, toAccount: custodyAccount, disposed: splitAmount(payload.amount_in), acquired: splitAmount(payload.amount_out),
        });
        break;
      }
      case "limit_order_create": {
        // The amount for sale leaves the balance when the order is created and is held by the order.
        if (payload.owner !== account) break;
        const { amount, commodity } = splitAmount(payload.amount_to_sell);
        bookMove({ date, narration: "Market order placed", metadata: { op_id: opId, order_id: String(payload.orderid ?? "") }, fromAccount: custodyAccount, toAccount: openOrdersAccount, amount, commodity });
        break;
      }
      case "limit_order_cancelled": {
        // Virtual operation, emitted for both a cancellation and an expiry, carrying what returns.
        if (payload.seller !== account) break;
        const { amount, commodity } = splitAmount(payload.amount_back);
        bookMove({ date, narration: "Market order closed (returned)", metadata: { op_id: opId, order_id: String(payload.orderid ?? "") }, fromAccount: openOrdersAccount, toAccount: custodyAccount, amount, commodity });
        break;
      }
      case "fill_order": {
        // Each side's order was funded when created, so what an order pays leaves the open-order
        // holding and what it receives lands in the custody account.
        const sides = [
          ["current_owner", "current_pays", "open_pays"],
          ["open_owner", "open_pays", "current_pays"],
        ];
        for (const [ownerField, paysField, getsField] of sides) {
          if (payload[ownerField] !== account) continue;
          internalMarketFills += 1;
          bookConversion({
            date, narration: "Hive internal market fill", metadata: { op_id: opId, venue: "hive-internal-market" },
            fromAccount: openOrdersAccount, toAccount: custodyAccount, disposed: splitAmount(payload[paysField]), acquired: splitAmount(payload[getsField]),
          });
        }
        break;
      }
      // informational only: no balance change to a tracked account.
      case "transfer_to_vesting":
      case "withdraw_vesting":
      case "delegate_vesting_shares":
      case "limit_order_cancel":
        break;
      case "proposal_pay": {
        if (payload.receiver !== account) break;
        const { amount, commodity } = splitAmount(payload.payment);
        book(date, "DHF proposal payment", { op_id: opId }, [
          { account: custodyAccount, amount, commodity },
          { account: OTHER_INCOME, amount: negateDecimalString(amount), commodity },
        ]);
        break;
      }
      default:
        refusals.push({ reason: "unhandled-operation-kind", kind, opId });
    }
  }

  // Hive-Engine market and pool fills settle on the Hive-Engine custody account, where the tokens
  // are held; the quote amount is what actually settled, so the exchange is booked on those numbers.
  let fillsBooked = internalMarketFills;
  for (const fillResult of hiveEngineFills) {
    if (!fillResult.ok) { refusals.push({ reason: "fill-refused", refusal: fillResult.refusal }); continue; }
    if (!hiveEngineCustodyAccount) { refusals.push({ reason: "fill-without-hive-engine-custody-account", fillId: fillResult.fill?.fillId }); continue; }
    const { fill } = fillResult;
    const base = { amount: plainDecimal(fill.baseQuantity), commodity: fill.baseCommodity };
    const quote = { amount: plainDecimal(fill.quoteAmount), commodity: fill.quoteCommodity };
    const sell = fill.side === "sell";
    const postings = [
      { account: hiveEngineCustodyAccount, amount: negateDecimalString((sell ? base : quote).amount), commodity: (sell ? base : quote).commodity, totalPrice: `${(sell ? quote : base).amount} ${(sell ? quote : base).commodity}` },
      { account: hiveEngineCustodyAccount, amount: (sell ? quote : base).amount, commodity: (sell ? quote : base).commodity },
    ];
    const feeAmount = fill.feeAmount === undefined ? ZERO : plainDecimal(fill.feeAmount);
    if (!isZero(feeAmount)) {
      if (typeof fill.feeCommodity !== "string" || typeof fill.feeAccount !== "string") { refusals.push({ reason: "fill-fee-without-commodity-or-account", fillId: fill.fillId }); continue; }
      postings.push({ account: hiveEngineCustodyAccount, amount: negateDecimalString(feeAmount), commodity: fill.feeCommodity });
      postings.push({ account: fill.feeAccount, amount: feeAmount, commodity: fill.feeCommodity });
    }
    book(fill.date, fill.narration ?? `${fill.venue} ${fill.side} ${fill.baseCommodity} for ${fill.quoteCommodity}`, { op_id: fill.fillId, venue: fill.venue }, postings);
    fillsBooked += 1;
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

  // Every account's opening position: the liquid custody balances and each sub-account the chain
  // reports separately.
  const opening = [];
  const addOpening = (acct, commodity, amount) => {
    if (acct && amount !== undefined && !isZero(amount)) opening.push({ account: acct, amount, commodity });
  };
  addOpening(custodyAccount, "HIVE", openingBalances.hive);
  addOpening(custodyAccount, "HBD", openingBalances.hbd);
  addOpening(custodyAccount, "VESTS", openingBalances.vests);
  addOpening(savingsAccount, "HIVE", openingBalances.hiveSavings);
  addOpening(savingsAccount, "HBD", openingBalances.hbdSavings);
  for (const [symbol, amount] of Object.entries(openingBalances.hiveEngine ?? {})) addOpening(hiveEngineCustodyAccount, symbol, amount);
  for (const [symbol, amount] of Object.entries(openingBalances.hiveEngineStaked ?? {})) addOpening(heStakedAccount, symbol, amount);
  for (const [symbol, amount] of Object.entries(openingBalances.hiveEnginePendingUnstake ?? {})) addOpening(hePendingUnstakeAccount, symbol, amount);
  for (const [symbol, amount] of Object.entries(openingBalances.hiveEngineDelegatedOut ?? {})) addOpening(heDelegatedOutAccount, symbol, amount);

  const openingBlock = [];
  if (opening.length > 0) {
    openAccount("Equity:Opening-Balances");
    for (const p of opening) openAccount(p.account);
    openingBlock.push(renderTransaction({
      date: rangeStart,
      narration: `Opening evidenced Hive balances for ${account}`,
      metadata: { source_id: `HIVE-LEDGER-OPEN-${account.toUpperCase()}-${rangeStart}` },
      postings: [
        ...opening,
        ...opening.map((p) => ({ account: "Equity:Opening-Balances", amount: negateDecimalString(p.amount), commodity: p.commodity })),
      ],
    }));
  }

  // The ledger's own position in every account, by folding the opening and every rendered posting.
  const accountBalances = {};
  const fold = (acct, commodity, amount) => {
    accountBalances[acct] ??= {};
    accountBalances[acct][commodity] = addDecimalStrings([accountBalances[acct][commodity] ?? ZERO, amount]);
  };
  for (const p of opening) fold(p.account, p.commodity, p.amount);
  const postingLine = /^ {2}(\S+)\s+(-?\d+(?:\.\d+)?)\s+(\S+)(?:\s+@@?\s+\S+\s+\S+)?$/u;
  for (const { tx } of transactions) {
    for (const line of tx.split("\n")) {
      const m = postingLine.exec(line);
      if (m) fold(m[1], m[3], m[2]);
    }
  }
  const exactBalance = (acct, commodity) => accountBalances[acct]?.[commodity] ?? ZERO;
  // Beancount counts an account together with every account beneath it.
  const treeBalance = (root, commodity) => Object.keys(accountBalances)
    .filter((acct) => acct === root || acct.startsWith(`${root}:`))
    .reduce((sum, acct) => addDecimalStrings([sum, exactBalance(acct, commodity)]), ZERO);

  const balanceComparison = [];
  const closingBlock = [];
  const assertBalance = ({ acct, commodity, chainValue, tree }) => {
    const computed = tree ? treeBalance(acct, commodity) : exactBalance(acct, commodity);
    balanceComparison.push({ account: acct, commodity, scope: tree ? "tree" : "account", computedClosing: computed, chainClosing: chainValue, match: compareDecimalStrings(computed, chainValue) === 0 });
    openAccount(acct);
    closingBlock.push(renderBalanceDirective({ date: balanceDate, account: acct, amount: chainValue, commodity, metadata: { source: "chain-live-read" } }));
  };
  const sum = (...values) => addDecimalStrings(values.map((v) => v ?? ZERO));

  // Mainchain. The liquid balance is asserted on the custody account's whole tree together with
  // the savings figure the chain reports separately; savings is then asserted on its own, which
  // leaves the liquid balance as the remainder of two chain-evidenced figures.
  const chain = chainClosingBalances;
  assertBalance({ acct: custodyAccount, commodity: "HIVE", chainValue: sum(chain.hive, chain.hiveSavings), tree: true });
  assertBalance({ acct: custodyAccount, commodity: "HBD", chainValue: sum(chain.hbd, chain.hbdSavings), tree: true });
  assertBalance({ acct: custodyAccount, commodity: "VESTS", chainValue: chain.vests ?? ZERO, tree: true });
  assertBalance({ acct: savingsAccount, commodity: "HIVE", chainValue: chain.hiveSavings ?? ZERO, tree: false });
  assertBalance({ acct: savingsAccount, commodity: "HBD", chainValue: chain.hbdSavings ?? ZERO, tree: false });
  // The liquid balance on its own, compared in the generator (Beancount cannot state it).
  for (const [commodity, chainValue] of [["HIVE", chain.hive], ["HBD", chain.hbd], ["VESTS", chain.vests]]) {
    const computed = exactBalance(custodyAccount, commodity);
    balanceComparison.push({ account: custodyAccount, commodity, scope: "liquid", computedClosing: computed, chainClosing: chainValue ?? ZERO, match: compareDecimalStrings(computed, chainValue ?? ZERO) === 0 });
  }

  // Hive-Engine, per symbol: the whole tree equals liquid + staked + pending unstake + delegated out.
  if (hiveEngineCustodyAccount) {
    const symbols = new Set([
      ...Object.keys(chain.hiveEngine ?? {}), ...Object.keys(chain.hiveEngineStaked ?? {}),
      ...Object.keys(chain.hiveEnginePendingUnstake ?? {}), ...Object.keys(chain.hiveEngineDelegatedOut ?? {}),
    ]);
    for (const symbol of symbols) {
      const liquid = chain.hiveEngine?.[symbol] ?? ZERO;
      const staked = chain.hiveEngineStaked?.[symbol] ?? ZERO;
      const pendingUnstake = chain.hiveEnginePendingUnstake?.[symbol] ?? ZERO;
      const delegatedOut = chain.hiveEngineDelegatedOut?.[symbol] ?? ZERO;
      assertBalance({ acct: hiveEngineCustodyAccount, commodity: symbol, chainValue: sum(liquid, staked, pendingUnstake, delegatedOut), tree: true });
      for (const [acct, value] of [[heStakedAccount, staked], [hePendingUnstakeAccount, pendingUnstake], [heDelegatedOutAccount, delegatedOut]]) {
        if (!isZero(value) || accountsOpened.has(acct)) assertBalance({ acct, commodity: symbol, chainValue: value, tree: false });
      }
      const computed = exactBalance(hiveEngineCustodyAccount, symbol);
      balanceComparison.push({ account: hiveEngineCustodyAccount, commodity: symbol, scope: "liquid", computedClosing: computed, chainClosing: liquid, match: compareDecimalStrings(computed, liquid) === 0 });
    }
  }

  const openDirectives = [...accountsOpened].sort().map((a) => `${rangeStart} open ${a}`);
  const header = `; Hive account ledger for ${account}, range [${rangeStart}, ${rangeEnd}]. Generated by @red-cup-engineering/derive-hive-account-ledger-service. Do not hand-edit.`;
  const ledgerText = renderFile(header, [...openDirectives, ...openingBlock, ...transactions.map((t) => t.tx), ...closingBlock]);

  return {
    type: "HiveAccountLedgerSet",
    version: 1,
    account,
    rangeStart,
    rangeEnd,
    balanceDate,
    ledgerText,
    accountsOpened: [...accountsOpened].sort(),
    transactionCount: openingBlock.length + transactions.length,
    lastHiveOperationIndex,
    fillsBooked,
    nativeRewardTotals,
    accountBalances,
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
