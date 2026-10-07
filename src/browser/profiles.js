// Named, persistent browser profiles.
//
// A profile is a dedicated Chromium user-data directory under
// `.dalexio/profiles/<name>/user-data`. Logging in once (see the CLI's
// --login bootstrap) leaves the session's cookies and storage there, and later
// runs with the same --profile reuse it. Profiles never share a directory, so
// they never share cookies: "mixed-beanz" cannot see "ai-carty"'s login.
//
// Nothing in a profile is ever read by Dalexio, shown to a planner, logged, or
// committed: the directory is mode 0700, sits under the gitignored `.dalexio/`,
// and gets its own catch-all .gitignore as a second line of defence.
//
// A lock file stops two runs from opening one profile at the same time
// (Chromium would otherwise fail with an opaque "profile in use" error).

import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ROOT, ensureManagedDir, assertInside, PathSafetyError } from '../files/paths.js';

export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export class ProfileError extends PathSafetyError {
  constructor(message, code = 'profile_error') {
    super(message, { code });
    this.name = 'ProfileError';
  }
}

export function validateProfileName(name) {
  if (typeof name !== 'string' || !PROFILE_NAME_PATTERN.test(name)) {
    throw new ProfileError(`invalid profile name ${JSON.stringify(String(name).slice(0, 60))}: use 1-48 lowercase letters, digits, "-" or "_"`, 'invalid_profile_name');
  }
  return name;
}

export class ProfileStore {
  constructor({ root = DEFAULT_ROOT } = {}) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, 'profiles');
  }

  /** Paths for a profile; validates the name, never touches disk. */
  paths(name) {
    validateProfileName(name);
    const base = assertInside(this.dir, path.join(this.dir, name));
    return {
      name,
      base,
      userDataDir: path.join(base, 'user-data'),
      lockFile: path.join(base, '.lock'),
      downloadsDir: path.join(this.root, 'downloads', name),
      uploadsDir: path.join(this.root, 'uploads', name),
    };
  }

  /** Create the profile directories if needed and return their paths. */
  async ensure(name) {
    const p = this.paths(name);
    await ensureManagedDir(this.root);
    await ensureManagedDir(this.dir);
    await mkdir(p.userDataDir, { recursive: true, mode: 0o700 });
    return p;
  }

  async exists(name) {
    try {
      return (await stat(this.paths(name).userDataDir)).isDirectory();
    } catch {
      return false;
    }
  }

  async list() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      if (!PROFILE_NAME_PATTERN.test(name)) continue;
      const info = await stat(this.paths(name).userDataDir).catch(() => null);
      if (info?.isDirectory()) out.push({ name, modified: info.mtime.toISOString(), locked: Boolean(await this._liveLock(name)) });
    }
    return out;
  }

  /**
   * Take the profile's lock. Returns a release function.
   * @throws {ProfileError} when another live process holds it.
   */
  async lock(name) {
    const { lockFile } = await this.ensure(name);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(lockFile, 'wx', 0o600);
        await fh.writeFile(String(process.pid));
        await fh.close();
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await rm(lockFile, { force: true });
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const holder = await this._liveLock(name);
        if (holder) throw new ProfileError(`profile "${name}" is already in use by process ${holder}`, 'profile_locked');
        await rm(lockFile, { force: true }); // stale lock from a crashed run
      }
    }
    throw new ProfileError(`could not lock profile "${name}"`, 'profile_locked');
  }

  async _liveLock(name) {
    let pid;
    try {
      pid = Number((await readFile(this.paths(name).lockFile, 'utf8')).trim());
    } catch {
      return null;
    }
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (err) {
      return err.code === 'EPERM' ? pid : null;
    }
  }
}
