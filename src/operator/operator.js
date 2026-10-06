// The observe → plan → validate → classify → approve → execute loop.

import { BrowserController, BrowserError } from '../browser/controller.js';
import { BrowserExecutor } from '../browser/executor.js';
import { fingerprintObservation } from '../browser/observation.js';
import { validateAction, ActionValidationError, findElement } from '../actions/schema.js';
import { assertPlanner, PlannerError } from '../agents/planner.js';
import { classifyAction } from '../safety/policy.js';
import { ApprovalGate } from '../safety/approval-gate.js';
import { TaskState } from '../state/task-state.js';
import { AuditLog, redactAction } from '../state/audit-log.js';
import { withTimeout, TimeoutError } from '../util/timeout.js';
import { LoopGuard, LoopGuardViolation, DEFAULT_GUARD_LIMITS } from './loop-guard.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxSteps: 15,
  actionTimeoutMs: 20_000,
  plannerTimeoutMs: 90_000,
  taskTimeoutMs: 5 * 60_000,
  maxConsecutiveErrors: 3,
  ...DEFAULT_GUARD_LIMITS,
});

export const FAILURE = Object.freeze({
  MAX_STEPS: 'max_steps',
  TASK_TIMEOUT: 'task_timeout',
  TOO_MANY_ERRORS: 'too_many_errors',
  PLANNER_FAILED: 'planner_failed',
  BROWSER_FAILED: 'browser_failed',
  OBJECTIVE_NOT_ACHIEVED: 'objective_not_achieved',
});

export class Operator {
  /**
   * @param {object} opts
   * @param {import('../agents/planner.js').Planner} opts.planner
   * @param {BrowserController} [opts.controller]  Supply your own (it will not be closed for you).
   * @param {object} [opts.browserOptions]          Used when the operator creates its own controller.
   * @param {ApprovalGate} [opts.gate]              Defaults to deny-all for AMBER/RED.
   * @param {object} [opts.policy]                  Extra policy rules for classifyAction.
   * @param {object} [opts.limits]                  Overrides for DEFAULT_LIMITS.
   * @param {string|null} [opts.auditDir]           JSONL audit directory, null for memory only.
   * @param {string} [opts.startUrl]                Page to open before the first step.
   * @param {(event: object) => void} [opts.onEvent] Progress callback.
   */
  constructor({ planner, controller, browserOptions, gate, policy, limits, auditDir = '.dalexio/runs', startUrl, onEvent } = {}) {
    this.planner = assertPlanner(planner);
    this.ownsController = !controller;
    this.controller = controller ?? new BrowserController(browserOptions);
    this.executor = new BrowserExecutor(this.controller);
    this.gate = gate ?? new ApprovalGate();
    this.policy = policy ?? {};
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.auditDir = auditDir;
    this.startUrl = startUrl;
    this.onEvent = onEvent ?? (() => {});
  }

