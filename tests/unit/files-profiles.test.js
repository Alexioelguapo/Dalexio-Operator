import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeFilename, isInside, assertInside, ensureManagedDir, displayPath } from '../../src/files/paths.js';
import { FileRegistry, FileRegistryError, deniedReason } from '../../src/files/registry.js';
import { ProfileStore, validateProfileName, ProfileError } from '../../src/browser/profiles.js';

let dir;
before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'dalexio-files-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const code = (c) => (e) => { assert.equal(e.code, c, e.message); return true; };

test('sanitizeFilename strips traversal, separators, control chars and hidden-file dots', () => {
  assert.equal(sanitizeFilename('../../../evil.sh'), 'evil.sh');
  assert.equal(sanitizeFilename('..\\..\\windows\\system32\\x.dll'), 'x.dll');
  assert.equal(sanitizeFilename('/etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('.bashrc'), 'bashrc');
  assert.equal(sanitizeFilename('a\u0000b\u001fc.txt'), 'abc.txt');
  assert.equal(sanitizeFilename('re:port<1>?.csv'), 're_port_1__.csv');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('..'), 'download.bin');
  assert.equal(sanitizeFilename(''), 'download.bin');
  const long = sanitizeFilename(`${'x'.repeat(300)}.pdf`);
  assert.ok(long.length <= 120 && long.endsWith('.pdf'));
});

test('isInside / assertInside reject escapes', () => {
  assert.ok(isInside('/a/b', '/a/b/c.txt'));
  assert.ok(!isInside('/a/b', '/a/bc/d'));
  assert.ok(!isInside('/a/b', '/a/b/../c'));
  assert.throws(() => assertInside('/a/b', '/a/b/../../etc/passwd'), /escapes/);
});

test('ensureManagedDir creates a 0700 dir with a catch-all .gitignore', async () => {
  const d = path.join(dir, 'managed');
  await ensureManagedDir(d);
  assert.equal((await stat(d)).mode & 0o777, 0o700);
  assert.match(await readFile(path.join(d, '.gitignore'), 'utf8'), /^\*$/m);
});

test('displayPath never shows absolute paths outside the working directory', () => {
  assert.equal(displayPath(path.join(process.cwd(), '.dalexio/downloads/x.csv')), '.dalexio/downloads/x.csv');
  assert.equal(displayPath('/home/someone/private/photo.jpg'), '…/photo.jpg');
});

test('FileRegistry: user files get opaque ids; listing exposes no paths', async () => {
  const f = path.join(dir, 'photo.jpg');
  await writeFile(f, 'jpegdata');
  const reg = new FileRegistry({ root: path.join(dir, '.dalexio') });
  const e = await reg.addUserFile(f);
  assert.equal(e.id, 'file-0');
  assert.equal((await reg.addUserFile(f)).id, 'file-0', 'same file registers once');
  assert.deepEqual(reg.list(), [{ id: 'file-0', name: 'photo.jpg', bytes: 8, source: 'user' }]);
  assert.ok(!JSON.stringify(reg.list()).includes(dir));
  assert.equal(reg.describe(e).path, '…/photo.jpg');
  assert.equal((await reg.resolveForUpload('file-0')).realPath, e.realPath);
});

test('FileRegistry: rejects missing files, directories, oversize files, unknown ids', async () => {
  const reg = new FileRegistry({ root: path.join(dir, '.dalexio'), maxBytes: 4 });
  await assert.rejects(reg.addUserFile(path.join(dir, 'nope.png')), code('file_not_found'));
  await assert.rejects(reg.addUserFile(dir), code('not_a_file'));
  const big = path.join(dir, 'big.bin');
  await writeFile(big, '12345');
  await assert.rejects(reg.addUserFile(big), code('file_too_large'));
  await assert.rejects(reg.resolveForUpload('file-9'), code('unknown_file'));
  await assert.rejects(reg.addUserFile(''), code('invalid_path'));
});

test('FileRegistry: refuses secrets and Dalexio session data even when explicitly allowed', async () => {
  const root = path.join(dir, 'state');
  const reg = new FileRegistry({ root });
  const cases = {
    '.env': 'credential', 'id_rsa': 'credential', 'server.pem': 'credential', 'storage-state.json': 'credential', 'Cookies': 'credential',
  };
  for (const name of Object.keys(cases)) {
    const p = path.join(dir, name);
    await writeFile(p, 'secret');
    await assert.rejects(reg.addUserFile(p), code('denied_path'), name);
  }
  const ssh = path.join(dir, '.ssh');
  await mkdir(ssh, { recursive: true });
  await writeFile(path.join(ssh, 'config'), 'x');
  await assert.rejects(reg.addUserFile(path.join(ssh, 'config')), code('denied_path'));
  const prof = path.join(root, 'profiles', 'brand', 'user-data');
  await mkdir(prof, { recursive: true });
  await writeFile(path.join(prof, 'Preferences'), '{}');
  await assert.rejects(reg.addUserFile(path.join(prof, 'Preferences')), code('denied_path'));
  // A symlink pointing at a denied file is judged by its target.
  const link = path.join(dir, 'innocent.txt');
  await symlink(path.join(dir, '.env'), link);
  await assert.rejects(reg.addUserFile(link), code('denied_path'));
  assert.equal(deniedReason('/home/u/pics/cat.png', root), null);
});

test('FileRegistry: managed folders are flat, skip dotfiles and symlinks', async () => {
  const up = path.join(dir, 'uploads');
  await mkdir(path.join(up, 'nested'), { recursive: true });
  await writeFile(path.join(up, 'a.png'), 'a');
  await writeFile(path.join(up, '.hidden'), 'h');
  await writeFile(path.join(up, 'nested', 'deep.png'), 'd');
  await writeFile(path.join(dir, 'outside.txt'), 'o');
  await symlink(path.join(dir, 'outside.txt'), path.join(up, 'link.txt'));
  const reg = new FileRegistry({ root: path.join(dir, '.dalexio') });
  const added = await reg.addManagedDir(up);
  assert.deepEqual(added.map((e) => e.name), ['a.png']);
  assert.deepEqual(await reg.addManagedDir(path.join(dir, 'does-not-exist')), []);
});

test('FileRegistry: a file swapped after registration is rejected at upload time', async () => {
  const up = path.join(dir, 'swap');
  await mkdir(up, { recursive: true });
  const f = path.join(up, 'clip.mp4');
  await writeFile(f, 'video');
  const reg = new FileRegistry({ root: path.join(dir, '.dalexio') });
  const [e] = await reg.addManagedDir(up);
  await rm(f);
  await writeFile(path.join(dir, 'secret.txt'), 'secret');
  await symlink(path.join(dir, 'secret.txt'), f);
  await assert.rejects(reg.resolveForUpload(e.id), (err) => err instanceof FileRegistryError && ['file_changed', 'outside_managed_dir'].includes(err.code));
  await rm(f);
  await assert.rejects(reg.resolveForUpload(e.id), code('file_not_found'));
});

test('profile names are validated against traversal and odd characters', () => {
  for (const ok of ['default', 'mixed-beanz', 'ai-carty', 'test_profile', 'b2']) assert.equal(validateProfileName(ok), ok);
  for (const bad of ['', '../x', 'a/b', '.hidden', 'Mixed', 'with space', '-x', 'x'.repeat(49), 'nul\u0000', undefined]) {
    assert.throws(() => validateProfileName(bad), ProfileError, String(bad));
  }
});

test('ProfileStore: separate directories per profile, gitignored, locked', async () => {
  const store = new ProfileStore({ root: path.join(dir, 'p-root') });
  const a = await store.ensure('mixed-beanz');
  const b = await store.ensure('ai-carty');
  assert.notEqual(a.userDataDir, b.userDataDir);
  assert.ok(!isInside(a.base, b.base) && !isInside(b.base, a.base));
  assert.notEqual(a.downloadsDir, b.downloadsDir);
  assert.notEqual(a.uploadsDir, b.uploadsDir);
  assert.match(await readFile(path.join(store.dir, '.gitignore'), 'utf8'), /^\*$/m);
  assert.equal((await stat(a.userDataDir)).mode & 0o777, 0o700);
  assert.deepEqual((await store.list()).map((p) => p.name), ['ai-carty', 'mixed-beanz']);

  const release = await store.lock('mixed-beanz');
  await assert.rejects(store.lock('mixed-beanz'), code('profile_locked'));
  const other = await store.lock('ai-carty');
  await release();
  await other();
  const again = await store.lock('mixed-beanz');
  await again();
});

test('ProfileStore: a stale lock from a dead process is taken over', async () => {
  const store = new ProfileStore({ root: path.join(dir, 'p-stale') });
  const { lockFile } = await store.ensure('default');
  await writeFile(lockFile, '999999999');
  const release = await store.lock('default');
  await release();
});
