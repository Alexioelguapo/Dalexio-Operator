import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockPlanner, ScriptedPlanner, bestLinkMatch } from '../../src/agents/mock-planner.js';
import { ClaudePlanner } from '../../src/agents/claude-planner.js';
import { OpenAIPlanner, OpenRouterPlanner } from '../../src/agents/openai-planner.js';
import { createPlanner, RouterPlanner } from '../../src/agents/router.js';
import { PlannerError, Planner } from '../../src/agents/planner.js';
import { renderContext, actionToolDefinitions, toolCallToAction, parseActionFromText } from '../../src/agents/prompt.js';
import { ACTIONS } from '../../src/actions/schema.js';

const observation = {
  url: 'https://www.wikipedia.org/',
  title: 'Wikipedia',
  headings: [{ level: 1, text: 'Wikipedia' }],
  text: 'The Free Encyclopedia',
  elements: [
    { ref: 'link-0', kind: 'link', label: 'English 7,000,000+ articles', href: 'https://en.wikipedia.org/' },
    { ref: 'link-1', kind: 'link', label: 'Deutsch', href: 'https://de.wikipedia.org/' },
    { ref: 'input-0', kind: 'input', type: 'search', name: 'search', label: 'Search Wikipedia' },
  ],
  forms: [],
};
const ctx = (over = {}) => ({ objective: 'Open English Wikipedia', observation, history: [], step: 0, maxSteps: 10, ...over });

// --- Mock planner ----------------------------------------------------------

test('MockPlanner clicks the best-matching link', async () => {
  assert.deepEqual(await new MockPlanner().plan(ctx()), { action: 'click_ref', ref: 'link-0', reason: 'best match for objective: "English 7,000,000+ articles"' });
});

test('MockPlanner navigates when the objective contains a URL', async () => {
  const a = await new MockPlanner().plan(ctx({ objective: 'Go to https://example.com/page' }));
  assert.deepEqual(a, { action: 'navigate', url: 'https://example.com/page', reason: 'objective names a URL' });
});

test('MockPlanner searches', async () => {
  const a = await new MockPlanner().plan(ctx({ objective: 'Search for octopus' }));
  assert.equal(a.action, 'type_ref');
  assert.equal(a.text, 'octopus');
  assert.equal(a.submit, true);
});

test('MockPlanner finishes after acting, and gives up when nothing matches', async () => {
  const history = [{ step: 0, action: { action: 'click_ref', ref: 'link-0' }, url: 'https://www.wikipedia.org/', urlAfter: 'https://en.wikipedia.org/' }];
  assert.equal((await new MockPlanner().plan(ctx({ history }))).action, 'done');
  const none = await new MockPlanner().plan(ctx({ objective: 'Open the Klingon edition' }));
  assert.deepEqual([none.action, none.success], ['done', false]);
});

test('bestLinkMatch ignores stopwords and needs at least one real match', () => {
  assert.equal(bestLinkMatch('open the page', observation.elements), null);
  assert.equal(bestLinkMatch('deutsch', observation.elements).ref, 'link-1');
});

test('ScriptedPlanner replays actions and supports repeatLast', async () => {
  const p = new ScriptedPlanner([{ action: 'observe' }, (c) => ({ action: 'done', summary: `step ${c.step}` })]);
  assert.equal((await p.plan(ctx())).action, 'observe');
  assert.equal((await p.plan(ctx({ step: 1 }))).summary, 'step 1');
  assert.equal((await p.plan(ctx())).summary, 'script exhausted');
  const r = new ScriptedPlanner([{ action: 'observe' }], { repeatLast: true });
  for (let i = 0; i < 3; i++) assert.equal((await r.plan(ctx())).action, 'observe');
});

// --- Shared prompt/tool contract ------------------------------------------

test('tool definitions cover exactly the V1 actions with closed schemas', () => {
  const tools = actionToolDefinitions();
  assert.deepEqual(tools.map((t) => t.name), [...ACTIONS]);
  for (const t of tools) assert.equal(t.parameters.additionalProperties, false);
  assert.deepEqual(tools.find((t) => t.name === 'type_ref').parameters.required, ['ref', 'text']);
});

