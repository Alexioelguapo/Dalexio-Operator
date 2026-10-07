// Claude Code planner: plans each step by running the locally installed,
// already-logged-in Claude Code CLI in print mode (`claude -p`).
//
// This is separate from ClaudePlanner (the Anthropic SDK/API planner). It
// needs no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN: the CLI uses whatever
// login `claude` already has on this machine. Nothing here reads, copies or
// logs credentials. By default the two API-credential variables are removed
// from the child's environment so the CLI cannot silently switch from the
// Claude Code login to API billing.
//
// The CLI is spawned directly (no shell), with every argument passed as a
// separate argv entry and the page context written to stdin, so page text can
// never be interpreted as shell syntax or CLI flags. The child runs with all
// built-in tools disabled, no MCP servers, no slash commands, no project
// settings, and a scratch working directory, so the only thing it can do is
// answer with text. That text must be exactly one JSON action; anything else
// fails closed with a PlannerError. The operator still validates the action
// before it reaches the browser.

import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { ACTIONS } from '../actions/schema.js';
import { Planner, PlannerError } from './planner.js';
import { SYSTEM_PROMPT, actionToolDefinitions, renderContext, toolCallToAction } from './prompt.js';

export const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 80_000; // under the operator's 90 s planner limit
const MAX_OUTPUT_BYTES = 1_000_000;
const KILL_GRACE_MS = 2_000;
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export const CLAUDE_CODE_SYSTEM_PROMPT = `${SYSTEM_PROMPT
  .replace('by calling exactly one of the provided tools', 'by replying with exactly one JSON object')
  .replace('Only the listed tools exist.', 'Only the listed actions exist.')}

Output format:
- Reply with ONE JSON object and nothing else: no prose, no markdown, no code fences.
- The object has an "action" field naming one action below, that action's fields, and an optional "reason" string.
- Example: {"action":"click_ref","ref":"link-0","reason":"English edition"}

Actions:
${actionToolDefinitions().map((t) => `- ${t.name}: ${t.description} Fields: ${describeFields(t.parameters)}`).join('\n')}`;

function describeFields({ properties, required }) {
  const fields = Object.entries(properties)
    .filter(([name]) => name !== 'reason')
    .map(([name, p]) => `${name} (${p.type}${required.includes(name) ? ', required' : ''})`);
  return fields.length ? fields.join(', ') : 'none';
}

export class ClaudeCodePlanner extends Planner {
  /**
   * @param {object} [opts]
   * @param {string} [opts.executable]   Defaults to DALEXIO_CLAUDE_CODE_BIN or "claude" on PATH.
   * @param {string} [opts.model]        Defaults to DALEXIO_CLAUDE_CODE_MODEL, else the CLI's own default.
   * @param {number} [opts.timeoutMs]    Per-step limit; the child is killed when it expires.
   * @param {boolean} [opts.stripApiKeyEnv] Remove ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the child env (default true).
   * @param {string} [opts.cwd]          Child working directory (default: OS temp dir, so no project CLAUDE.md or settings load).
   * @param {Function} [opts.spawn]      Injected child_process.spawn (tests).
   */
  constructor({
    executable = process.env.DALEXIO_CLAUDE_CODE_BIN || 'claude',
    model = process.env.DALEXIO_CLAUDE_CODE_MODEL || undefined,
    timeoutMs = Number(process.env.DALEXIO_CLAUDE_CODE_TIMEOUT_MS) || DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
    stripApiKeyEnv = true,
    cwd = tmpdir(),
    spawn = nodeSpawn,
  } = {}) {
    super('claude-code');
    this.executable = executable;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.stripApiKeyEnv = stripApiKeyEnv;
    this.cwd = cwd;
    this._spawn = spawn;
  }

  buildArgs() {
    const args = [
      '-p',
      '--output-format', 'json',
      '--system-prompt', CLAUDE_CODE_SYSTEM_PROMPT,
      '--no-session-persistence',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--setting-sources', 'user',
    ];
    if (this.model) args.push('--model', this.model);
    // Variadic flag last, so nothing after it can be read as a tool name.
    args.push('--tools', '');
    return args;
  }

