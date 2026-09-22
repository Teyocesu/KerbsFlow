const SECRET_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|sess|glpat)-[A-Za-z0-9_-]{8,}\b|\b(?:gh[pousr]|github_pat|npm)_[A-Za-z0-9_-]{8,}\b|\bBearer\s+[^\s"']+|\bAKIA[0-9A-Z]{16}\b|\b(?:Set-Cookie|Cookie):[^\r\n]+|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s@]+@|\b(?:[A-Z0-9]+_)*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET[_-]?ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|PASSWORD|TOKEN|SECRET|AUTHORIZATION|AUTH[_-]?COOKIE)\s*[:=]\s*["']?[^\s"',;}]{8,}/iu;
const SECRET_KEY = /(?:^|[_-])(?:authorization|api[_-]?key|token|secret|password|private[_-]?key|client[_-]?secret|cookie)(?:$|[_-])/iu;

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

export function redactDiagnostic(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu, "<redacted-private-key>")
    .replace(/\b(?:sk|sess|glpat)-[A-Za-z0-9_-]{8,}\b/giu, "<redacted-credential>")
    .replace(/\b(?:gh[pousr]|github_pat|npm)_[A-Za-z0-9_-]{8,}\b/giu, "<redacted-credential>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "<redacted-credential>")
    .replace(/\bBearer\s+[^\s"']+/giu, "Bearer <redacted>")
    .replace(/\b((?:Set-Cookie|Cookie):)[^\r\n]+/giu, "$1 <redacted>")
    .replace(/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/)[^\s@]+@/giu, "$1<redacted>@")
    .replace(/((?:[A-Z0-9]+_)*(?:api[_-]?key|access[_-]?token|secret[_-]?access[_-]?key|private[_-]?key|client[_-]?secret|password|token|secret|authorization|auth[_-]?cookie)\s*[:=]\s*)[^\s,;}]+/giu, "$1<redacted>");
}

export function publicFixtureIssue(value: string): string | undefined {
  if (containsLikelySecret(value)) return "credential-shaped material";
  if (/(?:^|["'\s])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/mu.test(value)) return "absolute user-home path";
  if (/^(?:Set-Cookie|Cookie):/imu.test(value)) return "authentication cookie";
  if (value.includes("SQLite format 3\0")) return "operational SQLite database content";
  if (/(?:^|\/)\.git\/worktrees\/|\[core\][\s\S]*repositoryformatversion/imu.test(value)) return "real Git worktree content";
  return undefined;
}

export function sanitizeDiagnosticValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "<redacted>";
  if (typeof value === "string") return redactDiagnostic(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeDiagnosticValue(entryValue, entryKey)]));
  }
  return value;
}

export const SENSITIVE_RESULT_REJECTION = "sensitive credential material was rejected before persistence";
