const SENSITIVE_KEY =
  /(authorization|api[-_]?key|api[-_]?secret|signature|token|listen[-_]?key|password|database_url|cookie|secret|account[-_]?id)/i;

const SECRET_LIKE_PATTERNS = [
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:postgres(?:ql)?):\/\/[^\s]+/gi,
  /\/auth-stream\/[A-Za-z0-9_-]{16,}/gi,
];

export function redactText(value: string): string {
  return SECRET_LIKE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item);
    }
    return result;
  }
  return value;
}
