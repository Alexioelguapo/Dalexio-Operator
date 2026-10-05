// Planner for OpenAI-compatible Chat Completions endpoints (OpenAI, OpenRouter,
// local servers such as Ollama / vLLM). Uses plain fetch, so it adds no
// dependency. Credentials come from the environment; nothing is hard-coded.

import { Planner, PlannerError } from './planner.js';
import { SYSTEM_PROMPT, actionToolDefinitions, renderContext, toolCallToAction, parseActionFromText } from './prompt.js';

export const OPENAI_COMPATIBLE_PRESETS = Object.freeze({
  openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', modelEnv: 'DALEXIO_OPENAI_MODEL' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', modelEnv: 'DALEXIO_OPENROUTER_MODEL' },
});

export class OpenAICompatiblePlanner extends Planner {
  /**
   * @param {object} opts
   * @param {'openai'|'openrouter'} [opts.provider]
   * @param {string} [opts.baseURL]
   * @param {string} [opts.apiKey]   Defaults to the provider's env var.
   * @param {string} opts.model      Required (or via DALEXIO_OPENAI_MODEL / DALEXIO_OPENROUTER_MODEL).
   * @param {Function} [opts.fetch]  Injected fetch (tests).
   */
  constructor({ provider = 'openai', baseURL, apiKey, model, fetch: fetchImpl = globalThis.fetch, timeoutMs = 60_000, extraHeaders = {} } = {}) {
    super(provider);
    const preset = OPENAI_COMPATIBLE_PRESETS[provider] ?? {};
    this.baseURL = (baseURL ?? process.env.DALEXIO_OPENAI_BASE_URL ?? preset.baseURL ?? '').replace(/\/$/, '');
    this.apiKey = apiKey ?? (preset.apiKeyEnv ? process.env[preset.apiKeyEnv] : undefined);
    this.model = model ?? (preset.modelEnv ? process.env[preset.modelEnv] : undefined);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.extraHeaders = extraHeaders;
    this.tools = actionToolDefinitions().map((t) => ({ type: 'function', function: t }));
  }

  _assertConfigured() {
    if (!this.baseURL) throw new PlannerError(`${this.name} planner has no baseURL`, { code: 'config_error' });
    if (!this.model) throw new PlannerError(`${this.name} planner has no model configured`, { code: 'config_error' });
    if (!this.apiKey) throw new PlannerError(`${this.name} planner has no API key in the environment`, { code: 'auth_error' });
  }

  buildRequest(context) {
    return {
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: renderContext(context) },
      ],
      tools: this.tools,
      tool_choice: 'required',
      parallel_tool_calls: false,
    };
  }

  async plan(context) {
    this._assertConfigured();
    let res;
    try {
      res = await this.fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
        body: JSON.stringify(this.buildRequest(context)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PlannerError(`${this.name} request failed: ${err.message}`, { code: 'network_error', retryable: true, cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 402/429 with "insufficient_quota" is the exhausted-credits case.
      const code = res.status === 401 || res.status === 403 ? 'auth_error'
        : /insufficient_quota|credit/i.test(body) || res.status === 402 ? 'quota_exhausted'
          : 'api_error';
      throw new PlannerError(`${this.name} API error ${res.status}: ${body.slice(0, 300)}`, { code, retryable: (res.status === 429 && code !== 'quota_exhausted') || res.status >= 500 });
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    const call = msg?.tool_calls?.[0];
    if (call) {
      let args;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        throw new PlannerError('model returned unparseable tool arguments', { code: 'bad_model_output' });
      }
      return toolCallToAction(call.function.name, args);
    }
    return parseActionFromText(msg?.content);
  }
}

export class OpenAIPlanner extends OpenAICompatiblePlanner {
  constructor(opts = {}) { super({ ...opts, provider: 'openai' }); }
}

export class OpenRouterPlanner extends OpenAICompatiblePlanner {
  constructor(opts = {}) { super({ ...opts, provider: 'openrouter' }); }
}
