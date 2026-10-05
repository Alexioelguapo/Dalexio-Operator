const BrowserController = require('./browser/controller');
const BrowserExecutor = require('./browser/executor');

(async () => {
  const controller = new BrowserController();
  const executor = new BrowserExecutor(controller);

  try {
    let result;

    result = await executor.execute({
      action: 'navigate',
      url: 'https://example.com'
    });

    console.log('NAVIGATE:', result);

    result = await executor.execute({
      action: 'read',
      selector: 'body'
    });

    console.log('READ:', result);

    result = await executor.execute({
      action: 'screenshot',
      path: 'executor-test.png'
    });

    console.log('SCREENSHOT:', result);

    result = await executor.execute({
      action: 'state'
    });

    console.log('STATE:', result);

  } catch (error) {
    console.error('ERROR:', error.message);
  } finally {
    await controller.close();
  }
})();
