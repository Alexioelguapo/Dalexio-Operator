#!/usr/bin/env node
// Command-line entry point:
//   npm run operator -- "Open English Wikipedia"
//   npm run operator -- --planner claude --start-url https://example.com "Find the contact page"
//   npm run operator -- --planner claude-code,mock "Open English Wikipedia"

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { Operator } from '../src/operator/operator.js';
import { createPlanner, availablePlanners } from '../src/agents/router.js';
import { ApprovalGate, terminalApprover, denyAll } from '../src/safety/approval-gate.js';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const HELP = `Usage: dalexio-operator [options] "<objective>"

Options:
  --planner <name>      ${availablePlanners().join(' | ')}, or a comma list for fallback routing
                        (default: $DALEXIO_PLANNER or "mock")
  --start-url <url>     Page to open first (default: $DALEXIO_START_URL or https://www.wikipedia.org)
  --max-steps <n>       Step limit (default 15)
  --task-timeout <s>    Whole-task timeout in seconds (default 300)
  --headed              Show the browser window
  --no-approval         Deny every AMBER/RED action without prompting
  --json                Print the final task record as JSON
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
  browserOptions: { headless: !args.values.headed },
  gate: new ApprovalGate({ approver: args.values['no-approval'] ? denyAll : terminalApprover() }),
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

function printEvent(e) {
  const a = e.action ? JSON.stringify(e.action) : '';
  switch (e.type) {
    case 'task_start': console.log(`▶ ${e.objective}  [planner: ${e.planner}]`); break;
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
