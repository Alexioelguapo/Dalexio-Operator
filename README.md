# Dalexio Operator

Dalexio Operator is a browser agent foundation that doesn't depend on any one model provider. A planner (a mock, Claude, OpenAI, OpenRouter, or anything you plug in) looks at a compact view of a web page and proposes **one** action at a time. Before that action reaches the browser, the operator checks it against a strict schema, classifies its risk, gets approval if needed, and runs it under timeouts and loop protection.

The mock planner needs no API keys and no paid services. The model planners keep credentials outside the repository.

```bash
npm install
npm test                                   # 89 unit + integration tests, local fixtures only
npm run operator -- "Open English Wikipedia"   # mock planner, real wikipedia.org
```

---

## Architecture

```
bin/operator.js          CLI  (also: node operator.js "<objective>")
src/
  actions/schema.js      V1 action contract + validateAction()      ← the trust boundary
  browser/
    controller.js        BrowserController: Playwright/Chromium wrapper
    observation.js       In-page compact observation + stable refs
    executor.js          BrowserExecutor: validate → run with timeout
  agents/
    planner.js           Planner contract + PlannerError
    prompt.js            Shared system prompt, page rendering, tool schemas
    mock-planner.js      MockPlanner (heuristic) + ScriptedPlanner (tests)
    claude-planner.js    ClaudePlanner (Anthropic SDK, optional dependency)
    openai-planner.js    OpenAI / OpenRouter / any OpenAI-compatible endpoint
    router.js            createPlanner() factory + RouterPlanner fallback chain
  safety/
    policy.js            GREEN / AMBER / RED risk classification
    approval-gate.js     Pluggable approvers (deny-all, terminal, custom)
  state/
    task-state.js        Per-run status, history, failure reason
    audit-log.js         Append-only JSONL audit log with redaction
  operator/
    operator.js          The loop
    loop-guard.js        Repeated-action / stuck-page / oscillation detection
  util/timeout.js
tests/
  unit/                  schema, safety, planners, loop guard, state
  integration/           real Chromium against local fixture pages
  smoke/                 optional live wikipedia.org check
  fixtures/, helpers/    deterministic HTML pages + a tiny local server
```

Each layer only depends on the ones below it. The browser layer knows nothing about planners. Planners never touch the browser. The operator is the only component that joins them.

## The loop

```
observe ─► plan ─► validate ─► loop-guard ─► classify risk ─► approval gate ─► execute ─► observe ─► …
                     │                                             │
                     └─ rejected: error is fed back to the planner ─┘ denied: same
```

For each step:

1. **Plan.** The planner receives `{ objective, observation, history, step, maxSteps }` and returns one action. Planner calls are bounded by `plannerTimeoutMs`.
2. **Validate.** `validateAction(action, { observation })` rejects anything that isn't a well-formed V1 action, or whose ref is not in the observation the planner just saw. The rejection is recorded in history so the planner can correct itself. After `maxConsecutiveErrors` (default 3) consecutive errors, the task fails.
3. **Loop guard.** It refuses a repeated identical action on an unchanged page, and fails the task when actions stop changing the page or it keeps bouncing between the same states.
4. **Risk and approval.** The policy classifies the action, then the approval gate runs **immediately before execution**. A RED confirmation applies only to the step it was given for; the next RED step asks again.
5. **Execute** under `actionTimeoutMs`. Browser errors are recorded and the page is re-observed. If the browser itself dies, the task fails.
6. **Re-observe.** The next plan always sees fresh refs.

A run ends in one of three ways:
- **Success:** the planner returns `done`.
- **Failure:** the run stops with a specific `failure.code`: `max_steps`, `task_timeout`, `too_many_errors`, `planner_failed`, `browser_failed`, `objective_not_achieved`, `repeated_action`, `stuck_page_state` or `page_state_loop`.
- **Shutdown:** in every case, the browser is closed in a `finally` block. Ctrl-C in the CLI also closes it.

