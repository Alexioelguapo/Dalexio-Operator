import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController } from '../../src/browser/controller.js';
import { BrowserExecutor } from '../../src/browser/executor.js';
import { ActionValidationError } from '../../src/actions/schema.js';
import { TimeoutError } from '../../src/util/timeout.js';
import { startFixtureServer } from '../helpers/fixture-server.js';

let server;
let controller;
let executor;

before(async () => {
  server = await startFixtureServer();
  controller = new BrowserController({ screenshotDir: '.dalexio/test-screenshots' });
  await controller.launch();
  executor = new BrowserExecutor(controller);
});

after(async () => {
  await controller?.close();
  await server?.close();
});

const rejectsWith = (promise, code) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof ActionValidationError, `expected validation error, got ${e}`);
  assert.equal(e.code, code);
  return true;
});

test('the executor exposes every original operation', () => {
  for (const name of ['navigate', 'observe', 'click_ref', 'type_ref', 'read', 'click', 'type', 'screenshot', 'state']) {
    assert.equal(typeof executor[name], 'function', name);
  }
});

test('executes the full planner action set', async () => {
  const nav = await executor.execute({ action: 'navigate', url: server.url('/portal.html') });
  assert.equal(nav.result.status, 200);
  const { result: { observation } } = await executor.execute({ action: 'observe' });
  assert.equal(observation.title, 'Wikipedia');
  await executor.execute({ action: 'type_ref', ref: 'input-0', text: 'kiwi' });
  const shot = await executor.execute({ action: 'screenshot' });
  assert.match(shot.result.path, /\.png$/);
  const click = await executor.execute({ action: 'click_ref', ref: 'link-0' });
  assert.equal(click.result.url, server.url('/en.html'));
  const done = await executor.execute({ action: 'done', summary: 'ok' });
  assert.deepEqual(done.result, { done: true, success: true, summary: 'ok' });
  assert.equal((await executor.state()).title, 'Wikipedia, the free encyclopedia');
  assert.match(await executor.read('h1'), /Welcome/);
});

test('6. validates before executing: malformed actions never reach the browser', async () => {
  await executor.navigate(server.url('/portal.html'));
  await executor.observe();
  const before = await executor.state();
  await rejectsWith(executor.execute({ action: 'shell', command: 'ls' }), 'forbidden_action');
  await rejectsWith(executor.execute({ action: 'evaluate', script: 'document.body.remove()' }), 'forbidden_action');
  await rejectsWith(executor.execute({ action: 'teleport' }), 'unknown_action');
  await rejectsWith(executor.execute({ action: 'navigate', url: 'javascript:alert(1)' }), 'invalid_url');
  await rejectsWith(executor.execute({ action: 'navigate', url: 'file:///etc/passwd' }), 'invalid_url');
  await rejectsWith(executor.execute({ action: 'click_ref' }), 'missing_ref');
  await rejectsWith(executor.execute({ action: 'type_ref', ref: 'input-0', text: 'x\u0007' }), 'invalid_text');
  await rejectsWith(executor.execute({ action: 'type_ref', ref: 'link-0', text: 'x' }), 'not_typeable');
  assert.deepEqual(await executor.state(), before, 'page unchanged by rejected actions');
});

test('7. rejects refs that are not in the current observation', async () => {
  await executor.navigate(server.url('/portal.html'));
  await executor.observe();
  await rejectsWith(executor.execute({ action: 'click_ref', ref: 'link-42' }), 'unknown_ref');
  await rejectsWith(executor.execute({ action: 'click_ref', ref: 'button-99' }), 'unknown_ref');
});

test('ref actions require an observation; navigation invalidates the old one', async () => {
  await executor.navigate(server.url('/portal.html'));
  await rejectsWith(executor.execute({ action: 'click_ref', ref: 'link-0' }), 'no_observation');
  await executor.observe();
  await executor.click_ref('link-0');
  await rejectsWith(executor.execute({ action: 'click_ref', ref: 'link-0' }), 'no_observation');
});

test('enforces a per-action timeout', async () => {
  await assert.rejects(
    executor.execute({ action: 'navigate', url: server.url('/slow') }, { timeoutMs: 300 }),
    (e) => e instanceof TimeoutError && /action navigate timed out/.test(e.message),
  );
});
