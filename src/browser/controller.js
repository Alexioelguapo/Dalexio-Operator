// BrowserController: thin, defensive wrapper around a Playwright Chromium page.
//
// It knows nothing about planners or safety. The executor and operator layers
// sit on top of it.
//
// Two session modes:
//   stateless (default) – a fresh, isolated context per run; nothing persists.
//   profile             – `profile: 'name'` opens that profile's persistent
//                         user-data directory (see profiles.js), so a login made
//                         once with the --login bootstrap is reused.
//
// Downloads are only ever saved by downloadRef(), into the managed downloads
// folder, under a sanitized name. Any other download is cancelled.

import { chromium } from 'playwright';
import { chmod, mkdir, open as openFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  collectObservation, collectPageText, collectElementDetail, findSelectOption,
  DEFAULT_OBSERVATION_OPTIONS, REF_ATTR,
} from './observation.js';
import { ProfileStore } from './profiles.js';
import { DEFAULT_ROOT, assertInside, ensureManagedDir, sanitizeFilename } from '../files/paths.js';
import { sha256File } from '../files/registry.js';
import { redactObservation, redactSecrets } from '../safety/redact.js';

export class BrowserError extends Error {
  constructor(message, { code = 'browser_error', cause } = {}) {
    super(message, { cause });
    this.name = 'BrowserError';
    this.code = code;
  }
}

const DEFAULTS = {
  headless: true,
  viewport: { width: 1280, height: 800 },
  navigationTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
  screenshotDir: '.dalexio/screenshots',
  executablePath: process.env.DALEXIO_CHROMIUM_PATH || undefined,
  observation: DEFAULT_OBSERVATION_OPTIONS,
  stateRoot: DEFAULT_ROOT,
  profile: null,          // profile name, or null for a stateless run
  downloadsDir: null,     // default: <stateRoot>/downloads/<profile|_stateless>
  downloadTimeoutMs: 15_000,
  maxDownloadBytes: 500 * 1024 * 1024,
};

// Text reading bounds (the schema bounds what a planner may ask for; these
// bound what is pulled out of the page at all).
const READ = Object.freeze({ maxExtractChars: 1_010_000, maxHeadings: 40, minMainChars: 300, maxOptions: 200, maxRefText: 4000 });

