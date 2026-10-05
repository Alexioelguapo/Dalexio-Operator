// Deterministic planners that need no model and no network credentials.

import { Planner } from './planner.js';

/**
 * Heuristic planner for demos and offline runs.
 *
 * Understands objectives shaped like:
 *   "Open English Wikipedia"           → click the link best matching the words
 *   "Go to https://example.com"        → navigate
 *   "Search for <query>"               → type into the first search box + Enter
 *
 * It finishes with `done` once the page changes after its action, or gives up
 * (done, success=false) if nothing on the page matches.
 */
export class MockPlanner extends Planner {
  constructor() {
    super('mock');
  }

  async plan({ objective, observation, history }) {
    const acted = history.filter((h) => !['observe', 'screenshot'].includes(h.action?.action) && !h.error);
    const lastActed = acted.at(-1);

    if (lastActed) {
      const changed = lastActed.urlAfter && lastActed.urlAfter !== lastActed.url;
      return {
        action: 'done',
        success: true,
        summary: changed
          ? `Reached "${observation?.title ?? ''}" (${observation?.url ?? ''}).`
          : `Performed ${lastActed.action.action}; page is "${observation?.title ?? ''}".`,
      };
    }

    const url = objective.match(/https?:\/\/[^\s"']+/i)?.[0];
    if (url) return { action: 'navigate', url, reason: 'objective names a URL' };

    if (!observation) return { action: 'observe', reason: 'need page state' };

    const search = objective.match(/^\s*search(?: for)?\s+(.+)$/i);
    if (search) {
      const box = observation.elements.find((e) => e.kind === 'input' && (e.type === 'search' || /search|query|^q$/i.test(`${e.name ?? ''} ${e.label} ${e.placeholder ?? ''}`)));
      if (box) return { action: 'type_ref', ref: box.ref, text: search[1].trim(), submit: true, reason: 'search box' };
    }

    const target = bestLinkMatch(objective, observation.elements);
    if (target) return { action: 'click_ref', ref: target.ref, reason: `best match for objective: "${target.label}"` };

    return { action: 'done', success: false, summary: 'No element on the page matches the objective.' };
  }
}

const STOPWORDS = new Set(['open', 'go', 'to', 'the', 'a', 'an', 'click', 'visit', 'navigate', 'page', 'link', 'on', 'please']);

export function bestLinkMatch(objective, elements) {
  const words = objective.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOPWORDS.has(w));
  if (!words.length) return null;
  let best = null;
  let bestScore = 0;
  for (const el of elements) {
    if ((el.kind !== 'link' && el.kind !== 'button') || el.disabled) continue;
    const hay = `${el.label} ${el.href ?? ''}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 1;
    // Prefer exact-ish label matches and visible elements.
    if (el.label.toLowerCase().startsWith(words[0])) score += 0.5;
    if (el.offscreen) score -= 0.25;
    if (score > bestScore) { best = el; bestScore = score; }
  }
  return bestScore >= 1 ? best : null;
}

/** Replays a fixed list of actions (or functions of the context). For tests. */
export class ScriptedPlanner extends Planner {
  constructor(script, { name = 'scripted', repeatLast = false } = {}) {
    super(name);
    this.script = [...script];
    this.repeatLast = repeatLast;
    this.calls = [];
  }

  async plan(context) {
    this.calls.push(context);
    const i = Math.min(this.calls.length - 1, this.repeatLast ? this.script.length - 1 : Infinity);
    const next = this.script[i];
    if (next === undefined) return { action: 'done', success: false, summary: 'script exhausted' };
    return typeof next === 'function' ? next(context) : next;
  }
}
