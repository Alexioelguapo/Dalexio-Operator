import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAction, ActionValidationError, actionSignature, ACTIONS, FORBIDDEN_ACTIONS } from '../../src/actions/schema.js';
import { classifyAction, RISK } from '../../src/safety/policy.js';
import { sliceReading } from '../../src/browser/reading.js';
import { redactSecrets, redactObservation } from '../../src/safety/redact.js';

const obs = {
  url: 'https://studio.example/compose',
  forms: [{ id: 'form-0', method: 'post', action: 'https://studio.example/post', isSearch: false, hasPassword: false, hasPayment: false }],
  elements: [
    { ref: 'select-0', kind: 'select', label: 'Account', options: ['Mixed Beanz', 'AI Carty'], form: 'form-0' },
    { ref: 'select-1', kind: 'select', label: 'Expiry month', sensitive: 'payment' },
    { ref: 'select-2', kind: 'select', label: 'Action', options: ['Keep', 'Delete all posts'] },
    { ref: 'checkbox-0', kind: 'checkbox', label: 'Notify followers', form: 'form-0' },
    { ref: 'checkbox-1', kind: 'checkbox', label: 'I agree to the terms of service' },
    { ref: 'checkbox-2', kind: 'checkbox', label: 'Delete my archive too' },
    { ref: 'radio-0', kind: 'radio', label: 'Public' },
    { ref: 'file-0', kind: 'file', type: 'file', label: 'Media', hidden: true, form: 'form-0' },
    { ref: 'input-0', kind: 'input', type: 'date', label: 'Publish date' },
    { ref: 'input-1', kind: 'input', type: 'time', label: 'Publish time' },
    { ref: 'input-2', kind: 'input', type: 'text', label: 'Title' },
    { ref: 'textarea-0', kind: 'textarea', label: 'Caption', form: 'form-0' },
    { ref: 'button-0', kind: 'button', type: 'button', label: 'Preview' },
    { ref: 'button-1', kind: 'button', type: 'submit', label: 'Publish', form: 'form-0' },
    { ref: 'button-2', kind: 'button', type: 'button', label: 'Schedule post' },
    { ref: 'button-3', kind: 'button', type: 'button', label: 'Export and delete account' },
    { ref: 'link-0', kind: 'link', label: 'Download report', href: 'https://studio.example/report.csv' },
    { ref: 'link-1', kind: 'link', label: 'Disabled', href: 'https://studio.example/x', disabled: true },
  ],
};