  buildEnv() {
    const env = { ...process.env };
    if (this.stripApiKeyEnv) for (const name of STRIPPED_ENV) delete env[name];
    return env;
  }

  async plan(context) {
    const { stdout, stderr, exitCode } = await this._run(renderContext(context));
    return parseClaudeCodeOutput(stdout, { stderr, exitCode });
  }

  _run(input) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(this.executable, this.buildArgs(), {
          cwd: this.cwd,
          env: this.buildEnv(),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(spawnError(this.executable, err));
        return;
      }

      const out = [];
      const errOut = [];
      let outBytes = 0;
      let settled = false;
      let killTimer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const kill = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref?.();
      };

      const timer = setTimeout(() => {
        kill();
        finish(reject, new PlannerError(`claude -p did not answer within ${this.timeoutMs} ms`, { code: 'timeout', retryable: true }));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        outBytes += chunk.length;
        if (outBytes > MAX_OUTPUT_BYTES) {
          kill();
          finish(reject, new PlannerError('claude -p output exceeded the size limit', { code: 'bad_model_output' }));
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk) => { if (errOut.length < 64) errOut.push(chunk); });
      child.on('error', (err) => finish(reject, spawnError(this.executable, err)));
      child.on('close', (exitCode) => {
        clearTimeout(killTimer);
        finish(resolve, { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8'), exitCode });
      });
      // A child that exits before reading stdin raises EPIPE; 'close' reports the real outcome.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
}

function spawnError(executable, err) {
  if (err?.code === 'ENOENT' || err?.code === 'EACCES') {
    return new PlannerError(`Claude Code CLI "${executable}" not found or not executable. Install Claude Code and run \`claude\` once to log in.`, { code: 'missing_dependency', cause: err });
  }
  return new PlannerError(`could not start Claude Code CLI: ${err?.message ?? err}`, { code: 'api_error', cause: err });
}

/**
 * Turn `claude -p --output-format json` stdout into one planner action, or
 * throw a PlannerError. Every unexpected shape fails closed.
 */
export function parseClaudeCodeOutput(stdout, { stderr = '', exitCode = 0 } = {}) {
  let envelope;
  try {
    envelope = JSON.parse(String(stdout).trim());
  } catch {
    const detail = String(stderr || stdout).trim().slice(0, 300);
    if (exitCode !== 0) throw classifyCliError(`claude -p exited with code ${exitCode}${detail ? `: ${detail}` : ''}`);
    throw new PlannerError('claude -p returned output that is not a JSON result envelope', { code: 'bad_model_output' });
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new PlannerError('claude -p returned an unexpected result envelope', { code: 'bad_model_output' });
  }
  if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success') || exitCode !== 0) {
    const detail = typeof envelope.result === 'string' ? envelope.result : envelope.subtype ?? `exit code ${exitCode}`;
    throw classifyCliError(`claude -p failed: ${String(detail).slice(0, 300)}`);
  }
  if (typeof envelope.result !== 'string') {
    throw new PlannerError('claude -p result envelope has no text result', { code: 'bad_model_output' });
  }
  return parseActionJson(envelope.result);
}

function classifyCliError(message) {
  if (/not logged in|\/login|log ?in|invalid api key|authenticat|unauthori[sz]ed|\b401\b|\b403\b|oauth/i.test(message)) {
    return new PlannerError(message, { code: 'auth_error' });
  }
  if (/usage limit|rate limit|quota|\b429\b/i.test(message)) {
    return new PlannerError(message, { code: 'quota_exhausted' });
  }
  return new PlannerError(message, { code: 'api_error' });
}

/** Strict: the whole reply must be one JSON object naming a V1 action (a single ```json fence is tolerated). */
export function parseActionJson(text) {
  let body = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body);
  if (fence) body = fence[1].trim();
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new PlannerError('Claude Code reply is not a single JSON object', { code: 'bad_model_output' });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlannerError('Claude Code reply is not a JSON object', { code: 'bad_model_output' });
  }
  const { action, ...fields } = value;
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    throw new PlannerError(`Claude Code reply names no valid action (got ${JSON.stringify(action)})`, { code: 'bad_model_output' });
  }
  return toolCallToAction(action, fields);
}
