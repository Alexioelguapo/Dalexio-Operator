// Approval gate: decides whether a classified action may run.
//
// GREEN runs automatically. AMBER asks an approver. RED asks for an explicit
// typed confirmation *immediately* before execution; the gate is invoked by the
// operator right before the executor call, never ahead of time, and a RED
// approval is single-use (it is not cached for later steps).
//
// Approvers are pluggable so the same gate works in a terminal, a web UI, a
// chat surface, or tests:
//
//   approver({ level, action, reasons, observation, summary, signal })
//     → Promise<boolean | { approved, note }>
//
// `summary` is describeAction()'s sanitized, human-readable description
// (operation, site, target, payload, and for RED: consequence and amount).
// `signal` aborts when the gate's approval timeout expires.
//
// There is deliberately no "approve every RED action" helper. Each RED step
// needs its own fresh, explicit confirmation.

import { createInterface } from 'node:readline/promises';
import { RISK } from './policy.js';
import { describeAction, formatApprovalPrompt } from './describe.js';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

export const RED_CONFIRMATION_PHRASE = 'CONFIRM';

/** Denies everything that is not GREEN. Safe default for unattended runs. */
export const denyAll = async () => ({ approved: false, note: 'no approver configured (unattended run)' });

/** Approves AMBER, denies RED. Useful for supervised automation. */
export const approveAmberOnly = async ({ level }) =>
  level === RISK.AMBER ? { approved: true, note: 'auto-approved AMBER' } : { approved: false, note: 'RED requires a human' };

/**
 * Interactive terminal approver. Falls back to deny when stdin is not a TTY.
 * @param {object} [opts]
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 * @param {boolean} [opts.interactive]  Override TTY detection (tests, wrappers).
 */
export function terminalApprover({ input = process.stdin, output = process.stderr, interactive } = {}) {
  return async ({ level, action, reasons = [], observation, summary, signal }) => {
    if (!(interactive ?? input.isTTY)) return { approved: false, note: 'stdin is not interactive' };
    if (input.readableEnded || input.destroyed) return { approved: false, note: 'terminal: input closed' };
    const view = summary ?? describeAction(action, observation, { level, reasons });
    const rl = createInterface({ input, output, terminal: false });
    // EOF (Ctrl-D, a closed pipe) must end the prompt as a denial, not hang it.
    const closed = new Promise((_, reject) => rl.once('close', () => reject(new Error('input closed'))));
    closed.catch(() => {});
    const ask = (q) => Promise.race([rl.question(q, { signal }), closed]);
    try {
      output.write(`${formatApprovalPrompt(view)}\n`);
      if (level === RISK.RED) {
        const answer = await ask(`Type ${RED_CONFIRMATION_PHRASE} to execute this RED action now, anything else to deny: `);
        const approved = answer.trim() === RED_CONFIRMATION_PHRASE;
        output.write(approved ? 'Confirmed for this single step.\n' : 'Denied.\n');
        return { approved, note: approved ? 'terminal: typed confirmation' : 'terminal: not confirmed' };
      }
      const answer = await ask('Approve? [y/N] ');
      const approved = /^y(es)?$/i.test(answer.trim());
      output.write(approved ? 'Approved.\n' : 'Denied.\n');
      return { approved, note: approved ? 'terminal: approved' : 'terminal: denied' };
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return { approved: false, note: 'approval timed out' };
      // Closed input (EOF) is a denial, never an approval.
      return { approved: false, note: `terminal: ${err?.message ?? 'input closed'}` };
    } finally {
      rl.close();
    }
  };
}

export class ApprovalGate {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.approver]     Handles AMBER and (by default) RED.
   * @param {Function} [opts.redApprover]  Optional separate handler for RED.
   * @param {number} [opts.timeoutMs]       Unanswered approvals are denied after this long.
   */
  constructor({ approver = denyAll, redApprover, timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS } = {}) {
    this.approver = approver;
    this.redApprover = redApprover ?? approver;
    this.timeoutMs = timeoutMs;
  }

  /** @returns {Promise<{ approved: boolean, level: string, note?: string }>} */
  async check({ level, action, reasons = [], observation, summary }) {
    if (level === RISK.GREEN) return { approved: true, level, note: 'auto' };
    // Unknown levels are treated as RED: fail closed.
    const effective = level === RISK.AMBER ? RISK.AMBER : RISK.RED;
    const handler = effective === RISK.RED ? this.redApprover : this.approver;
    const view = summary ?? safeDescribe(action, observation, { level: effective, reasons });
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ approved: false, note: 'approval timed out' }); }, this.timeoutMs);
    });
    let decision;
    try {
      decision = await Promise.race([
        handler({ level: effective, action, reasons, observation, summary: view, signal: controller.signal }),
        timedOut,
      ]);
    } catch (err) {
      return { approved: false, level: effective, note: `approver error: ${err.message}` };
    } finally {
      clearTimeout(timer);
    }
    level = effective;
    // Anything other than an explicit true is a denial.
    if (typeof decision === 'boolean') return { approved: decision === true, level };
    return { approved: decision?.approved === true, level, note: decision?.note };
  }
}

function safeDescribe(action, observation, risk) {
  try {
    return describeAction(action ?? {}, observation, risk);
  } catch {
    return { level: risk.level, operation: String(action?.action ?? 'unknown'), site: '(unknown)', target: null, payload: null, reasons: risk.reasons };
  }
}
