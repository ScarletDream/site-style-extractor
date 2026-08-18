#!/usr/bin/env node

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');

const {
  assertPublicNetworkTarget,
  buildEvidenceSummary,
  discoverRepresentativeInteractions,
  inspectRenderedPage,
  launchOptions,
  loadPlaywright,
  planScrollPositions,
  probeReadiness,
  settlePage,
  scrubRenderedEvidenceUrls,
  validatePublicUrl,
} = require('./capture-site.cjs');
const {
  BUDGET_POLICY_VERSION,
  SCAN_SCHEMA_VERSION,
  assertScanManifestShape,
} = require('./scan-schema.cjs');
const { createRequestPolicy, resourceId, scrubText, scrubUrl } = require('./url-policy.cjs');
const { createRuntimeProvenance, probeWebgl } = require('./runtime-provenance.cjs');

const DEFAULT_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function validateViewports(viewports) {
  if (!Array.isArray(viewports) || !viewports.length) throw new Error('At least one viewport is required');
  return viewports.map((viewport) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(viewport?.name || '')) throw new Error(`Invalid viewport name: ${viewport?.name || '<missing>'}`);
    if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)
      || viewport.width < 240 || viewport.width > 3840 || viewport.height < 240 || viewport.height > 2160) {
      throw new Error(`Invalid viewport dimensions for ${viewport.name}`);
    }
    return { name: viewport.name, width: viewport.width, height: viewport.height };
  });
}

async function renderProbeFromFrame(page, framePath, probePath) {
  const bytes = fs.readFileSync(framePath).toString('base64');
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:#111}img{display:block;width:360px;height:auto}</style><img src="data:image/png;base64,${bytes}">`);
  await page.locator('img').screenshot({ path: probePath, type: 'jpeg', quality: 35 });
}

async function visibleTextFingerprint(page) {
  const text = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
        && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    })
    .filter((element) => element.children.length === 0)
    .map((element) => (element.textContent || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean).join('\n').slice(0, 20000));
  return `sha256:${sha256(text)}`;
}

async function renderContactSheet(browser, outputDirectory, viewportName, candidates) {
  if (!candidates.length) return null;
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  const cards = candidates.map((candidate) => {
    const bytes = fs.readFileSync(path.join(outputDirectory, candidate.probePath)).toString('base64');
    const label = `${candidate.id} · y=${candidate.scrollY} · ${(candidate.scrollRatio * 100).toFixed(0)}% · ${candidate.readinessStatus}`;
    return `<figure><img src="data:image/jpeg;base64,${bytes}"><figcaption>${label}</figcaption></figure>`;
  }).join('');
  await page.setContent(`<!doctype html><style>
    body{margin:0;padding:24px;background:#111;color:#fff;font:14px system-ui}
    h1{margin:0 0 18px;font-size:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
    figure{margin:0;background:#222;border:1px solid #444;padding:10px}img{display:block;width:100%;height:auto}
    figcaption{padding-top:8px;color:#ddd}
  </style><h1>${viewportName} scan candidates</h1><div class="grid">${cards}</div>`);
  await page.screenshot({ path: path.join(outputDirectory, `contact-sheet-${viewportName}.png`), fullPage: true });
  await context.close();
  return `contact-sheet-${viewportName}.png`;
}

