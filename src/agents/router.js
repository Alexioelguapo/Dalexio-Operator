// Planner factory and fallback router.
//
// createPlanner('mock' | 'claude' | 'openai' | 'openrouter', options) builds a
// planner by name. RouterPlanner tries planners in order and falls through to
// the next one on infrastructure failures (auth, quota, network, refusal), but
// never on a successfully returned action — validation is the operator's job.

import { Planner, PlannerError } from './planner.js';
import { MockPlanner } from './mock-planner.js';
import { ClaudePlanner } from './claude-planner.js';
import { OpenAIPlanner, OpenRouterPlanner } from './openai-planner.js';

const FACTORIES = {
  mock: (o) => new MockPlanner(o),
  claude: (o) => new ClaudePlanner(o),
  openai: (o) => new OpenAIPlanner(o),
  openrouter: (o) => new OpenRouterPlanner(o),
};

export function registerPlanner(name, factory) {
  FACTORIES[name] = factory;
}

export function availablePlanners() {
  return Object.keys(FACTORIES);
}

/** Build a planner by name; "a,b,c" builds a RouterPlanner over each. */
export function createPlanner(spec = 'mock', options = {}) {
  const names = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  const build = (name) => {
    const factory = FACTORIES[name];
    if (!factory) throw new Error(`unknown planner "${name}". Available: ${availablePlanners().join(', ')}`);
    return factory(options[name] ?? {});
  };
  return names.length === 1 ? build(names[0]) : new RouterPlanner(names.map(build));
}

const FALLTHROUGH_CODES = new Set(['auth_error', 'quota_exhausted', 'network_error', 'api_error', 'refusal', 'missing_dependency', 'config_error']);

export class RouterPlanner extends Planner {
  constructor(planners) {
    super(`router(${planners.map((p) => p.name).join('→')})`);
    if (!planners.length) throw new Error('RouterPlanner needs at least one planner');
    this.planners = planners;
    this.lastUsed = null;
  }

  async plan(context) {
    const errors = [];
    for (const planner of this.planners) {
      try {
        const action = await planner.plan(context);
        this.lastUsed = planner.name;
        return action;
      } catch (err) {
        errors.push(`${planner.name}: ${err.message}`);
        if (!(err instanceof PlannerError) || !FALLTHROUGH_CODES.has(err.code)) throw err;
      }
    }
    throw new PlannerError(`all planners failed — ${errors.join(' | ')}`, { code: 'all_planners_failed' });
  }
}
