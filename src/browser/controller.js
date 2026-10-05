// BrowserController: thin, defensive wrapper around a Playwright Chromium page.
//
// It knows nothing about planners or safety. The executor and operator layers
// sit on top of it.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { collectObservation, DEFAULT_OBSERVATION_OPTIONS, REF_ATTR } from './observation.js';

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
};

export class BrowserController {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options, observation: { ...DEFAULTS.observation, ...options.observation } };
    this.browser = null;
    this.context = null;
    this.page = null;
    this._screenshotCount = 0;
  }

  get isLaunched() {
    return Boolean(this.browser?.isConnected());
  }

  async launch() {
    if (this.isLaunched) return this;
    try {
      this.browser = await chromium.launch({
        headless: this.options.headless,
        executablePath: this.options.executablePath,
      });
      // A fresh, isolated context per run: no persisted cookies or storage.
      this.context = await this.browser.newContext({
        viewport: this.options.viewport,
        acceptDownloads: false,
      });
      this.context.setDefaultTimeout(this.options.actionTimeoutMs);
      this.context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
      // Follow popups / target=_blank so the agent observes what it opened.
      this.context.on('page', (p) => {
        this.page = p;
        p.on('close', () => {
          if (this.page === p) this.page = this.context?.pages().at(-1) ?? null;
        });
      });
      this.page = await this.context.newPage();
    } catch (err) {
      await this.close();
      throw new BrowserError(`failed to launch Chromium: ${err.message}`, { code: 'launch_failed', cause: err });
    }
    return this;
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
        return await page.evaluate(collectObservation, args);
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

  /** Give a just-triggered navigation a moment to commit; never throws. */
  async _settle(page) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  }

  async close() {
    const browser = this.browser;
    this.page = null;
    this.context = null;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
  }
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}
