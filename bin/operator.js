#!/usr/bin/env node
// Command-line entry point:
//   npm run operator -- "Open English Wikipedia"
//   npm run operator -- --planner claude --start-url https://example.com "Find the contact page"
//   npm run operator -- --planner claude-code,mock "Open English Wikipedia"
//   npm run operator -- --profile mixed-beanz --login https://example.com/login
//   npm run operator -- --profile mixed-beanz --planner claude-code "…"

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Operator } from '../src/operator/operator.js';
import { BrowserController } from '../src/browser/controller.js';
import { ProfileStore, validateProfileName } from '../src/browser/profiles.js';
import { displayPath } from '../src/files/paths.js';
import { createPlanner, availablePlanners } from '../src/agents/router.js';
import { ApprovalGate, terminalApprover, denyAll } from '../src/safety/approval-gate.js';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const HELP = `Usage: dalexio-operator [options] "<objective>"
       dalexio-operator --profile <name> --login <url>
       dalexio-operator --list-profiles

Run options:
  --planner <name>      ${availablePlanners().join(' | ')}, or a comma list for fallback routing
                        (default: $DALEXIO_PLANNER or "mock")
  --start-url <url>     Page to open first (default: $DALEXIO_START_URL or https://www.wikipedia.org)
  --max-steps <n>       Step limit (default 15)
  --task-timeout <s>    Whole-task timeout in seconds (default 300)
  --profile <name>      Use the persistent browser profile <name> (cookies/logins kept in
                        .dalexio/profiles/<name>). Without it, every run is stateless.
  --allow-file <path>   Offer this file to upload_file (repeatable). Files in
                        .dalexio/uploads/<profile> are offered automatically.
  --headed              Show the browser window
  --no-approval         Deny every AMBER/RED action without prompting
  --json                Print the final task record as JSON

Profile options:
  --login <url>         Open <url> in a visible browser using --profile, let you log in by
                        hand, and save the session. No planner runs; nothing is logged.
  --list-profiles       List saved profiles

  -h, --help            Show this help`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      planner: { type: 'string' },
      'start-url': { type: 'string' },
      'max-steps': { type: 'string' },
      'task-timeout': { type: 'string' },
      profile: { type: 'string' },
      login: { type: 'string' },
      'list-profiles': { type: 'boolean', default: false },
      'allow-file': { type: 'string', multiple: true, default: [] },
      headed: { type: 'boolean', default: false },
      'no-approval': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}

const profile = args.values.profile;
if (profile !== undefined) {
  try { validateProfileName(profile); } catch (err) { console.error(err.message); process.exit(2); }
}

if (args.values['list-profiles']) {
  const profiles = await new ProfileStore().list();
  if (!profiles.length) console.log('No saved profiles. Create one with: --profile <name> --login <url>');
  for (const p of profiles) console.log(`${p.name.padEnd(24)} last used ${p.modified}${p.locked ? '  (in use)' : ''}`);
  process.exit(0);
}

if (args.values.login !== undefined) {
  if (!profile) { console.error('--login needs --profile <name>'); process.exit(2); }
  process.exit(await loginBootstrap(profile, args.values.login));
}

const objective = args.positionals.join(' ').trim();
if (args.values.help || !objective) {
  console.log(HELP);
  process.exit(args.values.help ? 0 : 2);
}

const positiveInt = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) { console.error(`--${name} must be a positive integer`); process.exit(2); }
  return n;
};

const limits = {};
const maxSteps = positiveInt(args.values['max-steps'], 'max-steps');
const taskTimeout = positiveInt(args.values['task-timeout'], 'task-timeout');
if (maxSteps) limits.maxSteps = maxSteps;
if (taskTimeout) limits.taskTimeoutMs = taskTimeout * 1000;

