const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BUDGET_POLICY_VERSION,
  SCAN_SCHEMA_VERSION,
  assertScanManifestShape,
  assertSelectionShape,
} = require('../src/scan-schema.cjs');

const HASH = `sha256:${'a'.repeat(64)}`;
const FILE_HASH = 'b'.repeat(64);

function manifest() {
  return {
    schemaVersion: '1.0.0',
    scanId: 'scan-example',
    capturedAt: '2026-08-17T00:00:00.000Z',
    sourceUrl: { displayUrl: 'https://example.com/', queryKeys: [], urlFingerprint: HASH },
    scanStatus: { status: 'complete', reasons: [] },
    budgetPolicyVersion: '1.0.0',
    scanEvidence: { path: 'scan-evidence.json', sha256: FILE_HASH },
    viewports: {
      desktop: { status: 'complete', width: 1440, height: 900 },
      narrow: { status: 'complete', width: 390, height: 844 },
    },
    contactSheets: {
      desktop: { status: 'complete', path: 'contact-sheet-desktop.png', sha256: FILE_HASH, candidateIds: ['desktop-000', 'desktop-001'] },
      narrow: { status: 'complete', path: 'contact-sheet-narrow.png', sha256: FILE_HASH, candidateIds: ['narrow-000', 'narrow-001'] },
    },
    interactionCandidates: [{
      id: 'interaction-desktop-000', viewport: 'desktop', nearCandidateId: 'desktop-000',
      kindHint: 'accordion', tag: 'button', text: 'Details', role: '', expanded: 'false',
      controls: 'details', targetFingerprint: HASH,
    }],
    candidates: [
      ['desktop-000', 'desktop', 0, 0, 0],
      ['desktop-001', 'desktop', 1500, 1, 1],
      ['narrow-000', 'narrow', 0, 0, 0],
      ['narrow-001', 'narrow', 1556, 1, 1],
    ].map(([id, viewport, scrollY, scrollRatio, ordinal], index) => ({
      id, viewport, ordinal, scrollY, plannedScrollY: scrollY, scrollRatio,
      documentHeight: 2400, viewportHeight: viewport === 'desktop' ? 900 : 844,
      framePath: `.staging/frames/${id}.png`, frameSha256: String(index + 1).repeat(64).slice(0, 64),
      probePath: `probes/${id}.jpg`, probeSha256: FILE_HASH,
      probeSourceFrameSha256: String(index + 1).repeat(64).slice(0, 64),
      readinessStatus: 'complete', settleStatus: 'complete', visibleTextHash: HASH,
    })),
  };
}

function selection(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    scanId: 'scan-example',
    scanManifestSha256: FILE_HASH,
    sourceUrlFingerprint: HASH,
    budgetPolicyVersion: '1.0.0',
    selectedCandidateIds: ['desktop-000', 'desktop-001', 'narrow-000', 'narrow-001'],
    contactSheetSha256ByViewport: { desktop: FILE_HASH, narrow: FILE_HASH },
    rationale: [],
    ...overrides,
  };
}

test('accepts a manifest-bound selection with opening and lower-page viewport coverage', () => {
  assert.equal(SCAN_SCHEMA_VERSION, '1.0.0');
  assert.equal(BUDGET_POLICY_VERSION, '1.0.0');
  assert.doesNotThrow(() => assertScanManifestShape(manifest()));
  assert.doesNotThrow(() => assertSelectionShape(selection(), manifest(), FILE_HASH));
});

test('rejects duplicate, unknown, over-budget, and path-like candidate IDs', () => {
  const source = manifest();
  assert.throws(
    () => assertSelectionShape(selection({ selectedCandidateIds: ['desktop-000', 'desktop-000'] }), source, FILE_HASH),
    /unique/i,
  );
  assert.throws(
    () => assertSelectionShape(selection({ selectedCandidateIds: ['desktop-000', 'desktop-001', 'narrow-000', 'missing'] }), source, FILE_HASH),
    /unknown candidate/i,
  );
  assert.throws(
    () => assertSelectionShape(selection({ selectedCandidateIds: Array.from({ length: 7 }, (_, i) => `x-${i}`) }), source, FILE_HASH),
    /2 to 6/i,
  );
  assert.throws(
    () => assertSelectionShape(selection({ selectedCandidateIds: ['../desktop-000', 'narrow-000'] }), source, FILE_HASH),
    /candidate ID|unknown/i,
  );
});

