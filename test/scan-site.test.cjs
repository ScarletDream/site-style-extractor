const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { collectScan } = require('../src/scan-site.cjs');
const { assertScanManifestShape } = require('../src/scan-schema.cjs');

test('scan captures bounded candidates across alternating long-page systems', { timeout: 60000 }, async (t) => {
  const html = `<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;font-family:Arial}
    section{height:900px;padding:80px;font-size:64px}
    .dark{background:#080808;color:white}.light{background:#faf7ef;color:#111}
  </style><section class="dark">Dark opening</section><section class="light">Light work</section>
  <section class="dark">Dark story</section><section class="light">Light world</section>
  <section class="dark">Dark footer</section>`;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-scan-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const result = await collectScan({
    url,
    outputDirectory,
    allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 960, height: 600 }],
    timing: { readinessTimeoutMs: 1500, traversalTimeoutMs: 10000, maxTraversalPositions: 10 },
  });

  assertScanManifestShape(result.manifest);
  assert.equal(result.manifest.scanStatus.status, 'complete');
  assert.ok(result.manifest.candidates.length >= 6);
  assert.equal(result.manifest.candidates[0].scrollY, 0);
  assert.ok(result.manifest.candidates.some((candidate) => candidate.scrollRatio > 0.75));
  for (const candidate of result.manifest.candidates) {
    assert.ok(fs.existsSync(path.join(outputDirectory, candidate.framePath)));
    assert.ok(fs.existsSync(path.join(outputDirectory, candidate.probePath)));
  }
  assert.ok(fs.existsSync(path.join(outputDirectory, 'contact-sheet-desktop.png')));
  assert.ok(fs.existsSync(path.join(outputDirectory, 'scan-evidence.json')));
  assert.ok(fs.existsSync(path.join(outputDirectory, 'scan-manifest.json')));
  assert.ok(result.manifest.candidates.every((candidate) => candidate.probeSourceFrameSha256 === candidate.frameSha256));
  assert.equal(result.manifest.contactSheets.desktop.status, 'complete');
  assert.match(result.manifest.contactSheets.desktop.sha256, /^[a-f0-9]{64}$/);
});

test('scan persists a blocked failure manifest when the browser runtime cannot load', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-scan-failure-'));
  try {
    await assert.rejects(collectScan({
      url: 'https://example.com/', outputDirectory,
      networkResolver: async () => [{ address: '93.184.216.34', family: 4 }],
      playwrightLoader: () => { throw new Error('fixture browser unavailable'); },
    }), /browser unavailable/);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'scan-manifest.json'), 'utf8'));
    assert.equal(manifest.scanStatus.status, 'blocked');
    assert.equal(manifest.scanStatus.stage, 'playwright-load');
    assert.ok(fs.existsSync(path.join(outputDirectory, 'scan-evidence.json')));
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('a stable HTTP error or anti-bot page cannot become complete style evidence', { timeout: 60000 }, async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(403, { 'content-type': 'text/html' });
    response.end('<main><h1>Performing security verification</h1><p>Please wait while this site verifies your browser.</p></main>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-http-error-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const result = await collectScan({
    url: `http://127.0.0.1:${server.address().port}/`, outputDirectory, allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    timing: { readinessTimeoutMs: 300, settleTimeoutMs: 100, maxTraversalPositions: 4 },
  });
  assert.equal(result.manifest.viewports.desktop.status, 'blocked');
  assert.ok(result.manifest.viewports.desktop.reasons.includes('http-status-403'));
  assert.ok(result.manifest.candidates.every((candidate) => candidate.readinessStatus === 'blocked'));
});

test('contact sheet failure preserves candidates and downgrades only scan status', { timeout: 60000 }, async (t) => {
  const server = http.createServer((request, response) => response.end('<main style="height:1400px">ready</main>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-sheet-failure-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const result = await collectScan({
    url: `http://127.0.0.1:${server.address().port}/`, outputDirectory, allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    contactSheetRenderer: async () => { throw new Error('fixture sheet failure'); },
    timing: { readinessTimeoutMs: 300, settleTimeoutMs: 100, maxTraversalPositions: 4 },
  });
  assert.equal(result.manifest.viewports.desktop.status, 'complete');
  assert.equal(result.manifest.scanStatus.status, 'partial');
  assert.equal(result.manifest.contactSheets.desktop.status, 'blocked');
  assert.ok(result.manifest.candidates.length > 0);
});

