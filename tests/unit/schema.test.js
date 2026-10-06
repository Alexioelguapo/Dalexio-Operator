import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAction, validateUrl, ActionValidationError, actionSignature, LIMITS } from '../../src/actions/schema.js';

const obs = {
  url: 'https://example.com/',
  elements: [
    { ref: 'link-0', kind: 'link', label: 'English' },
    { ref: 'input-0', kind: 'input', type: 'search', label: 'Search' },
    { ref: 'textarea-0', kind: 'textarea', label: 'Message' },
    { ref: 'checkbox-0', kind: 'checkbox', label: 'Agree' },
    { ref: 'button-0', kind: 'button', label: 'Disabled', disabled: true },
  ],
};

function rejects(action, code, opts = { observation: obs }) {
  assert.throws(() => validateAction(action, opts), (err) => {
    assert.ok(err instanceof ActionValidationError, `expected ActionValidationError, got ${err}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

test('accepts every V1 action in its minimal valid form', () => {
  assert.deepEqual(validateAction({ action: 'navigate', url: 'https://example.com' }), { action: 'navigate', url: 'https://example.com/' });
  assert.equal(validateAction({ action: 'click_ref', ref: 'link-0' }, { observation: obs }).ref, 'link-0');
  assert.equal(validateAction({ action: 'type_ref', ref: 'input-0', text: 'hello', submit: true }, { observation: obs }).submit, true);
  assert.equal(validateAction({ action: 'type_ref', ref: 'textarea-0', text: 'line1\nline2' }, { observation: obs }).text, 'line1\nline2');
  assert.deepEqual(validateAction({ action: 'observe' }), { action: 'observe' });
  assert.deepEqual(validateAction({ action: 'screenshot', fullPage: true }), { action: 'screenshot', fullPage: true });
  assert.deepEqual(validateAction({ action: 'done', summary: 'ok' }), { action: 'done', summary: 'ok', success: true });
});

test('validated actions are frozen and keep an optional reason', () => {
  const a = validateAction({ action: 'observe', reason: 'look again' });
  assert.equal(a.reason, 'look again');
  assert.ok(Object.isFrozen(a));
});

test('rejects non-objects and missing action names', () => {
  rejects(null, 'invalid_action');
  rejects('navigate', 'invalid_action');
  rejects([], 'invalid_action');
  rejects({}, 'missing_action');
  rejects({ action: '' }, 'missing_action');
});

test('rejects unknown actions', () => {
  rejects({ action: 'scroll' }, 'unknown_action');
  rejects({ action: 'fly_to_moon' }, 'unknown_action');
});

test('rejects dangerous actions explicitly (no shell/script/file access)', () => {
  for (const action of ['shell', 'exec', 'eval', 'evaluate', 'run_script', 'bash', 'javascript', 'write_file', 'EXEC']) {
    rejects({ action, command: 'rm -rf /' }, 'forbidden_action');
  }
});

test('rejects unexpected fields (no smuggling extra parameters)', () => {
  rejects({ action: 'navigate', url: 'https://example.com', script: 'alert(1)' }, 'unexpected_field');
  rejects({ action: 'click_ref', ref: 'link-0', selector: '#x' }, 'unexpected_field');
});

test('rejects missing refs', () => {
  rejects({ action: 'click_ref' }, 'missing_ref');
  rejects({ action: 'type_ref', text: 'x' }, 'missing_ref');
});

test('rejects malformed refs', () => {
  rejects({ action: 'click_ref', ref: 'a[href]' }, 'invalid_ref');
  rejects({ action: 'click_ref', ref: 'link-0"] , body' }, 'invalid_ref');
  rejects({ action: 'click_ref', ref: 42 }, 'invalid_field');
});

test('rejects refs that are not in the current observation', () => {
  rejects({ action: 'click_ref', ref: 'link-99' }, 'unknown_ref');
  rejects({ action: 'type_ref', ref: 'input-7', text: 'x' }, 'unknown_ref');
});

test('rejects typing into non-text elements and disabled elements', () => {
  rejects({ action: 'type_ref', ref: 'link-0', text: 'x' }, 'not_typeable');
  rejects({ action: 'type_ref', ref: 'checkbox-0', text: 'x' }, 'not_typeable');
  rejects({ action: 'click_ref', ref: 'button-0' }, 'disabled_element');
});

test('rejects malformed and unsafe URLs', () => {
  rejects({ action: 'navigate' }, 'missing_field');
  rejects({ action: 'navigate', url: 'not a url' }, 'invalid_url');
  rejects({ action: 'navigate', url: 'javascript:alert(1)' }, 'invalid_url');
  rejects({ action: 'navigate', url: 'file:///etc/passwd' }, 'invalid_url');
  rejects({ action: 'navigate', url: 'data:text/html,<h1>x</h1>' }, 'invalid_url');
  rejects({ action: 'navigate', url: 'chrome://settings' }, 'invalid_url');
  rejects({ action: 'navigate', url: 'https://user:pass@example.com/' }, 'invalid_url');
  rejects({ action: 'navigate', url: `https://example.com/${'a'.repeat(LIMITS.maxUrlLength)}` }, 'invalid_url');
  assert.equal(validateUrl('  http://localhost:3000/x '), 'http://localhost:3000/x');
});

test('rejects invalid text payloads', () => {
  rejects({ action: 'type_ref', ref: 'input-0' }, 'missing_field');
  rejects({ action: 'type_ref', ref: 'input-0', text: 123 }, 'invalid_field');
  rejects({ action: 'type_ref', ref: 'input-0', text: 'a'.repeat(LIMITS.maxTextLength + 1) }, 'invalid_text');
  rejects({ action: 'type_ref', ref: 'input-0', text: 'bad\u0000byte' }, 'invalid_text');
  rejects({ action: 'type_ref', ref: 'input-0', text: 'esc\u001b[2J' }, 'invalid_text');
  rejects({ action: 'type_ref', ref: 'input-0', text: 'x', submit: 'yes' }, 'invalid_field');
  rejects({ action: 'done' }, 'missing_field');
});

test('without an observation, ref shape is still checked but presence is not', () => {
  assert.equal(validateAction({ action: 'click_ref', ref: 'link-5' }).ref, 'link-5');
  rejects({ action: 'click_ref', ref: 'nope' }, 'invalid_ref', {});
});

test('actionSignature distinguishes targets and payloads', () => {
  assert.notEqual(actionSignature({ action: 'click_ref', ref: 'link-0' }), actionSignature({ action: 'click_ref', ref: 'link-1' }));
  assert.notEqual(actionSignature({ action: 'type_ref', ref: 'input-0', text: 'a' }), actionSignature({ action: 'type_ref', ref: 'input-0', text: 'b' }));
  assert.equal(actionSignature({ action: 'observe', reason: 'x' }), actionSignature({ action: 'observe' }));
});
