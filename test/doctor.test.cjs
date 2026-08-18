const assert = require('node:assert/strict');
const test = require('node:test');

const { runDoctor } = require('../src/doctor.cjs');

function healthyOptions(overrides = {}) {
  return {
    nodeVersion: '24.19.0',
    platform: 'win32',
    arch: 'x64',
    playwrightVersion: '1.62.1',
    chromiumExecutablePath: () => 'C:\\browser\\chrome.exe',
    pathExists: () => true,
    probeWritableDirectory: async () => 'C:\\temp\\site-style-doctor',
    launchChromium: async () => ({ version: () => 'Chromium 142', close: async () => {} }),
    ...overrides,
  };
}

test('doctor reports pinned runtime and successful isolated browser launch', async () => {
  const result = await runDoctor(healthyOptions());
  assert.equal(result.status, 'complete');
  assert.equal(result.runtime.node, '24.19.0');
  assert.equal(result.runtime.playwright, '1.62.1');
  assert.equal(result.runtime.browser, 'Chromium 142');
  assert.equal(result.runtime.platform, 'win32');
  assert.equal(result.runtime.arch, 'x64');
  assert.equal(result.runtime.headless, true);
  assert.equal(result.checks.every((item) => item.status === 'pass'), true);
});

test('doctor fails clearly when Node is unsupported or Chromium is absent', async () => {
  let result = await runDoctor(healthyOptions({ nodeVersion: '18.19.0' }));
  assert.equal(result.status, 'blocked');
  assert.match(result.errors.join(' '), /Node\.js 20/i);

  result = await runDoctor(healthyOptions({ pathExists: () => false }));
  assert.equal(result.status, 'blocked');
  assert.match(result.errors.join(' '), /Chromium executable/i);
});

test('doctor closes a browser even when later inspection fails', async () => {
  let closed = false;
  const result = await runDoctor(healthyOptions({
    launchChromium: async () => ({
      version: () => { throw new Error('version failed'); },
      close: async () => { closed = true; },
    }),
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(closed, true);
});
