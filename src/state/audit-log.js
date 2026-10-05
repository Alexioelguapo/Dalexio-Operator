// Append-only JSONL audit log, one file per task.
//
// Typed text is never written verbatim for sensitive fields, and is truncated
// otherwise, so the log is safe to keep alongside the repo (it is gitignored).

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class AuditLog {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.dir]  Directory for JSONL files; null keeps events in memory only.
   * @param {string} opts.taskId
   */
  constructor({ dir = '.dalexio/runs', taskId }) {
    this.dir = dir;
    this.file = dir ? path.join(dir, `${taskId}.jsonl`) : null;
    this.events = [];
    this._ready = null;
  }

  async write(type, data = {}) {
    const event = { ts: new Date().toISOString(), type, ...sanitize(data) };
    this.events.push(event);
    if (!this.file) return event;
    try {
      this._ready ??= mkdir(this.dir, { recursive: true });
      await this._ready;
      await appendFile(this.file, `${JSON.stringify(event)}\n`);
    } catch {
      // Logging must never break a run; the in-memory copy is still available.
    }
    return event;
  }
}

/** Redact typed text in actions; drop bulky observation bodies. */
export function sanitize(data) {
  const out = { ...data };
  if (out.action) out.action = redactAction(out.action, out.sensitive);
  delete out.sensitive;
  if (out.observation) {
    const o = out.observation;
    out.observation = { url: o.url, title: o.title, elements: o.elements?.length ?? 0 };
  }
  return out;
}

export function redactAction(action, sensitive) {
  if (!action || action.action !== 'type_ref' || typeof action.text !== 'string') return action;
  if (sensitive) return { ...action, text: `[redacted ${action.text.length} chars]` };
  return action.text.length > 200 ? { ...action, text: `${action.text.slice(0, 200)}…` } : action;
}
