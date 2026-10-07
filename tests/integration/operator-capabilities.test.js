import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Operator, FAILURE } from '../../src/operator/operator.js';
import { ScriptedPlanner } from '../../src/agents/mock-planner.js';
import { BrowserController } from '../../src/browser/controller.js';
import { ApprovalGate, approveAmberOnly } from '../../src/safety/approval-gate.js';
import { renderContext } from '../../src/agents/prompt.js';
import { startFixtureServer } from '../helpers/fixture-server.js';

let server;
let root;
before(async () => {
  server = await startFixtureServer();
  root = await mkdtemp(path.join(os.tmpdir(), 'dalexio-opcap-'));
});
after(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

const ref = (label) => ({ observation }) => observation.elements.find((e) => e.label.includes(label))?.ref ?? 'button-999';

function makeOperator(planner, { start, browserOptions, ...opts } = {}) {
  // Everything stays under the temp root: never the repository's .dalexio/.
  return new Operator({
    planner,
    auditDir: null,
    managedUploadDirs: null,
    ...opts,
    startUrl: server.url(start ?? '/controls.html'),
    browserOptions: { ...browserOptions, stateRoot: root },
  });
}

test('compose flow: attach, caption and publish are separate steps, each classified on its own', async () => {
  const media = path.join(root, 'drop.png');
  await writeFile(media, 'png');
  const asked = [];
  const gate = new ApprovalGate({ approver: async (req) => { asked.push({ level: req.level, op: req.summary.operation }); return true; } });
  const planner = new ScriptedPlanner([
    (ctx) => {
      assert.deepEqual(ctx.files, [{ id: 'file-0', name: 'drop.png', bytes: 3, source: 'user' }]);
      assert.match(renderContext(ctx), /AVAILABLE FILES/);
      return { action: 'upload_file', ref: ref('Media')(ctx), file: 'file-0' };
    },
    (ctx) => ({ action: 'select_option', ref: ref('Account')(ctx), option: 'AI Carty' }),
    (ctx) => ({ action: 'type_ref', ref: ref('Caption')(ctx), text: 'Fresh beans' }),
    (ctx) => ({ action: 'click_ref', ref: ctx.observation.elements.find((e) => e.label === 'Publish').ref }),
    { action: 'done', summary: 'published' },
  ]);
  const task = await makeOperator(planner, { gate, files: [media] }).run('publish the post');
  assert.equal(task.status, 'succeeded', JSON.stringify(task.failure ?? task.history));
  assert.deepEqual(task.history.map((h) => h.risk), ['AMBER', 'GREEN', 'GREEN', 'AMBER', undefined]);
  assert.deepEqual(asked.map((a) => a.level), ['AMBER', 'AMBER'], 'only the upload and the publish click needed approval');
  assert.match(asked[0].op, /Attach "drop.png".*does not submit/);
  assert.match(asked[1].op, /Click button "Publish"/);
  assert.match(task.history[0].outcome, /attached "drop.png".*not submitted/);
  assert.equal(task.history[3].urlAfter, server.url('/upload'));
});

test('a denied upload attaches nothing', async () => {
  const media = path.join(root, 'nope.png');
  await writeFile(media, 'png');
  let seenFiles;
  const planner = new ScriptedPlanner([
    (ctx) => ({ action: 'upload_file', ref: ref('Media')(ctx), file: 'file-0' }),
    (ctx) => { seenFiles = ctx.observation.elements.find((e) => e.label === 'Media').files; return { action: 'done', summary: 'gave up' }; },
  ]);
  const task = await makeOperator(planner, { files: [media] }).run('upload');
  assert.match(task.history[0].error, /approval_denied: AMBER/);
  assert.equal(seenFiles, undefined);
});

test('a disallowed --allow-file fails the task before the browser starts', async () => {
  const env = path.join(root, '.env');
  await writeFile(env, 'SECRET=1');
  const op = makeOperator(new ScriptedPlanner([{ action: 'done', summary: 'x' }]), { files: [env] });
  const task = await op.run('upload my env');
  assert.equal(task.failure.code, FAILURE.INVALID_FILE);
  assert.match(task.failure.message, /credential or secret/);
  assert.equal(op.controller.isLaunched, false);
  const missing = await makeOperator(new ScriptedPlanner([]), { files: [path.join(root, 'missing.png')] }).run('x');
  assert.equal(missing.failure.code, FAILURE.INVALID_FILE);
});

test('read_page results reach the planner inside an untrusted block and support answering questions', async () => {
  let rendered;
  const planner = new ScriptedPlanner([
    { action: 'read_page', find: 'Capital' },
    (ctx) => {
      rendered = renderContext(ctx);
      const text = ctx.reading.passages[0].text;
      const capital = /Capital and largest city (\w+)/.exec(text)[1];
      return { action: 'done', summary: `Capital: ${capital}` };
    },
  ]);
  const task = await makeOperator(planner, { start: '/article.html' }).run('What is the capital of Zimbabwe?');
  assert.equal(task.summary, 'Capital: Harare');
  assert.equal(task.history[0].risk, 'GREEN');
  assert.match(task.history[0].outcome, /1 match\(es\) for "Capital"/);
  assert.match(rendered, /<untrusted_page_content source="read_page">\nREAD PAGE: Zimbabwe/);
});

test('reading the same thing over and over is stopped by the loop guard', async () => {
  const planner = new ScriptedPlanner([{ action: 'read_page' }], { repeatLast: true });
  const task = await makeOperator(planner, { start: '/article.html' }).run('read forever');
  assert.equal(task.failure.code, 'repeated_action');
});

test('an approval is invalidated when the target changes while the human is deciding', async () => {
  const controller = new BrowserController({ stateRoot: root });
  await controller.launch();
  try {
    const gate = new ApprovalGate({
      approver: async () => {
        // While "the human" reads the prompt, the page swaps the button text.
        await controller.page.evaluate(() => window.swap());
        return true;
      },
    });
    const planner = new ScriptedPlanner([(ctx) => ({ action: 'click_ref', ref: ref('Save draft')(ctx) }), { action: 'done', summary: 'stopped' }]);
    const op = new Operator({ planner, controller, gate, auditDir: null, startUrl: server.url('/swap.html') });
    const task = await op.run('save the draft');
    assert.match(task.history[0].error, /approval_invalidated: target button-0 changed after approval \(was "Save draft", now "Delete account"\)/);
    assert.equal(await controller.readText('#s'), 'idle', 'the swapped button was never clicked');
  } finally {
    await controller.close();
  }
});

test('the planner sees a security note on pages that try to instruct the agent', async () => {
  let rendered;
  const planner = new ScriptedPlanner([(ctx) => { rendered = renderContext(ctx); return { action: 'done', summary: 'ok' }; }]);
  await makeOperator(planner, { start: '/injection.html' }).run('Find the banana bread recipe');
  assert.match(rendered, /SECURITY NOTE/);
  assert.equal((rendered.match(/<\/untrusted_page_content>/g) ?? []).length, 1);
});

test('downloads and uploads are audited without absolute paths or file contents', async () => {
  const auditDir = path.join(root, 'runs');
  const media = path.join(root, 'audit.png');
  await writeFile(media, 'png');
  const planner = new ScriptedPlanner([
    (ctx) => ({ action: 'download_ref', ref: ref('Download report')(ctx) }),
    (ctx) => ({ action: 'upload_file', ref: ref('Media')(ctx), file: 'file-1' }),
    { action: 'done', summary: 'ok' },
  ]);
  const task = await makeOperator(planner, { auditDir, files: [media], gate: new ApprovalGate({ approver: approveAmberOnly }), browserOptions: { profile: 'auditor' } }).run('download then upload it');
  assert.equal(task.status, 'succeeded', JSON.stringify(task.history));
  assert.match(task.history[0].outcome, /downloaded "report.csv" \(text\/csv, 27 bytes\).*available as file-1/);
  assert.match(task.history[1].outcome, /attached "report.csv"/, 'a downloaded file can be re-uploaded');
  const log = await readFile(path.join(auditDir, `${task.id}.jsonl`), 'utf8');
  const events = log.trim().split('\n').map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  for (const t of ['files_available', 'file_downloaded', 'approval_requested', 'file_uploaded']) assert.ok(types.includes(t), t);
  assert.equal(events[0].profile, 'auditor');
  const dl = events.find((e) => e.type === 'file_downloaded').download;
  assert.deepEqual(Object.keys(dl).sort(), ['bytes', 'dir', 'fileId', 'filename', 'mimeType', 'path', 'sha256', 'sourceUrl', 'suggestedFilename']);
  assert.ok(!log.includes(root), 'no absolute local paths in the audit log');
  assert.ok(!log.includes('mixed-beanz,12'), 'no file contents in the audit log');
});
