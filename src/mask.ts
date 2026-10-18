const TOKEN_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const ASSIGNMENT = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*)["']?[^\s"',]{6,}["']?/gi;

export function maskSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '***REDACTED***');
  return out.replace(ASSIGNMENT, '$1"***"');
}
