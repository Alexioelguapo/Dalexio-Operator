import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'operator.js');
let cwd;
before(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), 'dalexio-cli-')); });
after(async () => { await rm(cwd, { recursive: true, force: true }); });

function cli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test('help documents profiles, login and uploads', async () => {
  const { code, stdout } = await cli(['--help']);
  assert.equal(code, 0);
  for (const flag of ['--profile', '--login', '--list-profiles', '--allow-file']) assert.match(stdout, new RegExp(flag));
});

test('invalid profile names are rejected with usage exit code 2', async () => {
  const r = await cli(['--profile', '../../etc', 'do something']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /invalid profile name/);
});

test('--login needs --profile, and explains how to get a display when there is none', async () => {
  assert.equal((await cli(['--login', 'https://example.com'])).code, 2);
  if (process.platform !== 'linux') return;
  const r = await cli(['--profile', 'brand', '--login', 'https://example.com'], { DISPLAY: '', WAYLAND_DISPLAY: '' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No display found/);
  assert.match(r.stderr, /desktop-lite/);
});

test('--list-profiles lists saved profiles from .dalexio/profiles', async () => {
  assert.match((await cli(['--list-profiles'])).stdout, /No saved profiles/);
  await mkdir(path.join(cwd, '.dalexio', 'profiles', 'mixed-beanz', 'user-data'), { recursive: true });
  const r = await cli(['--list-profiles']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^mixed-beanz\s+last used/m);
});
