import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserController, BrowserError } from '../../src/browser/controller.js';
import { startFixtureServer } from '../helpers/fixture-server.js';

let server;
let browser;
let shotDir;

before(async () => {
  server = await startFixtureServer();
  shotDir = await mkdtemp(path.join(os.tmpdir(), 'dalexio-shots-'));
  browser = new BrowserController({ screenshotDir: shotDir });
  await browser.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
  await rm(shotDir, { recursive: true, force: true });
});

const ref = (obs, label) => obs.elements.find((e) => e.label.includes(label))?.ref;

test('1. launches Chromium', () => {
  assert.equal(browser.isLaunched, true);
});

test('2. navigates and reports state', async () => {
  const nav = await browser.navigate(server.url('/portal.html'));
  assert.equal(nav.status, 200);
  assert.deepEqual(await browser.getState(), { url: server.url('/portal.html'), title: 'Wikipedia' });
});

test('navigation failures surface as BrowserError', async () => {
  await assert.rejects(browser.navigate('http://127.0.0.1:1/'), (e) => e instanceof BrowserError && e.code === 'navigation_failed');
});

test('readText reads the page or a selector', async () => {
  await browser.navigate(server.url('/portal.html'));
  assert.match(await browser.readText(), /free online encyclopedia/);
  assert.equal(await browser.readText('h2'), 'The Free Encyclopedia');
});

test('3. observes compact structured state with refs', async () => {
  await browser.navigate(server.url('/portal.html'));
  const obs = await browser.observe();
  assert.equal(obs.title, 'Wikipedia');
  assert.deepEqual(obs.headings, [{ level: 1, text: 'Wikipedia' }, { level: 2, text: 'The Free Encyclopedia' }]);
  assert.match(obs.text, /free online encyclopedia/);
  const english = obs.elements.find((e) => e.ref === 'link-0');
  assert.equal(english.label, 'English 7,000,000+ articles');
  assert.equal(english.href, server.url('/en.html'));
  const search = obs.elements.find((e) => e.kind === 'input');
  assert.deepEqual([search.ref, search.type, search.name, search.form], ['input-0', 'search', 'search', 'form-0']);
  assert.deepEqual(obs.forms[0].isSearch, true);
  // Hidden elements are excluded.
  assert.ok(!obs.elements.some((e) => /Hidden/.test(e.label)));
});

test('refs are stable across observations of the same document', async () => {
  await browser.navigate(server.url('/dynamic.html'));
  const first = await browser.observe();
  const original = ref(first, 'Original link');
  await browser.clickRef(ref(first, 'Add link'));
  const second = await browser.observe();
  assert.equal(ref(second, 'Original link'), original, 'existing element keeps its ref');
  const added = second.elements.find((e) => e.label.startsWith('Added link'));
  assert.ok(added && added.ref !== original, 'new element gets a fresh ref');
});

test('observation is bounded (elements and text are truncated)', async () => {
  await browser.navigate(server.url('/dynamic.html'));
  const obs = await browser.observe();
  assert.ok(obs.elements.length <= 60);
  assert.ok(obs.truncated.elements > 0);
  assert.ok(obs.text.length <= 1501);
  assert.equal(obs.truncated.text, true);
  assert.ok(JSON.stringify(obs).length < 15_000, 'observation stays token-efficient');
});

test('4. click_ref follows a link', async () => {
  await browser.navigate(server.url('/portal.html'));
  const obs = await browser.observe();
  await browser.clickRef(ref(obs, 'English'));
  assert.equal((await browser.getState()).title, 'Wikipedia, the free encyclopedia');
});

test('5. type_ref fills an input and can submit', async () => {
  await browser.navigate(server.url('/portal.html'));
  let obs = await browser.observe();
  await browser.typeRef('input-0', 'octopus');
  obs = await browser.observe();
  assert.equal(obs.elements.find((e) => e.ref === 'input-0').value, 'octopus');
  await browser.typeRef('input-0', 'squid', { submit: true });
  assert.equal((await browser.getState()).title, 'Search results for squid');
});

test('password values are never exposed in observations', async () => {
  await browser.navigate(server.url('/forms.html'));
  let obs = await browser.observe();
  const pw = obs.elements.find((e) => e.sensitive === 'password');
  await browser.typeRef(pw.ref, 'hunter2');
  obs = await browser.observe();
  assert.equal(obs.elements.find((e) => e.ref === pw.ref).value, '[redacted]');
  assert.ok(!JSON.stringify(obs).includes('hunter2'));
  assert.equal(obs.elements.find((e) => e.label === 'Card number').sensitive, 'payment');
});

test('stale refs are rejected after navigation', async () => {
  await browser.navigate(server.url('/forms.html'));
  await browser.observe();
  await browser.navigate(server.url('/submitted.html'));
  await assert.rejects(browser.clickRef('button-3'), (e) => e.code === 'stale_ref');
});

test('selector-based click and type still work', async () => {
  await browser.navigate(server.url('/forms.html'));
  await browser.type('#name', 'Ada');
  assert.equal(await browser.page.inputValue('#name'), 'Ada');
  await browser.click('#delete');
  assert.equal(await browser.readText('#status'), 'deleted');
});

test('follows links that open a new tab', async () => {
  await browser.navigate(server.url('/dynamic.html'));
  const obs = await browser.observe();
  await browser.clickRef(ref(obs, 'Open French'));
  await browser.page.waitForLoadState('domcontentloaded');
  assert.match((await browser.getState()).title, /Wikipédia/);
});

test('takes screenshots', async () => {
  await browser.navigate(server.url('/portal.html'));
  const { path: file } = await browser.screenshot();
  assert.ok(file.startsWith(shotDir));
  assert.ok(existsSync(file));
});

test('close() is idempotent and leaves no browser running', async () => {
  const b = new BrowserController();
  await b.launch();
  await b.close();
  await b.close();
  assert.equal(b.isLaunched, false);
  await assert.rejects(b.observe(), (e) => e.code === 'not_launched');
});
