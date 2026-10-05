const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  await page.goto('https://example.com');

  console.log('TITLE:', await page.title());
  console.log('HEADING:', await page.locator('h1').textContent());

  await page.screenshot({
    path: 'example.png',
    fullPage: true
  });

  await browser.close();
})();
