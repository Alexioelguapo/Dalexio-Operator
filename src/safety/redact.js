// Last-line redaction for page-derived text before it reaches a planner.
//
// Observations never include cookies, storage or input values of sensitive
// fields in the first place. This catches the remaining case: a page that
// *displays* a token (an API-key settings page, a debug banner). Patterns are
// deliberately specific so ordinary prose is left alone.

const SECRET_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,         // JWT
  /\b(sk|pk|rk)-(ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}\b/g,              // sk-… style API keys
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g,                             // Stripe-style keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,                                           // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,                                         // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                                                     // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                                                // Google API key
  /\b(bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/gi,                                   // Authorization: Bearer …
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, p1) => (/^bearer$/i.test(p1 ?? '') ? `${p1} [redacted secret]` : '[redacted secret]'));
  return out;
}

/** Apply redactSecrets to the text-bearing fields of an observation (returns a copy). */
export function redactObservation(obs) {
  if (!obs) return obs;
  return {
    ...obs,
    title: redactSecrets(obs.title),
    text: redactSecrets(obs.text),
    headings: obs.headings?.map((h) => ({ ...h, text: redactSecrets(h.text) })),
    elements: obs.elements?.map((e) => ({
      ...e,
      label: redactSecrets(e.label),
      ...(typeof e.value === 'string' ? { value: redactSecrets(e.value) } : {}),
    })),
  };
}
