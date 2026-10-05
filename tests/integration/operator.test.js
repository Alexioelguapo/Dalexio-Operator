import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Operator, FAILURE } from '../../src/operator/operator.js';
import { MockPlanner, ScriptedPlanner } from '../../src/agents/mock-planner.js';
import { Planner } from '../../src/agents/planner.js';
import { BrowserController } from '../../src/browser/controller.js';
import { ApprovalGate, approveAmberOnly } from '../../src/safety/approval-gate.js';
import { startFixtureServer } from '../helpers/fixture-server.js';

let server;
before(async () => { server = await startFixtureServer(); });
after(async () => { await server?.close(); });

const byLabel = (label) => ({ observation }) => {
  const el = observation.elements.find((e) => e.label.includes(label));
  return { action: 'click_ref', ref: el?.ref ?? 'button-999' };
};

function makeOperator(planner, opts = {}) {
  return new Operator({
    planner,
    auditDir: null,
    startUrl: server.url(opts.start ?? '/portal.html'),
    ...opts,
  });
}

test('10. mock planner completes the full loop: portal → English', async () => {
  const op = makeOperator(new MockPlanner());
  const task = await op.run('Open English Wikipedia');
  assert.equal(task.status, 'succeeded', JSON.stringify(task.failure));
  assert.equal(task.history[0].action.action, 'click_ref');
  assert.equal(task.history[0].action.ref, 'link-0');
  assert.deepEqual(task.history.map((h) => h.step), [0, 1], 'history is indexed by the step that produced it');
  assert.equal(task.history[0].urlAfter, server.url('/en.html'));
  assert.match(task.summary, /Wikipedia, the free encyclopedia/);
  assert.equal(op.controller.isLaunched, false, 'browser shut down after run');
});

test('mock planner can search via type_ref + submit (GREEN search)', async () => {
  const task = await makeOperator(new MockPlanner()).run('Search for octopus');
  assert.equal(task.status, 'succeeded', JSON.stringify(task.failure));
  assert.match(task.summary, /Search results for octopus/);
});

test('8. terminates at the maximum step count', async () => {
  // Alternate between two different pages so no other guard trips first.
  const planner = new ScriptedPlanner([], { name: 'pingpong' });
  planner.plan = async ({ step }) => ({ action: 'navigate', url: server.url(step % 2 ? '/de.html' : '/fr.html') });
  const task = await makeOperator(planner, { limits: { maxSteps: 3 } }).run('wander');
  assert.equal(task.status, 'failed');
  assert.equal(task.failure.code, FAILURE.MAX_STEPS);
  assert.equal(task.step, 3);
});

test('9a. refuses to repeat the same action on an unchanged page', async () => {
  const planner = new ScriptedPlanner([byLabel('Next')], { repeatLast: true });
  const task = await makeOperator(planner, { start: '/loop.html' }).run('click next forever');
  assert.equal(task.failure.code, 'repeated_action');
  assert.equal(task.history.filter((h) => !h.error).length, 2, 'ran twice, refused the third');
});

test('9b. detects a page that never changes despite different actions', async () => {
  const planner = new ScriptedPlanner([byLabel('Next'), byLabel('More'), byLabel('Continue'), byLabel('Next')]);
  const task = await makeOperator(planner, { start: '/loop.html' }).run('try everything');
  assert.equal(task.failure.code, 'stuck_page_state');
});

test('9c. detects oscillation between pages', async () => {
  const planner = new ScriptedPlanner([], { name: 'oscillate' });
  planner.plan = async ({ observation }) => byLabel(observation.title === 'Loop fixture' ? 'Portal' : 'Loop test page')({ observation });
  const task = await makeOperator(planner, { start: '/loop.html', limits: { maxStateVisits: 2, maxRepeatedActions: 10 } }).run('go back and forth');
  assert.equal(task.failure.code, 'page_state_loop');
});

test('invalid planner actions are rejected, fed back, and bounded', async () => {
  const seen = [];
  const planner = new ScriptedPlanner([
    { action: 'click_ref', ref: 'link-77' },
    (ctx) => { seen.push(ctx.history.at(-1).error); return { action: 'shell', command: 'whoami' }; },
    { action: 'navigate', url: 'ftp://example.com' },
  ]);
  const task = await makeOperator(planner).run('misbehave');
  assert.match(seen[0], /unknown_ref/);
  assert.equal(task.failure.code, FAILURE.TOO_MANY_ERRORS);
  assert.deepEqual(task.history.map((h) => h.error.split(':')[0]), ['unknown_ref', 'forbidden_action', 'invalid_url']);
});

