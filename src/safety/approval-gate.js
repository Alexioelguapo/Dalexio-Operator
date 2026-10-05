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
//   approver({ level, action, reasons, observation }) → Promise<boolean | { approved, note }>

import { createInterface } from 'node:readline/promises';
import { RISK } from './policy.js';

export const RED_CONFIRMATION_PHRASE = 'CONFIRM';

/** Denies everything that is not GREEN. Safe default for unattended runs. */
export const denyAll = async () => ({ approved: false, note: 'no approver configured (unattended run)' });

/** Approves AMBER, denies RED. Useful for supervised automation. */
export const approveAmberOnly = async ({ level }) =>
  level === RISK.AMBER ? { approved: true, note: 'auto-approved AMBER' } : { approved: false, note: 'RED requires a human' };

/** Interactive terminal approver. Falls back to deny when stdin is not a TTY. */
export function terminalApprover({ input = process.stdin, output = process.stderr } = {}) {
  return async ({ level, action, reasons }) => {
    if (!input.isTTY) return { approved: false, note: 'stdin is not interactive' };
    const rl = createInterface({ input, output });
    try {
      output.write(`\n[${level}] The agent wants to run: ${JSON.stringify(action)}\n`);
      for (const r of reasons) output.write(`  - ${r}\n`);
      if (level === RISK.RED) {
        const answer = await rl.question(`Type ${RED_CONFIRMATION_PHRASE} to execute this RED action now, anything else to deny: `);
        return { approved: answer.trim() === RED_CONFIRMATION_PHRASE, note: 'terminal' };
      }
      const answer = await rl.question('Approve? [y/N] ');
      return { approved: /^y(es)?$/i.test(answer.trim()), note: 'terminal' };
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
   */
  constructor({ approver = denyAll, redApprover } = {}) {
    this.approver = approver;
    this.redApprover = redApprover ?? approver;
  }

  /** @returns {Promise<{ approved: boolean, level: string, note?: string }>} */
  async check({ level, action, reasons = [], observation }) {
    if (level === RISK.GREEN) return { approved: true, level, note: 'auto' };
    const handler = level === RISK.RED ? this.redApprover : this.approver;
    let decision;
    try {
      decision = await handler({ level, action, reasons, observation });
    } catch (err) {
      return { approved: false, level, note: `approver error: ${err.message}` };
    }
    // Anything other than an explicit true is a denial.
    if (typeof decision === 'boolean') return { approved: decision === true, level };
    return { approved: decision?.approved === true, level, note: decision?.note };
  }
}
