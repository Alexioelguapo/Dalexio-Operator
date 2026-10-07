// ClaudeCodePlanner tests. The child-process boundary is always faked: either
// an injected spawn() or a stand-in `claude` script on disk. The real Claude
// Code CLI (and the user's subscription) is never invoked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodePlanner, CLAUDE_CODE_SYSTEM_PROMPT, parseClaudeCodeOutput, parseActionJson } from '../../src/agents/claude-code-planner.js';
import { ClaudePlanner } from '../../src/agents/claude-planner.js';
import { createPlanner, availablePlanners, RouterPlanner } from '../../src/agents/router.js';
import { MockPlanner } from '../../src/agents/mock-planner.js';
import { ACTIONS } from '../../src/actions/schema.js';

const observation = {
  url: 'https://www.wikipedia.org/',
  title: 'Wikipedia',
  headings: [],
  text: 'The Free Encyclopedia',
  elements: [{ ref: 'link-0', kind: 'link', label: 'English 7,000,000+ articles', href: 'https://en.wikipedia.org/' }],
  forms: [],
};
const ctx = (over = {}) => ({ objective: 'Open English Wikipedia', observation, history: [], step: 0, maxSteps: 10, ...over });

const envelope = (result, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, ...extra });

/** A fake spawn(): records the call and lets the test script the child. */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = [];
    child.kill = (signal) => { child.killed.push(signal); return true; };
    const call = { file, args, options, child, stdin: '' };
    child.stdin.on('data', (d) => { call.stdin += d; });
    calls.push(call);
    child.stdin.on('finish', () => script(child, call));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const replies = (stdout, { stderr = '', code = 0 } = {}) => fakeSpawn((child) => {
  if (stderr) child.stderr.write(stderr);
  child.stdout.end(stdout);
  child.stderr.end();
  setImmediate(() => child.emit('close', code));
});

// --- Registration --------------------------------------------------------

test('claude-code is a registered planner name, distinct from claude', () => {
  assert.ok(availablePlanners().includes('claude-code'));
  assert.ok(availablePlanners().includes('claude'));
  const p = createPlanner('claude-code');
  assert.ok(p instanceof ClaudeCodePlanner);
  assert.equal(p.name, 'claude-code');
  assert.ok(createPlanner('claude', { claude: { client: {} } }) instanceof ClaudePlanner);
  const router = createPlanner('claude-code,mock');
  assert.ok(router instanceof RouterPlanner);
  assert.deepEqual(router.planners.map((x) => x.name), ['claude-code', 'mock']);
});

// --- Invocation ----------------------------------------------------------

test('runs `claude -p` via spawn with an argv array, no shell, prompt on stdin', async () => {
  const spawn = replies(envelope('{"action":"click_ref","ref":"link-0","reason":"English"}'));
  const action = await new ClaudeCodePlanner({ spawn }).plan(ctx());
  assert.deepEqual(action, { action: 'click_ref', ref: 'link-0', reason: 'English' });

  const [{ file, args, options, stdin }] = spawn.calls;
  assert.equal(file, 'claude');
  assert.equal(args[0], '-p');
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'json']);
  assert.deepEqual(args.slice(-2), ['--tools', ''], 'all built-in tools disabled');
  for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  assert.equal(args[args.indexOf('--system-prompt') + 1], CLAUDE_CODE_SYSTEM_PROMPT);
  assert.ok(!args.includes('--bare'), '--bare would force API-key auth');
  assert.equal(options.shell, false);
  assert.match(stdin, /OBJECTIVE: Open English Wikipedia/);
  assert.match(stdin, /\[link-0\]/);
  assert.ok(!args.some((a) => a.includes('Open English Wikipedia')), 'page/task text never goes on the command line');
});

