// Turns the full extracted page text into the bounded slice a planner asked
// for with read_page: either a chunk at an offset, or the passages around a
// search term. Pure functions, so the bounds are easy to test.

import { LIMITS } from '../actions/schema.js';

export const READ_CONTEXT_CHARS = 300;
export const READ_MAX_PASSAGES = 10;

/**
 * @param {{ url, title, scope, text, totalChars, headings }} page  From BrowserController.readPage().
 * @param {{ find?: string, offset?: number, maxChars?: number }} [opts]
 */
export function sliceReading(page, { find, offset = 0, maxChars = LIMITS.readDefaultChars } = {}) {
  const limit = Math.min(Math.max(1, maxChars), LIMITS.readMaxChars);
  const text = page.text ?? '';
  const base = { url: page.url, title: page.title, scope: page.scope, totalChars: page.totalChars ?? text.length };

  if (find) {
    const { passages, matches } = findPassages(text, find, limit);
    return { ...base, find, matches, passages, chars: passages.reduce((n, p) => n + p.text.length, 0) };
  }

  const start = Math.min(offset, text.length);
  const chunk = text.slice(start, start + limit);
  const end = start + chunk.length;
  return {
    ...base,
    offset: start,
    chars: chunk.length,
    nextOffset: end < base.totalChars ? end : null,
    ...(start === 0 && page.headings?.length ? { headings: page.headings } : {}),
    text: chunk,
  };
}

function findPassages(text, needle, budget) {
  const hay = text.toLowerCase();
  const n = needle.toLowerCase();
  const windows = [];
  let matches = 0;
  for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + n.length)) {
    matches += 1;
    const from = Math.max(0, i - READ_CONTEXT_CHARS);
    const to = Math.min(text.length, i + n.length + READ_CONTEXT_CHARS);
    const last = windows.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else windows.push({ from, to });
  }
  const passages = [];
  let used = 0;
  for (const w of windows) {
    // Two characters are reserved for the "…" continuation markers, so the
    // returned text never exceeds the budget.
    const room = budget - used - 2;
    if (passages.length >= READ_MAX_PASSAGES || room <= 0) break;
    const slice = text.slice(w.from, Math.min(w.to, w.from + room));
    const passage = `${w.from > 0 ? '…' : ''}${slice}${w.from + slice.length < text.length ? '…' : ''}`;
    passages.push({ at: w.from, text: passage });
    used += passage.length;
  }
  return { passages, matches };
}
