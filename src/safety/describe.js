// Human-readable, sanitized description of a proposed action, for approvers.
//
// describeAction() is the single source of what a human is shown before they
// approve something: the terminal approver renders it, and programmatic or UI
// approvers receive the same object as `summary`. It never includes text typed
// into sensitive fields, local file paths, or anything from cookies/storage.

import { findElement } from '../actions/schema.js';
import { RISK, hostOf } from './policy.js';

const TEXT_PREVIEW = 120;

// Plain-language consequence per RED reason family.
const CONSEQUENCES = [
  { re: /payment|purchase|financial|transfer|monetary/i, text: 'Money will be spent or moved. This may not be reversible.' },
  { re: /destructive|irreversible|delet/i, text: 'Data or an account may be permanently deleted or closed. This is likely irreversible.' },
  { re: /credential|security/i, text: 'Account security settings will change. You could lose access to the account.' },
  { re: /contract|tender|official/i, text: 'Creates a binding legal or official submission in your name.' },
  { re: /sensitive host/i, text: 'Opens a site you marked as sensitive.' },
];

const CURRENCY = /(?:[$€£¥₹₦₩]|\b(?:USD|EUR|GBP|ZAR|ZWL|CAD|AUD|NGN|KES|INR|JPY)\s?)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|ZAR|CAD|AUD|NGN|KES|INR|JPY)\b/g;

/**
 * @param {object} action        Validated action.
 * @param {object} [observation] Observation the action targets.
 * @param {{ level: string, reasons: string[] }} risk
 * @param {{ files?: import('../files/registry.js').FileRegistry }} [ctx]
 */
export function describeAction(action, observation, risk, { files } = {}) {
  const el = action.ref ? findElement(observation, action.ref) : null;
  const form = el?.form ? observation?.forms?.find((f) => f.id === el.form) : null;
  const summary = {
    level: risk.level,
    operation: operationText(action, el, files),
    site: hostOf(action.url ?? observation?.url) || '(unknown)',
    pageUrl: observation?.url ?? null,
    target: el ? targetInfo(el, form) : null,
    payload: payloadSummary(action, el, files),
    reasons: [...risk.reasons],
  };
  if (risk.level === RISK.RED) {
    summary.consequence = consequenceFor(risk.reasons);
    summary.amount = detectAmount(el, observation);
  }
  return summary;
}

function quote(s, n = 80) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return JSON.stringify(t.length > n ? `${t.slice(0, n - 1)}…` : t);
}

function elementName(el) {
  if (!el) return 'an element';
  return `${el.kind} ${quote(el.label || el.placeholder || el.name || el.ref)}`;
}

function operationText(action, el, files) {
  switch (action.action) {
    case 'navigate': return `Open ${action.url}`;
    case 'click_ref': return `Click ${elementName(el)}`;
    case 'download_ref': return `Download the file behind ${elementName(el)}`;
    case 'type_ref': return `Type ${action.text.length} characters into ${elementName(el)}${action.submit ? ' and press Enter (submits)' : ''}`;
    case 'select_option': return `Choose ${el?.sensitive ? 'an option' : quote(action.option)} in ${elementName(el)}`;
    case 'set_checked': return `${action.checked ? 'Tick' : 'Untick'} ${elementName(el)}`;
    case 'upload_file': {
      const f = files?.get(action.file);
      return `Attach ${f ? `${quote(f.name)} (${formatBytes(f.bytes)})` : action.file} to ${elementName(el)} (does not submit)`;
    }
    default: return action.action;
  }
}

function targetInfo(el, form) {
  const t = { ref: el.ref, kind: el.kind, label: el.label ?? '' };
  if (el.type) t.type = el.type;
  if (el.href) t.href = el.href;
  if (el.sensitive) t.sensitive = el.sensitive;
  if (form) t.form = { id: form.id, method: form.method.toUpperCase(), action: form.action };
  return t;
}

function payloadSummary(action, el, files) {
  switch (action.action) {
    case 'type_ref':
      return {
        text: el?.sensitive ? `[redacted ${action.text.length} chars]` : preview(action.text),
        chars: action.text.length,
        submit: Boolean(action.submit),
      };
    case 'select_option': return { option: el?.sensitive ? '[redacted]' : action.option };
    case 'set_checked': return { checked: action.checked };
    case 'upload_file': {
      const f = files?.get(action.file);
      return f ? { file: action.file, name: f.name, bytes: f.bytes, source: f.source } : { file: action.file };
    }
    case 'navigate': return { url: action.url };
    default: return null;
  }
}

function preview(text) {
  const t = text.replace(/\s+/g, ' ');
  return t.length > TEXT_PREVIEW ? `${t.slice(0, TEXT_PREVIEW)}… (+${t.length - TEXT_PREVIEW} chars)` : t;
}

function consequenceFor(reasons) {
  const joined = reasons.join(' ');
  const hits = CONSEQUENCES.filter((c) => c.re.test(joined)).map((c) => c.text);
  return hits.length ? hits.join(' ') : 'This action was classified RED: treat it as consequential and possibly irreversible.';
}

/** Amount on the target itself wins; otherwise amounts visible on the page, flagged as such. */
export function detectAmount(el, observation) {
  const inLabel = String(el?.label ?? '').match(CURRENCY);
  if (inLabel) return { value: inLabel[0].trim(), source: 'target label' };
  const onPage = [...new Set(String(observation?.text ?? '').match(CURRENCY) ?? [])].slice(0, 3).map((s) => s.trim());
  if (onPage.length) return { value: onPage.join(', '), source: 'visible on page (verify which applies)' };
  return null;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '? bytes';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Render a summary for a terminal. */
export function formatApprovalPrompt(summary) {
  const t = summary.target;
  const targetLine = t
    ? `${t.ref} ${t.kind}${t.type ? `[${t.type}]` : ''} ${quote(t.label)}${t.form ? ` — in form ${t.form.id} (${t.form.method} → ${t.form.action || 'same page'})` : ''}${t.href ? ` → ${t.href}` : ''}`
    : '—';
  const payload = summary.payload ? Object.entries(summary.payload).map(([k, v]) => `${k}=${typeof v === 'string' ? quote(v, 140) : v}`).join('  ') : '—';
  const why = summary.reasons.length ? summary.reasons : ['(no specific reason recorded)'];

  if (summary.level === RISK.RED) {
    const bar = '!'.repeat(64);
    const amount = summary.amount ? `${summary.amount.value}  (${summary.amount.source})` : 'none detected — check the page before confirming';
    return [
      '',
      bar,
      '!!  RED · CONSEQUENTIAL ACTION · READ CAREFULLY BEFORE CONFIRMING  !!',
      bar,
      `  Operation:    ${summary.operation}`,
      `  Destination:  ${summary.site}${summary.pageUrl ? `  (${summary.pageUrl})` : ''}`,
      `  Target:       ${targetLine}`,
      `  Amount:       ${amount}`,
      `  Consequence:  ${summary.consequence}`,
      `  Payload:      ${payload}`,
      ...why.map((r, i) => `  ${i ? '              ' : 'Why RED:      '}${r}`),
      '  This confirmation covers this one step only and is used immediately.',
      bar,
      '',
    ].join('\n');
  }
  return [
    '',
    `┌─ ${summary.level} · approval needed ${'─'.repeat(40)}`,
    `│ Action:   ${summary.operation}`,
    `│ Site:     ${summary.site}`,
    `│ Target:   ${targetLine}`,
    `│ Payload:  ${payload}`,
    ...why.map((r, i) => `│ ${i ? '          ' : 'Reason:   '}${r}`),
    '└─',
  ].join('\n');
}
