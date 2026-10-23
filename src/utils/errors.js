import { STATUS_CODES } from "node:http";

// Only messages constructed by application code are eligible for logging.
const trusted = new WeakSet();
const codes = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EACCES", "ENOENT", "EROFS", "ENOSPC", "ERR_SQLITE_ERROR", "ERR_SQLITE_MISUSE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "INVALID_RESPONSE", "TIMEOUT"]);
export function diagnosticError(message, details = {}, ErrorType = Error) {
  const error = Object.assign(new ErrorType(message), details);
  trusted.add(error);
  return error;
}
export function errorContext(error, details) {
  return diagnosticError(trusted.has(error) ? error.message : "Operation failed.", {
    cause: error, httpStatus: error?.httpStatus, code: error?.code,
    uncertain: error?.uncertain, candidateRequestId: error?.candidateRequestId,
    ...details,
  });
}
export function formatError(error) {
  const parts = [];
  const seen = new Set();
  for (let current = error, depth = 0; current && depth < 6 && !seen.has(current); current = current.cause, depth++) {
    seen.add(current);
    // Endpoint paths are allowlisted, never extracted from request URLs.
    if (typeof current.operation === "string" && /^(GET|POST|PUT|DELETE) \/(?:api\/v1\/)?(?:user|request|movie|tv)(?:\/\d+)?(?:\/settings\/permissions|\/approve)?$/.test(current.operation)) parts.push(current.operation);
    if (current.operation === "GET /lists/{listid}/items") parts.push(current.operation);
    if (Number.isInteger(current.httpStatus) && current.httpStatus >= 100 && current.httpStatus <= 599) parts.push(`HTTP ${current.httpStatus} ${STATUS_CODES[current.httpStatus] ?? ""}`.trim());
    if (["SQLite initialization", "SQLite history lookup", "SQLite history persistence"].includes(current.operation)) parts.push(current.operation);
    if (codes.has(current.code)) parts.push(current.code);
    if (current.name === "TimeoutError" || current.name === "AbortError") parts.push("TIMEOUT");
    if (trusted.has(current)) parts.push(current.message);
    if (current.uncertain) parts.push("Outcome: UNCERTAIN");
    if (Number.isSafeInteger(current.candidateRequestId) && current.candidateRequestId > 0) parts.push(`Candidate request: ${current.candidateRequestId}`);
  }
  return [...new Set(parts)].join("; ") || "Operation failed (unsafe error details omitted).";
}
export function safeContext(values, secrets = []) {
  return JSON.stringify(values, (_key, value) => {
    if (typeof value !== "string") return value;
    for (const secret of secrets) if (typeof secret === "string" && secret) value = value.replaceAll(secret, "[REDACTED]");
    return value.replace(/https?:\/\/\S+|[^\s]+@[^\s]+/g, "[REDACTED]");
  });
}
