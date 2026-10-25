#!/usr/bin/env node
// Builds dist-server/ like `npm run build:server`, but tolerates type errors
// that live only in upstream test files. Upstream sets `noEmitOnError`, so a
// broken test type on an upstream commit would otherwise block the build.
// Type errors in any non-test source still fail the build.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = (name) => path.join(appRoot, 'node_modules', '.bin', name);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: appRoot, encoding: 'utf8' });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

fs.rmSync(path.join(appRoot, 'dist-server.next'), { recursive: true, force: true });

const tsc = run(bin('tsc'), ['-p', 'server/tsconfig.json', '--noEmitOnError', 'false']);
const errors = tsc.output.split('\n').filter((line) => /\): error TS\d+:/.test(line));
const blocking = errors.filter((line) => !/[\\/]tests[\\/]/.test(line.split('(')[0]));
for (const line of errors) {
  console.log(`${blocking.includes(line) ? 'error  ' : 'ignored'} ${line}`);
}
if (blocking.length > 0 || (tsc.status !== 0 && errors.length === 0)) {
  if (errors.length === 0) console.error(tsc.output);
  console.error(`build-server: ${blocking.length} type error(s) outside tests; aborting.`);
  process.exit(1);
}

for (const [command, args] of [
  [bin('tsc-alias'), ['-p', 'server/tsconfig.json']],
  [process.execPath, ['scripts/promote-dist-server.mjs']],
]) {
  const step = run(command, args);
  if (step.status !== 0) {
    console.error(step.output);
    process.exit(step.status);
  }
}
console.log(`build-server: ok${errors.length ? ` (${errors.length} test-only type error(s) ignored)` : ''}`);
