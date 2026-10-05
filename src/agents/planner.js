// Provider-neutral planner contract.
//
// A planner is any object with:
//
//   name: string
//   plan(context: PlannerContext): Promise<PlannerAction>
//
// PlannerContext (built by the operator, identical for every provider):
//   {
//     objective:   string,             // the user's task
//     observation: Observation,        // compact page state (see browser/observation.js)
//     history:     HistoryEntry[],     // prior steps: { step, action, outcome, error?, url }
//     step:        number,             // 0-based index of the step being planned
//     maxSteps:    number,
//   }
//
// PlannerAction is exactly ONE action object from actions/schema.js, e.g.
//   { action: 'click_ref', ref: 'link-0', reason: 'English edition' }
//
// The operator validates every returned action; planners do not need to
// (and must not be trusted to) validate their own output.

export class Planner {
  constructor(name) {
    this.name = name;
  }

  // eslint-disable-next-line no-unused-vars
  async plan(context) {
    throw new Error(`${this.constructor.name}.plan() is not implemented`);
  }
}

export class PlannerError extends Error {
  constructor(message, { code = 'planner_error', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'PlannerError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function assertPlanner(planner) {
  if (!planner || typeof planner.plan !== 'function') {
    throw new TypeError('planner must implement plan(context) → Promise<action>');
  }
  return planner;
}
