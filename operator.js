const BrowserController = require('./browser/controller');
const BrowserExecutor = require('./browser/executor');
const MockPlanner = require('./agents/mock-planner');

async function runOperator(objective) {
  const controller = new BrowserController();
  const executor = new BrowserExecutor(controller);
  const planner = new MockPlanner();

  const MAX_STEPS = 10;

  let observation = {
    url: null,
    title: null,
    text: '',
    links: [],
    buttons: [],
    inputs: [],
    headings: []
  };

  try {
    console.log('\nOBJECTIVE:', objective);

    for (let step = 1; step <= MAX_STEPS; step++) {
      console.log(`\n--- STEP ${step} ---`);

      const decision = await planner.plan({
        objective,
        observation
      });

      console.log('DECISION:', decision);

      if (!decision || !decision.action) {
        throw new Error('Planner returned no action.');
      }

      if (decision.action === 'done') {
        console.log('\nDONE');
        console.log(decision.answer || 'Task completed.');
        return;
      }

      const result = await executor.execute(decision);

      console.log('RESULT:', result);

      observation = await executor.execute({
        action: 'observe'
      });

      console.log(
        'OBSERVATION:',
        JSON.stringify(
          {
            url: observation.url,
            title: observation.title,
            links: observation.links?.slice(0, 5),
            buttons: observation.buttons?.slice(0, 5),
            inputs: observation.inputs?.slice(0, 5)
          },
          null,
          2
        )
      );
    }

    console.log('\nSTOPPED: maximum step count reached.');
  } catch (error) {
    console.error('\nOPERATOR ERROR:', error);
  } finally {
    await controller.close();
  }
}

const objective =
  process.argv.slice(2).join(' ') ||
  'Open English Wikipedia';

runOperator(objective);
