// BrowserExecutor: the only path from a planner action to the browser.
//
// execute() validates every action against the schema and against the most
// recent observation (so refs must be ones the planner actually saw), then runs
// it under a per-action timeout. Selector-based helpers (read/click/type/state)
// remain available for developers and tests but are not reachable through
// execute(), which only accepts the V1 planner actions.

import { validateAction, ActionValidationError } from '../actions/schema.js';
import { withTimeout } from '../util/timeout.js';

export class BrowserExecutor {
  /**
   * @param {import('./controller.js').BrowserController} controller
   * @param {{ actionTimeoutMs?: number }} [options]
   */
  constructor(controller, { actionTimeoutMs = 20_000 } = {}) {
    this.controller = controller;
    this.actionTimeoutMs = actionTimeoutMs;
    this.lastObservation = null;
  }

  /**
   * Validate and execute one planner action.
   * @returns {Promise<{action: object, result: object}>}
   * @throws {ActionValidationError | import('./controller.js').BrowserError | import('../util/timeout.js').TimeoutError}
   */
  async execute(rawAction, { observation = this.lastObservation, timeoutMs = this.actionTimeoutMs } = {}) {
    const action = validateAction(rawAction, { observation });
    if ((action.action === 'click_ref' || action.action === 'type_ref') && !observation) {
      throw new ActionValidationError(`${action.action} requires an observation first`, { code: 'no_observation', action: rawAction });
    }
    const result = await withTimeout(this._run(action), timeoutMs, `action ${action.action}`);
    return { action, result };
  }

  async _run(action) {
    const c = this.controller;
    switch (action.action) {
      case 'navigate': {
        const nav = await c.navigate(action.url);
        this.lastObservation = null; // refs from the old document are void
        return nav;
      }
      case 'click_ref':
        await c.clickRef(action.ref);
        this.lastObservation = null;
        return { clicked: action.ref, ...(await c.getState()) };
      case 'type_ref':
        await c.typeRef(action.ref, action.text, { submit: Boolean(action.submit) });
        if (action.submit) this.lastObservation = null;
        return { typed: action.ref, chars: action.text.length, submitted: Boolean(action.submit) };
      case 'observe':
        return { observation: await this.observe() };
      case 'screenshot':
        return c.screenshot({ fullPage: Boolean(action.fullPage) });
      case 'done':
        return { done: true, success: action.success, summary: action.summary };
      default:
        // Unreachable: validateAction rejects anything else.
        throw new ActionValidationError(`unsupported action ${action.action}`, { code: 'unknown_action' });
    }
  }

  // --- convenience wrappers (same names as the original executor) ---------

  async observe() {
    this.lastObservation = await this.controller.observe();
    return this.lastObservation;
  }

  navigate(url) { return this.execute({ action: 'navigate', url }); }
  click_ref(ref) { return this.execute({ action: 'click_ref', ref }); }
  type_ref(ref, text, opts = {}) { return this.execute({ action: 'type_ref', ref, text, ...opts }); }
  screenshot(opts = {}) { return this.execute({ action: 'screenshot', ...opts }); }

  // Developer-only selector helpers. Not part of the planner contract.
  read(selector) { return withTimeout(this.controller.readText(selector), this.actionTimeoutMs, 'read'); }
  click(selector) { this.lastObservation = null; return withTimeout(this.controller.click(selector), this.actionTimeoutMs, 'click'); }
  type(selector, text, opts) { return withTimeout(this.controller.type(selector, text, opts), this.actionTimeoutMs, 'type'); }
  state() { return this.controller.getState(); }
}