test('rejects tampered provenance and incomplete viewport coverage', () => {
  const source = manifest();
  assert.throws(
    () => assertSelectionShape(selection({ scanManifestSha256: 'c'.repeat(64) }), source, FILE_HASH),
    /manifest hash/i,
  );
  assert.throws(
    () => assertSelectionShape(selection({ sourceUrlFingerprint: `sha256:${'d'.repeat(64)}` }), source, FILE_HASH),
    /URL fingerprint/i,
  );
  assert.throws(
    () => assertSelectionShape(selection({ selectedCandidateIds: ['desktop-000', 'narrow-000'] }), source, FILE_HASH),
    /lower-page candidate/i,
  );
  assert.throws(
    () => assertSelectionShape(selection({ selectedCandidateIds: ['desktop-001', 'narrow-001'] }), source, FILE_HASH),
    /opening candidate/i,
  );
});

test('manifest rejects duplicate IDs and candidate paths outside staging/probes', () => {
  const duplicate = manifest();
  duplicate.candidates[1].id = duplicate.candidates[0].id;
  assert.throws(() => assertScanManifestShape(duplicate), /duplicate candidate/i);
  const escaped = manifest();
  escaped.candidates[0].framePath = '../outside.png';
  assert.throws(() => assertScanManifestShape(escaped), /framePath/i);
});

test('rejects aggregate status, candidate-state, and contact-sheet provenance contradictions', () => {
  const aggregate = manifest();
  aggregate.viewports.narrow.status = 'blocked';
  assert.throws(() => assertScanManifestShape(aggregate), /aggregate|status/i);

  const candidateState = manifest();
  candidateState.viewports.desktop.status = 'partial';
  candidateState.scanStatus.status = 'partial';
  assert.throws(() => assertScanManifestShape(candidateState), /candidate.+status/i);

  const missingCandidates = manifest();
  missingCandidates.candidates = missingCandidates.candidates.filter((candidate) => candidate.viewport !== 'narrow');
  missingCandidates.contactSheets.narrow.candidateIds = [];
  assert.throws(() => assertScanManifestShape(missingCandidates), /complete viewport.+candidate/i);

  const changedSheet = selection({ contactSheetSha256ByViewport: { desktop: 'c'.repeat(64), narrow: FILE_HASH } });
  assert.throws(() => assertSelectionShape(changedSheet, manifest(), FILE_HASH), /contact sheet hash/i);
});

test('selection reserves two screenshot slots for one known interaction candidate', () => {
  const source = manifest();
  assert.doesNotThrow(() => assertSelectionShape(selection({
    selectedCandidateIds: ['desktop-000', 'desktop-001', 'narrow-000', 'narrow-001'],
    interactionCandidateId: 'interaction-desktop-000',
  }), source, FILE_HASH));
  assert.throws(() => assertSelectionShape(selection({
    selectedCandidateIds: ['desktop-000', 'desktop-001', 'narrow-000', 'narrow-001', 'desktop-000'],
    interactionCandidateId: 'interaction-desktop-000',
  }), source, FILE_HASH), /2 to 4|unique/i);
  assert.throws(() => assertSelectionShape(selection({ interactionCandidateId: 'interaction-missing-000' }), source, FILE_HASH), /unknown interaction/i);
});

test('allows scroll snap to move actual positions backward while planned traversal remains monotonic', () => {
  const source = manifest();
  source.scanStatus.status = 'partial';
  source.viewports.desktop.status = 'partial';
  source.candidates.filter((candidate) => candidate.viewport === 'desktop')
    .forEach((candidate) => { candidate.readinessStatus = 'partial'; });
  source.candidates[1].scrollY = 0;
  source.candidates[1].scrollRatio = 0;
  assert.doesNotThrow(() => assertScanManifestShape(source));

  source.candidates[1].plannedScrollY = -1;
  assert.throws(() => assertScanManifestShape(source), /plannedScrollY.*monotonic/i);
});

test('selection rejects opening and lower-page evidence that are byte-identical', () => {
  const source = manifest();
  source.candidates[1].frameSha256 = source.candidates[0].frameSha256;
  source.candidates[1].probeSourceFrameSha256 = source.candidates[0].frameSha256;
  assert.throws(() => assertSelectionShape(selection(), source, FILE_HASH), /same rendered frame|identical/i);
  source.candidates[1].frameSha256 = '9'.repeat(64);
  source.candidates[1].probeSourceFrameSha256 = source.candidates[1].frameSha256;
  assert.doesNotThrow(() => assertSelectionShape(selection(), source, FILE_HASH));
});
