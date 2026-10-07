// The observe → plan → validate → classify → approve → re-check → execute loop.

import path from 'node:path';
import { BrowserController, BrowserError } from '../browser/controller.js';
import { BrowserExecutor } from '../browser/executor.js';
import { fingerprintObservation } from '../browser/observation.js';
import { validateAction, ActionValidationError, findElement } from '../actions/schema.js';
import { assertPlanner, PlannerError } from '../agents/planner.js';
import { classifyAction, RISK } from '../safety/policy.js';
import { ApprovalGate } from '../safety/approval-gate.js';
import { describeAction } from '../safety/describe.js';
import { FileRegistry } from '../files/registry.js';
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
  INVALID_FILE: 'invalid_file',
});

const ORDER = { GREEN: 0, AMBER: 1, RED: 2 };

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
   * @param {string[]} [opts.files]                 Paths the user explicitly allows upload_file to use.
   * @param {string[]|null} [opts.managedUploadDirs] Folders whose top-level files are offered for upload
   *   (default: the profile's `.dalexio/uploads/<profile>`; null disables).
   * @param {(event: object) => void} [opts.onEvent] Progress callback.
   */
  constructor({ planner, controller, browserOptions, gate, policy, limits, auditDir = '.dalexio/runs', startUrl, files = [], managedUploadDirs, onEvent } = {}) {
    this.planner = assertPlanner(planner);
    this.ownsController = !controller;
    this.controller = controller ?? new BrowserController(browserOptions);
    this.files = new FileRegistry({ root: this.controller.options.stateRoot });
    this.userFiles = [...files];
    this.managedUploadDirs = managedUploadDirs === undefined ? [defaultUploadsDir(this.controller)] : managedUploadDirs ?? [];
    this.executor = new BrowserExecutor(this.controller, { files: this.files });
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

    await emit('task_start', {
      objective: task.objective,
      planner: this.planner.name,
      profile: this.controller.profile ?? null,
      limits: this.limits,
    });

    // Upload sources are fixed before the browser starts; the planner can
    // never add to them.
    try {
      for (const f of this.userFiles) await this.files.addUserFile(f);
      for (const dir of this.managedUploadDirs) await this.files.addManagedDir(dir);
    } catch (err) {
      const failed = await this._finish(task, emit, FAILURE.INVALID_FILE, err.message);
      await audit.write('browser_closed', { taskId: task.id, owned: this.ownsController, launched: false });
      return failed;
    }
    if (this.files.list().length) await emit('files_available', { files: this.files.list().map(({ id, name, bytes, source }) => ({ id, name, bytes, source })) });

    let reading = null; // most recent read_page / read_ref result, shown to the planner

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
          files: this.files.list(),
          reading,
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
        const summary = risk.level === RISK.GREEN ? null : describeAction(action, observation, risk, { files: this.files });
        if (summary) await emit('approval_requested', { level: risk.level, summary });
        const decision = await this.gate.check({ ...risk, action, observation, summary });
        if (!decision.approved) {
          await emit('action_denied', { action, sensitive, risk, note: decision.note });
          task.step += 1;
          if (noteError('approval_denied', `${risk.level} action denied (${risk.reasons.join('; ')})`, redactAction(action, sensitive))) {
            return this._finish(task, emit, FAILURE.TOO_MANY_ERRORS, 'too many denied or failed actions');
          }
          continue;
        }

        // 4b. An approval covers what the human saw. Re-read the page and make
        // sure the target is still the same element and the action is not now
        // riskier (pages change while people read prompts).
        if (risk.level !== RISK.GREEN) {
          const fresh = await bounded(this.executor.observe(), this.limits.actionTimeoutMs, 'observe');
          const problem = recheckApproved(action, observation, fresh, risk, this.policy);
          observation = fresh;
          if (problem) {
            await emit('action_invalidated', { action, sensitive, risk, error: problem });
            task.step += 1;
            if (noteError('approval_invalidated', problem, redactAction(action, sensitive))) return this._finish(task, emit, FAILURE.TOO_MANY_ERRORS, `approval invalidated: ${problem}`);
            continue;
          }
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
        if (result.reading) {
          reading = result.reading;
          await emit('page_read', { url: reading.url, ref: reading.ref, chars: reading.chars ?? reading.text?.length ?? 0, find: reading.find });
        }
        if (result.download) await emit('file_downloaded', { ref: action.ref, download: result.download });
        if (action.action === 'upload_file') await emit('file_uploaded', { ref: action.ref, file: result.file });

        // 6. Observe the result (always fresh, so refs match the next plan).
        const urlBefore = observation.url;
        observation = action.action === 'observe'
          ? result.observation
          : PASSIVE.has(action.action) ? observation : await bounded(this.executor.observe(), this.limits.actionTimeoutMs, 'observe');
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

// Actions that cannot change the page, so the old observation stays valid.
const PASSIVE = new Set(['screenshot', 'read_page', 'read_ref']);

function defaultUploadsDir(controller) {
  const { stateRoot } = controller.options;
  return controller.profilePaths?.uploadsDir ?? path.join(stateRoot, 'uploads', '_stateless');
}

/** Returns why an approved action no longer matches the page, or null. */
export function recheckApproved(action, approvedObs, freshObs, risk, policy) {
  try {
    validateAction(action, { observation: freshObs });
  } catch (err) {
    return `page changed after approval: ${err.message}`;
  }
  if (action.ref) {
    const before = findElement(approvedObs, action.ref);
    const now = findElement(freshObs, action.ref);
    if (!before || !now || before.kind !== now.kind || before.label !== now.label) {
      return `target ${action.ref} changed after approval (was ${JSON.stringify(before?.label ?? null)}, now ${JSON.stringify(now?.label ?? null)})`;
    }
  }
  const again = classifyAction(action, freshObs, policy);
  if (ORDER[again.level] > ORDER[risk.level]) return `action is now ${again.level} (${again.reasons.join('; ')}); it was approved as ${risk.level}`;
  return null;
}

function plannerHistoryView(h) {
  return { step: h.step, action: h.action, outcome: h.outcome, error: h.error, url: h.url, urlAfter: h.urlAfter };
}

function summarizeResult(action, result) {
  switch (action.action) {
    case 'navigate': return `loaded ${result.url}${result.status ? ` (HTTP ${result.status})` : ''}`;
    case 'click_ref': return `clicked; now at ${result.url}`;
    case 'type_ref': return `typed ${result.chars} chars${result.submitted ? ' and submitted' : ''}`;
    case 'select_option': return `selected ${JSON.stringify(result.selected)}`;
    case 'set_checked': return result.checked ? 'ticked' : 'unticked';
    case 'upload_file': return `attached ${JSON.stringify(result.file.name)} (${result.file.bytes} bytes); not submitted`;
    case 'download_ref': {
      const d = result.download;
      return `downloaded ${JSON.stringify(d.filename)} (${d.mimeType}, ${d.bytes} bytes) to ${d.dir}; available as ${d.fileId}`;
    }
    case 'read_page': {
      const r = result.reading;
      if (r.find !== undefined) return `read: ${r.matches} match(es) for ${JSON.stringify(r.find)} (latest read is shown below)`;
      return `read ${r.chars} of ${r.totalChars} chars${r.nextOffset !== null ? `; next offset ${r.nextOffset}` : '; end of page'} (latest read is shown below)`;
    }
    case 'read_ref': return `read ${result.reading.ref} (latest read is shown below)`;
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
