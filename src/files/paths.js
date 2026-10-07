// Path safety helpers for everything Dalexio writes or reads on disk.
//
// All managed state lives under one root (default `.dalexio/`, gitignored).
// Each managed directory also gets its own `.gitignore` containing `*`, so its
// contents stay out of git even if the repository's ignore rules change.

import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_ROOT = '.dalexio';

export class PathSafetyError extends Error {
  constructor(message, { code = 'unsafe_path' } = {}) {
    super(message);
    this.name = 'PathSafetyError';
    this.code = code;
  }
}

/** True when `child` is `parent` or lies strictly inside it (both resolved). */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertInside(parent, child) {
  if (!isInside(parent, child)) throw new PathSafetyError(`path escapes ${parent}`);
  return path.resolve(child);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MAX_FILENAME = 120;

/**
 * Turn an untrusted, server-suggested filename into a single safe path
 * segment. Directory parts, traversal, control characters, characters that are
 * special on any OS, and leading dots (hidden files) are all removed.
 */
export function sanitizeFilename(name, fallback = 'download.bin') {
  let s = String(name ?? '');
  s = s.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_');
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  if (s.length > MAX_FILENAME) {
    const ext = path.extname(s).slice(0, 16);
    s = `${s.slice(0, MAX_FILENAME - ext.length)}${ext}`;
  }
  return s || fallback;
}

/** Create a managed directory (0700) and drop a catch-all .gitignore in it. */
export async function ensureManagedDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ignore = path.join(dir, '.gitignore');
  try {
    await access(ignore);
  } catch {
    await writeFile(ignore, '# Managed by Dalexio Operator: never commit anything in here.\n*\n', { mode: 0o600 }).catch(() => {});
  }
  return dir;
}

/** Path for display and audit: relative to cwd when inside it, else just the basename. */
export function displayPath(p, cwd = process.cwd()) {
  const abs = path.resolve(p);
  return isInside(cwd, abs) ? path.relative(cwd, abs) || '.' : `…/${path.basename(abs)}`;
}
