// Claude planner (Anthropic Messages API via the official SDK).
//
// Credentials stay external: the SDK resolves ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile on its own. Nothing here
// reads, stores or logs a key. The SDK is an optional dependency and is only
// imported when this planner is actually used, so tests and the mock operator
// never need it.
//
// Each step is one stateless request: the operator re-sends the objective, the
// current observation and a summary of history, and Claude answers with one
// tool call (one tool per action). The operator validates that call before
// anything touches the browser.

import { Planner, PlannerError } from './planner.js';
import { SYSTEM_PROMPT, actionToolDefinitions, renderContext, toolCallToAction } from './prompt.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class ClaudePlanner extends Planner {
  /**
   * @param {object} [opts]
   * @param {string} [opts.model]       Defaults to DALEXIO_CLAUDE_MODEL or claude-opus-5-5.
   * @param {'low'|'medium'|'high'|'xhigh'|'max'} [opts.effort]
   * @param {number} [opts.maxTokens]
   * @param {boolean} [opts.fallbacks]  Server-side refusal fallback (Claude API only).
   * @param {object} [opts.client]      Pre-built Anthropic client (tests, Bedrock/Vertex clients, …).
   * @param {object} [opts.clientOptions] Passed to `new Anthropic()` when no client is given.
   */
  constructor({
    model = process.env.DALEXIO_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    effort = process.env.DALEXIO_CLAUDE_EFFORT || 'medium',
    maxTokens = 16_000,
    fallbacks = process.env.DALEXIO_CLAUDE_FALLBACKS !== 'false',
    client,
    clientOptions,
  } = {}) {
    super('claude');
    this.model = model;
    this.effort = effort;
    this.maxTokens = maxTokens;
    this.fallbacks = fallbacks;
    this._client = client ?? null;
    this._clientOptions = clientOptions;
    this.tools = actionToolDefinitions().map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }

  async _getClient() {
    if (this._client) return this._client;
    let Anthropic;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw new PlannerError('ClaudePlanner needs the optional dependency @anthropic-ai/sdk (npm install @anthropic-ai/sdk)', { code: 'missing_dependency' });
    }
    this._client = new Anthropic(this._clientOptions);
    return this._client;
  }

  buildRequest(context) {
    const request = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      tools: this.tools,
      // Forced tool_choice is rejected by current models; auto + one-call limit
      // + the prompt instruction, with a retry below if no tool is called.
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      output_config: { effort: this.effort },
      messages: [{ role: 'user', content: renderContext(context) }],
    };
    if (this.fallbacks) {
      request.betas = [FALLBACK_BETA];
      request.fallbacks = 'default';
    }
    return request;
  }

  async plan(context) {
    const client = await this._getClient();
    const request = this.buildRequest(context);
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = request.betas ? await client.beta.messages.create(request) : await client.messages.create(request);
      } catch (err) {
        const status = err?.status;
        throw new PlannerError(`Claude API error${status ? ` ${status}` : ''}: ${err.message}`, {
          code: status === 401 || status === 403 ? 'auth_error' : 'api_error',
          retryable: status === 429 || status >= 500,
          cause: err,
        });
      }
      if (response.stop_reason === 'refusal') {
        throw new PlannerError(`Claude declined the request (${response.stop_details?.category ?? 'unspecified'})`, { code: 'refusal' });
      }
      if (response.stop_reason === 'max_tokens') {
        throw new PlannerError('Claude response hit max_tokens before choosing an action', { code: 'truncated', retryable: true });
      }
      const call = response.content?.find((b) => b.type === 'tool_use');
      if (call) return toolCallToAction(call.name, call.input);
      // No tool call: nudge once, then give up.
      request.messages = [
        ...request.messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: 'You must respond by calling exactly one of the provided tools.' },
      ];
    }
    throw new PlannerError('Claude did not call a tool', { code: 'bad_model_output' });
  }
}
