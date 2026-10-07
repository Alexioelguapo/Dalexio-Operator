// Planner action contract and validation.
//
// Every action a planner proposes passes through validateAction() before the
// executor is allowed to touch the browser. Validation is strict: unknown
// actions, unknown fields, stale refs and malformed payloads are all rejected.
//
// Every action does exactly one thing. Filling a field, choosing an option,
// ticking a box or attaching a file never submits anything; committing a form
// is always its own click_ref (or an explicit type_ref `submit`), so the
// safety policy sees and classifies it separately.

export const ACTIONS = Object.freeze([
  'navigate', 'click_ref', 'type_ref', 'select_option', 'set_checked',
  'upload_file', 'download_ref', 'read_page', 'read_ref', 'observe', 'screenshot', 'done',
]);

// Action names a model might plausibly emit that must never be executable
// through the browser-action interface. They get a distinct, explicit error.
export const FORBIDDEN_ACTIONS = Object.freeze([
  'shell', 'exec', 'execute', 'run', 'bash', 'sh', 'cmd', 'command', 'system', 'spawn',
  'eval', 'evaluate', 'script', 'javascript', 'js', 'run_script', 'execute_script',
  'download', 'file', 'read_file', 'write_file', 'list_files', 'open_file', 'fs',
  'set_cookie', 'cookies', 'storage', 'localstorage', 'devtools', 'cdp',
]);

export const LIMITS = Object.freeze({
  maxUrlLength: 2048,
  maxTextLength: 2000,
  maxReasonLength: 500,
  maxSummaryLength: 2000,
  maxOptionLength: 200,
  maxFindLength: 100,
  readDefaultChars: 4000,
  readMaxChars: 8000,
  readMaxOffset: 1_000_000,
});

const REF_PATTERN = /^(link|button|input|select|textarea|checkbox|radio|file)-\d{1,5}$/;
// Upload sources are opaque ids handed out by the FileRegistry, never paths.
export const FILE_ID_PATTERN = /^file-\d{1,4}$/;
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
  select_option: {
    description: 'Choose one option of a <select> dropdown identified by a ref from the CURRENT observation. Matches the option label first, then its value. Does not submit the form.',
    fields: {
      ref: { type: 'string', required: true, description: 'Select ref such as "select-0".' },
      option: { type: 'string', required: true, description: 'Visible option label (or its value).' },
    },
  },
  set_checked: {
    description: 'Tick or untick a checkbox, or select a radio button, identified by a ref from the CURRENT observation. Does not submit the form.',
    fields: {
      ref: { type: 'string', required: true, description: 'Checkbox or radio ref such as "checkbox-0" or "radio-2".' },
      checked: { type: 'boolean', required: true, description: 'true to tick/select, false to untick (checkboxes only).' },
    },
  },
  upload_file: {
    description: 'Attach one AVAILABLE FILE (by its file id) to a file input identified by a ref from the CURRENT observation. Needs approval. Does not submit or publish anything.',
    fields: {
      ref: { type: 'string', required: true, description: 'File input ref such as "file-0".' },
      file: { type: 'string', required: true, description: 'File id from AVAILABLE FILES, such as "file-0". Paths are not accepted.' },
    },
  },
  download_ref: {
    description: 'Click a link or button from the CURRENT observation that downloads a file, and save it to the managed downloads folder. The file is never opened or executed.',
    fields: { ref: { type: 'string', required: true, description: 'Link or button ref that starts the download.' } },
  },
  read_page: {
    description: 'Read the visible text of the current page in bounded chunks (more than the observation shows). Use "find" to get only the passages mentioning a word, or "offset" to continue reading.',
    fields: {
      find: { type: 'string', required: false, description: 'Case-insensitive text to search for; returns the passages around each match.' },
      offset: { type: 'integer', required: false, description: 'Character offset to start reading from (default 0).' },
      maxChars: { type: 'integer', required: false, description: `Characters to return (default ${LIMITS.readDefaultChars}, max ${LIMITS.readMaxChars}).` },
    },
  },
  read_ref: {
    description: 'Read one element from the CURRENT observation in full: its complete text, and every option of a dropdown.',
    fields: { ref: { type: 'string', required: true, description: 'Element ref.' } },
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
    if (fspec.type === 'integer' && !Number.isSafeInteger(value)) fail(`"${field}" must be an integer`, 'invalid_field', input);
    out[field] = value;
  }

  switch (name) {
    case 'navigate':
      out.url = validateUrl(out.url);
      break;
    case 'click_ref':
    case 'type_ref':
    case 'select_option':
    case 'set_checked':
    case 'upload_file':
    case 'download_ref':
    case 'read_ref': {
      if (!REF_PATTERN.test(out.ref)) fail(`malformed ref "${String(out.ref).slice(0, 50)}"`, 'invalid_ref', input);
      if (name === 'type_ref') out.text = validateText(out.text, 'text', LIMITS.maxTextLength);
      if (name === 'select_option') {
        out.option = validateText(out.option, 'option', LIMITS.maxOptionLength);
        if (out.option.trim() === '') fail('"option" must not be empty', 'invalid_field', input);
      }
      if (name === 'upload_file' && !FILE_ID_PATTERN.test(out.file)) {
        fail(`"file" must be a file id from AVAILABLE FILES (like "file-0"), not a path`, 'invalid_file', input);
      }
      if (observation) {
        const el = findElement(observation, out.ref);
        if (!el) fail(`ref "${out.ref}" is not present in the current observation`, 'unknown_ref', input);
        if (el.disabled && name !== 'read_ref') fail(`ref "${out.ref}" is disabled`, 'disabled_element', input);
        checkTarget(name, el, out, input);
      }
      break;
    }
    case 'read_page':
      if (out.find !== undefined) {
        out.find = validateText(out.find, 'find', LIMITS.maxFindLength);
        if (out.find.trim() === '') fail('"find" must not be empty', 'invalid_field', input);
      }
      if (out.offset !== undefined && (out.offset < 0 || out.offset > LIMITS.readMaxOffset)) fail(`"offset" must be between 0 and ${LIMITS.readMaxOffset}`, 'invalid_field', input);
      if (out.maxChars !== undefined && (out.maxChars < 1 || out.maxChars > LIMITS.readMaxChars)) fail(`"maxChars" must be between 1 and ${LIMITS.readMaxChars}`, 'invalid_field', input);
      break;
    case 'done':
      out.summary = validateText(out.summary, 'summary', LIMITS.maxSummaryLength);
      if (out.success === undefined) out.success = true;
      break;
    default:
      break;
  }
  return Object.freeze(out);
}

