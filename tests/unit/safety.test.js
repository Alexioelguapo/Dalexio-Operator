import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction, RISK } from '../../src/safety/policy.js';
import { ApprovalGate, denyAll, approveAmberOnly } from '../../src/safety/approval-gate.js';
import { validateAction } from '../../src/actions/schema.js';

const obs = {
  url: 'https://shop.example/',
  forms: [
    { id: 'form-0', method: 'get', action: 'https://shop.example/search', isSearch: true, hasPassword: false, hasPayment: false },
    { id: 'form-1', method: 'post', action: 'https://shop.example/contact', isSearch: false, hasPassword: false, hasPayment: false },
    { id: 'form-2', method: 'post', action: 'https://shop.example/login', isSearch: false, hasPassword: true, hasPayment: false },
    { id: 'form-3', method: 'post', action: 'https://shop.example/pay', isSearch: false, hasPayment: true, hasPassword: false },
  ],
  elements: [
    { ref: 'link-0', kind: 'link', label: 'About us', href: 'https://shop.example/about' },
    { ref: 'link-1', kind: 'link', label: 'Buy now', href: 'https://shop.example/buy' },
    { ref: 'link-2', kind: 'link', label: 'Payment (article)', href: 'https://en.wikipedia.org/wiki/Payment' },
    { ref: 'link-3', kind: 'link', label: 'Do it', href: 'javascript:' },
    { ref: 'input-0', kind: 'input', type: 'search', label: 'Search', form: 'form-0' },
    { ref: 'button-0', kind: 'button', type: 'submit', label: 'Search', form: 'form-0' },
    { ref: 'input-1', kind: 'input', type: 'text', label: 'Name', form: 'form-1' },
    { ref: 'button-1', kind: 'button', type: 'submit', label: 'Send message', form: 'form-1' },
    { ref: 'input-2', kind: 'input', type: 'password', label: 'Password', sensitive: 'password', form: 'form-2' },
    { ref: 'button-2', kind: 'button', type: 'submit', label: 'Continue', form: 'form-2' },
    { ref: 'input-3', kind: 'input', type: 'text', label: 'Card number', sensitive: 'payment', form: 'form-3' },
    { ref: 'button-3', kind: 'button', type: 'submit', label: 'Continue', form: 'form-3' },
    { ref: 'button-4', kind: 'button', type: 'button', label: 'Delete account' },
    { ref: 'button-5', kind: 'button', type: 'button', label: 'Change password' },
    { ref: 'button-6', kind: 'button', type: 'button', label: 'Publish post' },
    { ref: 'button-7', kind: 'button', type: 'button', label: 'Place order' },
    { ref: 'button-8', kind: 'button', type: 'button', label: 'Transfer funds' },
    { ref: 'button-9', kind: 'button', type: 'button', label: 'Submit tender' },
    { ref: 'button-10', kind: 'button', type: 'button', label: 'Show more' },
    { ref: 'button-11', kind: 'button', type: 'button', label: 'Upload file' },
    { ref: 'button-12', kind: 'button', type: 'button', label: 'Account settings' },
  ],
};

const level = (raw) => classifyAction(validateAction(raw, { observation: obs }), obs).level;

test('GREEN: navigation, observation, screenshots, ordinary links, searches, plain typing', () => {
  assert.equal(level({ action: 'navigate', url: 'https://example.com' }), RISK.GREEN);
  assert.equal(level({ action: 'observe' }), RISK.GREEN);
  assert.equal(level({ action: 'screenshot' }), RISK.GREEN);
  assert.equal(level({ action: 'click_ref', ref: 'link-0' }), RISK.GREEN);
  assert.equal(level({ action: 'click_ref', ref: 'link-2' }), RISK.GREEN, 'an article about payments is just a link');
  assert.equal(level({ action: 'type_ref', ref: 'input-0', text: 'shoes', submit: true }), RISK.GREEN, 'search submit');
  assert.equal(level({ action: 'click_ref', ref: 'button-0' }), RISK.GREEN, 'search button');
  assert.equal(level({ action: 'type_ref', ref: 'input-1', text: 'Ada' }), RISK.GREEN);
  assert.equal(level({ action: 'click_ref', ref: 'button-10' }), RISK.GREEN);
});

