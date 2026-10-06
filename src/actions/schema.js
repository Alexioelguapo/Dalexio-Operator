// Planner action contract and validation.
//
// Every action a planner proposes passes through validateAction() before the
// executor is allowed to touch the browser. Validation is strict: unknown
// actions, unknown fields, stale refs and malformed payloads are all rejected.

export const ACTIONS = Object.freeze(['navigate', 'click_ref', 'type_ref', 'observe', 'screenshot', 'done']);

// Action names a model might plausibly emit that must never be executable
// through the browser-action interface. They get a distinct, explicit error.
export const FORBIDDEN_ACTIONS = Object.freeze([
  'shell', 'exec', 'execute', 'run', 'bash', 'sh', 'cmd', 'command', 'system', 'spawn',
  'eval', 'evaluate', 'script', 'javascript', 'js', 'run_script', 'execute_script',
  'download', 'file', 'read_file', 'write_file',
  'set_cookie', 'cookies', 'storage', 'localstorage', 'devtools', 'cdp',
]);

export const LIMITS = Object.freeze({
  maxUrlLength: 2048,
  maxTextLength: 2000,
  maxReasonLength: 500,
  maxSummaryLength: 2000,
});

const REF_PATTERN = /^(link|button|input|select|textarea|checkbox|radio)-\d{1,5}$/;
// Control characters other than tab/newline have no business in typed text.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Per-action field specs. `reason` is accepted on every action so planners can
// explain themselves; it is logged but never executed.
export const ACTION_SPECS = Object.freeze({
  navigate: {
    description: 'Load an absolute http(s) URL in the current tab.',
    fields: { url: { type: 'string', required: true, description: 'Absolute http:// or https:// URL.' } },
  },
  click_ref: {
    description: 'Click a link, button or control identified by a ref from the CURRENT observation.',
    fields: { ref: { type: 'string', required: true, description: 'Element ref such as "link-3" or "button-0".' } },
  },
  type_ref: {
    description: 'Type text into an input identified by a ref from the CURRENT observation. Replaces existing value.',
    fields: {
      ref: { type: 'string', required: true, description: 'Input ref such as "input-2".' },
      text: { type: 'string', required: true, description: 'Text to type.' },
      submit: { type: 'boolean', required: false, description: 'Press Enter after typing (submits the form).' },
    },
  },
  observe: {
    description: 'Re-read the current page and receive a fresh observation.',
    fields: {},
  },
  screenshot: {
    description: 'Capture a screenshot of the current page for the audit trail.',
    fields: { fullPage: { type: 'boolean', required: false, description: 'Capture the full scrollable page.' } },
  },
  done: {
    description: 'Finish the task. Use when the objective is achieved or cannot be achieved.',
    fields: {
      summary: { type: 'string', required: true, description: 'What was accomplished, or why it failed.' },
      success: { type: 'boolean', required: false, description: 'false if the objective could not be completed.' },
    },
  },
});

export class ActionValidationError extends Error {
  constructor(message, { code = 'invalid_action', action } = {}) {
    super(message);
    this.name = 'ActionValidationError';
    this.code = code;
    this.action = action;
  }
}

function fail(message, code, action) {
  throw new ActionValidationError(message, { code, action });
}

export function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') fail('navigate requires a non-empty "url" string', 'invalid_url');
  const value = raw.trim();
  if (value.length > LIMITS.maxUrlLength) fail(`url exceeds ${LIMITS.maxUrlLength} characters`, 'invalid_url');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`malformed url: ${JSON.stringify(value.slice(0, 200))}`, 'invalid_url');
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) fail(`url scheme "${url.protocol}" is not allowed (http/https only)`, 'invalid_url');
  if (!url.hostname) fail('url has no host', 'invalid_url');
  if (url.username || url.password) fail('urls with embedded credentials are not allowed', 'invalid_url');
  return url.href;
}