function rejects(action, code, opts = { observation: obs }) {
  assert.throws(() => validateAction(action, opts), (err) => {
    assert.ok(err instanceof ActionValidationError, `expected ActionValidationError, got ${err}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}
const level = (raw, policy) => classifyAction(validateAction(raw, { observation: obs }), obs, policy).level;

test('new actions are part of the contract', () => {
  for (const a of ['select_option', 'set_checked', 'upload_file', 'download_ref', 'read_page', 'read_ref']) assert.ok(ACTIONS.includes(a), a);
});

test('select_option: needs a select ref and a non-empty option', () => {
  assert.equal(validateAction({ action: 'select_option', ref: 'select-0', option: 'AI Carty' }, { observation: obs }).option, 'AI Carty');
  rejects({ action: 'select_option', ref: 'checkbox-0', option: 'x' }, 'wrong_target');
  rejects({ action: 'select_option', ref: 'button-1', option: 'x' }, 'wrong_target');
  rejects({ action: 'select_option', ref: 'select-0', option: '  ' }, 'invalid_field');
  rejects({ action: 'select_option', ref: 'select-0' }, 'missing_field');
  rejects({ action: 'select_option', ref: 'select-0', option: 'x', submit: true }, 'unexpected_field');
});

test('set_checked: checkbox or radio only; radios cannot be unticked', () => {
  assert.equal(validateAction({ action: 'set_checked', ref: 'checkbox-0', checked: false }, { observation: obs }).checked, false);
  assert.equal(validateAction({ action: 'set_checked', ref: 'radio-0', checked: true }, { observation: obs }).checked, true);
  rejects({ action: 'set_checked', ref: 'radio-0', checked: false }, 'wrong_target');
  rejects({ action: 'set_checked', ref: 'button-1', checked: true }, 'wrong_target');
  rejects({ action: 'set_checked', ref: 'checkbox-0', checked: 'yes' }, 'invalid_field');
});

test('upload_file: file input ref plus a registry id, never a path', () => {
  assert.equal(validateAction({ action: 'upload_file', ref: 'file-0', file: 'file-3' }, { observation: obs }).file, 'file-3');
  for (const file of ['/etc/passwd', '../secret.txt', '~/.ssh/id_rsa', 'C:\\x.txt', 'photo.jpg', 'file-0; rm -rf /']) {
    rejects({ action: 'upload_file', ref: 'file-0', file }, 'invalid_file');
  }
  rejects({ action: 'upload_file', ref: 'input-2', file: 'file-0' }, 'wrong_target');
  rejects({ action: 'upload_file', ref: 'file-0', file: 'file-0', path: '/tmp/x' }, 'unexpected_field');
});

test('download_ref: link or button only, not disabled', () => {
  assert.equal(validateAction({ action: 'download_ref', ref: 'link-0' }, { observation: obs }).ref, 'link-0');
  rejects({ action: 'download_ref', ref: 'input-2' }, 'wrong_target');
  rejects({ action: 'download_ref', ref: 'link-1' }, 'disabled_element');
  rejects({ action: 'download_ref', ref: 'link-0', url: 'https://evil.example/x' }, 'unexpected_field');
  rejects({ action: 'download', url: 'https://evil.example/x' }, 'forbidden_action');
});

test('read_page: bounded integer parameters and optional find', () => {
  assert.deepEqual(validateAction({ action: 'read_page' }), { action: 'read_page' });
  assert.equal(validateAction({ action: 'read_page', offset: 4000, maxChars: 8000 }).offset, 4000);
  assert.equal(validateAction({ action: 'read_page', find: 'capital' }).find, 'capital');
  rejects({ action: 'read_page', maxChars: 8001 }, 'invalid_field', {});
  rejects({ action: 'read_page', maxChars: 0 }, 'invalid_field', {});
  rejects({ action: 'read_page', offset: -1 }, 'invalid_field', {});
  rejects({ action: 'read_page', offset: 1.5 }, 'invalid_field', {});
  rejects({ action: 'read_page', find: '' }, 'invalid_field', {});
  rejects({ action: 'read_page', find: 'x'.repeat(101) }, 'invalid_text', {});
  rejects({ action: 'read_page', selector: 'body' }, 'unexpected_field', {});
  rejects({ action: 'read_page', script: 'document.cookie' }, 'unexpected_field', {});
});

test('read_ref: any element in the observation, even disabled', () => {
  assert.equal(validateAction({ action: 'read_ref', ref: 'link-1' }, { observation: obs }).ref, 'link-1');
  rejects({ action: 'read_ref', ref: 'link-99' }, 'unknown_ref');
  rejects({ action: 'read_ref', ref: 'body' }, 'invalid_ref');
});

test('type_ref: date and time fields require machine formats', () => {
  assert.equal(validateAction({ action: 'type_ref', ref: 'input-0', text: '2026-12-01' }, { observation: obs }).text, '2026-12-01');
  assert.equal(validateAction({ action: 'type_ref', ref: 'input-1', text: '09:30' }, { observation: obs }).text, '09:30');
  assert.equal(validateAction({ action: 'type_ref', ref: 'input-0', text: '' }, { observation: obs }).text, '', 'clearing is allowed');
  rejects({ action: 'type_ref', ref: 'input-0', text: '01/12/2026' }, 'invalid_text');
  rejects({ action: 'type_ref', ref: 'input-1', text: '9.30am' }, 'invalid_text');
  rejects({ action: 'type_ref', ref: 'file-0', text: '/etc/passwd' }, 'not_typeable');
});

test('actionSignature distinguishes the new actions by target and payload', () => {
  const sig = (a) => actionSignature(validateAction(a, { observation: obs }));
  assert.notEqual(sig({ action: 'select_option', ref: 'select-0', option: 'A' }), sig({ action: 'select_option', ref: 'select-0', option: 'B' }));
  assert.notEqual(sig({ action: 'read_page', offset: 0 }), sig({ action: 'read_page', offset: 4000 }));
  assert.notEqual(sig({ action: 'read_page', find: 'a' }), sig({ action: 'read_page', find: 'b' }));
  assert.notEqual(sig({ action: 'set_checked', ref: 'checkbox-0', checked: true }), sig({ action: 'set_checked', ref: 'checkbox-0', checked: false }));
});

test('policy: reading, choosing, ticking and downloading are GREEN', () => {
  assert.equal(level({ action: 'read_page' }), RISK.GREEN);
  assert.equal(level({ action: 'read_ref', ref: 'button-3' }), RISK.GREEN, 'reading a scary button is harmless');
  assert.equal(level({ action: 'select_option', ref: 'select-0', option: 'AI Carty' }), RISK.GREEN, 'choosing an account');
  assert.equal(level({ action: 'set_checked', ref: 'checkbox-0', checked: true }), RISK.GREEN);
  assert.equal(level({ action: 'type_ref', ref: 'textarea-0', text: 'New drop!' }), RISK.GREEN, 'filling a caption');
  assert.equal(level({ action: 'type_ref', ref: 'input-0', text: '2026-12-01' }), RISK.GREEN, 'choosing a date');
  assert.equal(level({ action: 'click_ref', ref: 'button-0' }), RISK.GREEN, 'preview');
  assert.equal(level({ action: 'download_ref', ref: 'link-0' }), RISK.GREEN);
});

test('policy: upload, publish, schedule and consent are at least AMBER', () => {
  assert.equal(level({ action: 'upload_file', ref: 'file-0', file: 'file-0' }), RISK.AMBER);
  assert.equal(level({ action: 'click_ref', ref: 'button-1' }), RISK.AMBER, 'publish submits the form');
  assert.equal(level({ action: 'click_ref', ref: 'button-2' }), RISK.AMBER, 'schedule post');
  assert.equal(level({ action: 'type_ref', ref: 'textarea-0', text: 'x', submit: true }), RISK.AMBER, 'Enter in a non-search form');
  assert.equal(level({ action: 'set_checked', ref: 'checkbox-1', checked: true }), RISK.AMBER, 'accepting terms');
  assert.equal(level({ action: 'click_ref', ref: 'checkbox-1' }), RISK.AMBER, 'clicking the consent box is the same as ticking it');
  assert.equal(level({ action: 'set_checked', ref: 'checkbox-2', checked: true }), RISK.AMBER, 'destructive label on a toggle');
  assert.equal(level({ action: 'select_option', ref: 'select-2', option: 'Delete all posts' }), RISK.AMBER, 'destructive option');
});

test('policy: payment selects and destructive download triggers are RED', () => {
  assert.equal(level({ action: 'select_option', ref: 'select-1', option: '04' }), RISK.RED);
  assert.equal(level({ action: 'download_ref', ref: 'button-3' }), RISK.RED, 'a download cannot launder a destructive click');
});

test('policy rules from adapters can raise risk but never lower it; failures fail closed', () => {
  const raiseToRed = ({ action, element }) => (action.action === 'click_ref' && /preview/i.test(element?.label) ? { level: 'RED', why: 'adapter: preview publishes on this platform' } : null);
  assert.equal(level({ action: 'click_ref', ref: 'button-0' }, { rules: [raiseToRed] }), RISK.RED);
  const tryLower = () => ({ level: 'GREEN', why: 'trust me' });
  assert.equal(level({ action: 'click_ref', ref: 'button-1' }, { rules: [tryLower] }), RISK.AMBER);
  const bogus = () => ({ level: 'PURPLE' });
  assert.equal(level({ action: 'read_page' }, { rules: [bogus] }), RISK.RED, 'unknown level → RED');
  const broken = () => { throw new Error('boom'); };
  const r = classifyAction({ action: 'read_page' }, obs, { rules: [broken] });
  assert.equal(r.level, RISK.RED);
  assert.match(r.reasons.join(), /policy rule failed: boom/);
});

const page = { url: 'https://x/', title: 'T', scope: 'main', headings: ['# T', '## A'], text: `${'a'.repeat(5000)}Capital: Harare.${'b'.repeat(5000)}Capital again`, totalChars: 10029 };

test('sliceReading: chunked reads are bounded and report where to continue', () => {
  const r = sliceReading(page, {});
  assert.equal(r.chars, 4000);
  assert.equal(r.nextOffset, 4000);
  assert.deepEqual(r.headings, ['# T', '## A']);
  const r2 = sliceReading(page, { offset: 8000, maxChars: 8000 });
  assert.equal(r2.chars, page.text.length - 8000);
  assert.equal(r2.nextOffset, null);
  assert.equal(r2.headings, undefined, 'outline only on the first chunk');
  assert.equal(sliceReading(page, { maxChars: 999_999 }).chars, 8000, 'hard cap even if called directly');
});

test('sliceReading: find returns bounded passages around matches', () => {
  const r = sliceReading(page, { find: 'CAPITAL' });
  assert.equal(r.matches, 2);
  assert.equal(r.passages.length, 2);
  assert.match(r.passages[0].text, /Capital: Harare/);
  assert.ok(r.chars <= 4000);
  assert.equal(sliceReading(page, { find: 'zzz' }).matches, 0);
  const many = { ...page, text: 'hit '.repeat(5000) };
  const m = sliceReading(many, { find: 'hit', maxChars: 500 });
  assert.ok(m.chars <= 500 && m.passages.length <= 10);
});

test('redactSecrets hides tokens shown on pages and leaves prose alone', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const text = `Your token ${jwt} and key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_${'a'.repeat(36)} AKIAABCDEFGHIJKLMNOP; Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456`;
  const out = redactSecrets(text);
  for (const secret of [jwt, 'sk-ant-api03', 'ghp_', 'AKIAABCDEFGHIJKLMNOP', 'abcdefghijklmnopqrstuvwxyz123456']) assert.ok(!out.includes(secret), secret);
  assert.match(out, /Bearer \[redacted secret\]/);
  assert.equal(redactSecrets('The capital of Zimbabwe is Harare.'), 'The capital of Zimbabwe is Harare.');
  const o = redactObservation({ title: 't', text: `x ${jwt}`, headings: [], elements: [{ ref: 'input-0', label: 'k', value: `sk-live_${'z'.repeat(30)}` }] });
  assert.ok(!o.text.includes(jwt) && !o.elements[0].value.includes('zzzz'));
});

test('security regression: the action set still has no escape hatch', () => {
  for (const name of ['evaluate', 'eval', 'javascript', 'shell', 'exec', 'run_script', 'read_file', 'write_file', 'list_files', 'open_file', 'cookies', 'storage', 'cdp']) {
    assert.ok(FORBIDDEN_ACTIONS.includes(name), name);
    rejects({ action: name }, 'forbidden_action', {});
  }
  rejects({ action: 'EVALUATE', script: '1' }, 'forbidden_action', {});
  rejects({ action: 'read_page', evaluate: '1' }, 'unexpected_field', {});
  rejects({ action: 'click_ref', ref: 'button-1', submit: true }, 'unexpected_field');
  rejects({ action: 'set_checked', ref: 'checkbox-0', checked: true, then: 'click_ref' }, 'unexpected_field');
  rejects({ action: 'upload_file', ref: 'file-0', file: 'file-0', submit: true }, 'unexpected_field');
});
