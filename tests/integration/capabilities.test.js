import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserController, BrowserError } from '../../src/browser/controller.js';
import { BrowserExecutor } from '../../src/browser/executor.js';
import { ActionValidationError } from '../../src/actions/schema.js';
import { startFixtureServer } from '../helpers/fixture-server.js';

let server;
let root;
before(async () => {
  server = await startFixtureServer();
  root = await mkdtemp(path.join(os.tmpdir(), 'dalexio-cap-'));
});
after(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

async function session(opts = {}, fn) {
  const c = new BrowserController({ stateRoot: root, ...opts });
  await c.launch();
  try {
    return await fn(new BrowserExecutor(c), c);
  } finally {
    await c.close();
  }
}
const refOf = (obs, label) => obs.elements.find((e) => e.label.includes(label))?.ref;
const whoami = async (ex) => {
  await ex.navigate(server.url('/whoami'));
  return ex.read('#who').then(async (who) => [who, await ex.read('#ls')]);
};

// --- persistent profiles ------------------------------------------------------

test('profiles: a login persists across runs and stays inside its own profile', async () => {
  await session({ profile: 'mixed-beanz' }, async (ex) => {
    await ex.navigate(server.url('/set-session?who=beanz'));
    assert.deepEqual(await whoami(ex), ['beanz', 'beanz']);
  });
  await session({ profile: 'ai-carty' }, async (ex) => {
    assert.deepEqual(await whoami(ex), ['nobody', 'none'], 'a second profile does not see the first one\'s cookie or storage');
    await ex.navigate(server.url('/set-session?who=carty'));
  });
  await session({ profile: 'mixed-beanz' }, async (ex) => {
    assert.deepEqual(await whoami(ex), ['beanz', 'beanz'], 'session reused on the next run');
  });
  await session({ profile: 'ai-carty' }, async (ex) => {
    assert.deepEqual(await whoami(ex), ['carty', 'carty']);
  });
  await session({}, async (ex) => {
    assert.deepEqual(await whoami(ex), ['nobody', 'none'], 'stateless mode sees no profile data');
    await ex.navigate(server.url('/set-session?who=temp'));
  });
  await session({}, async (ex) => {
    assert.deepEqual(await whoami(ex), ['nobody', 'none'], 'stateless runs persist nothing');
  });
  const profiles = await readdir(path.join(root, 'profiles'));
  assert.deepEqual(profiles.sort(), ['.gitignore', 'ai-carty', 'mixed-beanz']);
});

test('profiles: one profile cannot be opened twice at once; the lock is released on close', async () => {
  const a = new BrowserController({ stateRoot: root, profile: 'default' });
  await a.launch();
  try {
    const b = new BrowserController({ stateRoot: root, profile: 'default' });
    await assert.rejects(b.launch(), (e) => e instanceof BrowserError && e.code === 'profile_locked');
  } finally {
    await a.close();
  }
  await session({ profile: 'default' }, async (ex, c) => assert.equal(c.isLaunched, true));
});

test('profiles: invalid names are rejected before anything touches disk', () => {
  assert.throws(() => new BrowserController({ stateRoot: root, profile: '../escape' }), /invalid profile name/);
});

test('observations never contain cookies or storage', async () => {
  await session({ profile: 'mixed-beanz' }, async (ex) => {
    await ex.navigate(server.url('/whoami'));
    const obs = await ex.observe();
    assert.ok(!JSON.stringify(obs).includes('session='));
    const { result } = await ex.execute({ action: 'read_page' });
    assert.ok(!JSON.stringify(result).includes('session='));
  });
});

// --- forms ----------------------------------------------------------------------

test('forms: select, checkbox, radio, switch, date/time, textarea, contenteditable', async () => {
  await session({}, async (ex) => {
    await ex.navigate(server.url('/controls.html'));
    let obs = await ex.observe();
    const run = (a) => ex.execute(a, { observation: obs });
    assert.equal((await run({ action: 'select_option', ref: refOf(obs, 'Account'), option: 'mixed beanz' })).result.selected, 'Mixed Beanz');
    assert.equal((await run({ action: 'select_option', ref: refOf(obs, 'Country'), option: 'zw' })).result.selected, 'Zimbabwe', 'by value, beyond the first 10 options');
    await assert.rejects(run({ action: 'select_option', ref: refOf(obs, 'Account'), option: 'Archived brand' }), (e) => e.code === 'option_disabled');
    await assert.rejects(run({ action: 'select_option', ref: refOf(obs, 'Account'), option: 'Nope' }), (e) => e.code === 'option_not_found' && /Mixed Beanz/.test(e.message));
    await run({ action: 'set_checked', ref: refOf(obs, 'Notify followers'), checked: true });
    await run({ action: 'set_checked', ref: refOf(obs, 'Private'), checked: true });
    await run({ action: 'set_checked', ref: refOf(obs, 'Auto-crop'), checked: true });
    await run({ action: 'type_ref', ref: refOf(obs, 'Publish date'), text: '2026-12-01' });
    await run({ action: 'type_ref', ref: refOf(obs, 'Publish time'), text: '09:30' });
    await run({ action: 'type_ref', ref: refOf(obs, 'Caption'), text: 'New roast drops Friday' });
    await run({ action: 'type_ref', ref: refOf(obs, 'Rich caption'), text: 'Rich text caption' });
    obs = await ex.observe();
    const el = (l) => obs.elements.find((e) => e.label.includes(l));
    assert.equal(el('Account').value, 'Mixed Beanz');
    assert.equal(el('Country').value, 'Zimbabwe');
    assert.equal(el('Country').optionCount, 31);
    assert.equal(el('Notify followers').checked, true);
    assert.equal(el('Private').checked, true);
    assert.equal(el('Public').checked, false);
    assert.equal(el('Auto-crop').checked, true, 'ARIA switch');
    assert.equal(el('Publish date').value, '2026-12-01');
    assert.equal(el('Publish time').value, '09:30');
    assert.equal(el('Rich caption').value, 'Rich text caption');
    assert.equal(obs.url, server.url('/controls.html'), 'none of this submitted the form');
    await run({ action: 'set_checked', ref: refOf(obs, 'Notify followers'), checked: false });
    assert.equal((await ex.observe()).elements.find((e) => e.label.includes('Notify')).checked, false);
  });
});

test('forms: wrong targets and bad formats are rejected before reaching the page', async () => {
  await session({}, async (ex) => {
    await ex.navigate(server.url('/controls.html'));
    const obs = await ex.observe();
    const rejects = (a, code) => assert.rejects(ex.execute(a), (e) => e instanceof ActionValidationError && e.code === code);
    await rejects({ action: 'select_option', ref: refOf(obs, 'Publish'), option: 'x' }, 'wrong_target');
    await rejects({ action: 'set_checked', ref: refOf(obs, 'Public'), checked: false }, 'wrong_target');
    await rejects({ action: 'type_ref', ref: refOf(obs, 'Publish date'), text: '1 Dec 2026' }, 'invalid_text');
    await rejects({ action: 'upload_file', ref: refOf(obs, 'Caption'), file: 'file-0' }, 'wrong_target');
  });
});

// --- reading ----------------------------------------------------------------------

test('read_page: main content, bounded chunks, find, and redaction', async () => {
  await session({}, async (ex) => {
    await ex.navigate(server.url('/article.html'));
    await ex.observe();
    const first = (await ex.execute({ action: 'read_page', maxChars: 500 })).result.reading;
    assert.deepEqual([first.title, first.scope, first.chars, first.nextOffset], ['Zimbabwe - Fixturepedia', 'main', 500, 500]);
    assert.ok(first.totalChars > 10_000);
    assert.ok(!first.text.includes('Main page'), 'nav chrome outside <main> is skipped');
    assert.deepEqual(first.headings, ['# Zimbabwe', '## History', '## Geography']);
    const next = (await ex.execute({ action: 'read_page', offset: first.nextOffset, maxChars: 500 })).result.reading;
    assert.equal(next.offset, 500);
    const found = (await ex.execute({ action: 'read_page', find: 'official languages' })).result.reading;
    assert.equal(found.matches, 1);
    assert.match(found.passages[0].text, /Capital and largest city Harare/);
    assert.match(found.passages[0].text, /English, Shona and Ndebele/);
    const token = (await ex.execute({ action: 'read_page', find: 'api token' })).result.reading;
    assert.match(token.passages[0].text, /\[redacted secret\]/);
    assert.ok(!token.passages[0].text.includes('eyJhbGci'));
  });
});

test('read_ref: every option of a long dropdown; sensitive values stay redacted', async () => {
  await session({}, async (ex) => {
    await ex.navigate(server.url('/controls.html'));
    const obs = await ex.observe();
    const country = (await ex.execute({ action: 'read_ref', ref: refOf(obs, 'Country') })).result.reading;
    assert.equal(country.options.length, 31);
    assert.equal(country.options.at(-1).label, 'Zimbabwe');
    const pw = (await ex.execute({ action: 'read_ref', ref: refOf(obs, 'Password') })).result.reading;
    assert.equal(pw.value, '[redacted]');
    assert.ok(!JSON.stringify(pw).includes('hunter2'));
    const page = (await ex.execute({ action: 'read_page' })).result.reading;
    assert.ok(!page.text.includes('hunter2'), 'input values never appear in page text');
  });
});

// --- downloads ----------------------------------------------------------------------

test('downloads: saved into the managed folder with metadata, never executable', async () => {
  await session({ profile: 'mixed-beanz' }, async (ex, c) => {
    await ex.navigate(server.url('/controls.html'));
    let obs = await ex.observe();
    const { result } = await ex.execute({ action: 'download_ref', ref: refOf(obs, 'Download report') });
    const d = result.download;
    assert.equal(d.filename, 'report.csv');
    assert.equal(d.mimeType, 'text/csv');
    assert.equal(d.bytes, 27);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.equal(d.sourceUrl, server.url('/files/report.csv'));
    assert.equal(d.fileId, 'file-0', 'downloads become available for upload');
    const saved = path.join(c.downloadsDir, 'report.csv');
    assert.equal(c.downloadsDir, path.join(root, 'downloads', 'mixed-beanz'));
    assert.equal(await readFile(saved, 'utf8'), 'brand,posts\nmixed-beanz,12\n');
    assert.equal((await stat(saved)).mode & 0o111, 0, 'no execute bits');
    assert.ok(!JSON.stringify(result).includes(root), 'no absolute local paths in the result');

    obs = await ex.observe();
    const again = (await ex.execute({ action: 'download_ref', ref: refOf(obs, 'Download report') })).result.download;
    assert.equal(again.filename, 'report (1).csv', 'never overwrites');

    obs = await ex.observe();
    const logo = (await ex.execute({ action: 'download_ref', ref: refOf(obs, 'Get logo') })).result.download;
    assert.equal(logo.mimeType, 'image/png', 'sniffed from content');
  });
});

test('downloads: hostile filenames cannot escape the folder or hide', async () => {
  await session({}, async (ex, c) => {
    await ex.navigate(server.url('/controls.html'));
    let obs = await ex.observe();
    const evil = (await ex.execute({ action: 'download_ref', ref: refOf(obs, 'Download tool') })).result.download;
    // The server sent filename="../../../evil.sh"; Chromium and sanitizeFilename
    // both reduce it to one plain path segment.
    assert.match(evil.filename, /evil\.sh$/);
    assert.ok(!/[\\/]/.test(evil.filename) && !evil.filename.startsWith('.'));
    assert.equal(path.dirname(path.join(c.downloadsDir, evil.filename)), c.downloadsDir);
    assert.equal((await stat(path.join(c.downloadsDir, evil.filename))).mode & 0o111, 0, 'not executable');
    assert.ok(!(await readdir(root)).includes('evil.sh'), 'nothing escaped to the parent folders');
    obs = await ex.observe();
    const hidden = (await ex.execute({ action: 'download_ref', ref: refOf(obs, 'Get config') })).result.download;
    assert.ok(!hidden.filename.startsWith('.'), `dotfile was hidden: ${hidden.filename}`);
  });
});

test('downloads: a link that just navigates fails fast; stray downloads from clicks are cancelled', async () => {
  await session({}, async (ex, c) => {
    await ex.navigate(server.url('/controls.html'));
    let obs = await ex.observe();
    const t0 = Date.now();
    await assert.rejects(ex.execute({ action: 'download_ref', ref: refOf(obs, 'Not a download') }), (e) => e.code === 'no_download');
    assert.ok(Date.now() - t0 < 8000);
    await ex.navigate(server.url('/controls.html'));
    obs = await ex.observe();
    const before = (await readdir(c.downloadsDir).catch(() => [])).length;
    await ex.execute({ action: 'click_ref', ref: refOf(obs, 'Download report') });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(c.cancelledDownloads, 1);
    assert.equal((await readdir(c.downloadsDir).catch(() => [])).length, before, 'click_ref never saves files');
  });
});

// --- uploads ----------------------------------------------------------------------

test('uploads: registered files attach to file inputs (incl. hidden ones) without submitting', async () => {
  const media = path.join(root, 'launch.png');
  await writeFile(media, 'png-bytes');
  await session({}, async (ex) => {
    const entry = await ex.files.addUserFile(media);
    await ex.navigate(server.url('/controls.html'));
    let obs = await ex.observe();
    const hiddenDoc = obs.elements.find((e) => e.label === 'Hidden doc');
    assert.equal(hiddenDoc.hidden, true);
    const { result } = await ex.execute({ action: 'upload_file', ref: refOf(obs, 'Media'), file: entry.id });
    assert.deepEqual(result.file, { id: 'file-0', name: 'launch.png', bytes: 9, source: 'user', path: '…/launch.png' });
    await ex.execute({ action: 'upload_file', ref: hiddenDoc.ref, file: entry.id }, { observation: obs });
    obs = await ex.observe();
    assert.deepEqual(obs.elements.find((e) => e.label === 'Media').files, ['launch.png']);
    assert.equal(obs.url, server.url('/controls.html'), 'attaching did not submit');
    await assert.rejects(ex.execute({ action: 'upload_file', ref: refOf(obs, 'Media'), file: 'file-7' }), (e) => e.code === 'unknown_file');
  });
});

test('uploads: a file deleted after registration is rejected at execution time', async () => {
  const media = path.join(root, 'gone.png');
  await writeFile(media, 'x');
  await session({}, async (ex) => {
    const entry = await ex.files.addUserFile(media);
    await rm(media);
    await ex.navigate(server.url('/controls.html'));
    const obs = await ex.observe();
    await assert.rejects(ex.execute({ action: 'upload_file', ref: refOf(obs, 'Media'), file: entry.id }), (e) => e.code === 'file_not_found');
  });
});

test('uploads: files from the profile\'s managed uploads folder are offered; other profiles\' are not', async () => {
  const mine = path.join(root, 'uploads', 'mixed-beanz');
  const theirs = path.join(root, 'uploads', 'ai-carty');
  await mkdir(mine, { recursive: true });
  await mkdir(theirs, { recursive: true });
  await writeFile(path.join(mine, 'beanz.jpg'), 'b');
  await writeFile(path.join(theirs, 'carty.jpg'), 'c');
  const c = new BrowserController({ stateRoot: root, profile: 'mixed-beanz' });
  assert.equal(c.profilePaths.uploadsDir, mine);
});
