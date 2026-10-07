// Risk classification for planner actions.
//
// GREEN  – runs automatically.
// AMBER  – needs approval (submitting forms, sending/publishing, uploads,
//          account settings, creating external records).
// RED    – needs explicit typed confirmation immediately before execution
//          (payments, purchases, transfers, contracts/tenders, destructive
//          deletion, credential/security changes, anything irreversible).
//
// Classification is deliberately conservative: when an element's purpose is
// ambiguous but it submits a non-search form, it is AMBER, not GREEN. The
// policy only ever raises risk; nothing a planner says can lower it.
//
// Platform-specific knowledge (a particular site's "Post" button, say) does
// not belong here. Adapters add it through `policy.rules`, which can only
// raise risk, never lower it.

import { findElement } from '../actions/schema.js';

export const RISK = Object.freeze({ GREEN: 'GREEN', AMBER: 'AMBER', RED: 'RED' });
const ORDER = { GREEN: 0, AMBER: 1, RED: 2 };

export function maxRisk(a, b) {
  return ORDER[a] >= ORDER[b] ? a : b;
}

// Keyword rules are matched against the element label (and link href path).
// Order does not matter; the highest matching level wins.
export const RED_PATTERNS = [
  { re: /\b(pay|payment|pay now|checkout|check out|place (your )?order|confirm (order|purchase|payment)|complete (order|purchase)|buy( now)?|purchase|subscribe( now)?|add payment|donate)\b/i, why: 'payment or purchase' },
  { re: /\b(transfer|wire|send money|withdraw|remittance)\b/i, why: 'financial transfer' },
  { re: /\b(sign (the )?contract|e-?sign|accept (the )?contract|submit (the )?(tender|bid|proposal)|submit (application|filing|return))\b/i, why: 'contract, tender or official submission' },
  { re: /\b(delete|remove|erase|destroy|terminate|close account|deactivate|cancel (subscription|account|order)|wipe|purge)\b/i, why: 'destructive or irreversible action' },
  { re: /\b(change|reset|update) (your )?(password|passcode|pin|email|2fa|two.factor|security)\b|\b(disable|turn off) (2fa|two.factor|mfa)\b|\b(revoke|regenerate) (token|key|api key)\b/i, why: 'credential or security change' },
];

// Links are mostly navigation, so only imperative phrases escalate them
// (an article titled "Payment" is not a payment).
export const LINK_RED_PATTERNS = [
  { re: /\b(pay now|buy( now)?|checkout|check out|place (your )?order|complete (order|purchase)|confirm (order|purchase|payment)|send money|withdraw)\b/i, why: 'payment or purchase' },
  { re: /\b(delete|remove|close account|deactivate|cancel (subscription|account|order))\b/i, why: 'destructive or irreversible action' },
  { re: /\b(change|reset) (your )?(password|email|pin)\b|\b(disable|turn off) (2fa|two.factor|mfa)\b/i, why: 'credential or security change' },
];

export const AMBER_PATTERNS = [
  { re: /\b(submit|send|post|publish|reply|comment|tweet|share|upload|attach|save|apply|register|sign up|create|invite|book|reserve|confirm|follow|connect|request)\b/i, why: 'submits data or creates an external record' },
  { re: /\b(schedule|go live|broadcast|repost|retweet|boost|promote|release|send to|queue)\b/i, why: 'publishes or schedules content' },
  { re: /\b(settings|preferences|account|profile|privacy)\b/i, why: 'account settings' },
  { re: /\b(log ?in|sign ?in)\b/i, why: 'authentication' },
];

// Ticking these is agreeing to something on the user's behalf.
export const CONSENT_PATTERNS = [
  { re: /\b(i agree|agree to|accept|consent|terms|authori[sz]e|acknowledge)\b/i, why: 'gives consent or accepts terms' },
];

// Starting risk per action type. Element, form and label rules can only raise
// it. Entries without an implementation yet fix the class in advance.
export const ACTION_BASE_RISK = Object.freeze({
  navigate: RISK.GREEN,
  observe: RISK.GREEN,
  screenshot: RISK.GREEN,
  read: RISK.GREEN,
  read_page: RISK.GREEN,
  read_ref: RISK.GREEN,
  done: RISK.GREEN,
  click_ref: RISK.GREEN,
  type_ref: RISK.GREEN,
  select_option: RISK.GREEN,
  set_checked: RISK.GREEN,
  download_ref: RISK.GREEN,
  upload_file: RISK.AMBER,
  // future
  send_message: RISK.AMBER,
  submit_form: RISK.AMBER,
  download: RISK.AMBER,
  purchase: RISK.RED,
  payment: RISK.RED,
  delete: RISK.RED,
});

function matchPatterns(text, patterns) {
  if (!text) return null;
  for (const p of patterns) if (p.re.test(text)) return p.why;
  return null;
}

function formOf(observation, el) {
  return el?.form ? observation?.forms?.find((f) => f.id === el.form) ?? null : null;
}

/**
 * @param {object} action       A validated action.
 * @param {object} [observation] The observation the action refers to.
 * @param {object} [policy]     Extra rules:
 *   { blockedHosts?: string[], redHosts?: string[],
 *     rules?: Array<(ctx: { action, element, observation, host }) => null | { level, why }> }
 *   `rules` come from platform adapters; they can only raise risk.
 * @returns {{ level: 'GREEN'|'AMBER'|'RED', reasons: string[] }}
 */
