'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  'unit.cjs',
  'smoke.cjs',
  'process-smoke.cjs',
  'e2e-synthetic.cjs',
  'e2e-keyring.cjs',
  'cli-e2e.cjs',
];

const results = [];
for (const testFile of TESTS) {
  const full = path.join(__dirname, testFile);
  console.log(`\n===== ${testFile} =====`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const result = spawnSync(process.execPath, [full], {
    stdio: 'inherit',
    env,
    timeout: 300000,
    windowsHide: true,
  });
  const ok = result.status === 0 && !result.error;
  results.push({ testFile, ok, status: result.status, error: result.error });
  if (!ok) {
    console.error(
      `\n${testFile} failed: status=${result.status}${result.error ? ` error=${result.error.message}` : ''}`
    );
  }
}

console.log('\n===== summary =====');
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.testFile}`);
}
const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  process.exitCode = 1;
}
