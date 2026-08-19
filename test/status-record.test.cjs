const assert = require('node:assert/strict');
const test = require('node:test');

const { aggregateScanStatus } = require('../src/status-record.cjs');

test('aggregate scan status preserves concrete viewport and contact-sheet reasons', () => {
  assert.deepEqual(aggregateScanStatus({
    desktop: { status: 'blocked', reasons: ['screenshot timeout'] },
    narrow: { status: 'partial', reasons: ['bounded traversal'] },
  }, {
    desktop: { status: 'blocked', reasons: ['no candidates'] },
    narrow: { status: 'complete' },
  }), {
    status: 'partial',
    reasons: [
      'desktop: screenshot timeout',
      'narrow: bounded traversal',
      'contact-sheet desktop: no candidates',
    ],
  });
});

test('aggregate scan status handles complete, fully blocked, and empty scans', () => {
  assert.deepEqual(aggregateScanStatus({ desktop: { status: 'complete' } }), { status: 'complete', reasons: [] });
  assert.deepEqual(aggregateScanStatus({ desktop: { status: 'blocked', reasons: ['navigation'] } }), {
    status: 'blocked', reasons: ['desktop: navigation'],
  });
  assert.deepEqual(aggregateScanStatus({}), { status: 'blocked', reasons: ['no viewport results'] });
});
