const SECRET_VALUE = /\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[^\s"']+|\bAKIA[0-9A-Z]{16}\b|\b(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*["']?[^\s"',;}]{8,}/iu;
const SECRET_KEY = /^(?:authorization|api[_-]?key|token|secret|password)$/iu;

export function containsLikelySecret(value: unknown, key = ""): boolean {
  if (typeof value === "string") {
    return SECRET_VALUE.test(value) || (SECRET_KEY.test(key) && value.length >= 8);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsLikelySecret(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([entryKey, entryValue]) => containsLikelySecret(entryValue, entryKey));
  }
  return false;
}

export const SENSITIVE_RESULT_REJECTION = "semantic review result contained likely credential material and was rejected";
