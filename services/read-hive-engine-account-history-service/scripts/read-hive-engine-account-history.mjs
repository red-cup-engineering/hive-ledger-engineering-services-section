#!/usr/bin/env node
/**
 * read-hive-engine-account-history — pages a Hive-Engine account's operation history from
 * two independent public REST indexers, witnessing each page between them, over an optional
 * time range. Token transfers, staking, delegation, and distribution/curation entries are
 * shaped directly; market and pool-swap fills are resolved by transaction id through
 * @red-cup-engineering/read-hive-engine-fill-service rather than re-derived.
 */
import { readHiveEngineFill } from "@red-cup-engineering/read-hive-engine-fill-service";

const DEFAULT_REST_NODES = ["https://accounts.hive-engine.com", "https://history.hive-engine.com"];
const DEFAULT_FILL_NODES = ["https://api.hive-engine.com/rpc", "https://api2.hive-engine.com/rpc"];
const PAGE_LIMIT = 1000;

/** Operations a single fill can be resolved from by transaction id via read-hive-engine-fill-service. */
const FILL_OPERATIONS = new Set(["market_buy", "market_sell", "market_marketSell", "market_buyRemaining", "marketpools_swapTokens"]);

/** Operations shaped directly as ledger entries (never resolved as a fill). */
const DIRECT_OPERATIONS = new Set([
  "tokens_transfer",
  "tokens_issue",
  "tokens_stake",
  "tokens_unstakeStart",
  "tokens_unstakeDone",
  "tokens_delegate",
  "tokens_undelegate",
  "tokens_undelegateDone",
  "comments_curationReward",
  "comments_curationReward_stake",
  "comments_authorReward",
  "comments_authorReward_stake",
  "comments_beneficiaryReward",
  "comments_beneficiaryReward_stake",
  "distribution_checkPendingDistributions",
  "hivepegged_buy",
  "hivepegged_withdraw",
]);

/**
 * Order-lifecycle rows with no balance effect of their own: the actual balance change is a
 * separate row already classified under FILL_OPERATIONS (a market/pool fill always accompanies
 * a `market_placeOrder` and, when the order fully executes, a `market_closeOrder`).
 */
const INFORMATIONAL_OPERATIONS = new Set([
  "market_placeOrder", "market_closeOrder", "market_cancelOrder", "market_expireOrder",
  "market_cancel", "market_expire", "market_sellRemaining", "tokens_undelegateStart",
]);

function unixToIso(timestampSeconds) {
  return new Date(timestampSeconds * 1000).toISOString();
}

function withinRange(timestampSeconds, from, to) {
  const t = timestampSeconds * 1000;
  if (from && t < Date.parse(from)) return false;
  if (to && t >= Date.parse(to)) return false;
  return true;
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Fetch one page, retrying a transient failure (non-2xx, or a non-JSON body such as an HTML
 * rate-limit/error page) a bounded number of times with linear backoff.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<object[]>}
 * @throws {Error} after exhausting retries
 */
async function fetchPageWithRetry(url, fetchImpl, { retries = 4, retryDelayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await delay(retryDelayMs * attempt); // eslint-disable-line no-await-in-loop
    // eslint-disable-next-line no-await-in-loop
    const response = await fetchImpl(url);
    if (!response.ok) { lastError = new Error(`read-hive-engine-account-history: HTTP ${response.status} from ${url}`); continue; }
    let page;
    try {
      // eslint-disable-next-line no-await-in-loop
      page = await response.json();
    } catch (error) {
      lastError = new Error(`read-hive-engine-account-history: non-JSON response from ${url}: ${error.message}`);
      continue;
    }
    if (!Array.isArray(page)) { lastError = new Error(`read-hive-engine-account-history: non-array response from ${url}`); continue; }
    return page;
  }
  throw lastError;
}

// The real indexer caps a page at its own server-side maximum regardless of the requested
// `limit` (verified 2026-09-05: requesting 1000 for michael561 still returned exactly 500, and
// offset=500 revealed 500 MORE rows a "shorter than requested" stop heuristic had dropped).
const MAX_PAGES = 500; // far beyond any real account's history; a runaway loop is a bug to surface.

/**
 * Fetch one REST indexer's full paged account history, stopping only on a genuinely empty page
 * (never on "fewer rows than requested", which the real indexer's own page cap makes unsafe).
 * @param {string} node base URL
 * @param {string} account
 * @param {typeof fetch} fetchImpl
 * @param {number} limit
 * @returns {Promise<object[]>}
 * @throws {Error} if no page ever comes back empty within {@link MAX_PAGES}
 */
export async function fetchAllPages(node, account, fetchImpl, limit = PAGE_LIMIT) {
  const rows = [];
  let offset = 0;
  for (let page_index = 0; page_index < MAX_PAGES; page_index += 1) {
    const url = `${node}/accountHistory?account=${encodeURIComponent(account)}&limit=${limit}&offset=${offset}`;
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchPageWithRetry(url, fetchImpl);
    if (page.length === 0) return rows;
    rows.push(...page);
    offset += page.length;
  }
  throw new Error(`read-hive-engine-account-history: exceeded ${MAX_PAGES} pages fetching ${account}'s history from ${node}; refusing to silently truncate`);
}

