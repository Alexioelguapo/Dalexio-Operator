// Parse-check every project JavaScript file with `node --check`.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'bin', 'tests', 'scripts', 'operator.js'];
const files = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(path.join(p, f));
  else if (p.endsWith('.js')) files.push(p);
};
ROOTS.forEach(walk);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`✘ ${f}\n${err.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files parse cleanly`);
process.exit(failed ? 1 : 0);
