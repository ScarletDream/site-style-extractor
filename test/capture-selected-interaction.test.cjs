const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { captureSelectedInteraction } = require('../src/capture-selected-interaction.cjs');
const { collectScan } = require('../src/scan-site.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function prepareRun(t, html, onRequest = null) {
  const server = http.createServer((request, response) => {
    if (onRequest) onRequest(request);
    if (request.method !== 'GET') { response.end('ok'); return; }
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-interaction-case-'));
  t.after(() => fs.rmSync(runDirectory, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const scan = await collectScan({
    url, outputDirectory: runDirectory, allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    timing: { readinessTimeoutMs: 300, settleTimeoutMs: 100, maxTraversalPositions: 3 },
  });
  const manifestBytes = fs.readFileSync(path.join(runDirectory, 'scan-manifest.json'));
  const desktop = scan.manifest.candidates.filter((candidate) => candidate.viewport === 'desktop');
  const selection = {
    schemaVersion: '1.0.0', scanId: scan.manifest.scanId,
    scanManifestSha256: sha256(manifestBytes), sourceUrlFingerprint: scan.manifest.sourceUrl.urlFingerprint,
    budgetPolicyVersion: '1.0.0', contactSheetSha256ByViewport: { desktop: scan.manifest.contactSheets.desktop.sha256 },
    selectedCandidateIds: [desktop[0].id, desktop.at(-1).id],
    interactionCandidateId: scan.manifest.interactionCandidates[0].id,
  };
  const selectionPath = path.join(runDirectory, 'selection.json');
  fs.writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
  return { runDirectory, selectionPath, url, scan };
}

test('scan discovers and isolated capture verifies one selected reversible interaction', { timeout: 60000 }, async (t) => {
  const html = `<!doctype html><button aria-expanded="false" aria-controls="panel">Show details</button>
    <div id="panel" hidden>Distinct panel state</div><main style="height:1300px"></main><script>
    const b=document.querySelector('button'),p=document.querySelector('#panel');b.onclick=()=>{const x=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!x));p.hidden=x}
    </script>`;
  const server = http.createServer((request, response) => response.end(html));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-interaction-'));
  t.after(() => fs.rmSync(runDirectory, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const scan = await collectScan({
    url, outputDirectory: runDirectory, allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    timing: { readinessTimeoutMs: 300, settleTimeoutMs: 100, maxTraversalPositions: 4 },
  });
  assert.equal(scan.manifest.interactionCandidates.length, 1);
  const manifestBytes = fs.readFileSync(path.join(runDirectory, 'scan-manifest.json'));
  const sheet = scan.manifest.contactSheets.desktop;
  const desktop = scan.manifest.candidates.filter((candidate) => candidate.viewport === 'desktop');
  const selection = {
    schemaVersion: '1.0.0', scanId: scan.manifest.scanId,
    scanManifestSha256: sha256(manifestBytes),
    sourceUrlFingerprint: scan.manifest.sourceUrl.urlFingerprint,
    budgetPolicyVersion: '1.0.0',
    contactSheetSha256ByViewport: { desktop: sheet.sha256 },
    selectedCandidateIds: [desktop[0].id, desktop.at(-1).id],
    interactionCandidateId: scan.manifest.interactionCandidates[0].id,
  };
  const selectionPath = path.join(runDirectory, 'selection.json');
  fs.writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
  const result = await captureSelectedInteraction({ url, runDirectory, selectionPath, allowPrivateNetwork: true });
  assert.equal(result.status, 'complete');
  assert.equal(result.reversible, true);
  assert.ok(fs.existsSync(path.join(runDirectory, result.before.path)));
  assert.ok(fs.existsSync(path.join(runDirectory, result.after.path)));
  await assert.rejects(captureSelectedInteraction({ url, runDirectory, selectionPath, allowPrivateNetwork: false }), /public network target/i);
  assert.equal(fs.existsSync(path.join(runDirectory, 'interaction-result.json')), false);
});

test('no-op and ambiguous controls never become complete interaction evidence', { timeout: 60000 }, async (t) => {
  const noop = await prepareRun(t, '<button aria-expanded="false" aria-controls="panel">Details</button><div id="panel" hidden></div><main style="height:900px"></main>');
  const noopResult = await captureSelectedInteraction({ ...noop, allowPrivateNetwork: true });
  assert.equal(noopResult.status, 'partial');
  assert.equal(noopResult.changed, false);

  const ambiguous = await prepareRun(t, '<button aria-expanded="false" aria-controls="panel">Details</button><button aria-expanded="false" aria-controls="panel">Details</button><div id="panel" hidden></div><main style="height:900px"></main>');
  const ambiguousResult = await captureSelectedInteraction({ ...ambiguous, allowPrivateNetwork: true });
  assert.equal(ambiguousResult.status, 'blocked');
  assert.match(ambiguousResult.reasons.join(' '), /2 visible fingerprint matches/i);
});

test('interaction replay blocks write requests and refuses promotion', { timeout: 60000 }, async (t) => {
  let writes = 0;
  const html = `<button aria-expanded="false" aria-controls="panel">Details</button><div id="panel" hidden></div><main style="height:900px"></main><script>
    const b=document.querySelector('button'),p=document.querySelector('#panel');b.onclick=()=>{const x=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!x));p.hidden=x;fetch('/counter',{method:'POST',body:'x'}).catch(()=>{})}
  </script>`;
  const item = await prepareRun(t, html, (request) => { if (request.method === 'POST') writes += 1; });
  const result = await captureSelectedInteraction({ ...item, allowPrivateNetwork: true });
  assert.equal(writes, 0);
  assert.equal(result.status, 'blocked');
  assert.match(result.reasons.join(' '), /blocked POST request/i);
});

test('interaction replay blocks popups even when the local UI state changes', { timeout: 60000 }, async (t) => {
  const html = `<button aria-expanded="false" aria-controls="panel">Details</button><div id="panel" hidden></div><main style="height:900px"></main><script>
    const b=document.querySelector('button'),p=document.querySelector('#panel');b.onclick=()=>{const x=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!x));p.hidden=x;open('/popup','_blank')}
  </script>`;
  const item = await prepareRun(t, html);
  const result = await captureSelectedInteraction({ ...item, allowPrivateNetwork: true });
  assert.equal(result.status, 'blocked');
  assert.match(result.reasons.join(' '), /popup|navigation/i);
});

test('interaction replay blocks a navigation scheduled after DOMContentLoaded', { timeout: 60000 }, async (t) => {
  let documentRequests = 0;
  let mutationRequests = 0;
  const base = `<button aria-expanded="false" aria-controls="panel">Details</button><div id="panel" hidden></div><main style="height:900px"></main><script>
    const b=document.querySelector('button'),p=document.querySelector('#panel');b.onclick=()=>{const x=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!x));p.hidden=x}
  </script>`;
  const server = http.createServer((request, response) => {
    documentRequests += 1;
    if (request.url.includes('mutate=1')) mutationRequests += 1;
    const replayScript = documentRequests > 1 ? `<script>addEventListener('DOMContentLoaded',()=>setTimeout(()=>location.href='/?mutate=1',25))</script>` : '';
    response.end(`${base}${replayScript}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-post-dom-nav-'));
  t.after(() => fs.rmSync(runDirectory, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const scan = await collectScan({ url, outputDirectory: runDirectory, allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    timing: { readinessTimeoutMs: 300, settleTimeoutMs: 100, maxTraversalPositions: 3 } });
  const manifestBytes = fs.readFileSync(path.join(runDirectory, 'scan-manifest.json'));
  const desktop = scan.manifest.candidates.filter((candidate) => candidate.viewport === 'desktop');
  const selection = { schemaVersion: '1.0.0', scanId: scan.manifest.scanId,
    scanManifestSha256: sha256(manifestBytes), sourceUrlFingerprint: scan.manifest.sourceUrl.urlFingerprint,
    budgetPolicyVersion: '1.0.0', contactSheetSha256ByViewport: { desktop: scan.manifest.contactSheets.desktop.sha256 },
    selectedCandidateIds: [desktop[0].id, desktop.at(-1).id], interactionCandidateId: scan.manifest.interactionCandidates[0].id };
  const selectionPath = path.join(runDirectory, 'selection.json');
  fs.writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
  const result = await captureSelectedInteraction({ url, runDirectory, selectionPath, allowPrivateNetwork: true });
  assert.equal(mutationRequests, 0);
  assert.equal(result.status, 'blocked');
  assert.match(result.reasons.join(' '), /navigation/i);
});

test('interaction replay checks matching targets beyond the scan discovery cap', { timeout: 60000 }, async (t) => {
  const middle = Array.from({ length: 19 }, (_, index) => `<button aria-expanded="false" aria-controls="panel-${index}">Other ${index}</button><div id="panel-${index}" hidden></div>`).join('');
  const html = `<button aria-expanded="false" aria-controls="shared">Details</button>${middle}<button aria-expanded="false" aria-controls="shared">Details</button><div id="shared" hidden></div><main style="height:900px"></main>`;
  const item = await prepareRun(t, html);
  const result = await captureSelectedInteraction({ ...item, allowPrivateNetwork: true });
  assert.equal(result.status, 'blocked');
  assert.match(result.reasons.join(' '), /2 visible fingerprint matches/i);
});

test('interaction replay blocks visible text drift at the selected scan position', { timeout: 60000 }, async (t) => {
  const html = '<p>Stable context</p><button aria-expanded="false" aria-controls="panel">Details</button><div id="panel" hidden></div><main style="height:900px"></main>';
  const item = await prepareRun(t, html);
  const manifestPath = path.join(item.runDirectory, 'scan-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const interaction = manifest.interactionCandidates.find((candidate) => candidate.id === JSON.parse(fs.readFileSync(item.selectionPath, 'utf8')).interactionCandidateId);
  manifest.candidates.find((candidate) => candidate.id === interaction.nearCandidateId).visibleTextHash = `sha256:${'0'.repeat(64)}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const selection = JSON.parse(fs.readFileSync(item.selectionPath, 'utf8'));
  selection.scanManifestSha256 = sha256(fs.readFileSync(manifestPath));
  fs.writeFileSync(item.selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
  const result = await captureSelectedInteraction({ ...item, allowPrivateNetwork: true });
  assert.equal(result.status, 'blocked');
  assert.match(result.reasons.join(' '), /visible text|context drift/i);
});
