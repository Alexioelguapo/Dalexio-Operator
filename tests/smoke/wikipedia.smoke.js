// Live smoke test against the real wikipedia.org portal (needs internet).
//
//   npm run smoke            → reports SKIPPED if the network is unavailable
//   SMOKE_STRICT=1 npm run smoke → treats an unreachable network as a failure
//
// Reproduces the original integration proof: observe the portal, identify the
// English link, click_ref it, arrive at English Wikipedia, observe again.

import { BrowserController } from '../../src/browser/controller.js';
import { BrowserExecutor } from '../../src/browser/executor.js';
import { Operator } from '../../src/operator/operator.js';
import { MockPlanner } from '../../src/agents/mock-planner.js';

const NETWORK_ERRORS = /ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_REFUSED|PROXY_CONNECTION_FAILED|ADDRESS_UNREACHABLE|TIMED_OUT)/;
const strict = process.env.SMOKE_STRICT === '1';
class SkipError extends Error {}

function check(cond, msg) {
  if (!cond) throw new Error(`smoke assertion failed: ${msg}`);
  console.log(`  ✔ ${msg}`);
}

const controller = new BrowserController();
try {
  console.log('Smoke 1: executor-level Wikipedia flow');
  await controller.launch();
  const ex = new BrowserExecutor(controller);
  try {
    await ex.navigate('https://www.wikipedia.org/');
  } catch (err) {
    if (!strict && NETWORK_ERRORS.test(err.message)) {
      throw new SkipError(`wikipedia.org is unreachable from this environment (${err.message.match(NETWORK_ERRORS)[0]})`);
    }
    throw err;
  }
  const obs = await ex.observe();
  check(/Wikipedia/.test(obs.title), `portal title is "${obs.title}"`);
  const english = obs.elements.find((e) => e.kind === 'link' && /^English\b/.test(e.label));
  check(english, `English link found as ${english?.ref}`);
  await ex.click_ref(english.ref);
  const after = await ex.observe();
  check(/^https:\/\/en\.(m\.)?wikipedia\.org\//.test(after.url), `arrived at ${after.url}`);
  check(after.elements.length > 0, `observed ${after.elements.length} elements on English Wikipedia`);
  await controller.close();

  console.log('Smoke 2: full operator loop with MockPlanner');
  const task = await new Operator({ planner: new MockPlanner(), startUrl: 'https://www.wikipedia.org/', auditDir: null }).run('Open English Wikipedia');
  check(task.status === 'succeeded', `operator ${task.status}: ${task.summary}`);
  console.log('SMOKE PASSED');
} catch (err) {
  if (err instanceof SkipError) {
    console.log(`SKIPPED: ${err.message}. Run in an environment with internet access to exercise it.`);
  } else {
    console.error(`SMOKE FAILED: ${err.message}`);
    process.exitCode = 1;
  }
} finally {
  await controller.close();
}