/**
 * Whether two indexers' rows for the same account agree, keyed by `transactionId` + `operation`
 * + `symbol` (Hive-Engine's own row `_id` is indexer-local and not compared).
 * @param {readonly object[]} rowsA
 * @param {readonly object[]} rowsB
 * @returns {boolean}
 */
export function rowsAgree(rowsA, rowsB) {
  const key = (r) => `${r.transactionId}:${r.operation}:${r.symbol ?? ""}:${r.quantity ?? ""}`;
  const setA = new Set(rowsA.map(key));
  const setB = new Set(rowsB.map(key));
  if (setA.size !== setB.size) return false;
  for (const k of setA) if (!setB.has(k)) return false;
  return true;
}

/**
 * Classify one Hive-Engine account-history row: `"fill"` (resolved via
 * read-hive-engine-fill-service), `"direct"` (shaped in place), `"informational"` (an
 * order-lifecycle row with no balance effect of its own), or `"unclassified"` (named as a
 * refusal rather than silently dropped).
 * @param {string} operation
 * @returns {"fill" | "direct" | "informational" | "unclassified"}
 */
export function classifyRow(operation) {
  if (FILL_OPERATIONS.has(operation)) return "fill";
  if (DIRECT_OPERATIONS.has(operation)) return "direct";
  if (INFORMATIONAL_OPERATIONS.has(operation)) return "informational";
  return "unclassified";
}

/**
 * Read a Hive-Engine account's operation history since a range boundary, from two independent
 * public REST indexers, witnessed against each other, composing
 * `@red-cup-engineering/read-hive-engine-fill-service` for every market/pool fill.
 * @param {{ account: string, nodes?: readonly string[], fillNodes?: readonly string[],
 *   from?: { time?: string }, to?: { time?: string } }} input
 * @param {{ fetchImpl?: typeof fetch, readFillImpl?: typeof readHiveEngineFill }} [options]
 * @returns {Promise<object>}
 * @throws {TypeError} When `input.account` is missing.
 */
export async function readHiveEngineAccountHistory(input, { fetchImpl = fetch, readFillImpl = readHiveEngineFill } = {}) {
  if (!input || typeof input.account !== "string" || input.account === "") {
    throw new TypeError("read-hive-engine-account-history: input.account must be a non-empty string");
  }
  const { account } = input;
  const nodes = input.nodes && input.nodes.length >= 2 ? input.nodes : DEFAULT_REST_NODES;
  const fillNodes = input.fillNodes && input.fillNodes.length >= 2 ? input.fillNodes : DEFAULT_FILL_NODES;
  const fromTime = input.from?.time ?? null;
  const toTime = input.to?.time ?? null;

  const [rowsPrimary, rowsSecondary] = await Promise.all([
    fetchAllPages(nodes[0], account, fetchImpl),
    fetchAllPages(nodes[1], account, fetchImpl).catch((error) => ({ error: String(error?.message ?? error) })),
  ]);
  const secondaryOk = Array.isArray(rowsSecondary);
  const witnessed = secondaryOk && rowsAgree(rowsPrimary, rowsSecondary);
  const refusals = [];
  if (!witnessed) {
    refusals.push({
      reason: secondaryOk ? "witness-disagreement" : "witness-fetch-failed",
      error: secondaryOk ? undefined : rowsSecondary.error,
    });
  }

  const inRange = rowsPrimary.filter((r) => withinRange(r.timestamp, fromTime, toTime));
  const entries = [];
  const fillTransactionIds = [];
  for (const row of inRange) {
    const kind = classifyRow(row.operation);
    if (kind === "fill") {
      if (!fillTransactionIds.includes(row.transactionId)) fillTransactionIds.push(row.transactionId);
      continue;
    }
    if (kind === "informational") continue;
    entries.push({
      transactionId: row.transactionId,
      blockNumber: row.blockNumber,
      timestamp: unixToIso(row.timestamp),
      operation: row.operation,
      symbol: row.symbol ?? null,
      quantity: row.quantity ?? null,
      from: row.from ?? null,
      to: row.to ?? null,
      account: row.account,
      classification: kind,
      witnessed,
    });
    if (kind === "unclassified") {
      refusals.push({ reason: "unclassified-operation", transactionId: row.transactionId, operation: row.operation });
    }
  }

  const fills = [];
  for (const transactionId of fillTransactionIds) {
    const dateRow = inRange.find((r) => r.transactionId === transactionId);
    const date = unixToIso(dateRow.timestamp).slice(0, 10);
    // read-hive-engine-fill-service throws (rather than refusing) on a transport-level failure
    // (e.g. a rate-limited node answering with an HTML page instead of JSON); this composing
    // service retries a couple of times, then reports it as a refusal instead of crashing.
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await readFillImpl({ transactionId, account, date, nodes: fillNodes });
        break;
      } catch (error) {
        if (attempt >= 3) { result = { ok: false, refusal: { reason: "fill-read-failed", transactionId, error: String(error?.message ?? error) } }; break; }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 500 * (attempt + 1)); });
      }
    }
    fills.push(result);
  }

  return {
    account,
    nodesUsed: [nodes[0], nodes[1]],
    fillNodesUsed: [fillNodes[0], fillNodes[1]],
    from: fromTime,
    to: toTime,
    entryCount: entries.length,
    fillCount: fills.length,
    entries,
    fills,
    refusals,
  };
}

if (import.meta.main) {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const result = await readHiveEngineAccountHistory(JSON.parse(text));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(2);
  }
}