### Limits (defaults)

| Limit | Default |
|---|---|
| `maxSteps` | 15 |
| `actionTimeoutMs` | 20 s |
| `plannerTimeoutMs` | 90 s |
| `taskTimeoutMs` | 5 min |
| `maxConsecutiveErrors` | 3 |
| `maxRepeatedActions` (same action, same page state) | 2 |
| `maxStagnantSteps` (state-changing actions with no page change) | 3 |
| `maxStateVisits` (re-entering one page state) | 4 |

Override any of them with `new Operator({ limits: { … } })`.

## How browser control works

`BrowserController` launches Chromium through Playwright:
- **Isolation:** each run gets a fresh, isolated context with no persisted cookies, and downloads are disabled.
- **Timeouts:** navigation and action calls have their own timeouts.
- **Errors:** every failure is raised as a `BrowserError` with a `code`, such as `navigation_failed`, `stale_ref` or `click_failed`.
- **New tabs:** popups and `target=_blank` links are followed automatically.

### Observations and refs

`observe()` runs one script in the page and returns compact state:

```js
{
  url, title,
  headings: [{ level: 1, text: 'Wikipedia' }, …],          // h1–h3, max 15
  text: 'visible text, collapsed…',                        // max 1,500 chars
  elements: [                                              // max 60, in-viewport first
    { ref: 'link-0',   kind: 'link',   label: 'English 7,000,000+ articles', href: 'https://en.wikipedia.org/' },
    { ref: 'input-0',  kind: 'input',  type: 'search', name: 'search', label: 'Search Wikipedia', form: 'form-0' },
    { ref: 'button-0', kind: 'button', type: 'submit', label: 'Search', form: 'form-0' },
  ],
  forms: [{ id: 'form-0', method: 'get', action: '…', isSearch: true, hasPassword: false, hasPayment: false }],
  truncated: { text: false, elements: 0 },
}
```

How refs work:
- **What gets a ref:** each visible link, button, input, textarea, select, checkbox and radio is tagged in the DOM with `data-dalexio-ref`.
- **Stability:** refs stay the same across observations of the same document. An element keeps its ref, and new elements get new numbers. They reset only when the document is replaced.
- **Stale refs:** a ref that no longer resolves fails with `stale_ref` instead of clicking the wrong thing.
- **Excluded:** hidden elements are left out of the observation.
- **Sensitive fields:** password, OTP and payment inputs are flagged `sensitive`, and their values are always shown as `[redacted]`.

## Supported actions (V1)

| Action | Fields | Notes |
|---|---|---|
| `navigate` | `url` | Absolute `http(s)` only. `javascript:`, `file:`, `data:`, `chrome:` and URLs with embedded credentials are rejected. |
| `click_ref` | `ref` | Ref must exist in the current observation and not be disabled. |
| `type_ref` | `ref`, `text`, `submit?` | Text inputs and textareas only. Max 2,000 chars, no control characters. `submit` presses Enter. |
| `observe` | – | Fresh observation. |
| `screenshot` | `fullPage?` | Saved under `.dalexio/screenshots/` (gitignored). |
| `done` | `summary`, `success?` | Ends the task. `success: false` reports that the objective could not be achieved. |

Every action may also carry a `reason` string, which is logged and never executed.

Validation also rejects:
- unknown actions;
- unexpected fields, so extra parameters can't be smuggled in;
- an explicit deny-list of names such as `shell`, `exec`, `eval`, `evaluate`, `run_script` and `write_file`.

The browser-action interface cannot run shell commands, scripts or file operations.

`BrowserExecutor` also keeps the selector-based developer helpers (`read`, `click`, `type`, `state`). They are not reachable through `execute()`, so planners cannot use them.

## Safety model

