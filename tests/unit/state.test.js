import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, sanitize } from '../../src/state/audit-log.js';
import { TaskState, TASK_STATUS } from '../../src/state/task-state.js';
import { withTimeout, TimeoutError } from '../../src/util/timeout.js';

test('TaskState tracks status, history and failure', () => {
  const t = new TaskState('do it');
  t.record({ action: { action: 'observe' } });
  t.step = 1;
  t.fail('max_steps', 'too long');
  const j = t.toJSON();
  assert.equal(j.status, TASK_STATUS.FAILED);
  assert.deepEqual(j.failure, { code: 'max_steps', message: 'too long' });
  assert.equal(j.history.length, 1);
  assert.equal(j.summary, 'too long');
});

test('audit log redacts sensitive typed text and trims observations', () => {
  const e = sanitize({
    action: { action: 'type_ref', ref: 'input-0', text: 'hunter2' },
    sensitive: true,
    observation: { url: 'u', title: 't', text: 'big', elements: [1, 2, 3] },
  });
  assert.equal(e.action.text, '[redacted 7 chars]');
  assert.equal(e.sensitive, undefined);
  assert.deepEqual(e.observation, { url: 'u', title: 't', elements: 3 });
  assert.equal(sanitize({ action: { action: 'type_ref', ref: 'input-0', text: 'shoes' } }).action.text, 'shoes');
});

test('audit log writes JSONL to disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dalexio-audit-'));
  try {
    const log = new AuditLog({ dir, taskId: 'abc' });
    await log.write('one', { a: 1 });
    await log.write('two', { action: { action: 'type_ref', ref: 'input-0', text: 'secret' }, sensitive: true });
    const lines = (await readFile(path.join(dir, 'abc.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.type), ['one', 'two']);
    assert.ok(!JSON.stringify(lines).includes('secret'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('withTimeout resolves fast promises and rejects slow ones', async () => {
  assert.equal(await withTimeout(Promise.resolve(5), 100), 5);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, 'slow thing'), (e) => e instanceof TimeoutError && /slow thing/.test(e.message));
});
