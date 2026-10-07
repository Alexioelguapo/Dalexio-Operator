// FileRegistry: the only files an agent may upload.
//
// The planner never sees or supplies a filesystem path. It sees a short list
// of AVAILABLE FILES, each with an opaque id ("file-0"), a basename and a size,
// and upload_file names one of those ids. A file gets into the registry in one
// of three ways:
//
//   user      – the caller explicitly allowed it (CLI --allow-file, or the
//               `files` option). Any regular file the user can read, except
//               the denylisted secrets below.
//   managed   – a regular file directly inside an approved managed folder
//               (default `.dalexio/uploads/`). Not recursive; symlinks skipped.
//   download  – a file this run downloaded into the managed downloads folder.
//
// Every entry is re-checked when it is used (still a regular file, same real
// path, same size limit), so swapping a file for a symlink between
// registration and upload does not work.

import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_ROOT, displayPath, isInside, PathSafetyError } from './paths.js';

export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_REGISTERED_FILES = 50;

// Even an explicitly allowed path is refused when it looks like a secret or
// like Dalexio's own session state (uploading a cookie jar would leak a login).
const DENIED_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.claude', '.git']);
const DENIED_NAMES = [
  /^\.env(\..*)?$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /^credentials(\..*)?$/i, /^storage-state.*\.json$/i,
  /\.(pem|key|p12|pfx|kdbx|keychain)$/i, /^(cookies|login data|web data)(-journal)?$/i,
];

export class FileRegistryError extends PathSafetyError {
  constructor(message, code = 'file_rejected') {
    super(message, { code });
    this.name = 'FileRegistryError';
  }
}

export class FileRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.root]          Dalexio state root; `<root>/profiles` is never uploadable.
   * @param {number} [opts.maxBytes]      Per-file upload limit.
   */
  constructor({ root = DEFAULT_ROOT, maxBytes = DEFAULT_MAX_UPLOAD_BYTES } = {}) {
    this.root = path.resolve(root);
    this.maxBytes = maxBytes;
    this._entries = new Map(); // id → entry
    this._byReal = new Map();  // realpath → id
    this._next = 0;
  }

  /** Register a caller-supplied file. Throws FileRegistryError when refused. */
  async addUserFile(p) {
    return this._add(p, 'user');
  }

  /** Register every regular file directly inside a managed folder. Missing folder → nothing. */
  async addManagedDir(dir) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const added = [];
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const info = await lstat(full).catch(() => null);
      if (!info?.isFile()) continue; // symlinks and directories are skipped
      try {
        added.push(await this._add(full, 'managed', { within: dir }));
      } catch {
        // A file that fails the checks is simply not offered.
      }
    }
    return added;
  }

  /** Register a file this run downloaded (must be inside the downloads folder). */
  async addDownload(p, downloadsDir) {
    return this._add(p, 'download', { within: downloadsDir });
  }

  async _add(p, source, { within } = {}) {
    if (typeof p !== 'string' || !p.trim()) throw new FileRegistryError('file path must be a non-empty string', 'invalid_path');
    const abs = path.resolve(p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
    const real = await this._check(abs, { within });
    const existing = this._byReal.get(real);
    if (existing) return this._entries.get(existing);
    if (this._entries.size >= MAX_REGISTERED_FILES) throw new FileRegistryError(`at most ${MAX_REGISTERED_FILES} files can be registered`, 'too_many_files');
    const info = await stat(real);
    const entry = Object.freeze({
      id: `file-${this._next++}`,
      name: path.basename(real),
      bytes: info.size,
      source,
      realPath: real,
      within: within ? path.resolve(within) : null,
    });
    this._entries.set(entry.id, entry);
    this._byReal.set(real, entry.id);
    return entry;
  }

  async _check(abs, { within } = {}) {
    let real;
    try {
      real = await realpath(abs);
    } catch {
      throw new FileRegistryError(`file not found: ${path.basename(abs)}`, 'file_not_found');
    }
    const info = await stat(real);
    if (!info.isFile()) throw new FileRegistryError(`not a regular file: ${path.basename(abs)}`, 'not_a_file');
    if (info.size > this.maxBytes) throw new FileRegistryError(`file is larger than ${this.maxBytes} bytes: ${path.basename(abs)}`, 'file_too_large');
    if (within) {
      const realWithin = await realpath(within).catch(() => path.resolve(within));
      if (!isInside(realWithin, real)) throw new FileRegistryError(`file is outside the managed folder: ${path.basename(abs)}`, 'outside_managed_dir');
    }
    const denied = deniedReason(real, this.root);
    if (denied) throw new FileRegistryError(`refusing to offer ${path.basename(abs)} for upload: ${denied}`, 'denied_path');
    return real;
  }

  get(id) {
    return this._entries.get(id) ?? null;
  }

  /**
   * Re-validate an entry immediately before use and return its real path.
   * @throws {FileRegistryError}
   */
  async resolveForUpload(id) {
    const entry = this.get(id);
    if (!entry) throw new FileRegistryError(`unknown file id "${id}"; use one listed under AVAILABLE FILES`, 'unknown_file');
    const real = await this._check(entry.realPath, { within: entry.within });
    if (real !== entry.realPath) throw new FileRegistryError(`file ${entry.name} changed location since it was registered`, 'file_changed');
    return { ...entry, realPath: real, bytes: (await stat(real)).size };
  }

  /** Planner-safe listing: no paths. */
  list() {
    return [...this._entries.values()].map(({ id, name, bytes, source }) => ({ id, name, bytes, source }));
  }

  /** Audit-safe description of one entry. */
  describe(entry) {
    return { id: entry.id, name: entry.name, bytes: entry.bytes, source: entry.source, path: entry.source === 'user' ? `…/${entry.name}` : displayPath(entry.realPath) };
  }
}

export function deniedReason(real, root) {
  const resolvedRoot = path.resolve(root);
  if (isInside(path.join(resolvedRoot, 'profiles'), real)) return 'browser profile/session data';
  const parts = real.split(path.sep);
  const name = parts.at(-1) ?? '';
  for (const seg of parts.slice(0, -1)) if (DENIED_SEGMENTS.has(seg.toLowerCase())) return `inside a ${seg} directory`;
  if (DENIED_NAMES.some((re) => re.test(name))) return 'looks like a credential or secret file';
  return null;
}

export async function sha256File(p) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(p)) hash.update(chunk);
  return hash.digest('hex');
}