| Class | Behaviour | Examples |
|---|---|---|
| **GREEN** | Runs automatically. | navigate, observe, screenshot, ordinary links, search forms, typing into non-sensitive fields |
| **AMBER** | Needs approval. | submitting a non-search form, send/post/publish/upload/save buttons, account settings, entering passwords or OTPs, `javascript:` links |
| **RED** | Needs typed confirmation (`CONFIRM`) immediately before execution, every time. | pay/buy/checkout/place order, transfers, contract or tender submission, delete/close account, password and 2FA changes, payment-field entry, hosts listed in `policy.redHosts` |

How classification works:
- **Inputs:** the policy looks at the element label, its kind and type, the form it belongs to (search, password or payment form), and field sensitivity.
- **Raise only:** classification can only increase risk. Nothing the planner says can lower it.
- **Future actions:** action types not built yet already have a fixed class (`upload_file` and `send_message` are AMBER; `purchase`, `payment` and `delete` are RED).
- **Unknown actions:** any action type the policy doesn't recognise is treated as RED.

Approval is pluggable. An approver is `async ({ level, action, reasons, observation }) => boolean | { approved, note }`:

```js
import { Operator, ApprovalGate, terminalApprover, approveAmberOnly, denyAll } from './src/index.js';

new Operator({
  planner,
  gate: new ApprovalGate({ approver: terminalApprover() }),          // prompt in the terminal
  // gate: new ApprovalGate({ approver: approveAmberOnly }),        // supervised automation, RED still denied
  // gate: new ApprovalGate({ approver: myWebUi, redApprover: myTwoPersonCheck }),
});
```

Gate rules:
- **Default:** the gate denies all AMBER and RED actions.
- **Strict answers:** anything other than an explicit `true` counts as a denial, and so does an approver that throws.
- **Unattended CLI runs:** when stdin isn't a TTY, the terminal approver denies.

Every event is written to `.dalexio/runs/<taskId>.jsonl`. Text typed into sensitive fields is redacted in both the audit log and the planner-visible history.

## Running it

```bash
npm install                     # Playwright 1.56.1 (+ optional @anthropic-ai/sdk)
npx playwright install chromium # only if Chromium isn't already available

npm test                        # everything below except smoke
npm run test:unit               # no browser needed
npm run test:integration        # real Chromium against local fixture pages
npm run check                   # node --check on every source file
npm run smoke                   # live wikipedia.org; prints SKIPPED if offline
SMOKE_STRICT=1 npm run smoke    # treat "offline" as a failure

npm run operator -- "Open English Wikipedia"
npm run operator -- --start-url https://www.wikipedia.org "Search for octopus"
npm run operator -- --planner claude,mock --max-steps 10 "Open English Wikipedia"
npm run operator -- --headed --json "Open English Wikipedia"
node operator.js "Open English Wikipedia"      # original entry point still works
```

Exit codes: `0` on success, `1` on task failure, `2` on bad CLI usage.

### The mock planner

`MockPlanner` is deterministic and offline. It understands three objective shapes:
- **"Open X":** it clicks the link that best matches the words in X.
- **"Go to https://…":** it navigates to that URL.
- **"Search for X":** it types X into the page's search box and presses Enter.

It returns `done` once its action has run. If nothing matches, it returns `done` with `success: false`. `ScriptedPlanner` replays a fixed list of actions, for tests.

## Plugging in a model planner

Any object with `plan(context) → Promise<action>` works:

```js
import { Planner, Operator } from './src/index.js';

class MyPlanner extends Planner {
  constructor() { super('mine'); }
  async plan({ objective, observation, history, step, maxSteps }) {
    return { action: 'observe' };
  }
}
await new Operator({ planner: new MyPlanner() }).run('…');
```

What the built-in planners share (`src/agents/prompt.js`):
- **System prompt:** it treats page content as untrusted, so text on a page can't override the objective or rules.
- **Page rendering:** a compact text form of the observation, usually well under 1 k tokens.
- **Tools:** one per action, with closed JSON schemas.
- **Validation:** the operator still validates every result. Planners are never trusted to validate their own output.