test('a planner can recover after a rejected action', async () => {
  const planner = new ScriptedPlanner([{ action: 'click_ref', ref: 'link-77' }, { action: 'click_ref', ref: 'link-0' }, { action: 'done', summary: 'there' }]);
  const task = await makeOperator(planner).run('recover');
  assert.equal(task.status, 'succeeded');
});

test('AMBER actions are blocked without approval and run with it', async () => {
  const script = () => new ScriptedPlanner([byLabel('Send message'), { action: 'done', summary: 'sent' }]);
  const denied = await makeOperator(script(), { start: '/forms.html' }).run('send the contact form');
  assert.match(denied.history[0].error, /approval_denied: AMBER/);
  assert.equal(denied.status, 'succeeded', 'planner chose done after denial');

  const approved = await makeOperator(script(), { start: '/forms.html', gate: new ApprovalGate({ approver: approveAmberOnly }) }).run('send the contact form');
  assert.equal(approved.history[0].urlAfter.split('?')[0], server.url('/submitted.html'));
  assert.equal(approved.history[0].risk, 'AMBER');
});

test('RED actions require their own confirmation immediately before execution', async () => {
  const asked = [];
  const gate = new ApprovalGate({
    approver: approveAmberOnly,
    redApprover: async (req) => { asked.push(req.action.ref); return { approved: asked.length > 1 }; },
  });
  const planner = new ScriptedPlanner([byLabel('Delete account'), byLabel('Delete account'), { action: 'done', summary: 'x' }]);
  const op = makeOperator(planner, { start: '/forms.html', gate, limits: { maxRepeatedActions: 5 } });
  const task = await op.run('delete my account');
  assert.equal(asked.length, 2, 'asked again for the second attempt');
  assert.match(task.history[0].error, /approval_denied: RED/);
  assert.equal(task.history[1].risk, 'RED');
  assert.ok(!task.history[1].error, 'second, confirmed attempt executed');
});

test('typed secrets are redacted from history and the audit log', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dalexio-runs-'));
  try {
    const planner = new ScriptedPlanner([
      ({ observation }) => ({ action: 'type_ref', ref: observation.elements.find((e) => e.sensitive === 'password').ref, text: 'hunter2' }),
      { action: 'done', summary: 'typed' },
    ]);
    const task = await makeOperator(planner, { start: '/forms.html', auditDir: dir, gate: new ApprovalGate({ approver: approveAmberOnly }) }).run('type a password');
    assert.equal(task.status, 'succeeded');
    assert.equal(task.history[0].action.text, '[redacted 7 chars]');
    const log = await readFile(path.join(dir, `${task.id}.jsonl`), 'utf8');
    assert.ok(!log.includes('hunter2'));
    const types = log.trim().split('\n').map((l) => JSON.parse(l).type);
    assert.deepEqual([types[0], types.at(-1)], ['task_start', 'browser_closed']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('planner timeout and task timeout produce clear failures', async () => {
  class Hanging extends Planner { constructor() { super('hang'); } plan() { return new Promise(() => {}); } }
  const t1 = await makeOperator(new Hanging(), { limits: { plannerTimeoutMs: 200, maxConsecutiveErrors: 2 } }).run('hang');
  assert.equal(t1.failure.code, FAILURE.TOO_MANY_ERRORS);
  assert.match(t1.failure.message, /planner timed out/);

  const t2 = await makeOperator(new Hanging(), { limits: { taskTimeoutMs: 1500 } }).run('hang');
  assert.equal(t2.failure.code, FAILURE.TASK_TIMEOUT);
});

test('planner returning done(success=false) fails with the planner reason', async () => {
  const task = await makeOperator(new ScriptedPlanner([{ action: 'done', success: false, summary: 'login wall' }])).run('x');
  assert.deepEqual(task.failure, { code: FAILURE.OBJECTIVE_NOT_ACHIEVED, message: 'login wall' });
});

test('browser errors fail gracefully and still shut down', async () => {
  const op = makeOperator(new MockPlanner(), { startUrl: 'http://127.0.0.1:1/' });
  const task = await op.run('Open English Wikipedia');
  assert.equal(task.failure.code, FAILURE.BROWSER_FAILED);
  assert.match(task.failure.message, /navigation/);
  assert.equal(op.controller.isLaunched, false);
});

test('a caller-supplied controller is reused and left open', async () => {
  const controller = new BrowserController();
  try {
    const op = new Operator({ planner: new MockPlanner(), controller, auditDir: null, startUrl: server.url('/portal.html') });
    assert.equal((await op.run('Open English Wikipedia')).status, 'succeeded');
    assert.equal(controller.isLaunched, true);
  } finally {
    await controller.close();
  }
});
