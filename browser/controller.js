const { chromium } = require('playwright');

class BrowserController {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async start() {
    if (this.browser) return;

    this.browser = await chromium.launch({ headless: true });

    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 }
    });

    this.page = await this.context.newPage();
  }

  async navigate(url) {
    await this.start();

    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    return this.getState();
  }

  async getState() {
    await this.start();

    return {
      url: this.page.url(),
      title: await this.page.title()
    };
  }

  async observe() {
    await this.start();

    const data = await this.page.evaluate(() => {
      document
        .querySelectorAll('[data-dalexio-ref]')
        .forEach(el => el.removeAttribute('data-dalexio-ref'));

      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const links = [...document.querySelectorAll('a')]
        .filter(visible)
        .slice(0, 100)
        .map((el, index) => {
          const ref = `link-${index}`;
          el.setAttribute('data-dalexio-ref', ref);

          return {
            ref,
            text: (
              el.innerText ||
              el.getAttribute('aria-label') ||
              ''
            ).trim(),
            href: el.href || null
          };
        });

      const buttons = [
        ...document.querySelectorAll('button, [role="button"]')
      ]
        .filter(visible)
        .slice(0, 100)
        .map((el, index) => {
          const ref = `button-${index}`;
          el.setAttribute('data-dalexio-ref', ref);

          return {
            ref,
            text: (
              el.innerText ||
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              ''
            ).trim(),
            disabled: !!el.disabled
          };
        });

      const inputs = [
        ...document.querySelectorAll(
          'input, textarea, select, [contenteditable="true"]'
        )
      ]
        .filter(visible)
        .slice(0, 100)
        .map((el, index) => {
          const ref = `input-${index}`;
          el.setAttribute('data-dalexio-ref', ref);

          return {
            ref,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || null,
            name: el.getAttribute('name') || null,
            placeholder: el.getAttribute('placeholder') || null,
            ariaLabel: el.getAttribute('aria-label') || null
          };
        });

      const headings = [...document.querySelectorAll('h1,h2,h3')]
        .filter(visible)
        .slice(0, 50)
        .map(el => ({
          level: el.tagName.toLowerCase(),
          text: (el.innerText || '').trim()
        }));

      return {
        text: (document.body?.innerText || '').slice(0, 15000),
        links,
        buttons,
        inputs,
        headings
      };
    });

    return {
      url: this.page.url(),
      title: await this.page.title(),
      ...data
    };
  }

  async clickRef(ref) {
    await this.start();

    const locator = this.page.locator(
      `[data-dalexio-ref="${ref}"]`
    );

    if (await locator.count() === 0) {
      throw new Error(`Element ref not found: ${ref}`);
    }

    await Promise.all([
      this.page.waitForLoadState('domcontentloaded').catch(() => {}),
      locator.first().click()
    ]);

    return this.getState();
  }

  async typeRef(ref, text) {
    await this.start();

    const locator = this.page.locator(
      `[data-dalexio-ref="${ref}"]`
    );

    if (await locator.count() === 0) {
      throw new Error(`Element ref not found: ${ref}`);
    }

    await locator.first().fill(text);

    return this.getState();
  }

  async readText(selector = 'body') {
    await this.start();
    return this.page.locator(selector).innerText();
  }

  async click(selector) {
    await this.start();
    await this.page.locator(selector).click();
    return this.getState();
  }

  async type(selector, text) {
    await this.start();
    await this.page.locator(selector).fill(text);
    return this.getState();
  }

  async screenshot(path = 'browser-state.png') {
    await this.start();

    await this.page.screenshot({
      path,
      fullPage: true
    });

    return path;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }

    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

module.exports = BrowserController;