| Planner | Name | Credentials | Notes |
|---|---|---|---|
| `MockPlanner` | `mock` | none | Default. |
| `ClaudePlanner` | `claude` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile, resolved by the SDK | See below. |
| `OpenAIPlanner` | `openai` | `OPENAI_API_KEY` + `DALEXIO_OPENAI_MODEL` | Plain `fetch`, no dependency. `DALEXIO_OPENAI_BASE_URL` points it at any OpenAI-compatible server. |
| `OpenRouterPlanner` | `openrouter` | `OPENROUTER_API_KEY` + `DALEXIO_OPENROUTER_MODEL` | Same implementation as `openai`, with OpenRouter's base URL. |
| `RouterPlanner` | `a,b,c` | — | Tries planners in order. It falls through on auth, quota, network, refusal or missing-dependency errors, but never on a returned action. |

`registerPlanner(name, factory)` adds new providers to `createPlanner()` and the CLI.

### Claude planner

- **SDK:** it uses the official `@anthropic-ai/sdk`, an `optionalDependency` that is imported only when the planner is used.
- **Model:** the default is `claude-opus-5-5`; override it with `DALEXIO_CLAUDE_MODEL`. Effort is set explicitly (`DALEXIO_CLAUDE_EFFORT`, default `medium`).
- **Tool choice:** current Claude models reject forced `tool_choice`. The planner sends `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`, tells the model in the prompt to call exactly one tool, and retries once if it doesn't.
- **Fallbacks:** server-side refusal fallback (`fallbacks: "default"`) is on by default. Set `DALEXIO_CLAUDE_FALLBACKS=false` when using a Bedrock, Vertex or Foundry client through the `client` option.
- **Errors:** refusals, `max_tokens` truncation, auth errors and retryable API errors map to `PlannerError` codes, which the router and operator understand.
- **Testing:** pass `{ client }` to inject any Anthropic-compatible client. The tests do this, and also run the real SDK against a captured `fetch`, so no network or key is needed.

**Credentials are never stored in this repository.** Put them in `.env` (gitignored; see `.env.example`) or your shell or CI secret store.

## Current limitations

- The live Claude and OpenAI paths are tested only against fake clients and a captured `fetch`. A run against the real APIs has not been done (it needs credentials and credits).
- The live Wikipedia smoke test could not run in the cloud environment where this was built (outbound access is blocked there). It reports `SKIPPED`. Run it from Codespaces or a local machine.
- There are no actions yet for `select`, checkboxes, scrolling, hover, keyboard shortcuts, uploads or downloads. Checkboxes can be clicked with `click_ref`.
- Risk classification uses keywords and structure, in English only. It is deliberately conservative (it errs toward AMBER), but it cannot know what an arbitrary button really does. Treat it as a safety net, not a guarantee.
- Observations don't look inside iframes or shadow DOM, and there is no vision or screenshot input to planners.
- One tab is active at a time, and there is no persistent login or session reuse (by design, for now).

## Roadmap

1. **Claude in production.** Run `ClaudePlanner` against real tasks with a key and tune the prompt and effort.
2. **Router policies.** Choose a planner by cost or latency, fall back automatically on `quota_exhausted` (already wired), and add per-provider budgets.
3. **Approval surfaces.** Add web and chat approvers, and a two-person rule for RED.
4. **Richer actions.** Add `select_ref`, `scroll`, `press_key`, `upload_file` (AMBER) and `wait_for`, each with schema and policy entries.
5. **Observation upgrades.** Add iframe and shadow-DOM traversal, optional screenshot input for vision models, and diff-based observations to save tokens.
6. **Resumable tasks.** Persist `TaskState` so a run can pause for approval and continue later.
7. **CI.** Run `npm test` on pull requests.