test('renderContext is compact and includes refs, history and objective', () => {
  const text = renderContext(ctx({ history: [{ step: 0, action: { action: 'observe' }, outcome: 'observed' }] }));
  assert.match(text, /OBJECTIVE: Open English Wikipedia/);
  assert.match(text, /\[link-0\] link "English 7,000,000\+ articles"/);
  assert.match(text, /#1 \{"action":"observe"\} → observed/);
  assert.ok(text.length < 1500, `rendered context unexpectedly large: ${text.length}`);
});

test('toolCallToAction / parseActionFromText', () => {
  assert.deepEqual(toolCallToAction('click_ref', { ref: 'link-0', reason: null }), { action: 'click_ref', ref: 'link-0' });
  assert.throws(() => toolCallToAction('shell', {}), PlannerError);
  assert.deepEqual(parseActionFromText('Sure: {"action":"observe"}'), { action: 'observe' });
  assert.throws(() => parseActionFromText('no json here'), PlannerError);
});

// --- Claude planner (fake client; no network, no key) --------------------

function fakeAnthropic(responses) {
  const requests = [];
  const create = async (req) => {
    requests.push(structuredClone(req));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { requests, client: { messages: { create }, beta: { messages: { create } } } };
}

test('ClaudePlanner builds a provider-correct request and maps the tool call', async () => {
  const { client, requests } = fakeAnthropic([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Clicking English.' }, { type: 'tool_use', id: 't1', name: 'click_ref', input: { ref: 'link-0', reason: 'English' } }] },
  ]);
  const planner = new ClaudePlanner({ client });
  assert.deepEqual(await planner.plan(ctx()), { action: 'click_ref', ref: 'link-0', reason: 'English' });
  const req = requests[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.deepEqual(req.tools.map((t) => t.name), [...ACTIONS]);
  assert.ok(req.tools.every((t) => t.input_schema && t.input_schema.type === 'object'));
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.match(req.messages[0].content, /\[link-0\]/);
  assert.equal(req.thinking, undefined, 'thinking is left at the model default');
});

test('ClaudePlanner without fallbacks uses the non-beta endpoint', async () => {
  let usedBeta = false;
  const client = {
    messages: { create: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'observe', input: {} }] }) },
    beta: { messages: { create: async () => { usedBeta = true; return {}; } } },
  };
  const a = await new ClaudePlanner({ client, fallbacks: false }).plan(ctx());
  assert.deepEqual(a, { action: 'observe' });
  assert.equal(usedBeta, false);
});

test('ClaudePlanner retries once when no tool is called, then errors', async () => {
  const { client, requests } = fakeAnthropic([
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Thinking out loud' }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'done', input: { summary: 'ok' } }] },
  ]);
  assert.equal((await new ClaudePlanner({ client }).plan(ctx())).action, 'done');
  assert.equal(requests[1].messages.length, 3);

  const { client: c2 } = fakeAnthropic([
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'a' }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'b' }] },
  ]);
  await assert.rejects(new ClaudePlanner({ client: c2 }).plan(ctx()), (e) => e.code === 'bad_model_output');
});

test('ClaudePlanner maps refusals, truncation and API errors to PlannerErrors', async () => {
  const { client } = fakeAnthropic([{ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }]);
  await assert.rejects(new ClaudePlanner({ client }).plan(ctx()), (e) => e.code === 'refusal');
  const { client: c2 } = fakeAnthropic([{ stop_reason: 'max_tokens', content: [] }]);
  await assert.rejects(new ClaudePlanner({ client: c2 }).plan(ctx()), (e) => e.code === 'truncated' && e.retryable);
  const { client: c3 } = fakeAnthropic([Object.assign(new Error('bad key'), { status: 401 })]);
  await assert.rejects(new ClaudePlanner({ client: c3 }).plan(ctx()), (e) => e.code === 'auth_error' && !e.retryable);
  const { client: c4 } = fakeAnthropic([Object.assign(new Error('overloaded'), { status: 529 })]);
  await assert.rejects(new ClaudePlanner({ client: c4 }).plan(ctx()), (e) => e.code === 'api_error' && e.retryable);
});