test('AMBER: form submission, messages, publishing, uploads, settings, credentials entry', () => {
  assert.equal(level({ action: 'click_ref', ref: 'button-1' }), RISK.AMBER);
  assert.equal(level({ action: 'type_ref', ref: 'input-1', text: 'Ada', submit: true }), RISK.AMBER);
  assert.equal(level({ action: 'click_ref', ref: 'button-6' }), RISK.AMBER);
  assert.equal(level({ action: 'click_ref', ref: 'button-11' }), RISK.AMBER);
  assert.equal(level({ action: 'click_ref', ref: 'button-12' }), RISK.AMBER);
  assert.equal(level({ action: 'type_ref', ref: 'input-2', text: 'hunter2' }), RISK.AMBER);
  assert.equal(level({ action: 'click_ref', ref: 'button-2' }), RISK.AMBER, 'login submit');
  assert.equal(level({ action: 'click_ref', ref: 'link-3' }), RISK.AMBER, 'javascript: link');
});

test('RED: payment, purchase, transfer, tender, deletion, credential change', () => {
  assert.equal(level({ action: 'click_ref', ref: 'link-1' }), RISK.RED);
  assert.equal(level({ action: 'type_ref', ref: 'input-3', text: '4111111111111111' }), RISK.RED);
  assert.equal(level({ action: 'click_ref', ref: 'button-3' }), RISK.RED, 'submits payment form');
  assert.equal(level({ action: 'click_ref', ref: 'button-4' }), RISK.RED);
  assert.equal(level({ action: 'click_ref', ref: 'button-5' }), RISK.RED);
  assert.equal(level({ action: 'click_ref', ref: 'button-7' }), RISK.RED);
  assert.equal(level({ action: 'click_ref', ref: 'button-8' }), RISK.RED);
  assert.equal(level({ action: 'click_ref', ref: 'button-9' }), RISK.RED);
});

test('reasons explain non-GREEN classifications', () => {
  const r = classifyAction({ action: 'click_ref', ref: 'button-4' }, obs);
  assert.equal(r.level, RISK.RED);
  assert.match(r.reasons.join(' '), /destructive/);
});

test('unknown/future action types are not GREEN', () => {
  assert.equal(classifyAction({ action: 'upload_file' }, obs).level, RISK.AMBER);
  assert.equal(classifyAction({ action: 'purchase' }, obs).level, RISK.RED);
  assert.equal(classifyAction({ action: 'something_new' }, obs).level, RISK.RED);
});

test('policy redHosts escalates navigation', () => {
  const r = classifyAction({ action: 'navigate', url: 'https://online.mybank.com/' }, obs, { redHosts: ['mybank.com'] });
  assert.equal(r.level, RISK.RED);
});

test('ApprovalGate: GREEN auto, AMBER/RED denied by default', async () => {
  const gate = new ApprovalGate();
  assert.equal((await gate.check({ level: RISK.GREEN, action: {} })).approved, true);
  assert.equal((await gate.check({ level: RISK.AMBER, action: {} })).approved, false);
  assert.equal((await gate.check({ level: RISK.RED, action: {} })).approved, false);
});

test('ApprovalGate: approveAmberOnly never approves RED', async () => {
  const gate = new ApprovalGate({ approver: approveAmberOnly });
  assert.equal((await gate.check({ level: RISK.AMBER, action: {} })).approved, true);
  assert.equal((await gate.check({ level: RISK.RED, action: {} })).approved, false);
});

test('ApprovalGate: RED uses its own approver and is asked every time', async () => {
  const calls = [];
  const gate = new ApprovalGate({ approver: async () => true, redApprover: async (req) => { calls.push(req.level); return { approved: true }; } });
  await gate.check({ level: RISK.RED, action: { action: 'click_ref', ref: 'button-4' } });
  await gate.check({ level: RISK.RED, action: { action: 'click_ref', ref: 'button-4' } });
  assert.deepEqual(calls, ['RED', 'RED']);
});

test('ApprovalGate: anything but an explicit true is a denial; approver errors deny', async () => {
  for (const answer of [undefined, null, 'yes', 1, { approved: 'true' }]) {
    const gate = new ApprovalGate({ approver: async () => answer });
    assert.equal((await gate.check({ level: RISK.AMBER, action: {} })).approved, false, String(answer));
  }
  const boom = new ApprovalGate({ approver: async () => { throw new Error('ui crashed'); } });
  const d = await boom.check({ level: RISK.AMBER, action: {} });
  assert.equal(d.approved, false);
  assert.match(d.note, /ui crashed/);
  assert.equal((await new ApprovalGate({ approver: denyAll }).check({ level: RISK.AMBER, action: {} })).approved, false);
});
