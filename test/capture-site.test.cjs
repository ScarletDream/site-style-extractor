const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertPublicNetworkTarget, assertSupportedNodeVersion, collectSite, formatUrlIdentity, launchOptions,
  planScrollPositions,
} = require('../src/capture-site.cjs');

const fixture = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width">
<style>
:root { --ink: #10131a; --accent: #355cff; }
body { margin: 0; color: var(--ink); font: 16px/1.5 Arial, sans-serif; }
main { width: min(1100px, calc(100% - 48px)); margin: auto; display: grid; gap: 32px; }
h1 { font-size: 56px; line-height: 1.05; }
button { color: white; background: var(--accent); border-radius: 999px; padding: 12px 20px; }
button:hover { background: #1737b8; transform: translateY(-1px); }
@media (max-width: 600px) { h1 { font-size: 34px; } }
</style></head><body><main><h1>Measured interface</h1><p>Evidence first.</p><button>Inspect</button></main></body></html>`;

async function withFixtureServer(routes, run) {
  const server = http.createServer((request, response) => {
    const body = routes[request.url] || routes['/'];
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('public runtime defaults to Playwright Chromium and only uses an explicit browser override', () => {
  assert.deepEqual(launchOptions({}, 'win32', () => true), { headless: true });
  assert.deepEqual(
    launchOptions({ SITE_STYLE_BROWSER: 'C:\\custom\\chrome.exe' }, 'win32', () => true),
    { headless: true, executablePath: 'C:\\custom\\chrome.exe' },
  );
  assert.throws(
    () => launchOptions({ SITE_STYLE_BROWSER: 'C:\\missing\\chrome.exe' }, 'win32', () => false),
    /does not exist/i,
  );
});

test('requires Node 20 or newer before loading Playwright', () => {
  assert.throws(
    () => assertSupportedNodeVersion('18.19.0'),
    /Node\.js 20 or newer.+18\.19\.0.+install or select a supported runtime/i,
  );
  assert.doesNotMatch(
    (() => { try { assertSupportedNodeVersion('18.19.0'); } catch (error) { return error.message; } })(),
    /Blacksun|[A-Z]:\\Users\\/i,
  );
  assert.doesNotThrow(() => assertSupportedNodeVersion('20.0.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.19.0'));
});

test('formats scrubbed URL identities without object coercion', () => {
  assert.equal(formatUrlIdentity({ displayUrl: 'https://example.com/' }), 'https://example.com/');
  assert.equal(formatUrlIdentity('https://example.com/'), 'https://example.com/');
  assert.notEqual(formatUrlIdentity({ displayUrl: 'https://example.com/' }), '[object Object]');
});

test('bounds very long pages with evenly distributed scroll positions', () => {
  const positions = planScrollPositions(100000, 900, 16);
  assert.equal(positions.length, 16);
  assert.equal(positions[0], 0);
  assert.equal(positions.at(-1), 100000);
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
});

test('caps authored CSS rule inspection and records truncation', async () => {
  const rules = Array.from({ length: 5200 }, (_, index) => `.r${index}{color:rgb(${index % 255},0,0)}`).join('');
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-css-cap-'));
  try {
    await withFixtureServer({ '/': `<style>${rules}</style><main><h1>Rule-heavy page</h1></main>` }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      const scan = report.pages[0].viewports.desktop.styleRuleScan;
      assert.equal(scan.truncated, true);
      assert.ok(scan.inspected <= 5000);
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('samples a bounded number of DOM candidates on very large pages', async () => {
  const nodes = Array.from({ length: 2500 }, (_, index) => `<div>Node ${index}</div>`).join('');
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-dom-cap-'));
  try {
    await withFixtureServer({ '/': `<main>${nodes}</main>` }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      const sampling = report.pages[0].viewports.desktop.domSampling;
      assert.equal(sampling.truncated, true);
      assert.ok(sampling.candidatesInspected <= 2000);
      assert.ok(sampling.totalCandidates > sampling.candidatesInspected);
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('maps rendered elements to bounded public CSS mechanism clues', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-mechanisms-'));
  try {
    await withFixtureServer({ '/': fixture }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      const mechanisms = report.pages[0].viewports.desktop.publicMechanismCandidates;
      assert.ok(Array.isArray(mechanisms));
      assert.ok(mechanisms.length > 0 && mechanisms.length <= 250);
      assert.ok(mechanisms.some((item) => item.targetSelector === 'button'
        && item.matchedRuleSelector === 'button'
        && /border-radius|background/.test(Object.keys(item.declarations).join(' '))));
      assert.ok(report.pages[0].viewports.desktop.evidenceSummary.publicMechanismCandidates.length > 0);
      assert.ok(mechanisms.every((item) => typeof item.targetSelector === 'string'
        && typeof item.matchedRuleSelector === 'string'));
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('bulk rendered sampling reads textContent without layout-forcing innerText', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'capture-site.cjs'), 'utf8');
  assert.match(source, /text:\s*\(element\.textContent \|\| ''\)/);
});

test('hover and focus probes use explicit short timeouts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'capture-site.cjs'), 'utf8');
  assert.match(source, /item\.hover\(\{ trial: false, timeout: 1000 \}\)/);
  assert.match(source, /item\.focus\(\{ timeout: 1000 \}\)/);
  assert.match(source, /Math\.min\(await locator\.count\(\), 6\)/);
});

test('collectSite captures desktop and honest narrow viewports with schema v2 evidence', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-extractor-'));
  const address = server.address();

  try {
    const report = await collectSite({
      url: `http://127.0.0.1:${address.port}/`,
      outputDirectory,
      allowPrivateNetwork: true,
    });

    assert.equal(report.schemaVersion, '2.0.0');
    assert.equal(report.captureStatus.status, 'complete');
    assert.match(report.requestedUrl.displayUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(report.outputDirectory, outputDirectory);
    assert.equal(report.pages.length, 1);
    assert.deepEqual(Object.keys(report.pages[0].viewports), ['desktop', 'narrow']);
    assert.ok(report.pages[0].viewports.desktop.elements.length >= 3);
    assert.ok(report.pages[0].viewports.desktop.evidenceSummary.representativeElements.length >= 2);
    assert.ok(
      report.pages[0].viewports.desktop.evidenceSummary.representativeElements.length
      < report.pages[0].viewports.desktop.elements.length,
    );
    assert.ok(report.pages[0].viewports.desktop.evidenceSummary.typography.length >= 1);
    assert.ok(report.pages[0].viewports.desktop.evidenceSummary.colors.length >= 1);
    assert.equal(report.pages[0].viewports.desktop.openingScreenshot.scrollY, 0);
    assert.equal(report.pages[0].viewports.desktop.openingScreenshot.path, 'screenshots/desktop-viewport.png');
    assert.equal(report.pages[0].viewports.desktop.customProperties['--accent'], '#355cff');
    assert.ok(report.pages[0].viewports.desktop.mediaQueries.includes('(max-width: 600px)'));
    assert.ok(report.pages[0].publicResources.some((resource) => resource.type === 'document'));
    assert.ok(report.pages[0].viewports.desktop.interactionStates.some((state) => state.kind === 'hover'));
    assert.ok(report.pages[0].viewports.narrow.interactionStates.every((state) => state.kind !== 'hover'));
    assert.ok(report.pages[0].mainPath.length >= 2);
    assert.ok(Array.isArray(report.pages[0].representativeStates));
    assert.deepEqual(report.pages[0].skippedBranches, []);
    assert.deepEqual(report.pages[0].outliers, []);
    assert.ok(report.pages[0].screenshots.length >= 4);
    assert.ok(report.pages[0].screenshots.every((shot) => /^[a-f0-9]{64}$/.test(shot.sha256)));
    assert.ok(report.pages[0].screenshots.every((shot) => Number.isFinite(shot.scrollY)));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'evidence.json')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'screenshots', 'desktop-viewport.png')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'screenshots', 'narrow-viewport.png')));
  } finally {
    server.close();
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('collectSite rejects non-http URLs', async () => {
  await assert.rejects(
    () => collectSite({ url: 'file:///tmp/private.html', outputDirectory: os.tmpdir() }),
    /public http\(s\) URL/i,
  );
});

test('rejects loopback and private-network targets unless a development override is explicit', () => {
  for (const url of [
    'http://localhost:3000/', 'http://127.0.0.1/', 'http://10.1.2.3/',
    'http://172.16.0.1/', 'http://192.168.1.2/', 'http://169.254.1.1/', 'http://[::1]/',
  ]) {
    assert.throws(() => require('../src/capture-site.cjs').validatePublicUrl(url), /public network target/i);
    assert.doesNotThrow(() => require('../src/capture-site.cjs').validatePublicUrl(url, { allowPrivateNetwork: true }));
  }
  assert.doesNotThrow(() => require('../src/capture-site.cjs').validatePublicUrl('https://example.com/'));
});

test('rejects a public-looking hostname when DNS resolves it to a private address', async () => {
  const privateResolver = async () => [{ address: '10.20.30.40', family: 4 }];
  await assert.rejects(
    () => assertPublicNetworkTarget('https://public-looking.example/', {}, privateResolver),
    /resolves to a non-public address/i,
  );
  await assert.doesNotReject(
    () => assertPublicNetworkTarget(
      'https://public-looking.example/',
      { allowPrivateNetwork: true },
      privateResolver,
    ),
  );
});

test('waits for delayed content and traverses incrementally to reveal scroll content', async () => {
  const delayedReveal = `<!doctype html><style>
    body{margin:0}.spacer{height:1100px}.reveal{opacity:.08;transition:opacity 80ms linear}
    .reveal.ready{opacity:1}
  </style><div id="loader" role="status">Loading</div><main hidden>
    <h1>Delayed hero</h1><div class="spacer"></div><section class="reveal">Revealed section</section>
  </main><script>
    setTimeout(()=>{loader.remove();document.querySelector('main').hidden=false},120);
    addEventListener('scroll',()=>{if(scrollY>500)document.querySelector('.reveal').classList.add('ready')});
  </script>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-ready-'));
  try {
    await withFixtureServer({ '/': delayedReveal }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 1200, readinessPollMs: 40, settleTimeoutMs: 300 },
      });
      const desktop = report.pages[0].viewports.desktop;
      assert.equal(desktop.captureStatus.status, 'complete');
      assert.ok(desktop.captureStatus.readiness.attempts >= 2);
      assert.ok(desktop.traversal.positions.length >= 2);
      assert.ok(desktop.elements.some((element) => element.text.includes('Revealed section')));
      assert.equal(
        desktop.elements.find((element) => element.text === 'Revealed section').style.opacity,
        '1',
      );
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('classifies a persistent explicit loader as partial instead of successful style evidence', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-loader-'));
  try {
    await withFixtureServer({ '/': '<div class="loading" role="status">Loading…</div>' }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 180, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      const desktop = report.pages[0].viewports.desktop;
      assert.equal(desktop.captureStatus.status, 'partial');
      assert.ok(desktop.captureStatus.reasons.includes('persistent-explicit-loader'));
      assert.equal(desktop.openingScreenshot.kind, 'diagnostic');
      assert.ok(report.pages[0].screenshots.length >= 1);
      assert.ok(report.pages[0].screenshots.every((screenshot) => screenshot.kind === 'diagnostic'));
      assert.ok(report.pages[0].representativeStates.every((state) => state.status !== 'complete'));
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('ignores hidden and offscreen loader markers when substantive viewport content is ready', async () => {
  const html = `<!doctype html><style>
    .offscreen-loader{position:absolute;top:2000px;width:20px;height:20px}
  </style><div class="loading" hidden>Loading</div><div class="offscreen-loader" role="status">Loading</div>
  <main><h1>Ready product system</h1><p>This viewport contains enough visible product content to be useful evidence.</p></main>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-offscreen-loader-'));
  try {
    await withFixtureServer({ '/': html }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 240, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      assert.equal(report.pages[0].viewports.desktop.captureStatus.status, 'complete');
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('does not let a small in-content spinner block a substantive page', async () => {
  const html = `<!doctype html><main><h1>Analytics workspace</h1>
    <p>Live reports, decisions, workflows, and project history are available in this workspace.</p>
    <button><span class="loader" role="status">Loading</span> Refresh report</button>
  </main>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-inline-spinner-'));
  try {
    await withFixtureServer({ '/': html }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 240, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      assert.equal(report.pages[0].viewports.desktop.captureStatus.status, 'complete');
      assert.ok(report.pages[0].viewports.desktop.captureStatus.softSignals.includes('visible-loader-marker'));
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('treats a small spinner inside an unnamed full-screen overlay as blocking', async () => {
  const html = `<!doctype html><main><h1>Rendered workspace behind overlay</h1>
    <p>This text is already present but cannot be used while the loading veil covers the viewport.</p></main>
    <div style="position:fixed;inset:0;background:white;display:grid;place-items:center">
      <span class="loader" role="status">Loading</span>
    </div>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-overlay-spinner-'));
  try {
    await withFixtureServer({ '/': html }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 180, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      assert.equal(report.pages[0].viewports.desktop.captureStatus.status, 'partial');
      assert.ok(report.pages[0].viewports.desktop.captureStatus.reasons.includes('persistent-explicit-loader'));
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('classifies a sparse centered graphical shell as partial without treating every SVG as a loader', async () => {
  const shell = `<!doctype html><style>
    html,body{margin:0;min-height:100%;background:#050505}
    svg{position:fixed;left:50%;top:50%;width:28px;height:28px;transform:translate(-50%,-50%)}
  </style><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="white"/></svg>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-graphical-shell-'));
  try {
    await withFixtureServer({ '/': shell }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 180, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      const status = report.pages[0].viewports.desktop.captureStatus;
      assert.equal(status.status, 'partial');
      assert.ok(status.reasons.includes('sparse-graphical-shell'));
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('persists a blocked schema-v2 report when Playwright loading fails after output creation', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-blocked-'));
  try {
    await assert.rejects(
      () => collectSite({
        url: 'https://example.com/',
        outputDirectory,
        networkResolver: async () => [{ address: '93.184.216.34', family: 4 }],
        playwrightLoader: () => { throw new Error('fixture playwright unavailable'); },
      }),
      /fixture playwright unavailable/,
    );
    const evidencePath = path.join(outputDirectory, 'evidence.json');
    assert.equal(fs.existsSync(evidencePath), true);
    const report = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(report.schemaVersion, '2.0.0');
    assert.equal(report.captureStatus.status, 'blocked');
    assert.equal(report.captureStatus.stage, 'playwright-load');
    assert.match(report.captureStatus.reasons.join(' '), /fixture playwright unavailable/);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('one viewport failure is persisted without erasing a completed sibling viewport', async () => {
  let documentRequests = 0;
  const server = http.createServer((request, response) => {
    documentRequests += 1;
    if (documentRequests === 1) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixture);
      return;
    }
    response.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-viewport-failure-'));
  try {
    const report = await collectSite({
      url: `http://127.0.0.1:${server.address().port}/`,
      outputDirectory,
      allowPrivateNetwork: true,
      viewports: [
        { name: 'desktop', width: 800, height: 600 },
        { name: 'narrow', width: 390, height: 600 },
      ],
      navigationTimeoutMs: 700,
      timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 100 },
    });

    assert.equal(report.captureStatus.status, 'partial');
    assert.equal(report.pages[0].viewports.desktop.captureStatus.status, 'complete');
    assert.equal(report.pages[0].viewports.narrow.captureStatus.status, 'blocked');
    assert.equal(report.pages[0].viewports.narrow.captureStatus.stage, 'navigation');
    const persisted = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'evidence.json'), 'utf8'));
    assert.equal(persisted.pages[0].viewports.desktop.captureStatus.status, 'complete');
    assert.equal(persisted.pages[0].viewports.narrow.captureStatus.status, 'blocked');
  } finally {
    server.close();
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('capture scrubs resource URLs and bounds URL-bearing runtime diagnostics', async () => {
  const noisyPage = `<!doctype html><link rel="stylesheet" href="/style.css?token=resource-secret">
    <main><h1>Bounded diagnostics</h1><p>Rendered evidence.</p></main><script>
      for(let i=0;i<60;i++) console.error('console '+i+' https://example.com/log?token=console-secret');
      fetch('/missing?token=request-secret').catch(()=>{});
      setTimeout(()=>{throw new Error('page https://example.com/error?token=page-secret')},10);
    </script>`;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/missing')) {
      response.destroy();
      return;
    }
    if (request.url.startsWith('/style.css')) {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end('body{color:#123456}');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(noisyPage);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-diagnostics-'));
  try {
    const report = await collectSite({
      url: `http://127.0.0.1:${server.address().port}/`,
      outputDirectory,
      allowPrivateNetwork: true,
      viewports: [{ name: 'desktop', width: 800, height: 600 }],
      timing: { readinessTimeoutMs: 400, readinessPollMs: 40, settleTimeoutMs: 120 },
    });
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /resource-secret|console-secret|request-secret|page-secret/);
    assert.ok(report.runtimeDiagnostics.consoleErrors.length > 0);
    assert.ok(report.runtimeDiagnostics.consoleErrors.length <= 50);
    assert.ok(report.runtimeDiagnostics.pageErrors.length >= 1);
    assert.ok(report.runtimeDiagnostics.requestFailures.length >= 1);
    assert.ok(report.pages[0].publicResources.every((resource) => /^res_[a-f0-9]{16}$/.test(resource.resourceId)));
    assert.ok(report.pages[0].publicResources.every((resource) => resource.displayUrl && !('url' in resource)));
  } finally {
    server.close();
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('browser request policy blocks a denied subresource before it reaches the fixture server', async () => {
  let blockedResourceRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/blocked.png')) blockedResourceRequests += 1;
    response.writeHead(200, { 'content-type': request.url === '/' ? 'text/html' : 'image/png' });
    response.end(request.url === '/' ? '<main><h1>Policy fixture</h1><img src="/blocked.png?token=blocked-secret"></main>' : 'x');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-policy-'));
  try {
    const requestPolicy = {
      check: async (url) => (url.includes('/blocked.png')
        ? { allowed: false, reason: 'fixture-denied' }
        : { allowed: true }),
    };
    const report = await collectSite({
      url: `http://127.0.0.1:${server.address().port}/`,
      outputDirectory,
      allowPrivateNetwork: true,
      requestPolicy,
      viewports: [{ name: 'desktop', width: 800, height: 600 }],
      timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 100 },
    });
    assert.equal(blockedResourceRequests, 0);
    assert.equal(report.runtimeDiagnostics.policyBlockedRequests.length, 1);
    assert.equal(report.runtimeDiagnostics.policyBlockedRequests[0].reason, 'fixture-denied');
    assert.doesNotMatch(JSON.stringify(report.runtimeDiagnostics), /blocked-secret/);
  } finally {
    server.close();
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('keeps an intentionally minimal page complete while recording sparse-content as a soft signal', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-minimal-'));
  try {
    await withFixtureServer({ '/': '<main style="min-height:100vh"><h1>One quiet thought.</h1></main>' }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 100 },
      });
      const desktop = report.pages[0].viewports.desktop;
      assert.equal(desktop.captureStatus.status, 'complete');
      assert.ok(desktop.captureStatus.softSignals.includes('sparse-content'));
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('bounds settle time for perpetual animation and records unresolved motion', async () => {
  const animated = `<!doctype html><style>@keyframes drift{to{transform:translateX(20px)}}
    h1{animation:drift 10ms linear infinite}</style><main><h1>Always moving</h1><p>Still capturable.</p></main>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-motion-'));
  try {
    await withFixtureServer({ '/': animated }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 120 },
      });
      const desktop = report.pages[0].viewports.desktop;
      assert.equal(desktop.captureStatus.status, 'complete');
      assert.equal(desktop.traversal.unresolvedMotion, true);
      assert.ok(desktop.traversal.maxSettleDurationMs <= 500);
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('captures one reversible tab interaction and never activates a dangerous control', async () => {
  let dangerousRequests = 0;
  const interactive = `<!doctype html><style>[role=tabpanel][hidden]{display:none}</style>
    <div role="tablist"><button role="tab" aria-selected="true" aria-controls="one">Overview</button>
    <button role="tab" aria-selected="false" aria-controls="two">Details</button></div>
    <section id="one" role="tabpanel">Quiet overview</section><section id="two" role="tabpanel" hidden>Distinct details</section>
    <div style="height:5000px" aria-hidden="true"></div>
    <button onclick="fetch('/danger')">Delete account</button>
    <script>document.querySelectorAll('[role=tab]').forEach(tab=>tab.onclick=()=>{
      document.querySelectorAll('[role=tab]').forEach(x=>x.setAttribute('aria-selected',String(x===tab)));
      document.querySelectorAll('[role=tabpanel]').forEach(x=>x.hidden=x.id!==tab.getAttribute('aria-controls'));
    })</script>`;
  const server = http.createServer((request, response) => {
    if (request.url === '/danger') dangerousRequests += 1;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(interactive);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-interaction-'));
  try {
    const report = await collectSite({
      url: `http://127.0.0.1:${server.address().port}/`, outputDirectory, allowPrivateNetwork: true,
      viewports: [
        { name: 'desktop', width: 800, height: 600 },
        { name: 'narrow', width: 390, height: 600 },
      ],
      timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 120 },
    });
    const interaction = report.pages[0].representativeInteraction;
    assert.equal(interaction.kind, 'tab');
    assert.equal(interaction.target.text, 'Details');
    assert.equal(interaction.reversible, true, JSON.stringify({
      before: interaction.beforeState,
      after: interaction.afterState,
      restored: interaction.restoredState,
    }));
    assert.equal(interaction.changed, true);
    assert.equal(interaction.beforeState.triggerSelected, 'false');
    assert.equal(interaction.afterState.triggerSelected, 'true');
    assert.deepEqual(interaction.restoredState, interaction.beforeState);
    assert.ok(fs.existsSync(path.join(outputDirectory, interaction.beforeScreenshot)));
    assert.ok(fs.existsSync(path.join(outputDirectory, interaction.afterScreenshot)));
    assert.equal(dangerousRequests, 0);
    assert.ok(fs.readdirSync(path.join(outputDirectory, 'screenshots')).length <= 6);
  } finally {
    server.close();
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('classifies an aria-controlled alert dialog as a dialog interaction, not an accordion', async () => {
  const fixture = `<!doctype html><button aria-expanded="false" aria-controls="install">Install via package manager</button>
    <div id="install" role="alertdialog" hidden>Install commands <button>Close</button></div>
    <script>const trigger=document.querySelector('[aria-controls]');const dialog=document.querySelector('[role=alertdialog]');
    trigger.onclick=()=>{dialog.hidden=!dialog.hidden;trigger.setAttribute('aria-expanded',String(!dialog.hidden))};
    dialog.querySelector('button').onclick=()=>{dialog.hidden=true;trigger.setAttribute('aria-expanded','false')}</script>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-dialog-'));
  try {
    await withFixtureServer({ '/': fixture }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 120 },
      });
      assert.equal(report.pages[0].representativeInteraction.kind, 'alertdialog');
      assert.equal(report.pages[0].representativeInteraction.reversible, true);
      assert.equal(report.pages[0].representativeInteraction.changed, true);
      assert.deepEqual(
        report.pages[0].representativeInteraction.restoredState,
        report.pages[0].representativeInteraction.beforeState,
      );
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('unrestorable accordion is recorded truthfully and recovered by reload', async () => {
  const fixture = `<!doctype html><button aria-expanded="false" aria-controls="panel">Reveal details</button>
    <section id="panel" hidden>Details remain open once revealed.</section>
    <script>const trigger=document.querySelector('button');const panel=document.querySelector('section');
    trigger.onclick=()=>{trigger.setAttribute('aria-expanded','true');panel.hidden=false}</script>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-unrestorable-'));
  try {
    await withFixtureServer({ '/': fixture }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 120 },
      });
      const interaction = report.pages[0].representativeInteraction;
      assert.equal(interaction.kind, 'accordion');
      assert.equal(interaction.reversible, false);
      assert.notDeepEqual(interaction.restoredState, interaction.beforeState);
      assert.equal(interaction.recovery.status, 'complete');
      assert.ok(report.pages[0].mainPath.some((entry) => entry.action === 'click-unrestored'));
      assert.ok(report.pages[0].mainPath.every((entry) => entry.action !== 'click-reversible'));
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('reload recovery repeats traversal before rendered evidence inspection', async () => {
  const fixture = `<!doctype html><button aria-expanded="false" aria-controls="panel">Reveal details</button>
    <section id="panel" hidden>Persistent details</section><div style="height:2400px"></div><footer></footer>
    <script>const trigger=document.querySelector('button');const panel=document.querySelector('section');
    trigger.onclick=()=>{trigger.setAttribute('aria-expanded','true');panel.hidden=false};
    addEventListener('scroll',()=>{if(scrollY>1000)document.querySelector('footer').textContent='Lazy footer revealed'})</script>`;
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-recovery-traversal-'));
  try {
    await withFixtureServer({ '/': fixture }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 120 },
      });
      const page = report.pages[0];
      assert.ok(page.mainPath.some((entry) => entry.action === 'reload-recovery'));
      assert.match(JSON.stringify(page.viewports.desktop), /Lazy footer revealed/);
    });
  } finally { fs.rmSync(outputDirectory, { recursive: true, force: true }); }
});

test('an exception after opening screenshot downgrades retained viewport screenshots', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-late-error-'));
  try {
    await withFixtureServer({ '/': fixture }, async (baseUrl) => {
      const report = await collectSite({
        url: `${baseUrl}/`, outputDirectory, allowPrivateNetwork: true,
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        timing: { readinessTimeoutMs: 300, readinessPollMs: 40, settleTimeoutMs: 120 },
        inspectRenderedPage: async () => { throw new Error('injected late inspection failure'); },
      });
      assert.equal(report.pages[0].viewports.desktop.captureStatus.status, 'blocked');
      assert.ok(report.pages[0].screenshots.length > 0);
      assert.ok(report.pages[0].screenshots.every((shot) => shot.kind === 'diagnostic'));
      assert.ok(report.pages[0].representativeStates.every((state) => state.status === 'blocked'));
    });
  } finally { fs.rmSync(outputDirectory, { recursive: true, force: true }); }
});
