// Pure admission shared by the real reader and its offline boundary checks.
export function resolveOperation(result, transactionId) {
  const candidates = Array.isArray(result) ? result : [result];
  const matched = candidates.filter((candidate) => candidate && candidate.transactionId === transactionId);
  return matched.length === 1 ? matched[0] : null;
}

export function witnessHashRefusal(witnesses) {
  if (!Array.isArray(witnesses) || witnesses.length < 2) {
    throw new TypeError("fill witnesses require at least two observations");
  }
  if (witnesses.some((witness) => typeof witness.databaseHash !== "string" || !witness.databaseHash.trim())) {
    return "missing-witness-hash";
  }
  const firstHash = witnesses[0].databaseHash;
  return witnesses.every((witness) => witness.databaseHash === firstHash) ? null : "witness-disagreement";
}