// --- OpenAI-compatible planner (fake fetch) -------------------------------

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

test('OpenAIPlanner sends function tools and parses the tool call', async () => {
  const fetch = fakeFetch(200, { choices: [{ message: { tool_calls: [{ function: { name: 'type_ref', arguments: '{"ref":"input-0","text":"octopus","submit":true}' } }] } }] });
  const p = new OpenAIPlanner({ apiKey: 'test-key', model: 'some-model', fetch });
  assert.deepEqual(await p.plan(ctx()), { action: 'type_ref', ref: 'input-0', text: 'octopus', submit: true });
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer test-key');
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.tools[0].type, 'function');
});

test('OpenAIPlanner classifies exhausted credits as quota_exhausted (not retryable)', async () => {
  const fetch = fakeFetch(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } });
  await assert.rejects(new OpenAIPlanner({ apiKey: 'k', model: 'm', fetch }).plan(ctx()), (e) => e.code === 'quota_exhausted' && !e.retryable);
});

test('OpenAI-compatible planners refuse to run without key/model', async () => {
  await assert.rejects(new OpenAIPlanner({ apiKey: undefined, model: 'm', fetch: fakeFetch(200, {}) }).plan(ctx()), (e) => e.code === 'auth_error');
  await assert.rejects(new OpenRouterPlanner({ apiKey: 'k', model: undefined, fetch: fakeFetch(200, {}) }).plan(ctx()), (e) => e.code === 'config_error');
});

// --- Router -------------------------------------------------------------

class FailingPlanner extends Planner {
  constructor(code) { super(`fail-${code}`); this.code = code; }
  async plan() { throw new PlannerError(`failed with ${this.code}`, { code: this.code }); }
}

test('RouterPlanner falls through infrastructure failures to the next planner', async () => {
  const router = new RouterPlanner([new FailingPlanner('quota_exhausted'), new FailingPlanner('auth_error'), new MockPlanner()]);
  assert.equal((await router.plan(ctx())).ref, 'link-0');
  assert.equal(router.lastUsed, 'mock');
});

test('RouterPlanner does not mask unexpected errors', async () => {
  const router = new RouterPlanner([new FailingPlanner('bad_model_output'), new MockPlanner()]);
  await assert.rejects(router.plan(ctx()), (e) => e.code === 'bad_model_output');
  const allFail = new RouterPlanner([new FailingPlanner('network_error')]);
  await assert.rejects(allFail.plan(ctx()), (e) => e.code === 'all_planners_failed');
});

test('createPlanner builds by name and by comma list', () => {
  assert.equal(createPlanner('mock').name, 'mock');
  assert.equal(createPlanner('claude', { claude: { client: {} } }).name, 'claude');
  assert.ok(createPlanner('openai,mock') instanceof RouterPlanner);
  assert.throws(() => createPlanner('gpt-9000'), /unknown planner/);
});

test('ClaudePlanner produces a correct HTTP request through the real Anthropic SDK', async (t) => {
  try { await import('@anthropic-ai/sdk'); } catch { t.skip('optional @anthropic-ai/sdk not installed'); return; }
  let captured;
  const fetch = async (url, init) => {
    captured = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'click_ref', input: { ref: 'link-0' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // A dummy key: the request never leaves this process.
  const planner = new ClaudePlanner({ clientOptions: { apiKey: 'test-not-a-real-key', fetch, maxRetries: 0 } });
  assert.deepEqual(await planner.plan(ctx()), { action: 'click_ref', ref: 'link-0' });
  assert.match(captured.url, /\/v1\/messages/);
  assert.equal(captured.headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01');
  assert.equal(captured.body.fallbacks, 'default');
  assert.equal(captured.body.betas, undefined, 'betas travel as a header, not in the body');
  assert.deepEqual(captured.body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
});
