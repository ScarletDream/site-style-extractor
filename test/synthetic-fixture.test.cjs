const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { collectScan } = require('../src/scan-site.cjs');
const { finalizeScan } = require('../src/finalize-scan.cjs');
const { validateCapturePackage } = require('../src/validate-package.cjs');

test('first-party fixture exposes contrasting regions and reversible interaction candidates', { timeout: 60000 }, async (t) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'examples', 'synthetic-site', 'index.html'));
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-fixture-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const finalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-fixture-final-'));
  t.after(() => fs.rmSync(finalDirectory, { recursive: true, force: true }));

  const result = await collectScan({
    url: `http://127.0.0.1:${server.address().port}/`,
    outputDirectory,
    allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 960, height: 600 }],
    timing: { readinessTimeoutMs: 1200, traversalTimeoutMs: 10000, maxTraversalPositions: 8 },
  });

  assert.equal(result.manifest.scanStatus.status, 'complete');
  assert.ok(result.manifest.candidates.length >= 5);
  assert.ok(result.manifest.candidates.some((candidate) => candidate.scrollRatio > 0.9));
  const evidence = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'scan-evidence.json'), 'utf8'));
  const labels = JSON.stringify(evidence).toLowerCase();
  assert.match(labels, /signal/);
  assert.match(labels, /what is this fixture/);

  const manifestPath = path.join(outputDirectory, 'scan-manifest.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const selected = [result.manifest.candidates[0], result.manifest.candidates.at(-1)];
  const selection = {
    schemaVersion: result.manifest.schemaVersion,
    scanId: result.manifest.scanId,
    scanManifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    sourceUrlFingerprint: result.manifest.sourceUrl.urlFingerprint,
    budgetPolicyVersion: result.manifest.budgetPolicyVersion,
    selectedCandidateIds: selected.map((candidate) => candidate.id),
    contactSheetSha256ByViewport: { desktop: result.manifest.contactSheets.desktop.sha256 },
  };
  const selectionPath = path.join(outputDirectory, 'selection.json');
  fs.writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
  const finalized = finalizeScan(outputDirectory, selectionPath, finalDirectory);
  assert.equal(finalized.captureStatus.status, 'complete');
  assert.deepEqual(finalized.pages[0].scanProvenance.selectedCandidateIds, selection.selectedCandidateIds);
  const validation = validateCapturePackage(finalDirectory);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.stage, 'capture');
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
});