test('does not require, and does not pass on, ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN', async (t) => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  t.after(() => {
    for (const [name, v] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_AUTH_TOKEN', saved.token]]) {
      if (v === undefined) delete process.env[name]; else process.env[name] = v;
    }
  });

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const spawn = replies(envelope('{"action":"observe"}'));
  assert.deepEqual(await new ClaudeCodePlanner({ spawn }).plan(ctx()), { action: 'observe' });

  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-token-not-real';
  const spawn2 = replies(envelope('{"action":"observe"}'));
  await new ClaudeCodePlanner({ spawn: spawn2 }).plan(ctx());
  const env = spawn2.calls[0].options.env;
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, process.env.PATH, 'the rest of the environment is inherited');
  assert.ok(!spawn2.calls[0].args.some((a) => a.includes('sk-test')), 'credentials never reach argv');
});

test('passes --model only when one is configured', async () => {
  const spawn = replies(envelope('{"action":"observe"}'));
  await new ClaudeCodePlanner({ spawn, model: 'claude-sonnet-5-5' }).plan(ctx());
  const { args } = spawn.calls[0];
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.ok(!new ClaudeCodePlanner({ model: undefined }).buildArgs().includes('--model'));
});

// --- Fail closed on malformed output --------------------------------------

test('malformed model output fails closed with bad_model_output', async () => {
  const bad = [
    'not json at all',
    '',
    JSON.stringify([{ action: 'observe' }]),
    envelope('Sure! I will click the English link.'),
    envelope('Here you go: {"action":"observe"}'),
    envelope('{"action":"observe"} {"action":"done"}'),
    envelope('[{"action":"observe"}]'),
    envelope('{"ref":"link-0"}'),
    envelope('{"action":"shell","command":"rm -rf /"}'),
    envelope('{"action":"evaluate","script":"alert(1)"}'),
    envelope('null'),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
  ];
  for (const stdout of bad) {
    await assert.rejects(new ClaudeCodePlanner({ spawn: replies(stdout) }).plan(ctx()), (e) => e.code === 'bad_model_output', `should reject: ${stdout}`);
  }
});

test('parseActionJson accepts exactly one object, optionally in a single json fence', () => {
  assert.deepEqual(parseActionJson('{"action":"done","summary":"ok","success":true}'), { action: 'done', summary: 'ok', success: true });
  assert.deepEqual(parseActionJson('```json\n{"action":"observe"}\n```'), { action: 'observe' });
  assert.deepEqual(parseActionJson('{"action":"click_ref","ref":"link-0","reason":null}'), { action: 'click_ref', ref: 'link-0' });
  assert.throws(() => parseActionJson('```json\n{"action":"observe"}\n```\nextra'), (e) => e.code === 'bad_model_output');
});

test('CLI errors are classified so the router can fall back', async () => {
  const cases = [
    [envelope('Not logged in · Please run /login', { is_error: true }), 1, 'auth_error'],
    [envelope('Invalid API key · Please run /login', { is_error: true }), 1, 'auth_error'],
    [envelope('Claude usage limit reached', { is_error: true }), 1, 'quota_exhausted'],
    [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }), 1, 'api_error'],
    ['', 1, 'api_error'],
    [envelope('{"action":"observe"}'), 2, 'api_error'],
  ];
  for (const [stdout, code, expected] of cases) {
    await assert.rejects(new ClaudeCodePlanner({ spawn: replies(stdout, { code, stderr: 'boom' }) }).plan(ctx()), (e) => e.code === expected, `${stdout} → ${expected}`);
  }
  assert.throws(() => parseClaudeCodeOutput('garbage', { exitCode: 1, stderr: 'Error: not logged in' }), (e) => e.code === 'auth_error');
});

test('a missing executable is missing_dependency', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(new ClaudeCodePlanner({ spawn }).plan(ctx()), (e) => e.code === 'missing_dependency');
});

// --- Timeout -------------------------------------------------------------

test('a child that never answers is killed and reported as a timeout', async () => {
  const spawn = fakeSpawn(() => {}); // never writes, never closes
  const started = Date.now();
  await assert.rejects(new ClaudeCodePlanner({ spawn, timeoutMs: 50 }).plan(ctx()), (e) => e.code === 'timeout' && e.retryable);
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(spawn.calls[0].child.killed, ['SIGTERM']);
});