  async run(objective) {
    if (typeof objective !== 'string' || !objective.trim()) throw new TypeError('objective must be a non-empty string');
    const task = new TaskState(objective.trim());
    const audit = new AuditLog({ dir: this.auditDir, taskId: task.id });
    const guard = new LoopGuard(this.limits);
    const deadline = Date.now() + this.limits.taskTimeoutMs;
    const remaining = () => deadline - Date.now();
    const bounded = (promise, ms, label) => {
      const left = remaining();
      if (left <= 0) throw new TimeoutError('task', this.limits.taskTimeoutMs);
      return withTimeout(promise, Math.min(ms, left), label);
    };
    const emit = async (type, data = {}) => {
      // Observers get the same sanitized event the audit log stores.
      const event = await audit.write(type, { taskId: task.id, step: task.step, ...data });
      try { this.onEvent(event); } catch { /* observers must not break runs */ }
    };

    let observation = null;
    let consecutiveErrors = 0;
    let current = 0; // index of the step being processed; history entries carry it
    const noteError = (code, message, action) => {
      consecutiveErrors += 1;
      task.record({ step: current, action: action ?? null, error: `${code}: ${message}`, url: observation?.url });
      return consecutiveErrors >= this.limits.maxConsecutiveErrors;
    };

    await emit('task_start', { objective: task.objective, planner: this.planner.name, limits: this.limits });

    try {
      if (this.ownsController || !this.controller.isLaunched) await bounded(this.controller.launch(), this.limits.actionTimeoutMs * 2, 'browser launch');
      if (this.startUrl) await bounded(this.executor.navigate(this.startUrl), this.limits.actionTimeoutMs, 'start navigation');
      observation = await bounded(this.executor.observe(), this.limits.actionTimeoutMs, 'observe');
      await emit('observation', { observation });

      while (task.step < this.limits.maxSteps) {
        current = task.step;
        // 1. Plan.
        const context = {
          objective: task.objective,
          observation,
          history: task.history.map(plannerHistoryView),
          step: task.step,
          maxSteps: this.limits.maxSteps,
        };
        let proposed;
        try {
          proposed = await bounded(this.planner.plan(context), this.limits.plannerTimeoutMs, 'planner');
        } catch (err) {
          if (err instanceof TimeoutError && remaining() <= 0) throw err;
          const retryable = err instanceof PlannerError ? err.retryable : err instanceof TimeoutError;
          await emit('planner_error', { error: err.message, code: err.code });
          task.step += 1;
          if (!retryable) return this._finish(task, emit, FAILURE.PLANNER_FAILED, `planner failed: ${err.message}`);
          if (noteError(err.code ?? 'planner_error', err.message)) return this._finish(task, emit, FAILURE.TOO_MANY_ERRORS, `planner kept failing: ${err.message}`);
          continue;
        }

        // 2. Validate against the observation the planner actually saw.
        let action;
        try {
          action = validateAction(proposed, { observation });
        } catch (err) {
          if (!(err instanceof ActionValidationError)) throw err;
          await emit('action_rejected', { proposed: safeJson(proposed), code: err.code, error: err.message });
          task.step += 1;
          if (noteError(err.code, err.message, safeJson(proposed))) return this._finish(task, emit, FAILURE.TOO_MANY_ERRORS, `repeated invalid actions; last: ${err.message}`);
          continue;
        }

        if (action.action === 'done') {
          task.step += 1;
          task.record({ step: current, action, outcome: 'done', url: observation?.url });
          if (action.success) {
            task.succeed(action.summary);
            await emit('task_end', { status: task.status, summary: task.summary });
            return task;
          }
          return this._finish(task, emit, FAILURE.OBJECTIVE_NOT_ACHIEVED, action.summary);
        }

        // 3. Loop protection (before spending an action).
        const before = fingerprintObservation(observation);
        try {
          guard.beforeAction(action, before);
        } catch (err) {
          if (err instanceof LoopGuardViolation) return this._finish(task, emit, err.code, err.message, { step: current, action, error: `${err.code}: refused` });
          throw err;
        }

        // 4. Risk + approval, immediately before execution.
        const risk = classifyAction(action, observation, this.policy);
        const sensitive = Boolean(action.ref && findElement(observation, action.ref)?.sensitive);
        await emit('action_proposed', { action, sensitive, risk });
        const decision = await this.gate.check({ ...risk, action, observation });
        if (!decision.approved) {
          await emit('action_denied', { action, sensitive, risk, note: decision.note });
          task.step += 1;
          if (noteError('approval_denied', `${risk.level} action denied (${risk.reasons.join('; ')})`, redactAction(action, sensitive))) {
            return this._finish(task, emit, FAILURE.TOO_MANY_ERRORS, 'too many denied or failed actions');
          }
          continue;
        }

        // 5. Execute.
        let result;
        try {
          ({ result } = await bounded(this.executor.execute(action, { observation, timeoutMs: this.limits.actionTimeoutMs }), this.limits.actionTimeoutMs + 1_000, `action ${action.action}`));
        } catch (err) {
          if (err instanceof TimeoutError && remaining() <= 0) throw err;
          if (!this.controller.isLaunched) throw new BrowserError(`browser died during ${action.action}: ${err.message}`, { code: 'browser_crashed' });
          await emit('action_failed', { action, sensitive, error: err.message, code: err.code });
          task.step += 1;
          if (noteError(err.code ?? 'action_failed', err.message, redactAction(action, sensitive))) return this._finish(task, emit, FAILURE.TOO_MANY_ERRORS, `repeated action failures; last: ${err.message}`);
          // Refresh the observation: a failed click may still have changed the page.
          observation = await bounded(this.executor.observe(), this.limits.actionTimeoutMs, 'observe');
          continue;
        }
        consecutiveErrors = 0;

        // 6. Observe the result (always fresh, so refs match the next plan).
        const urlBefore = observation.url;
        observation = action.action === 'observe'
          ? result.observation
          : action.action === 'screenshot' ? observation : await bounded(this.executor.observe(), this.limits.actionTimeoutMs, 'observe');
        task.step += 1;
        task.record({
          step: current,
          action: redactAction(action, sensitive),
          outcome: summarizeResult(action, result),
          url: urlBefore,
          urlAfter: observation.url,
          risk: risk.level,
        });
        await emit('action_executed', { action, sensitive, risk: risk.level, result: summarizeResult(action, result), observation });

        try {
          guard.afterAction(action, before, fingerprintObservation(observation));
        } catch (err) {
          if (err instanceof LoopGuardViolation) return this._finish(task, emit, err.code, err.message);
          throw err;
        }
      }
      return this._finish(task, emit, FAILURE.MAX_STEPS, `reached the maximum of ${this.limits.maxSteps} steps without finishing`);
    } catch (err) {
      if (err instanceof TimeoutError && remaining() <= 0) {
        return this._finish(task, emit, FAILURE.TASK_TIMEOUT, `task exceeded ${this.limits.taskTimeoutMs}ms`);
      }
      const code = err instanceof BrowserError || err instanceof TimeoutError ? FAILURE.BROWSER_FAILED : 'internal_error';
      return this._finish(task, emit, code, err.message);
    } finally {
      if (this.ownsController) await this.controller.close();
      await audit.write('browser_closed', { taskId: task.id, owned: this.ownsController });
    }
  }

  async _finish(task, emit, code, message, historyEntry) {
    if (historyEntry) task.record(historyEntry);
    task.fail(code, message);
    await emit('task_end', { status: task.status, failure: task.failure });
    return task;
  }
}

/** Run one objective with a fresh browser. Convenience for scripts. */
export async function runOperator(objective, options) {
  return new Operator(options).run(objective);
}

function plannerHistoryView(h) {
  return { step: h.step, action: h.action, outcome: h.outcome, error: h.error, url: h.url, urlAfter: h.urlAfter };
}

function summarizeResult(action, result) {
  switch (action.action) {
    case 'navigate': return `loaded ${result.url}${result.status ? ` (HTTP ${result.status})` : ''}`;
    case 'click_ref': return `clicked; now at ${result.url}`;
    case 'type_ref': return `typed ${result.chars} chars${result.submitted ? ' and submitted' : ''}`;
    case 'observe': return 'observed';
    case 'screenshot': return `saved ${result.path}`;
    default: return 'ok';
  }
}

function safeJson(value) {
  try {
    const s = JSON.stringify(value);
    return s && s.length > 500 ? `${s.slice(0, 500)}…` : JSON.parse(s ?? 'null');
  } catch {
    return String(value).slice(0, 200);
  }
}
