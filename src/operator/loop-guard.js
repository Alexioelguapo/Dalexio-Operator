// Detects an agent that is going in circles.
//
// Three independent signals, each with its own limit:
//   repeated_action  – the same action on the same page state, again and again
//   stuck_page_state – state-changing actions that leave the page unchanged
//   page_state_loop  – revisiting the same page state too often (A→B→A→B…)

import { actionSignature } from '../actions/schema.js';

export const DEFAULT_GUARD_LIMITS = Object.freeze({
  maxRepeatedActions: 2,   // identical action on identical state may run this many times
  maxStagnantSteps: 3,     // consecutive state-changing actions with no page change
  maxStateVisits: 4,       // times a page state may be re-entered via an action
});

const STATE_CHANGING = new Set(['navigate', 'click_ref', 'type_ref']);

export class LoopGuardViolation extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LoopGuardViolation';
    this.code = code;
  }
}

export class LoopGuard {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_GUARD_LIMITS, ...limits };
    this.actionCounts = new Map();
    this.stateVisits = new Map();
    this.stagnant = 0;
  }

  /** Call before executing. Throws if this exact action has run too often here. */
  beforeAction(action, fingerprint) {
    const key = `${actionSignature(action)}@${fingerprint}`;
    const n = this.actionCounts.get(key) ?? 0;
    if (n >= this.limits.maxRepeatedActions) {
      throw new LoopGuardViolation('repeated_action',
        `refusing to repeat ${actionSignature(action)} a ${ordinal(n + 1)} time on an unchanged page`);
    }
    this.actionCounts.set(key, n + 1);
  }

  /** Call after executing with the page fingerprints before and after. */
  afterAction(action, before, after) {
    if (!STATE_CHANGING.has(action.action)) return;
    // Typing without submitting legitimately changes only an input value.
    if (before === after) {
      this.stagnant += 1;
      if (this.stagnant >= this.limits.maxStagnantSteps) {
        throw new LoopGuardViolation('stuck_page_state',
          `${this.stagnant} consecutive actions did not change the page`);
      }
      return;
    }
    this.stagnant = 0;
    const visits = (this.stateVisits.get(after) ?? 0) + 1;
    this.stateVisits.set(after, visits);
    if (visits > this.limits.maxStateVisits) {
      throw new LoopGuardViolation('page_state_loop',
        `returned to the same page state ${visits} times`);
    }
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