function validateText(value, field, max) {
  if (typeof value !== 'string') fail(`"${field}" must be a string`, 'invalid_text');
  if (value.length > max) fail(`"${field}" exceeds ${max} characters`, 'invalid_text');
  if (CONTROL_CHARS.test(value)) fail(`"${field}" contains control characters`, 'invalid_text');
  return value;
}

/**
 * Validate a planner action.
 *
 * @param {unknown} input            Raw action proposed by a planner.
 * @param {object}  [opts]
 * @param {object}  [opts.observation] The observation the planner saw. When
 *   given, refs must exist in it (and type_ref must target a typeable element).
 * @returns {object} A normalized, frozen action.
 */
export function validateAction(input, { observation } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('action must be a JSON object', 'invalid_action');
  }
  const name = input.action;
  if (typeof name !== 'string' || name === '') fail('action is missing the "action" field', 'missing_action', input);
  if (FORBIDDEN_ACTIONS.includes(name.toLowerCase())) {
    fail(`action "${name}" is forbidden: the browser interface cannot execute shell, scripts or file operations`, 'forbidden_action', input);
  }
  const spec = ACTION_SPECS[name];
  if (!spec) fail(`unknown action "${name}". Allowed: ${ACTIONS.join(', ')}`, 'unknown_action', input);

  const allowedKeys = new Set(['action', 'reason', ...Object.keys(spec.fields)]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) fail(`unexpected field "${key}" for action "${name}"`, 'unexpected_field', input);
  }

  const out = { action: name };
  if (input.reason !== undefined && input.reason !== null) {
    out.reason = validateText(String(input.reason), 'reason', LIMITS.maxReasonLength);
  }

  for (const [field, fspec] of Object.entries(spec.fields)) {
    const value = input[field];
    if (value === undefined || value === null) {
      if (fspec.required) fail(`action "${name}" requires "${field}"`, field === 'ref' ? 'missing_ref' : 'missing_field', input);
      continue;
    }
    if (fspec.type === 'boolean' && typeof value !== 'boolean') fail(`"${field}" must be a boolean`, 'invalid_field', input);
    if (fspec.type === 'string' && typeof value !== 'string') fail(`"${field}" must be a string`, 'invalid_field', input);
    out[field] = value;
  }

  switch (name) {
    case 'navigate':
      out.url = validateUrl(out.url);
      break;
    case 'click_ref':
    case 'type_ref': {
      if (!REF_PATTERN.test(out.ref)) fail(`malformed ref "${String(out.ref).slice(0, 50)}"`, 'invalid_ref', input);
      if (name === 'type_ref') out.text = validateText(out.text, 'text', LIMITS.maxTextLength);
      if (observation) {
        const el = findElement(observation, out.ref);
        if (!el) fail(`ref "${out.ref}" is not present in the current observation`, 'unknown_ref', input);
        if (name === 'type_ref' && !isTypeable(el)) fail(`ref "${out.ref}" (${el.kind}) is not a text input`, 'not_typeable', input);
        if (el.disabled) fail(`ref "${out.ref}" is disabled`, 'disabled_element', input);
      }
      break;
    }
    case 'done':
      out.summary = validateText(out.summary, 'summary', LIMITS.maxSummaryLength);
      if (out.success === undefined) out.success = true;
      break;
    default:
      break;
  }
  return Object.freeze(out);
}

export function findElement(observation, ref) {
  return observation?.elements?.find((el) => el.ref === ref) ?? null;
}

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'hidden', 'range', 'color']);

export function isTypeable(el) {
  if (el.kind === 'textarea') return true;
  if (el.kind !== 'input') return false;
  return !NON_TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase());
}

/** Stable signature of an action, used for loop detection. */
export function actionSignature(action) {
  switch (action.action) {
    case 'navigate': return `navigate:${action.url}`;
    case 'click_ref': return `click_ref:${action.ref}`;
    case 'type_ref': return `type_ref:${action.ref}:${action.text}:${action.submit ? 1 : 0}`;
    default: return action.action;
  }
}
