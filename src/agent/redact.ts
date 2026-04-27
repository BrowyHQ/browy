/**
 * Lightweight secret redaction for log/buffer surfaces that may carry user
 * data we should never persist to disk or transport.
 *
 * Applied at *capture* time (not at read time) so even an in-memory dump or
 * a crash log won't leak. False positives are acceptable; false negatives
 * are not.
 *
 * Targets:
 *   - URL query params: token=, access_token=, api_key=, password=, etc.
 *   - Header values: Authorization, Cookie, X-Api-Key
 *   - Inline secrets in text: JWTs (eyJ…), GitHub PATs (ghp_…), AWS keys
 *     (AKIA…), OpenAI/Stripe keys (sk_…/pk_…), and generic Bearer tokens.
 */

const SECRET_QUERY_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token',
  'api_key', 'apikey', 'key', 'auth', 'password', 'pwd', 'secret',
  'client_secret', 'sessionid', 'phpsessid', 'jwt', 'bearer',
  'signature', 'sig', 'code',
]);

const PATTERNS: Array<[RegExp, string]> = [
  // JWTs (three base64 segments separated by dots, starts with eyJ)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED_JWT]'],
  // GitHub tokens
  [/\b(?:ghp|ghs|gho|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  // OpenAI / Stripe / Anthropic-style prefixed keys
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED_API_KEY]'],
  // AWS access keys
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  // Authorization / Bearer / Cookie header values (case-insensitive)
  [/(authorization|x-api-key|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]'],
];

/** Redact secrets from a URL by scrubbing known sensitive query params. */
export function redactUrl(url: string): string {
  if (!url) return url;
  // Cheap path: no '?' → no query params.
  const q = url.indexOf('?');
  if (q < 0) return url;
  const base = url.slice(0, q);
  const rest = url.slice(q + 1);
  // Hash fragment (browsers can put #access_token=… for OAuth implicit flow).
  const hashIdx = rest.indexOf('#');
  const queryStr = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const fragment = hashIdx >= 0 ? rest.slice(hashIdx) : '';
  const parts = queryStr.split('&').map((kv) => {
    const eq = kv.indexOf('=');
    if (eq < 0) return kv;
    const k = kv.slice(0, eq);
    if (SECRET_QUERY_KEYS.has(k.toLowerCase())) return `${k}=[REDACTED]`;
    return kv;
  });
  // Also scrub OAuth-implicit-style #access_token= in the fragment.
  let cleanFragment = fragment;
  if (cleanFragment.length > 1) {
    const fragInner = cleanFragment.slice(1).split('&').map((kv) => {
      const eq = kv.indexOf('=');
      if (eq < 0) return kv;
      const k = kv.slice(0, eq);
      if (SECRET_QUERY_KEYS.has(k.toLowerCase())) return `${k}=[REDACTED]`;
      return kv;
    }).join('&');
    cleanFragment = '#' + fragInner;
  }
  return `${base}?${parts.join('&')}${cleanFragment}`;
}

/** Redact secrets from arbitrary text (console output, log lines, headers). */
export function redactText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pat, repl] of PATTERNS) {
    out = out.replace(pat, repl);
  }
  return out;
}
