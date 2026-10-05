const BrowserController = require('./browser/controller');

(async () => {
  const browser = new BrowserController();

  try {
    const state = await browser.navigate('https://example.com');

    console.log('STATE:', state);

   const bodyText = await browser.readText('body');
console.log('BODY:', bodyText.slice(0, 500));

    const screenshot = await browser.screenshot('controller-test.png');
    console.log('SCREENSHOT:', screenshot);
  } catch (error) {
    console.error('ERROR:', error);
  } finally {
    await browser.close();
  }
})();