// Each ref action only works on the element kinds it was designed for, so a
// planner cannot, say, "select" a submit button or "upload" into a text box.
function checkTarget(name, el, out, input) {
  switch (name) {
    case 'type_ref':
      if (!isTypeable(el)) fail(`ref "${out.ref}" (${el.kind}) is not a text input`, 'not_typeable', input);
      checkTemporalFormat(el, out.text, input);
      break;
    case 'select_option':
      if (el.kind !== 'select') fail(`ref "${out.ref}" (${el.kind}) is not a dropdown; select_option needs a select-N ref`, 'wrong_target', input);
      break;
    case 'set_checked':
      if (el.kind !== 'checkbox' && el.kind !== 'radio') fail(`ref "${out.ref}" (${el.kind}) is not a checkbox or radio button`, 'wrong_target', input);
      if (el.kind === 'radio' && out.checked === false) fail('a radio button cannot be unticked; select a different option in its group instead', 'wrong_target', input);
      break;
    case 'upload_file':
      if (el.kind !== 'file') fail(`ref "${out.ref}" (${el.kind}) is not a file input; upload_file needs a file-N ref`, 'wrong_target', input);
      break;
    case 'download_ref':
      if (el.kind !== 'link' && el.kind !== 'button') fail(`ref "${out.ref}" (${el.kind}) is not a link or button`, 'wrong_target', input);
      break;
    default:
      break;
  }
}

// HTML date/time inputs only accept these machine formats; a clear error here
// is better than a vague browser failure.
export const TEMPORAL_FORMATS = Object.freeze({
  date: { re: /^\d{4}-\d{2}-\d{2}$/, hint: 'YYYY-MM-DD' },
  time: { re: /^\d{2}:\d{2}(:\d{2})?$/, hint: 'HH:MM' },
  'datetime-local': { re: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, hint: 'YYYY-MM-DDTHH:MM' },
  month: { re: /^\d{4}-\d{2}$/, hint: 'YYYY-MM' },
  week: { re: /^\d{4}-W\d{2}$/, hint: 'YYYY-Www' },
});

function checkTemporalFormat(el, text, input) {
  const fmt = el.kind === 'input' ? TEMPORAL_FORMATS[(el.type || '').toLowerCase()] : null;
  if (fmt && text !== '' && !fmt.re.test(text)) {
    fail(`ref "${el.ref}" is a ${el.type} field; text must look like ${fmt.hint}`, 'invalid_text', input);
  }
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
    case 'select_option': return `select_option:${action.ref}:${action.option}`;
    case 'set_checked': return `set_checked:${action.ref}:${action.checked ? 1 : 0}`;
    case 'upload_file': return `upload_file:${action.ref}:${action.file}`;
    case 'download_ref': return `download_ref:${action.ref}`;
    case 'read_ref': return `read_ref:${action.ref}`;
    case 'read_page': return `read_page:${action.find ?? ''}:${action.offset ?? 0}:${action.maxChars ?? ''}`;
    default: return action.action;
  }
}
