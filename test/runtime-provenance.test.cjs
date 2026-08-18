const assert = require('node:assert/strict');
const test = require('node:test');

const { createRuntimeProvenance, probeWebgl } = require('../src/runtime-provenance.cjs');

test('creates bounded provenance with unknown browser and WebGL fallbacks', () => {
  const value = createRuntimeProvenance({
    nodeVersion: '24.19.0',
    playwrightVersion: '1.62.1',
    platform: 'linux',
    arch: 'x64',
  });
  assert.deepEqual(value.browser, { name: 'chromium', version: 'unknown' });
  assert.deepEqual(value.webgl, { status: 'unknown', vendor: 'unknown', renderer: 'unknown' });
  assert.equal(value.deviceScaleFactor, 1);
});

test('probes WebGL without turning unavailable rendering into capture failure', async () => {
  const observed = await probeWebgl({
    evaluate: async () => ({ vendor: 'Google Inc.', renderer: 'ANGLE (SwiftShader)' }),
  });
  assert.deepEqual(observed, { status: 'observed', vendor: 'Google Inc.', renderer: 'ANGLE (SwiftShader)' });

  const unavailable = await probeWebgl({ evaluate: async () => { throw new Error('no webgl'); } });
  assert.deepEqual(unavailable, { status: 'unknown', vendor: 'unknown', renderer: 'unknown' });
});