export class BrowserController {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options, observation: { ...DEFAULTS.observation, ...options.observation } };
    this.browser = null;
    this.context = null;
    this.page = null;
    this._screenshotCount = 0;
    this._connected = false;
    this._releaseProfile = null;
    this._downloadWaiter = null;
    this.cancelledDownloads = 0;
    this.profileStore = new ProfileStore({ root: this.options.stateRoot });
    const p = this.options.profile;
    this.profilePaths = p ? this.profileStore.paths(p) : null; // validates the name early
    this.downloadsDir = path.resolve(this.options.downloadsDir
      ?? this.profilePaths?.downloadsDir
      ?? path.join(this.options.stateRoot, 'downloads', '_stateless'));
  }

  get isLaunched() {
    return this._connected && Boolean(this.context);
  }

  get profile() {
    return this.options.profile;
  }

  async launch() {
    if (this.isLaunched) return this;
    const contextOptions = {
      viewport: this.options.viewport,
      // Accepted only so downloadRef() can capture them; every other
      // download is cancelled in _watchPage().
      acceptDownloads: true,
    };
    try {
      if (this.profilePaths) {
        this._releaseProfile = await this.profileStore.lock(this.options.profile);
        await this.profileStore.ensure(this.options.profile);
        this.context = await chromium.launchPersistentContext(this.profilePaths.userDataDir, {
          ...contextOptions,
          headless: this.options.headless,
          executablePath: this.options.executablePath,
        });
        this.browser = this.context.browser();
      } else {
        this.browser = await chromium.launch({
          headless: this.options.headless,
          executablePath: this.options.executablePath,
        });
        // A fresh, isolated context per run: no persisted cookies or storage.
        this.context = await this.browser.newContext(contextOptions);
      }
      this._connected = true;
      this.context.on('close', () => { this._connected = false; });
      this.browser?.on?.('disconnected', () => { this._connected = false; });
      this.context.setDefaultTimeout(this.options.actionTimeoutMs);
      this.context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
      // Follow popups / target=_blank so the agent observes what it opened.
      this.context.on('page', (p) => {
        this._watchPage(p);
        this.page = p;
        p.on('close', () => {
          if (this.page === p) this.page = this.context?.pages().at(-1) ?? null;
        });
      });
      // A persistent context opens with a page already.
      const existing = this.context.pages();
      for (const p of existing) this._watchPage(p);
      this.page = existing[0] ?? await this.context.newPage();
    } catch (err) {
      await this.close();
      if (err?.code === 'profile_locked' || err?.code === 'invalid_profile_name') throw new BrowserError(err.message, { code: err.code, cause: err });
      throw new BrowserError(`failed to launch Chromium: ${firstLine(err)}`, { code: 'launch_failed', cause: err });
    }
    return this;
  }

  _watchPage(page) {
    if (page.__dalexioWatched) return;
    page.__dalexioWatched = true;
    page.on('download', (download) => {
      const waiter = this._downloadWaiter;
      if (waiter) {
        this._downloadWaiter = null;
        waiter(download);
      } else {
        this.cancelledDownloads += 1;
        download.cancel().catch(() => {});
      }
    });
  }

  _requirePage() {
    if (!this.page || this.page.isClosed()) throw new BrowserError('browser is not launched or page is closed', { code: 'not_launched' });
    return this.page;
  }

  async navigate(url) {
    const page = this._requirePage();
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        return { url: page.url(), status: response?.status() ?? null };
      } catch (err) {
        // A failed load commits Chrome's error page asynchronously; let it land
        // so it cannot interrupt the *next* navigation.
        await this._settle(page);
        if (attempt === 0 && /interrupted by another navigation/i.test(err.message)) continue;
        throw new BrowserError(`navigation to ${url} failed: ${firstLine(err)}`, { code: 'navigation_failed', cause: err });
      }
    }
  }

  async getState() {
    const page = this._requirePage();
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  /** Visible text of the page (or of the first element matching selector). */
  async readText(selector) {
    const page = this._requirePage();
    try {
      if (selector) return (await page.locator(selector).first().innerText()).trim();
      return (await page.locator('body').innerText()).trim();
    } catch (err) {
      throw new BrowserError(`read failed: ${firstLine(err)}`, { code: 'read_failed', cause: err });
    }
  }

  async observe() {
    const page = this._requirePage();
    const args = { ...this.options.observation, refAttr: REF_ATTR };
    for (let attempt = 0; ; attempt++) {
      await this._settle(page);
      try {
        return redactObservation(await page.evaluate(collectObservation, args));
      } catch (err) {
        // A navigation can destroy the execution context mid-evaluate; retry once.
        if (attempt === 0 && /Execution context was destroyed|navigation/i.test(err.message)) continue;
        throw new BrowserError(`observe failed: ${firstLine(err)}`, { code: 'observe_failed', cause: err });
      }
    }
  }

  async screenshot({ fullPage = false, filePath } = {}) {
    const page = this._requirePage();
    const target = filePath ?? path.join(this.options.screenshotDir, `shot-${Date.now()}-${this._screenshotCount++}.png`);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await page.screenshot({ path: target, fullPage });
      return { path: target };
    } catch (err) {
      throw new BrowserError(`screenshot failed: ${firstLine(err)}`, { code: 'screenshot_failed', cause: err });
    }
  }

  // --- selector-based primitives (developer use; not exposed to planners) ---

  async click(selector) {
    const page = this._requirePage();
    try {
      await page.locator(selector).first().click();
    } catch (err) {
      throw new BrowserError(`click ${selector} failed: ${firstLine(err)}`, { code: 'click_failed', cause: err });
    }
    await this._settle(page);
  }

  async type(selector, text, { submit = false } = {}) {
    const page = this._requirePage();
    try {
      const loc = page.locator(selector).first();
      await loc.fill(text);
      if (submit) await loc.press('Enter');
    } catch (err) {
      throw new BrowserError(`type into ${selector} failed: ${firstLine(err)}`, { code: 'type_failed', cause: err });
    }
    if (submit) await this._settle(page);
  }

  // --- ref-based primitives (planner-facing via the executor) --------------

  _refLocator(ref) {
    if (!/^[a-z]+-\d+$/.test(ref)) throw new BrowserError(`malformed ref "${ref}"`, { code: 'invalid_ref' });
    return this._requirePage().locator(`[${REF_ATTR}="${ref}"]`);
  }

  async _resolveRef(ref) {
    const loc = this._refLocator(ref);
    const count = await loc.count();
    if (count === 0) throw new BrowserError(`ref "${ref}" no longer exists on the page (stale ref; observe again)`, { code: 'stale_ref' });
    if (count > 1) throw new BrowserError(`ref "${ref}" is ambiguous (${count} matches)`, { code: 'ambiguous_ref' });
    return loc;
  }

  async clickRef(ref) {
    const loc = await this._resolveRef(ref);
    try {
      const opensTab = (await loc.getAttribute('target').catch(() => null)) === '_blank';
      const popup = opensTab ? this.context.waitForEvent('page', { timeout: 5_000 }).catch(() => null) : null;
      await loc.click();
      const newPage = await popup;
      if (newPage) {
        this.page = newPage;
        await this._settle(newPage);
      }
    } catch (err) {
      throw new BrowserError(`click_ref ${ref} failed: ${firstLine(err)}`, { code: 'click_failed', cause: err });
    }
    await this._settle(this._requirePage());
  }

  async typeRef(ref, text, { submit = false } = {}) {
    const loc = await this._resolveRef(ref);
    try {
      await loc.fill(text);
      if (submit) await loc.press('Enter');
    } catch (err) {
      throw new BrowserError(`type_ref ${ref} failed: ${firstLine(err)}`, { code: 'type_failed', cause: err });
    }
    if (submit) await this._settle(this._requirePage());
  }

  async selectOptionRef(ref, option) {
    const loc = await this._resolveRef(ref);
    let found;
    try {
      found = await loc.evaluate(findSelectOption, option);
    } catch (err) {
      throw new BrowserError(`select_option ${ref} failed: ${firstLine(err)}`, { code: 'select_failed', cause: err });
    }
    if (found?.error === 'not_found') {
      throw new BrowserError(`no option ${JSON.stringify(option)} in ${ref}; options include: ${found.available.map((o) => JSON.stringify(o)).join(', ')}`, { code: 'option_not_found' });
    }
    if (found?.error === 'ambiguous') throw new BrowserError(`${found.count} options in ${ref} match ${JSON.stringify(option)}; use the exact label`, { code: 'option_ambiguous' });
    if (found?.error === 'disabled') throw new BrowserError(`option ${JSON.stringify(found.label)} in ${ref} is disabled`, { code: 'option_disabled' });
    try {
      await loc.selectOption({ index: found.index });
    } catch (err) {
      throw new BrowserError(`select_option ${ref} failed: ${firstLine(err)}`, { code: 'select_failed', cause: err });
    }
    return { selected: found.label };
  }

  async setCheckedRef(ref, checked) {
    const loc = await this._resolveRef(ref);
    try {
      await loc.setChecked(checked);
    } catch (err) {
      throw new BrowserError(`set_checked ${ref} failed: ${firstLine(err)}`, { code: 'check_failed', cause: err });
    }
    return { checked };
  }

  /** Attach a file the caller has already vetted (see FileRegistry.resolveForUpload). */
  async setFileRef(ref, realPath) {
    const loc = await this._resolveRef(ref);
    const isFileInput = await loc.evaluate((el) => el.tagName === 'INPUT' && el.type === 'file').catch(() => false);
    if (!isFileInput) throw new BrowserError(`ref "${ref}" is not a file input`, { code: 'wrong_target' });
    try {
      await loc.setInputFiles(realPath);
    } catch (err) {
      throw new BrowserError(`upload_file ${ref} failed: ${firstLine(err)}`, { code: 'upload_failed', cause: err });
    }
  }

  /**
   * Click a ref that starts a download and save the file into the managed
   * downloads folder. Never opens or executes the file.
   */
  async downloadRef(ref) {
    const loc = await this._resolveRef(ref);
    await ensureManagedDir(this.downloadsDir);
    const page = this._requirePage();
    let timer;
    let graceTimer;
    let onNavigate;
    const started = new Promise((resolve, reject) => {
      this._downloadWaiter = resolve;
      timer = setTimeout(() => reject(new BrowserError(`clicking ${ref} did not start a download within ${this.options.downloadTimeoutMs} ms`, { code: 'no_download' })), this.options.downloadTimeoutMs);
      // A link that simply opens a page commits a navigation; give a late
      // download a short grace period, then report it instead of waiting.
      onNavigate = (frame) => {
        if (frame !== page.mainFrame() || graceTimer) return;
        graceTimer = setTimeout(() => reject(new BrowserError(`clicking ${ref} opened a page (${page.url()}) instead of downloading a file`, { code: 'no_download' })), 1_500);
      };
      page.on('framenavigated', onNavigate);
    });
    started.catch(() => {});
    let download;
    try {
      await loc.click();
      download = await started;
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError(`download_ref ${ref} failed: ${firstLine(err)}`, { code: 'download_failed', cause: err });
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      page.off('framenavigated', onNavigate);
      this._downloadWaiter = null;
    }

    const suggested = download.suggestedFilename();
    const filename = sanitizeFilename(suggested);
    const target = await reserveUniquePath(this.downloadsDir, filename);
    try {
      await download.saveAs(target);
      const failure = await download.failure();
      if (failure) throw new BrowserError(`download failed: ${failure}`, { code: 'download_failed' });
      const { size } = await stat(target);
      if (size > this.options.maxDownloadBytes) throw new BrowserError(`download is ${size} bytes, over the ${this.options.maxDownloadBytes}-byte limit`, { code: 'download_too_large' });
      await chmod(target, 0o600); // never executable
      return {
        filename: path.basename(target),
        suggestedFilename: suggested.slice(0, 200),
        sourceUrl: redactUrl(download.url()),
        mimeType: await sniffMimeType(target),
        bytes: size,
        sha256: await sha256File(target),
        path: target,
      };
    } catch (err) {
      await rm(target, { force: true });
      if (err instanceof BrowserError) throw err;
      throw new BrowserError(`saving download failed: ${firstLine(err)}`, { code: 'download_failed', cause: err });
    } finally {
      await this._settle(this._requirePage());
    }
  }

  /** Bounded visible text of the page (main content when there is one). */
  async readPage() {
    const page = this._requirePage();
    await this._settle(page);
    try {
      const r = await page.evaluate(collectPageText, READ);
      return { ...r, title: redactSecrets(r.title), text: redactSecrets(r.text), headings: r.headings.map(redactSecrets) };
    } catch (err) {
      throw new BrowserError(`read_page failed: ${firstLine(err)}`, { code: 'read_failed', cause: err });
    }
  }

  async readRef(ref, { sensitive = false } = {}) {
    const loc = await this._resolveRef(ref);
    try {
      const d = await loc.evaluate(collectElementDetail, { maxTextChars: READ.maxRefText, maxOptions: READ.maxOptions, sensitive });
      return { ...d, text: redactSecrets(d.text), ...(typeof d.value === 'string' ? { value: redactSecrets(d.value) } : {}) };
    } catch (err) {
      throw new BrowserError(`read_ref ${ref} failed: ${firstLine(err)}`, { code: 'read_failed', cause: err });
    }
  }

  /** Give a just-triggered navigation a moment to commit; never throws. */
  async _settle(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  }

  async close() {
    const { browser, context } = this;
    const release = this._releaseProfile;
    this.page = null;
    this.context = null;
    this.browser = null;
    this._connected = false;
    this._releaseProfile = null;
    // Closing a persistent context is what flushes its cookies to disk.
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (release) await release().catch(() => {});
  }

  /** Resolves when the user closes the window (or the browser dies). */
  waitForClose() {
    if (!this.context) return Promise.resolve();
    return new Promise((resolve) => {
      this.context.once('close', resolve);
      this.browser?.once?.('disconnected', resolve);
    });
  }
}

/** Atomically claim `name`, or `name (1)`, `name (2)`… inside dir. */
async function reserveUniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = assertInside(dir, path.join(dir, i ? `${stem} (${i})${ext}` : name));
    try {
      const fh = await openFile(candidate, 'wx', 0o600);
      await fh.close();
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new BrowserError('too many downloads with the same name', { code: 'download_failed' });
}

const MAGIC = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/gzip', bytes: [0x1f, 0x8b] },
  { mime: 'application/x-executable', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { mime: 'application/x-msdownload', bytes: [0x4d, 0x5a] },
];
const EXT_MIME = {
  '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Content sniffing first (what the bytes are), file extension second. */
async function sniffMimeType(file) {
  const fh = await openFile(file, 'r');
  try {
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    for (const m of MAGIC) if (bytesRead >= m.bytes.length && m.bytes.every((b, i) => buf[i] === b)) return m.mime;
  } finally {
    await fh.close();
  }
  return EXT_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Drop query strings and fragments, which often carry signed tokens. */
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return '';
  }
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}