const operator = new Operator({
  planner: createPlanner(args.values.planner ?? process.env.DALEXIO_PLANNER ?? 'mock'),
  startUrl: args.values['start-url'] ?? process.env.DALEXIO_START_URL ?? 'https://www.wikipedia.org',
  browserOptions: { headless: !args.values.headed, profile: profile ?? null },
  gate: new ApprovalGate({ approver: args.values['no-approval'] ? denyAll : terminalApprover() }),
  files: args.values['allow-file'],
  limits,
  onEvent: args.values.json ? undefined : printEvent,
});

// Ctrl-C: close the browser cleanly instead of leaving Chromium behind.
let interrupted = false;
process.on('SIGINT', async () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.error('\nInterrupted — closing browser…');
  await operator.controller.close();
  process.exit(130);
});

const task = await operator.run(objective);
if (args.values.json) {
  console.log(JSON.stringify(task, null, 2));
} else {
  console.log(`\n${task.status === 'succeeded' ? '✔' : '✘'} ${task.status} after ${task.step} step(s) in ${(task.elapsedMs / 1000).toFixed(1)}s`);
  if (task.summary) console.log(`  ${task.summary}`);
  if (task.failure) console.log(`  failure: ${task.failure.code}`);
}
process.exitCode = task.status === 'succeeded' ? 0 : 1;

async function loginBootstrap(name, url) {
  const store = new ProfileStore();
  const existed = await store.exists(name);
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error([
      'No display found, so a visible browser cannot open here.',
      'Options:',
      '  • Codespaces: add the "desktop-lite" dev container feature and open its noVNC desktop,',
      '    then run this command from a terminal inside that desktop (or with DISPLAY=:1).',
      '  • Run the --login step on a machine with a screen, then reuse the profile there.',
    ].join('\n'));
    return 2;
  }
  const controller = new BrowserController({ headless: false, profile: name });
  try {
    await controller.launch();
    await controller.navigate(url);
  } catch (err) {
    console.error(`Could not open the login browser: ${err.message}`);
    await controller.close();
    return 1;
  }
  console.log([
    `Profile "${name}" ${existed ? '(existing)' : '(new)'} — browser opened at ${url}`,
    'Log in by hand in that window. Dalexio does not read, record or log anything you type.',
    'When you are done, press Enter here (or close the browser window) to save the session.',
  ].join('\n'));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await Promise.race([rl.question('').catch(() => {}), controller.waitForClose()]);
  rl.close();
  await controller.close();
  console.log(`Saved. Session data is in ${displayPath(store.paths(name).base)} (gitignored, never committed).`);
  console.log(`Reuse it with: npm run operator -- --profile ${name} "<objective>"`);
  return 0;
}

function printEvent(e) {
  const a = e.action ? JSON.stringify(e.action) : '';
  switch (e.type) {
    case 'task_start': console.log(`▶ ${e.objective}  [planner: ${e.planner}${e.profile ? `, profile: ${e.profile}` : ', stateless'}]`); break;
    case 'files_available': console.log(`  files offered for upload: ${e.files.map((f) => `${f.id}=${f.name}`).join(', ')}`); break;
    case 'file_downloaded': console.log(`  ⬇ saved ${e.download.path} (${e.download.mimeType}, ${e.download.bytes} bytes)`); break;
    case 'action_invalidated': console.log(`  ✘ approval invalidated: ${e.error}`); break;
    case 'observation': console.log(`  observed ${e.observation.title || e.observation.url} (${e.observation.elements} elements)`); break;
    case 'action_proposed': if (e.risk.level !== 'GREEN') console.log(`  ⚠ ${e.risk.reasons.join('; ')}`); break;
    case 'action_executed': console.log(`  #${e.step} ${a} → ${e.result}`); break;
    case 'action_rejected': console.log(`  ✘ rejected ${JSON.stringify(e.proposed)}: ${e.error}`); break;
    case 'action_denied': console.log(`  ✘ denied ${a}${e.note ? ` (${e.note})` : ''}`); break;
    case 'action_failed': console.log(`  ✘ failed ${a}: ${e.error}`); break;
    case 'planner_error': console.log(`  ✘ planner: ${e.error}`); break;
    default: break;
  }
}
