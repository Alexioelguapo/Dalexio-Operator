import { randomUUID } from 'node:crypto';

export const TASK_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
});

/** In-memory record of one operator run. Serializable via toJSON(). */
export class TaskState {
  constructor(objective, { id = randomUUID() } = {}) {
    this.id = id;
    this.objective = objective;
    this.status = TASK_STATUS.RUNNING;
    this.step = 0;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.history = [];
    this.failure = null; // { code, message }
    this.summary = null;
  }

  /** Append one step to history. Entries are what planners see as `history`. */
  record(entry) {
    this.history.push({ step: this.step, at: Date.now(), ...entry });
  }

  succeed(summary) {
    this.status = TASK_STATUS.SUCCEEDED;
    this.summary = summary;
    this.endedAt = Date.now();
  }

  fail(code, message) {
    this.status = TASK_STATUS.FAILED;
    this.failure = { code, message };
    this.summary ??= message;
    this.endedAt = Date.now();
  }

  get elapsedMs() {
    return (this.endedAt ?? Date.now()) - this.startedAt;
  }

  toJSON() {
    return {
      id: this.id,
      objective: this.objective,
      status: this.status,
      steps: this.step,
      elapsedMs: this.elapsedMs,
      summary: this.summary,
      failure: this.failure,
      history: this.history,
    };
  }
}