// --- Router fallback -----------------------------------------------------

test('claude-code,mock falls back to mock on auth, missing CLI and timeout', async () => {
  const failures = [
    replies(envelope('Not logged in · Please run /login', { is_error: true }), { code: 1 }),
    fakeSpawn((child) => setImmediate(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })))),
    fakeSpawn(() => {}),
  ];
  for (const spawn of failures) {
    const router = new RouterPlanner([new ClaudeCodePlanner({ spawn, timeoutMs: 50 }), new MockPlanner()]);
    assert.equal((await router.plan(ctx())).ref, 'link-0');
    assert.equal(router.lastUsed, 'mock');
  }
});

test('claude-code,mock does not mask malformed output with the mock', async () => {
  const router = new RouterPlanner([new ClaudeCodePlanner({ spawn: replies(envelope('I think you should click English')) }), new MockPlanner()]);
  await assert.rejects(router.plan(ctx()), (e) => e.code === 'bad_model_output');
});

test('claude-code,mock uses claude-code when it answers', async () => {
  const router = new RouterPlanner([new ClaudeCodePlanner({ spawn: replies(envelope('{"action":"done","summary":"ok"}')) }), new MockPlanner()]);
  assert.equal((await router.plan(ctx())).action, 'done');
  assert.equal(router.lastUsed, 'claude-code');
});

// --- System prompt -------------------------------------------------------

test('the system prompt asks for JSON and lists every V1 action', () => {
  assert.match(CLAUDE_CODE_SYSTEM_PROMPT, /exactly one JSON object/);
  assert.doesNotMatch(CLAUDE_CODE_SYSTEM_PROMPT, /provided tools/);
  for (const name of ACTIONS) assert.match(CLAUDE_CODE_SYSTEM_PROMPT, new RegExp(`- ${name}:`));
  assert.match(CLAUDE_CODE_SYSTEM_PROMPT, /untrusted data/);
});

// --- Real spawn against a stand-in executable (never the real CLI) -------

test('real spawn: no shell interpolation, stdin delivered, exit handled', { skip: process.platform === 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dalexio-fake-claude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'pwned');
  const fake = join(dir, 'claude');
  writeFileSync(fake, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const sawObjective = input.includes(${JSON.stringify(`$(touch ${marker})`)});
  const result = JSON.stringify({ action: 'done', summary: JSON.stringify({ argv: process.argv.slice(2).filter((a) => a !== process.argv[process.argv.indexOf('--system-prompt') + 1]), sawObjective, apiKey: process.env.ANTHROPIC_API_KEY ?? null }) });
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result }));
});
`);
  chmodSync(fake, 0o755);

  const action = await new ClaudeCodePlanner({ executable: fake, timeoutMs: 10_000 }).plan(ctx({ objective: `$(touch ${marker}); echo \`id\`` }));
  const seen = JSON.parse(action.summary);
  assert.equal(existsSync(marker), false, 'objective text must not be run by a shell');
  assert.equal(seen.sawObjective, true, 'objective reached the child verbatim on stdin');
  assert.deepEqual(seen.argv.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.deepEqual(seen.argv.slice(-2), ['--tools', '']);
  assert.equal(seen.apiKey, null);
});

test('real spawn: a hung child is killed at the timeout', { skip: process.platform === 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dalexio-fake-claude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'claude');
  writeFileSync(fake, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
  chmodSync(fake, 0o755);
  const started = Date.now();
  await assert.rejects(new ClaudeCodePlanner({ executable: fake, timeoutMs: 300 }).plan(ctx()), (e) => e.code === 'timeout');
  assert.ok(Date.now() - started < 3_000);
});

test('real spawn: a missing executable is missing_dependency', async () => {
  await assert.rejects(
    new ClaudeCodePlanner({ executable: join(tmpdir(), 'dalexio-no-such-claude-binary') }).plan(ctx()),
    (e) => e.code === 'missing_dependency',
  );
});
