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
  { re: /\b(settings|preferences|account|profile|privacy)\b/i, why: 'account settings' },
  { re: /\b(log ?in|sign ?in)\b/i, why: 'authentication' },
];

// Actions that are not implemented yet but whose risk class is fixed now, so
// the gate is already in place when they are added.
export const ACTION_BASE_RISK = Object.freeze({
  navigate: RISK.GREEN,
  observe: RISK.GREEN,
  screenshot: RISK.GREEN,
  read: RISK.GREEN,
  done: RISK.GREEN,
  click_ref: RISK.GREEN,
  type_ref: RISK.GREEN,
  // future
  upload_file: RISK.AMBER,
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
 * @param {object} [policy]     Extra rules: { blockedHosts: string[], redHosts: string[] }
 * @returns {{ level: 'GREEN'|'AMBER'|'RED', reasons: string[] }}
 */
export function classifyAction(action, observation, policy = {}) {
  let level = ACTION_BASE_RISK[action.action] ?? RISK.RED; // unknown → most restrictive
  const reasons = [];
  const raise = (to, why) => {
    if (ORDER[to] > ORDER[level]) level = to;
    if (to !== RISK.GREEN) reasons.push(`${to}: ${why}`);
  };
  if (!(action.action in ACTION_BASE_RISK)) reasons.push('RED: unrecognized action type');
  else if (level !== RISK.GREEN) reasons.push(`${level}: ${action.action} is ${level} by default`);

  if (action.action === 'navigate') {
    const host = safeHost(action.url);
    if (host && policy.redHosts?.some((h) => hostMatches(host, h))) raise(RISK.RED, `navigation to sensitive host ${host}`);
    return { level, reasons };
  }

  if (action.action === 'click_ref') {
    const el = findElement(observation, action.ref);
    if (!el) {
      raise(RISK.AMBER, 'target element unknown to the policy');
      return { level, reasons };
    }
    const label = `${el.label ?? ''}`;
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
    return { level, reasons };
  }

  if (action.action === 'type_ref') {
    const el = findElement(observation, action.ref);
    if (el?.sensitive === 'payment') raise(RISK.RED, 'entering payment details');
    else if (el?.sensitive === 'password' || el?.sensitive === 'otp') raise(RISK.AMBER, `entering a ${el.sensitive}`);
    if (action.submit) {
      const form = formOf(observation, el);
      const isSearch = form?.isSearch || el?.type === 'search';
      if (form?.hasPayment) raise(RISK.RED, 'submitting a form containing payment fields');
      else if (!isSearch) raise(RISK.AMBER, 'pressing Enter submits a non-search form');
    }
    return { level, reasons };
  }

  return { level, reasons };
}

function safeHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
function hostMatches(host, rule) {
  const r = rule.toLowerCase();
  return host === r || host.endsWith(`.${r}`);
}