test('viewport names and dimensions are rejected before any candidate path is written', async () => {
  const outputDirectory = path.join(os.tmpdir(), `site-style-invalid-${Date.now()}`);
  await assert.rejects(collectScan({
    url: 'https://example.com/', outputDirectory,
    networkResolver: async () => [{ address: '93.184.216.34', family: 4 }],
    viewports: [{ name: '../../../../escaped', width: 800, height: 600 }],
  }), /viewport name/i);
  assert.equal(fs.existsSync(outputDirectory), false);
});

test('bounded traversal replans when lazy content expands document height', { timeout: 60000 }, async (t) => {
  const html = `<!doctype html><main style="height:1200px">opening</main><script>
    let expanded=false; addEventListener('scroll',()=>{if(!expanded&&scrollY>0){expanded=true;
      document.body.insertAdjacentHTML('beforeend','<section style="height:6000px;background:#eee">lazy lower system</section>')}})
  </script>`;
  const server = http.createServer((request, response) => response.end(html));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-dynamic-height-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const result = await collectScan({
    url: `http://127.0.0.1:${server.address().port}/`, outputDirectory, allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    timing: { readinessTimeoutMs: 300, settleTimeoutMs: 120, maxTraversalPositions: 6 },
  });
  const candidates = result.manifest.candidates;
  assert.ok(candidates.some((candidate) => candidate.documentHeight > 6000));
  assert.ok(candidates.at(-1).scrollRatio >= 0.95);
  assert.ok(candidates.length <= 6);
});

test('downgrades a tall page when significant scrolling produces the same rendered frame', { timeout: 60000 }, async (t) => {
  const html = `<!doctype html><style>
    html,body{margin:0}.scroll-space{height:3200px}.gate{position:fixed;inset:0;background:#f7f4ee;
    display:grid;place-items:center;font:700 48px Georgia}
  </style><div class="scroll-space" aria-hidden="true"></div><main class="gate">A STATIC GATE</main>`;
  const server = http.createServer((request, response) => response.end(html));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-no-progress-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const result = await collectScan({
    url: `http://127.0.0.1:${server.address().port}/`, outputDirectory, allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    timing: { readinessTimeoutMs: 300, settleTimeoutMs: 100, maxTraversalPositions: 5 },
  });
  assert.equal(result.manifest.viewports.desktop.status, 'partial');
  assert.ok(result.manifest.viewports.desktop.reasons.includes('no-visual-progress-across-scroll'));
  assert.ok(result.manifest.candidates.every((candidate) => candidate.readinessStatus === 'partial'));
  assert.match(result.manifest.scanStatus.reasons.join(' '), /desktop: no-visual-progress-across-scroll/);
});

test('uses planned traversal to detect a repeated gate even when the page locks actual scroll', { timeout: 60000 }, async (t) => {
  const html = `<!doctype html><style>
    html,body{margin:0}.scroll-space{height:3200px}.gate{position:fixed;inset:0;background:#111;color:white;
    display:grid;place-items:center;font:700 48px Georgia}
  </style><div class="scroll-space" aria-hidden="true"></div><main class="gate">LOCKED GATE</main>
  <script>addEventListener('scroll',()=>scrollTo(0,0))</script>`;
  const server = http.createServer((request, response) => response.end(html));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-locked-progress-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const result = await collectScan({
    url: `http://127.0.0.1:${server.address().port}/`, outputDirectory, allowPrivateNetwork: true,
    viewports: [{ name: 'desktop', width: 800, height: 600 }],
    timing: { readinessTimeoutMs: 300, settleTimeoutMs: 100, maxTraversalPositions: 5 },
  });
  assert.equal(result.manifest.viewports.desktop.status, 'partial');
  assert.ok(result.manifest.viewports.desktop.reasons.includes('no-visual-progress-across-scroll'));
});
