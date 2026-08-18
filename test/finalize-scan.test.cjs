const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { finalizeScan } = require('../src/finalize-scan.cjs');
const { validateCapturePackage } = require('../src/validate-package.cjs');
const { scrubUrl } = require('../src/url-policy.cjs');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const runtimeProvenance = {
  node: '24.19.0', playwright: '1.62.1',
  browser: { name: 'chromium', version: '151.0.7922.34' },
  platform: 'win32', arch: 'x64', headless: true, deviceScaleFactor: 1,
  webgl: { status: 'unknown', vendor: 'unknown', renderer: 'unknown' },
};

function fixture(status = 'complete', withInteraction = false) {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-finalize-run-'));
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-finalize-out-'));
  fs.mkdirSync(path.join(runDirectory, '.staging', 'frames'), { recursive: true });
  fs.mkdirSync(path.join(runDirectory, 'probes'), { recursive: true });
  const sheetBytes = Buffer.from('contact-sheet');
  fs.writeFileSync(path.join(runDirectory, 'contact-sheet-desktop.png'), sheetBytes);
  const bytes = [Buffer.from('opening-png'), Buffer.from('lower-png')];
  const sourceUrl = scrubUrl('https://example.com/?ref=secret');
  const candidates = bytes.map((data, index) => {
    const id = `desktop-00${index}`;
    const framePath = `.staging/frames/${id}.png`;
    const probePath = `probes/${id}.jpg`;
    fs.writeFileSync(path.join(runDirectory, framePath), data);
    fs.writeFileSync(path.join(runDirectory, probePath), Buffer.from(`probe-${index}`));
    return {
      id, viewport: 'desktop', ordinal: index, plannedScrollY: index * 600, scrollY: index * 600, scrollRatio: index,
      documentHeight: 1200, viewportHeight: 600, framePath, frameSha256: hash(data),
      probePath, probeSha256: hash(Buffer.from(`probe-${index}`)), readinessStatus: status,
      probeSourceFrameSha256: hash(data),
      settleStatus: 'complete', visibleTextHash: `sha256:${'a'.repeat(64)}`,
    };
  });
  const evidence = {
    artifactType: 'site-style-scan-evidence', schemaVersion: '1.0.0', scanId: 'scan-1',
    requestedUrl: sourceUrl, capturedAt: '2026-08-17T00:00:00.000Z', runtimeDiagnostics: {}, runtimeProvenance,
    page: { finalUrl: sourceUrl, status: 200, publicResources: [], mainPath: [{ action: 'open', viewport: 'desktop' }], viewports: {
      desktop: { profile: { name: 'desktop', width: 960, height: 600 }, captureStatus: { status, reasons: [] }, rendered: { evidenceSummary: { representativeElements: [] } } },
    } },
  };
  fs.writeFileSync(path.join(runDirectory, 'scan-evidence.json'), `${JSON.stringify(evidence)}\n`);
  const manifest = {
    schemaVersion: '1.0.0', scanId: 'scan-1', budgetPolicyVersion: '1.0.0',
    capturedAt: evidence.capturedAt, sourceUrl, scanStatus: { status, reasons: [] },
    viewports: { desktop: { name: 'desktop', width: 960, height: 600, status, reasons: [] } },
    candidates, interactionCandidates: withInteraction ? [{
      id: 'interaction-desktop-000', viewport: 'desktop', nearCandidateId: 'desktop-000',
      kindHint: 'accordion', tag: 'button', text: 'Details', role: '', expanded: 'false',
      controls: 'details', targetFingerprint: `sha256:${'c'.repeat(64)}`,
    }] : [], contactSheets: {
      desktop: { status: 'complete', path: 'contact-sheet-desktop.png', sha256: hash(sheetBytes), candidateIds: candidates.map((candidate) => candidate.id) },
    },
    scanEvidence: { path: 'scan-evidence.json', sha256: hash(fs.readFileSync(path.join(runDirectory, 'scan-evidence.json'))) },
  };
  fs.writeFileSync(path.join(runDirectory, 'scan-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestHash = hash(fs.readFileSync(path.join(runDirectory, 'scan-manifest.json')));
  const selection = {
    schemaVersion: '1.0.0', scanId: 'scan-1', scanManifestSha256: manifestHash,
    sourceUrlFingerprint: sourceUrl.urlFingerprint, budgetPolicyVersion: '1.0.0',
    selectedCandidateIds: candidates.map((candidate) => candidate.id),
    contactSheetSha256ByViewport: { desktop: hash(sheetBytes) },
    ...(withInteraction ? { interactionCandidateId: 'interaction-desktop-000' } : {}),
  };
  fs.writeFileSync(path.join(runDirectory, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`);
  if (withInteraction) {
    fs.mkdirSync(path.join(runDirectory, '.staging', 'interactions'), { recursive: true });
    const before = Buffer.from('interaction-before');
    const after = Buffer.from('interaction-after');
    fs.writeFileSync(path.join(runDirectory, '.staging', 'interactions', 'interaction-desktop-000-before.png'), before);
    fs.writeFileSync(path.join(runDirectory, '.staging', 'interactions', 'interaction-desktop-000-after.png'), after);
    fs.writeFileSync(path.join(runDirectory, 'interaction-result.json'), `${JSON.stringify({
      schemaVersion: '1.0.0', scanId: 'scan-1', scanManifestSha256: manifestHash,
      selectionSha256: hash(fs.readFileSync(path.join(runDirectory, 'selection.json'))),
      interactionCandidateId: 'interaction-desktop-000', status: 'complete', stage: 'complete',
      kind: 'accordion', reversible: true, changed: true,
      before: { path: '.staging/interactions/interaction-desktop-000-before.png', sha256: hash(before) },
      after: { path: '.staging/interactions/interaction-desktop-000-after.png', sha256: hash(after) },
    }, null, 2)}\n`);
  }
  return { runDirectory, outputDirectory, candidates, bytes };
}

test('finalize promotes exact selected bytes into a valid capture package', () => {
  const item = fixture();
  try {
    const report = finalizeScan(item.runDirectory, path.join(item.runDirectory, 'selection.json'), item.outputDirectory);
    assert.equal(report.captureStatus.status, 'complete');
    assert.deepEqual(fs.readFileSync(path.join(item.outputDirectory, 'screenshots', 'desktop-000.png')), item.bytes[0]);
    assert.equal(validateCapturePackage(item.outputDirectory).ok, true);
    assert.deepEqual(report.pages[0].mainPath, [{ action: 'open', viewport: 'desktop' }]);
    assert.deepEqual(report.pages[0].scanProvenance.selectedCandidateIds, ['desktop-000', 'desktop-001']);
    assert.match(report.pages[0].scanProvenance.selectionSha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(item.runDirectory, { recursive: true, force: true });
    fs.rmSync(item.outputDirectory, { recursive: true, force: true });
  }
});

test('finalize rejects a changed staged frame', () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.runDirectory, item.candidates[0].framePath), 'tampered');
    assert.throws(() => finalizeScan(item.runDirectory, path.join(item.runDirectory, 'selection.json'), item.outputDirectory), /hash/i);
    assert.deepEqual(fs.readdirSync(item.outputDirectory), []);
  } finally {
    fs.rmSync(item.runDirectory, { recursive: true, force: true });
    fs.rmSync(item.outputDirectory, { recursive: true, force: true });
  }
});

test('partial scan candidates remain diagnostic', () => {
  const item = fixture('partial');
  try {
    const report = finalizeScan(item.runDirectory, path.join(item.runDirectory, 'selection.json'), item.outputDirectory);
    assert.equal(report.captureStatus.status, 'partial');
    assert.ok(report.pages[0].screenshots.every((shot) => shot.kind === 'diagnostic'));
  } finally {
    fs.rmSync(item.runDirectory, { recursive: true, force: true });
    fs.rmSync(item.outputDirectory, { recursive: true, force: true });
  }
});

test('finalize rejects a changed contact sheet and a non-empty output directory', () => {
  const item = fixture();
  try {
    fs.writeFileSync(path.join(item.runDirectory, 'contact-sheet-desktop.png'), 'changed-sheet');
    assert.throws(() => finalizeScan(item.runDirectory, path.join(item.runDirectory, 'selection.json'), item.outputDirectory), /contact sheet hash/i);
    fs.writeFileSync(path.join(item.outputDirectory, 'owned.txt'), 'keep');
    assert.throws(() => finalizeScan(item.runDirectory, path.join(item.runDirectory, 'selection.json'), item.outputDirectory), /output directory.+empty/i);
    assert.equal(fs.readFileSync(path.join(item.outputDirectory, 'owned.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(item.runDirectory, { recursive: true, force: true });
    fs.rmSync(item.outputDirectory, { recursive: true, force: true });
  }
});

test('finalize includes a verified selected interaction within the six-shot budget', () => {
  const item = fixture('complete', true);
  try {
    const report = finalizeScan(item.runDirectory, path.join(item.runDirectory, 'selection.json'), item.outputDirectory);
    assert.equal(report.pages[0].screenshots.length, 4);
    assert.equal(report.pages[0].representativeInteraction.status, 'complete');
    assert.ok(report.pages[0].screenshots.some((shot) => shot.state === 'representative-interaction-after'));
    assert.equal(validateCapturePackage(item.outputDirectory).ok, true);
  } finally {
    fs.rmSync(item.runDirectory, { recursive: true, force: true });
    fs.rmSync(item.outputDirectory, { recursive: true, force: true });
  }
});

test('finalize reuses an identical static screenshot for interaction before state', () => {
  const item = fixture('complete', true);
  try {
    const resultPath = path.join(item.runDirectory, 'interaction-result.json');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const opening = fs.readFileSync(path.join(item.runDirectory, item.candidates[0].framePath));
    fs.writeFileSync(path.join(item.runDirectory, result.before.path), opening);
    result.before.sha256 = hash(opening);
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    const report = finalizeScan(item.runDirectory, path.join(item.runDirectory, 'selection.json'), item.outputDirectory);
    const page = report.pages[0];
    assert.equal(page.screenshots.length, 3);
    assert.equal(new Set(page.screenshots.map((shot) => shot.sha256)).size, 3);
    assert.equal(page.representativeInteraction.beforeScreenshot, 'screenshots/desktop-000.png');
    assert.ok(page.screenshots.some((shot) => shot.state === 'representative-interaction-after'));
    assert.equal(fs.readdirSync(path.join(item.outputDirectory, 'screenshots')).length, 3);
  } finally {
    fs.rmSync(item.runDirectory, { recursive: true, force: true });
    fs.rmSync(item.outputDirectory, { recursive: true, force: true });
  }
});

test('a selected blocked interaction makes the final package partial without downgrading static evidence', () => {
  const item = fixture('complete', true);
  try {
    const resultPath = path.join(item.runDirectory, 'interaction-result.json');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    result.status = 'blocked';
    result.reasons = ['target drift'];
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    const report = finalizeScan(item.runDirectory, path.join(item.runDirectory, 'selection.json'), item.outputDirectory);
    assert.equal(report.captureStatus.status, 'partial');
    assert.equal(report.pages[0].representativeInteraction.status, 'blocked');
    assert.ok(report.pages[0].screenshots.every((shot) => shot.kind === 'evidence'));
  } finally {
    fs.rmSync(item.runDirectory, { recursive: true, force: true });
    fs.rmSync(item.outputDirectory, { recursive: true, force: true });
  }
});
