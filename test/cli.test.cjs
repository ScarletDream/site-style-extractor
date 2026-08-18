const assert = require('node:assert/strict');
const test = require('node:test');

const { runCli } = require('../src/cli.cjs');

function memoryIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    },
    read: () => ({ stdout, stderr }),
  };
}

function fakeDependencies(overrides = {}) {
  return {
    doctor: async () => ({ status: 'complete', checks: [] }),
    scan: async () => ({ manifest: { scanStatus: { status: 'complete' }, scanId: 'scan-1' } }),
    interact: async () => ({ status: 'complete' }),
    finalize: async () => ({ captureStatus: { status: 'complete' } }),
    render: async () => ({ status: 'complete' }),
    validate: async () => ({ ok: true, stage: 'capture', captureStatus: 'complete', errors: [], warnings: [] }),
    ...overrides,
  };
}

test('help and usage errors use stable exit codes and streams', async () => {
  let capture = memoryIo();
  assert.equal(await runCli(['--help'], capture.io, fakeDependencies()), 0);
  assert.match(capture.read().stdout, /site-style doctor/);
  assert.equal(capture.read().stderr, '');

  capture = memoryIo();
  assert.equal(await runCli(['unknown'], capture.io, fakeDependencies()), 2);
  assert.equal(capture.read().stdout, '');
  assert.match(capture.read().stderr, /Unknown command/);

  capture = memoryIo();
  assert.equal(await runCli(['scan', 'https://example.com'], capture.io, fakeDependencies()), 2);
  assert.match(capture.read().stderr, /--run/);
});

test('routes all six commands with parsed arguments', async () => {
  const calls = [];
  const dependencies = fakeDependencies({
    doctor: async (options) => { calls.push(['doctor', options]); return { status: 'complete' }; },
    scan: async (options) => { calls.push(['scan', options]); return { manifest: { scanStatus: { status: 'complete' } } }; },
    interact: async (options) => { calls.push(['interact', options]); return { status: 'complete' }; },
    finalize: async (...args) => { calls.push(['finalize', args]); return { captureStatus: { status: 'complete' } }; },
    render: async (options) => { calls.push(['render', options]); return { status: 'complete' }; },
    validate: async (options) => { calls.push(['validate', options]); return { ok: true, captureStatus: 'complete' }; },
  });

  for (const argv of [
    ['doctor'],
    ['scan', 'https://example.com', '--run', 'run'],
    ['interact', 'https://example.com', '--run', 'run', '--selection', 'selection.json'],
    ['finalize', '--run', 'run', '--selection', 'selection.json', '--out', 'out'],
    ['render', '--profile', 'profile.yaml', '--analysis', 'analysis.md'],
    ['validate', 'delivery', 'out'],
  ]) {
    const capture = memoryIo();
    assert.equal(await runCli(argv, capture.io, dependencies), 0);
  }

  assert.deepEqual(calls.map(([name]) => name), ['doctor', 'scan', 'interact', 'finalize', 'render', 'validate']);
  assert.equal(calls[1][1].url, 'https://example.com');
  assert.equal(calls[1][1].outputDirectory, 'run');
  assert.deepEqual(calls[3][1], ['run', 'selection.json', 'out']);
  assert.deepEqual(calls[5][1], { stage: 'delivery', directory: 'out' });
});

test('json mode writes one machine result to stdout and keeps failures on stderr', async () => {
  let capture = memoryIo();
  const code = await runCli(['doctor', '--json'], capture.io, fakeDependencies());
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(capture.read().stdout), { status: 'complete', checks: [] });
  assert.equal(capture.read().stderr, '');

  capture = memoryIo();
  const failed = await runCli(['doctor', '--json'], capture.io, fakeDependencies({
    doctor: async () => { throw new Error('browser missing'); },
  }));
  assert.equal(failed, 1);
  assert.equal(capture.read().stdout, '');
  assert.match(capture.read().stderr, /browser missing/);
});

test('honest partial or blocked artifacts return exit code 3', async () => {
  for (const [argv, dependencies] of [
    [['scan', 'https://example.com', '--run', 'run'], fakeDependencies({ scan: async () => ({ manifest: { scanStatus: { status: 'partial' } } }) })],
    [['interact', 'https://example.com', '--run', 'run', '--selection', 'selection.json'], fakeDependencies({ interact: async () => ({ status: 'blocked' }) })],
    [['finalize', '--run', 'run', '--selection', 'selection.json', '--out', 'out'], fakeDependencies({ finalize: async () => ({ captureStatus: { status: 'partial' } }) })],
    [['validate', 'capture', 'out'], fakeDependencies({ validate: async () => ({ ok: true, captureStatus: 'partial' }) })],
  ]) {
    const capture = memoryIo();
    assert.equal(await runCli(argv, capture.io, dependencies), 3);
  }
});

test('validation failure returns exit code 1', async () => {
  const capture = memoryIo();
  const code = await runCli(
    ['validate', 'delivery', 'out'],
    capture.io,
    fakeDependencies({ validate: async () => ({ ok: false, errors: [{ code: 'bad' }] }) }),
  );
  assert.equal(code, 1);
});

test('unknown flags fail as usage errors instead of being ignored', async () => {
  const capture = memoryIo();
  const code = await runCli(
    ['scan', 'https://example.com', '--run', 'run', '--ruin', 'typo'],
    capture.io,
    fakeDependencies(),
  );
  assert.equal(code, 2);
  assert.match(capture.read().stderr, /Unknown flag.*--ruin/);
});
