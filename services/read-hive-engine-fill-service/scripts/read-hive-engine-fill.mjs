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