export function classifyAction(action, observation, policy = {}) {
  let level = ACTION_BASE_RISK[action.action] ?? RISK.RED; // unknown → most restrictive
  const reasons = [];
  const raise = (to, why) => {
    if (!(to in ORDER)) to = RISK.RED; // a malformed level fails closed
    if (ORDER[to] > ORDER[level]) level = to;
    if (to !== RISK.GREEN) reasons.push(`${to}: ${why}`);
  };
  if (!(action.action in ACTION_BASE_RISK)) reasons.push('RED: unrecognized action type');
  else if (level !== RISK.GREEN) reasons.push(`${level}: ${action.action} is ${level} by default`);

  const element = action.ref ? findElement(observation, action.ref) : null;
  classifyByType(action, element, observation, policy, raise);
  applyRules(policy.rules, { action, element, observation, host: safeHost(action.url ?? observation?.url) }, raise);
  return { level, reasons };
}

function classifyByType(action, el, observation, policy, raise) {
  switch (action.action) {
    case 'navigate': {
      const host = safeHost(action.url);
      if (host && policy.redHosts?.some((h) => hostMatches(host, h))) raise(RISK.RED, `navigation to sensitive host ${host}`);
      return;
    }
    case 'click_ref':
    case 'download_ref':
      // A download is triggered by a click, so the clicked element gets the
      // same scrutiny: "Export and delete", or a form-submitting button, still escalates.
      if (!el) return raise(RISK.AMBER, 'target element unknown to the policy');
      return classifyClickTarget(el, observation, raise);
    case 'type_ref': {
      if (el?.sensitive === 'payment') raise(RISK.RED, 'entering payment details');
      else if (el?.sensitive === 'password' || el?.sensitive === 'otp') raise(RISK.AMBER, `entering a ${el.sensitive}`);
      if (action.submit) {
        const form = formOf(observation, el);
        const isSearch = form?.isSearch || el?.type === 'search';
        if (form?.hasPayment) raise(RISK.RED, 'submitting a form containing payment fields');
        else if (!isSearch) raise(RISK.AMBER, 'pressing Enter submits a non-search form');
      }
      return;
    }
    case 'select_option': {
      if (!el) return raise(RISK.AMBER, 'target element unknown to the policy');
      if (el.sensitive === 'payment') raise(RISK.RED, 'choosing payment details');
      // Choosing an option commits nothing, but an option that names a
      // consequential operation deserves a human look.
      const red = matchPatterns(`${action.option}`, RED_PATTERNS);
      if (red) raise(RISK.AMBER, `option names a ${red} ("${String(action.option).slice(0, 60)}")`);
      return;
    }
    case 'set_checked':
      if (!el) return raise(RISK.AMBER, 'target element unknown to the policy');
      return classifyToggle(el, raise);
    case 'upload_file':
      if (el?.sensitive === 'payment') raise(RISK.RED, 'uploading into a payment field');
      return;
    default:
      return;
  }
}

function classifyClickTarget(el, observation, raise) {
  const label = `${el.label ?? ''}`;
  if (el.kind === 'checkbox' || el.kind === 'radio') return classifyToggle(el, raise);
  const red = matchPatterns(label, el.kind === 'link' ? LINK_RED_PATTERNS : RED_PATTERNS);
  if (red) raise(RISK.RED, `${red} ("${label.slice(0, 60)}")`);
  const form = formOf(observation, el);
  const isSubmitter = el.kind === 'button' && (el.type === 'submit' || el.type === 'image') && form;
  if (isSubmitter) {
    if (form.hasPayment) raise(RISK.RED, 'submits a form containing payment fields');
    else if (form.hasPassword) raise(RISK.AMBER, 'submits a form containing a password');
    else if (!form.isSearch) raise(RISK.AMBER, `submits form ${form.id} (${form.method.toUpperCase()})`);
  }
  if (el.kind === 'button') {
    const amber = matchPatterns(label, AMBER_PATTERNS);
    if (amber && !(form?.isSearch && /\b(search|go|find)\b/i.test(label))) raise(RISK.AMBER, `${amber} ("${label.slice(0, 60)}")`);
  } else if (el.kind === 'link') {
    // Ordinary links are GREEN (reading is harmless; RED labels were handled
    // above). Script-driven links can do anything, so they need approval.
    if (el.href === 'javascript:') raise(RISK.AMBER, 'javascript: link with unknown effect');
  }
}

// Toggling a box commits nothing by itself, so even scary labels are AMBER
// here; the click that submits the form is classified on its own.
function classifyToggle(el, raise) {
  const label = `${el.label ?? ''}`;
  const why = matchPatterns(label, CONSENT_PATTERNS) ?? matchPatterns(label, RED_PATTERNS);
  if (why) raise(RISK.AMBER, `${why} ("${label.slice(0, 60)}")`);
}

function applyRules(rules, ctx, raise) {
  if (!rules?.length) return;
  for (const rule of rules) {
    let verdict;
    try {
      verdict = rule(ctx);
    } catch (err) {
      raise(RISK.RED, `policy rule failed: ${String(err?.message ?? err).slice(0, 100)}`);
      continue;
    }
    if (verdict && verdict.level !== RISK.GREEN) raise(verdict.level, verdict.why ?? 'policy rule');
  }
}

function safeHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
export { safeHost as hostOf };
function hostMatches(host, rule) {
  const r = rule.toLowerCase();
  return host === r || host.endsWith(`.${r}`);
}