async function collectScan(options) {
  const url = validatePublicUrl(options.url, { allowPrivateNetwork: options.allowPrivateNetwork === true });
  await assertPublicNetworkTarget(url, { allowPrivateNetwork: options.allowPrivateNetwork === true }, options.networkResolver || dns.lookup);
  const viewports = validateViewports(options.viewports || DEFAULT_VIEWPORTS);
  const outputDirectory = path.resolve(options.outputDirectory || `site-style-scan-${Date.now()}`);
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length > 0) {
    throw new Error(`Scan output directory must not exist or must be empty: ${outputDirectory}`);
  }
  const framesDirectory = path.join(outputDirectory, '.staging', 'frames');
  const probesDirectory = path.join(outputDirectory, 'probes');
  fs.mkdirSync(framesDirectory, { recursive: true });
  fs.mkdirSync(probesDirectory, { recursive: true });
  const scanId = crypto.randomUUID();
  const sourceUrl = scrubUrl(url);
  const manifest = {
    schemaVersion: SCAN_SCHEMA_VERSION,
    scanId,
    budgetPolicyVersion: BUDGET_POLICY_VERSION,
    capturedAt: new Date().toISOString(),
    sourceUrl,
    scanStatus: { status: 'blocked', reasons: [] },
    viewports: {},
    candidates: [],
    interactionCandidates: [],
    contactSheets: {},
    scanEvidence: null,
  };
  const evidence = {
    artifactType: 'site-style-scan-evidence',
    schemaVersion: SCAN_SCHEMA_VERSION,
    scanId,
    requestedUrl: sourceUrl,
    capturedAt: manifest.capturedAt,
    runtimeDiagnostics: { consoleErrors: [], pageErrors: [], requestFailures: [], policyBlockedRequests: [] },
    runtimeProvenance: createRuntimeProvenance({ playwrightVersion: '1.62.1', deviceScaleFactor: 1 }),
    page: { finalUrl: null, status: null, publicResources: [], resourceInventoryTruncated: false, viewports: {}, mainPath: [] },
  };
  const evidencePath = path.join(outputDirectory, 'scan-evidence.json');
  const manifestPath = path.join(outputDirectory, 'scan-manifest.json');
  const persist = () => {
    atomicJson(evidencePath, evidence);
    manifest.scanEvidence = { path: 'scan-evidence.json', sha256: sha256(fs.readFileSync(evidencePath)) };
    atomicJson(manifestPath, manifest);
  };
  persist();
  let browser;
  let probeContext;
  let currentStage = 'playwright-load';
  try {
    const { chromium } = (options.playwrightLoader || loadPlaywright)();
    currentStage = 'browser-launch';
    browser = await chromium.launch(launchOptions());
    evidence.runtimeProvenance.browser.version = browser.version();
    probeContext = await browser.newContext({ viewport: { width: 380, height: 1200 } });
    const probePage = await probeContext.newPage();
    const resources = new Map();
    const interactionKeys = new Set();
    currentStage = 'viewport-scan';
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      const requestPolicy = options.requestPolicy || createRequestPolicy({
        allowPrivateNetwork: options.allowPrivateNetwork === true,
        resolver: options.networkResolver || dns.lookup,
      });
      let page;
      let readiness = { status: 'blocked', reasons: ['viewport capture did not start'] };
      try {
        await context.route('**/*', async (route) => {
          const decision = await requestPolicy.check(route.request().url());
          if (decision.allowed) return route.continue();
          if (evidence.runtimeDiagnostics.policyBlockedRequests.length < 50) {
            evidence.runtimeDiagnostics.policyBlockedRequests.push({ url: scrubUrl(route.request().url()), reason: decision.reason });
          } else evidence.runtimeDiagnostics.policyBlockedRequestsTruncated = true;
          return route.abort('blockedbyclient');
        });
        page = await context.newPage();
        page.on('console', (message) => {
          if (message.type() === 'error' && evidence.runtimeDiagnostics.consoleErrors.length < 50) evidence.runtimeDiagnostics.consoleErrors.push({ viewport: viewport.name, message: scrubText(message.text()) });
        });
        page.on('pageerror', (error) => {
          if (evidence.runtimeDiagnostics.pageErrors.length < 50) evidence.runtimeDiagnostics.pageErrors.push({ viewport: viewport.name, message: scrubText(error.message) });
        });
        page.on('requestfailed', (request) => {
          if (evidence.runtimeDiagnostics.requestFailures.length < 50) evidence.runtimeDiagnostics.requestFailures.push({ viewport: viewport.name, url: scrubUrl(request.url()), errorText: scrubText(request.failure()?.errorText || 'request failed') });
        });
        page.on('response', (response) => {
          const type = response.request().resourceType();
          const id = resourceId(response.url(), type);
          if (!resources.has(id) && resources.size < 1000) resources.set(id, { resourceId: id, ...scrubUrl(response.url()), type, status: response.status(), contentType: response.headers()['content-type'] || '' });
          else if (!resources.has(id)) evidence.page.resourceInventoryTruncated = true;
        });
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs || 45000 });
        if (evidence.runtimeProvenance.webgl.status === 'unknown') {
          evidence.runtimeProvenance.webgl = await probeWebgl(page);
        }
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);
        if (!evidence.page.finalUrl) evidence.page.finalUrl = scrubUrl(page.url());
        if (evidence.page.status === null) evidence.page.status = response?.status() ?? null;
        evidence.page.mainPath.push({ action: 'open', viewport: viewport.name, url: scrubUrl(page.url()) });
        readiness = await probeReadiness(page, options.timing || {});
        const initialGeometry = await page.evaluate(() => ({ documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight }));
        const maxPositions = options.timing?.maxTraversalPositions || 16;
        let knownMaximum = Math.max(0, initialGeometry.documentHeight - initialGeometry.viewportHeight);
        let queue = readiness.status === 'blocked' ? [0] : planScrollPositions(knownMaximum, initialGeometry.viewportHeight, maxPositions);
        const actualPositions = [];
        let ordinal = 0;
        while (queue.length && ordinal < maxPositions) {
          const plannedY = queue.shift();
          await page.evaluate((y) => window.scrollTo(0, y), plannedY);
          const settled = await settlePage(page, options.timing || {});
          const scrollY = await page.evaluate(() => window.scrollY);
          const geometry = await page.evaluate(() => ({ documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight }));
          const maximum = Math.max(0, geometry.documentHeight - geometry.viewportHeight);
          const id = `${viewport.name}-${String(ordinal).padStart(3, '0')}`;
          const framePath = `.staging/frames/${id}.png`;
          const probePath = `probes/${id}.jpg`;
          await page.screenshot({ path: path.join(outputDirectory, framePath), type: 'png', fullPage: false });
          const frameSha256 = sha256(fs.readFileSync(path.join(outputDirectory, framePath)));
          await renderProbeFromFrame(probePage, path.join(outputDirectory, framePath), path.join(outputDirectory, probePath));
          manifest.candidates.push({
            id, viewport: viewport.name, ordinal, plannedScrollY: plannedY, scrollY,
            scrollRatio: maximum ? scrollY / maximum : 0,
            documentHeight: geometry.documentHeight, viewportHeight: geometry.viewportHeight,
            framePath, frameSha256,
            probePath, probeSha256: sha256(fs.readFileSync(path.join(outputDirectory, probePath))),
            probeSourceFrameSha256: frameSha256,
            readinessStatus: readiness.status,
            settleStatus: settled.unresolvedMotion ? 'unresolved' : 'complete',
            visibleTextHash: await visibleTextFingerprint(page),
          });
          if (readiness.status === 'complete' && manifest.interactionCandidates.length < 12) {
            const interactions = await discoverRepresentativeInteractions(page, viewport.name, id);
            for (const interaction of interactions) {
              const key = `${interaction.viewport}:${interaction.targetFingerprint}`;
              if (interactionKeys.has(key) || manifest.interactionCandidates.length >= 12) continue;
              interactionKeys.add(key);
              manifest.interactionCandidates.push({
                id: `interaction-${viewport.name}-${String(manifest.interactionCandidates.length).padStart(3, '0')}`,
                ...interaction,
              });
            }
          }
          actualPositions.push(scrollY);
          evidence.page.mainPath.push({ action: 'scroll', viewport: viewport.name, plannedScrollY: plannedY, scrollY, documentHeight: geometry.documentHeight });
          ordinal += 1;
          if (maximum > knownMaximum + Math.max(32, geometry.viewportHeight * 0.1)) {
            knownMaximum = maximum;
            const remaining = maxPositions - ordinal;
            queue = remaining > 0 ? Array.from({ length: remaining }, (_, index) => (
              Math.round(scrollY + ((knownMaximum - scrollY) * (index + 1)) / remaining)
            )) : [];
          } else {
            knownMaximum = Math.max(knownMaximum, maximum);
            if (!queue.length && scrollY < maximum - 2 && ordinal < maxPositions) queue.push(maximum);
          }
        }
        const finalGeometry = await page.evaluate(() => ({ documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, scrollY: window.scrollY }));
        const finalMaximum = Math.max(0, finalGeometry.documentHeight - finalGeometry.viewportHeight);
        if (readiness.status === 'complete' && finalMaximum > 0 && finalGeometry.scrollY / finalMaximum < 0.95) {
          readiness = { ...readiness, status: 'partial', reasons: [...new Set([...(readiness.reasons || []), 'bounded traversal did not reach the current lower-page extent'])] };
          for (const candidate of manifest.candidates.filter((item) => item.viewport === viewport.name)) candidate.readinessStatus = 'partial';
        }
        const rendered = scrubRenderedEvidenceUrls(await inspectRenderedPage(page));
        rendered.evidenceSummary = buildEvidenceSummary(rendered);
        evidence.page.viewports[viewport.name] = {
          profile: viewport,
          captureStatus: { status: readiness.status, reasons: readiness.reasons || [], softSignals: readiness.softSignals || [] },
          traversal: { positions: actualPositions },
          rendered,
        };
        manifest.viewports[viewport.name] = { ...viewport, status: readiness.status, reasons: readiness.reasons || [] };
      } catch (error) {
        const reason = scrubText(error.message || String(error));
        for (const candidate of manifest.candidates.filter((item) => item.viewport === viewport.name)) candidate.readinessStatus = 'blocked';
        manifest.viewports[viewport.name] = { ...viewport, status: 'blocked', reasons: [reason] };
        evidence.page.viewports[viewport.name] = { profile: viewport, captureStatus: { status: 'blocked', reasons: [reason] } };
      } finally {
        await context.close();
      }
    }
    evidence.page.publicResources = [...resources.values()];
    const statuses = Object.values(manifest.viewports).map((viewport) => viewport.status);
    manifest.scanStatus = {
      status: statuses.every((status) => status === 'complete') ? 'complete'
        : statuses.every((status) => status === 'blocked') ? 'blocked' : 'partial',
      reasons: statuses.filter((status) => status !== 'complete'),
    };
    currentStage = 'contact-sheet';
    for (const viewportName of Object.keys(manifest.viewports)) {
      const candidates = manifest.candidates.filter((candidate) => candidate.viewport === viewportName);
      if (!candidates.length) {
        manifest.contactSheets[viewportName] = { status: 'blocked', reasons: ['no candidates'] };
        continue;
      }
      try {
        const sheet = await (options.contactSheetRenderer || renderContactSheet)(browser, outputDirectory, viewportName, candidates);
        const sheetPath = path.join(outputDirectory, sheet);
        manifest.contactSheets[viewportName] = {
          status: 'complete', path: sheet, sha256: sha256(fs.readFileSync(sheetPath)),
          candidateIds: candidates.map((candidate) => candidate.id),
        };
      } catch (error) {
        manifest.contactSheets[viewportName] = { status: 'blocked', reasons: [scrubText(error.message || String(error))] };
        if (manifest.scanStatus.status === 'complete') manifest.scanStatus.status = 'partial';
        manifest.scanStatus.reasons.push(`contact sheet failed for ${viewportName}`);
      }
    }
    assertScanManifestShape(manifest);
    persist();
    return { outputDirectory, manifest, evidence };
  } catch (error) {
    manifest.scanStatus = { status: 'blocked', stage: currentStage, reasons: [scrubText(error.message || String(error))] };
    persist();
    throw error;
  } finally {
    if (probeContext) await probeContext.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { collectScan, renderContactSheet, renderProbeFromFrame, validateViewports, visibleTextFingerprint };
