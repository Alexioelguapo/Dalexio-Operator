// Compact, token-efficient page observation.
//
// collectObservation() runs inside the page (via page.evaluate). It tags every
// visible interactive element with a stable `data-dalexio-ref` attribute, so a
// ref handed to the planner stays valid for the action that follows: refs are
// reused across observations of the same document and only reset when the
// document itself is replaced (navigation).
//
// collectPageText() and collectElementDetail() back read_page / read_ref. Like
// collectObservation they are fixed functions shipped with Dalexio; a planner
// can only choose their bounded parameters, never the code that runs.

export const REF_ATTR = 'data-dalexio-ref';

export const DEFAULT_OBSERVATION_OPTIONS = Object.freeze({
  maxTextChars: 1500,
  maxHeadings: 15,
  maxElements: 60,
  maxLabelChars: 80,
});

/* eslint-disable no-undef -- this function is serialized and runs in the browser */
export function collectObservation(opts) {
  const REF = opts.refAttr;
  const clip = (s, n) => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  const isVisible = (el) => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    return true;
  };
  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'file';
      return 'input';
    }
    if (role === 'link') return 'link';
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'textbox' || role === 'searchbox' || el.isContentEditable) return 'input';
    return null;
  };

  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (t.trim()) return t;
    }
    if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.innerText).join(' ');
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && ['submit', 'button', 'reset'].includes((el.type || '').toLowerCase())) return el.value;
    const text = el.innerText;
    if (text && text.trim()) return text;
    const img = el.querySelector?.('img[alt]');
    if (img) return img.getAttribute('alt');
    return el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  };

  const sensitivityOf = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    const hay = `${el.getAttribute('name') || ''} ${el.id || ''} ${auto} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    if (auto.startsWith('cc-') || /card.?num|cardnumber|\bcvv\b|\bcvc\b|\bcsc\b|security.?code|\biban\b|routing|account.?num|sort.?code/.test(hay)) return 'payment';
    if (type === 'password' || /password|passcode|\bpwd\b/.test(hay)) return 'password';
    if (auto === 'one-time-code' || /\botp\b|2fa|mfa|verification.?code/.test(hay)) return 'otp';
    return null;
  };

  // --- refs -------------------------------------------------------------
  const counters = (window.__dalexioRefCounters ||= {});
  const seen = new Set();
  const nextRef = (kind) => {
    counters[kind] = (counters[kind] ?? -1) + 1;
    return `${kind}-${counters[kind]}`;
  };

  const forms = new Map();
  const formInfo = (form) => {
    if (!form) return null;
    if (!forms.has(form)) {
      const inputs = Array.from(form.querySelectorAll('input,textarea,select'));
      const isSearch = form.getAttribute('role') === 'search'
        || inputs.some((i) => (i.type || '').toLowerCase() === 'search' || /^(q|query|search|search_query|s)$/i.test(i.name || ''));
      let action = '';
      try { action = new URL(form.getAttribute('action') || location.href, location.href).href; } catch { /* ignore */ }
      forms.set(form, {
        id: `form-${forms.size}`,
        method: (form.getAttribute('method') || 'get').toLowerCase(),
        action: action.slice(0, 200),
        isSearch,
        hasPassword: inputs.some((i) => sensitivityOf(i) === 'password'),
        hasPayment: inputs.some((i) => sensitivityOf(i) === 'payment'),
      });
    }
    return forms.get(form).id;
  };

  const candidates = document.querySelectorAll(
    'a[href],button,input,select,textarea,[role=button],[role=link],[role=textbox],[role=searchbox],[role=checkbox],[role=switch],[role=radio],[contenteditable=""],[contenteditable=true]'
  );
  const elements = [];
  for (const el of candidates) {
    const kind = kindOf(el);
    if (!kind) continue;
    // Modern upload widgets hide the real <input type=file> behind a styled
    // button, so file inputs are kept even when invisible (flagged hidden).
    const visible = isVisible(el);
    if (!visible && !(kind === 'file' && el.isConnected)) continue;
    let ref = el.getAttribute(REF);
    if (!ref || seen.has(ref) || !ref.startsWith(`${kind}-`)) {
      ref = nextRef(kind);
      el.setAttribute(REF, ref);
    }
    seen.add(ref);

    const item = { ref, kind, label: clip(labelFor(el), opts.maxLabelChars) };
    const tag = el.tagName.toLowerCase();
    if (kind === 'link') {
      const href = el.getAttribute('href') || '';
      if (/^\s*javascript:/i.test(href)) item.href = 'javascript:';
      else { try { item.href = new URL(href, location.href).href.slice(0, 200); } catch { item.href = href.slice(0, 200); } }
      if (el.getAttribute('target') === '_blank') item.newTab = true;
    }
    if (tag === 'input' || tag === 'button') item.type = (el.getAttribute('type') || (tag === 'button' ? 'submit' : 'text')).toLowerCase();
    if (el.getAttribute('role') === 'searchbox') item.type = 'search';
    if (kind === 'input' || kind === 'textarea' || kind === 'select') {
      const name = el.getAttribute('name');
      if (name) item.name = clip(name, 40);
      const ph = el.getAttribute('placeholder');
      if (ph) item.placeholder = clip(ph, 60);
      const sensitive = sensitivityOf(el);
      if (sensitive) item.sensitive = sensitive;
      const value = el.isContentEditable ? el.innerText : el.value;
      if (value) item.value = sensitive ? '[redacted]' : clip(value, 60);
    }
    if (kind === 'select') {
      item.options = Array.from(el.options).slice(0, 10).map((o) => clip(o.text, 30));
      if (el.options.length > 10) item.optionCount = el.options.length;
      if (el.multiple) item.multiple = true;
      const chosen = el.selectedOptions?.[0];
      item.value = chosen ? (item.sensitive ? '[redacted]' : clip(chosen.text, 60)) : undefined;
      if (item.value === undefined) delete item.value;
    }
    if (kind === 'checkbox' || kind === 'radio') {
      item.checked = el.getAttribute('role') ? el.getAttribute('aria-checked') === 'true' : !!el.checked;
    }
    if (kind === 'file') {
      // Only basenames are ever exposed by the browser; never a local path.
      const accept = el.getAttribute('accept');
      if (accept) item.accept = clip(accept, 60);
      if (el.multiple) item.multiple = true;
      const files = Array.from(el.files || []).map((f) => clip(f.name, 60));
      if (files.length) item.files = files;
      if (!visible) item.hidden = true;
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    const form = formInfo(el.form || el.closest('form'));
    if (form) item.form = form;
    item._inView = inViewport(el);
    elements.push(item);
  }

  // Prefer what the user can see now, then keep document order.
  const ordered = [...elements.filter((e) => e._inView), ...elements.filter((e) => !e._inView)];
  const kept = ordered.slice(0, opts.maxElements);
  const keptRefs = new Set(kept.map((e) => e.ref));
  const finalElements = elements.filter((e) => keptRefs.has(e.ref)).map(({ _inView, ...rest }) => (_inView ? rest : { ...rest, offscreen: true }));

  const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
    .filter(isVisible)
    .slice(0, opts.maxHeadings)
    .map((h) => ({ level: Number(h.tagName[1]), text: clip(h.innerText, 120) }))
    .filter((h) => h.text);

  const fullText = (document.body?.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

  return {
    url: location.href,
    title: clip(document.title, 200),
    headings,
    text: fullText.length > opts.maxTextChars ? `${fullText.slice(0, opts.maxTextChars)}…` : fullText,
    elements: finalElements,
    forms: Array.from(forms.values()),
    truncated: {
      text: fullText.length > opts.maxTextChars,
      elements: Math.max(0, elements.length - finalElements.length),
    },
  };
}

/** Bounded visible text of the page's main content (or body) plus its outline. */
export function collectPageText(opts) {
  const norm = (t) => (t || '').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n[\s]*\n+/g, '\n').trim();
  const roots = Array.from(document.querySelectorAll('main,[role=main],article'));
  let root = document.body;
  let scope = 'body';
  let best = '';
  for (const r of roots) {
    const t = r.innerText || '';
    if (t.length > best.length) { best = t; root = r; }
  }
  if (root !== document.body && best.trim().length >= opts.minMainChars) scope = root.tagName.toLowerCase() === 'article' ? 'article' : 'main';
  else root = document.body;
  const full = norm(root?.innerText);
  const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
    .filter((h) => h.getClientRects().length > 0 && (!root || root.contains(h)))
    .slice(0, opts.maxHeadings)
    .map((h) => `${'#'.repeat(Number(h.tagName[1]))} ${(h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120)}`)
    .filter((h) => h.length > 2);
  return {
    url: location.href,
    title: (document.title || '').slice(0, 200),
    scope,
    totalChars: full.length,
    text: full.slice(0, opts.maxExtractChars),
    headings,
  };
}

/** Full details of one ref'd element: text, every option of a dropdown, state. */
export function collectElementDetail(el, opts) {
  const clip = (s, n) => {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const hay = `${el.getAttribute('name') || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''}`.toLowerCase();
  const sensitive = opts.sensitive || type === 'password' || /password|passcode|card.?num|cvv|cvc|iban|otp|one-time-code|cc-/.test(hay);
  const out = { tag, text: clip(el.innerText || el.textContent || '', opts.maxTextChars) };
  if (tag === 'a') out.href = (el.href || '').slice(0, 500);
  if (tag === 'select') {
    out.options = Array.from(el.options).slice(0, opts.maxOptions).map((o) => ({
      label: clip(o.label || o.text, 120),
      value: sensitive ? '[redacted]' : clip(o.value, 120),
      ...(o.selected ? { selected: true } : {}),
      ...(o.disabled ? { disabled: true } : {}),
    }));
    out.optionCount = el.options.length;
    out.text = '';
  }
  if (tag === 'input' || tag === 'textarea') {
    out.type = type || (tag === 'textarea' ? 'textarea' : 'text');
    if (type === 'checkbox' || type === 'radio') out.checked = el.checked;
    else if (type === 'file') out.files = Array.from(el.files || []).map((f) => clip(f.name, 120));
    else out.value = sensitive ? (el.value ? '[redacted]' : '') : clip(el.value, opts.maxTextChars);
    for (const a of ['min', 'max', 'pattern', 'maxlength', 'accept']) if (el.hasAttribute(a)) out[a] = clip(el.getAttribute(a), 80);
    if (el.required) out.required = true;
  }
  const describedBy = el.getAttribute('aria-describedby');
  if (describedBy) out.description = clip(describedBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '), 300);
  return out;
}

/** Find a dropdown option by label, then value; reports ambiguity instead of guessing. */
export function findSelectOption(el, wanted) {
  const opts = Array.from(el.options).map((o, index) => ({ index, label: (o.label || o.text || '').replace(/\s+/g, ' ').trim(), value: o.value, disabled: o.disabled }));
  const w = wanted.replace(/\s+/g, ' ').trim();
  const tiers = [
    (o) => o.label === w,
    (o) => o.label.toLowerCase() === w.toLowerCase(),
    (o) => o.value === w,
  ];
  for (const test of tiers) {
    const hits = opts.filter(test);
    if (hits.length > 1) return { error: 'ambiguous', count: hits.length };
    if (hits.length === 1) {
      const hit = hits[0];
      if (hit.disabled) return { error: 'disabled', label: hit.label };
      return { label: hit.label, index: hit.index };
    }
  }
  return { error: 'not_found', available: opts.slice(0, 20).map((o) => o.label) };
}
/* eslint-enable no-undef */

/** Short, stable fingerprint of a page state for stagnation/loop detection. */
export function fingerprintObservation(obs) {
  const basis = JSON.stringify([
    obs.url,
    obs.title,
    obs.text,
    obs.elements.map((e) => [e.ref, e.label, e.value ?? '', e.checked ?? '', e.files ?? '']),
  ]);
  // FNV-1a 32-bit: fast, deterministic, good enough for equality checks.
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
