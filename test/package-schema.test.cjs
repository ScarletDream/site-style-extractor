const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEMA_VERSION,
  assertCaptureReportShape,
} = require('../src/package-schema.cjs');

function minimalReport(schemaVersion = '2.0.0') {
  return {
    schemaVersion,
    captureStatus: { status: 'blocked', stage: 'pending', reasons: [] },
    requestedUrl: {
      displayUrl: 'https://example.com/page?theme=<redacted>',
      queryKeys: ['theme'],
      urlFingerprint: `sha256:${'a'.repeat(64)}`,
    },
    capturedAt: '2026-08-17T00:00:00.000Z',
    pages: [],
    runtimeDiagnostics: {
      consoleErrors: [],
      pageErrors: [],
      requestFailures: [],
      policyBlockedRequests: [],
    },
    runtimeProvenance: {
      node: '24.19.0',
      playwright: '1.62.1',
      browser: { name: 'chromium', version: '151.0.7922.34' },
      platform: 'win32',
      arch: 'x64',
      headless: true,
      deviceScaleFactor: 1,
      webgl: { status: 'unknown', vendor: 'unknown', renderer: 'unknown' },
    },
  };
}

test('schema v2 accepts a blocked report skeleton', () => {
  assert.equal(SCHEMA_VERSION, '2.0.0');
  assert.doesNotThrow(() => assertCaptureReportShape(minimalReport()));
});

test('capture report requires bounded runtime provenance', () => {
  const report = minimalReport();
  delete report.runtimeProvenance;
  assert.throws(() => assertCaptureReportShape(report), /runtimeProvenance/i);

  report.runtimeProvenance = {
    node: '24.19.0',
    playwright: '1.62.1',
    browser: { name: 'chromium', version: '151.0.7922.34' },
    platform: 'win32',
    arch: 'x64',
    headless: true,
    deviceScaleFactor: 1,
    webgl: { status: 'unknown', vendor: 'unknown', renderer: 'unknown' },
  };
  assert.doesNotThrow(() => assertCaptureReportShape(report));

  report.runtimeProvenance.webgl.renderer = 'x'.repeat(501);
  assert.throws(() => assertCaptureReportShape(report), /webgl.*renderer/i);
});

test('schema v1 is rejected instead of being silently treated as current', () => {
  assert.throws(
    () => assertCaptureReportShape(minimalReport('1.0.0')),
    /unsupported schemaVersion 1\.0\.0/i,
  );
});

test('capture report rejects status and screenshot-kind contradictions', () => {
  const report = minimalReport();
  report.captureStatus = { status: 'partial', stage: 'capture', reasons: ['loader'] };
  report.pages.push({
    viewports: {
      narrow: {
        captureStatus: { status: 'partial', reasons: ['loader'] },
      },
    },
    screenshots: [{
      path: 'screenshots/narrow.png',
      viewport: 'narrow',
      kind: 'evidence',
      sha256: 'b'.repeat(64),
    }],
  });

  assert.throws(
    () => assertCaptureReportShape(report),
    /partial viewport narrow.*diagnostic/i,
  );
});

test('blocked viewport cannot contain successful evidence screenshots', () => {
  const report = minimalReport();
  report.pages.push({
    viewports: {
      desktop: { captureStatus: { status: 'blocked', reasons: ['navigation'] } },
    },
    screenshots: [{
      path: 'screenshots/desktop.png',
      viewport: 'desktop',
      kind: 'evidence',
      sha256: 'c'.repeat(64),
    }],
  });

  assert.throws(
    () => assertCaptureReportShape(report),
    /blocked viewport desktop.*diagnostic/i,
  );
});

test('capture report rejects an unsanitized requested URL identity', () => {
  const report = minimalReport();
  report.requestedUrl = {
    displayUrl: 'https://example.com/?token=super-secret',
    queryKeys: ['token'],
    urlFingerprint: `sha256:${'d'.repeat(64)}`,
  };
  report.runtimeDiagnostics = [];

  assert.throws(
    () => assertCaptureReportShape(report),
    /requestedUrl|runtimeDiagnostics/i,
  );
});

test('complete capture requires a complete viewport and evidence screenshot', () => {
  const report = minimalReport();
  report.captureStatus = { status: 'complete', stage: 'complete', reasons: [] };
  assert.throws(() => assertCaptureReportShape(report), /complete capture.*page|viewport|evidence/i);
});

test('top-level capture status must equal the aggregate viewport status', () => {
  const report = minimalReport();
  report.captureStatus = { status: 'complete', stage: 'complete', reasons: [] };
  report.pages = [{
    viewports: { desktop: { captureStatus: { status: 'partial' } } },
    screenshots: [{
      path: 'screenshots/desktop.png', viewport: 'desktop', kind: 'diagnostic', sha256: 'e'.repeat(64),
    }],
  }];
  assert.throws(() => assertCaptureReportShape(report), /aggregate viewport status partial/i);
});

test('duplicate and non-screenshot paths and duplicate resource IDs are rejected', () => {
  const report = minimalReport();
  report.pages = [{
    viewports: { desktop: { captureStatus: { status: 'blocked' } } },
    screenshots: [
      { path: 'screenshots/same.png', viewport: 'desktop', kind: 'diagnostic', sha256: 'f'.repeat(64) },
      { path: 'screenshots/same.png', viewport: 'desktop', kind: 'diagnostic', sha256: '0'.repeat(64) },
    ],
    publicResources: [
      { resourceId: 'res-same' },
      { resourceId: 'res-same' },
    ],
  }];
  assert.throws(() => assertCaptureReportShape(report), /duplicate screenshot path|duplicate resourceId/i);

  report.pages[0].screenshots = [
    { path: '../outside.png', viewport: 'desktop', kind: 'diagnostic', sha256: 'f'.repeat(64) },
  ];
  report.pages[0].publicResources = [];
  assert.throws(() => assertCaptureReportShape(report), /must start with screenshots\//i);
});

test('an explicitly selected failed interaction downgrades an otherwise complete capture', () => {
  const report = minimalReport();
  report.captureStatus = { status: 'complete', stage: 'finalized-scan', reasons: [] };
  report.pages = [{
    viewports: { desktop: { captureStatus: { status: 'complete' } } },
    representativeInteraction: { status: 'blocked' },
    screenshots: [{ path: 'screenshots/desktop.png', viewport: 'desktop', kind: 'evidence', sha256: '1'.repeat(64) }],
  }];
  assert.throws(() => assertCaptureReportShape(report), /aggregate viewport status partial/i);
  report.captureStatus.status = 'partial';
  assert.doesNotThrow(() => assertCaptureReportShape(report));
});
