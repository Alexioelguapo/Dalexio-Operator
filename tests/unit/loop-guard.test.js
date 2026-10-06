import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, LoopGuardViolation } from '../../src/operator/loop-guard.js';

const click = { action: 'click_ref', ref: 'button-0' };

test('allows an action up to the repeat limit on the same page state, then refuses', () => {
  const g = new LoopGuard({ maxRepeatedActions: 2 });
  g.beforeAction(click, 'aaa');
  g.beforeAction(click, 'aaa');
  assert.throws(() => g.beforeAction(click, 'aaa'), (e) => e instanceof LoopGuardViolation && e.code === 'repeated_action');
});

test('the same action on a different page state is not a repeat', () => {
  const g = new LoopGuard({ maxRepeatedActions: 1 });
  g.beforeAction(click, 'aaa');
  g.beforeAction(click, 'bbb');
  g.beforeAction({ action: 'click_ref', ref: 'button-1' }, 'aaa');
});

test('detects consecutive state-changing actions that do not change the page', () => {
  const g = new LoopGuard({ maxStagnantSteps: 3 });
  g.afterAction(click, 'aaa', 'aaa');
  g.afterAction({ action: 'observe' }, 'aaa', 'aaa'); // read-only actions don't count
  g.afterAction(click, 'aaa', 'aaa');
  assert.throws(() => g.afterAction(click, 'aaa', 'aaa'), (e) => e.code === 'stuck_page_state');
});

test('progress resets the stagnation counter', () => {
  const g = new LoopGuard({ maxStagnantSteps: 2 });
  g.afterAction(click, 'aaa', 'aaa');
  g.afterAction(click, 'aaa', 'bbb');
  g.afterAction(click, 'bbb', 'bbb');
});

test('detects oscillation between page states', () => {
  const g = new LoopGuard({ maxStateVisits: 2 });
  g.afterAction(click, 'A', 'B');
  g.afterAction(click, 'B', 'A');
  g.afterAction(click, 'A', 'B');
  g.afterAction(click, 'B', 'A');
  assert.throws(() => g.afterAction(click, 'A', 'B'), (e) => e.code === 'page_state_loop');
});
