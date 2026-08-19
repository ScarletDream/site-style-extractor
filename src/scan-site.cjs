#!/usr/bin/env node

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

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
const { aggregateScanStatus } = require('./status-record.cjs');

const DEFAULT_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
];
const DEFAULT_TOTAL_TIMEOUT_MS = 240000;
const MAX_TOTAL_TIMEOUT_MS = 900000;

class ScanDeadlineExceededError extends Error {
  constructor(totalTimeoutMs) {
    super(`scan deadline exceeded after ${totalTimeoutMs} ms`);
    this.name = 'ScanDeadlineExceededError';
    this.code = 'SCAN_DEADLINE_EXCEEDED';
  }
}

class ScanDeadline {
  constructor(totalTimeoutMs, onExpire = () => {}) {
    this.totalTimeoutMs = totalTimeoutMs;
    this.startedAt = new Date();
    this.startedAtMonotonic = performance.now();
    this.deadlineAt = new Date(this.startedAt.getTime() + totalTimeoutMs);
    this.activeStage = 'initialization';
    this.controller = new AbortController();
    this.reason = null;
    this.timer = setTimeout(() => {
      this.expire(this.activeStage);
      Promise.resolve(onExpire(this.reason)).catch(() => {});
    }, totalTimeoutMs);
  }

  setStage(stage) {
    this.activeStage = stage;
  }

  expire(stage = this.activeStage) {
    if (this.reason) return this.reason;
    this.activeStage = stage;
    this.reason = new ScanDeadlineExceededError(this.totalTimeoutMs);
    this.controller.abort(this.reason);
    return this.reason;
  }

  throwIfExpired(stage = this.activeStage) {
    this.setStage(stage);
    if (this.reason || performance.now() - this.startedAtMonotonic >= this.totalTimeoutMs) {
      throw this.expire(stage);
    }
  }

  async race(operation, stage = this.activeStage) {
    this.throwIfExpired(stage);
    let abortListener;
    const aborted = new Promise((resolve, reject) => {
      abortListener = () => reject(this.reason || this.expire(stage));
      this.controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const running = typeof operation === 'function' ? Promise.resolve().then(operation) : Promise.resolve(operation);
      return await Promise.race([running, aborted]);
    } finally {
      this.controller.signal.removeEventListener('abort', abortListener);
    }
  }

  finish() {
    clearTimeout(this.timer);
  }

  budget() {
    return {
      totalTimeoutMs: this.totalTimeoutMs,
      startedAt: this.startedAt.toISOString(),
      deadlineAt: this.deadlineAt.toISOString(),
    };
  }

  elapsedMs() {
    return Math.max(0, Math.round(performance.now() - this.startedAtMonotonic));
  }
}

function isDeadlineExceeded(error, deadline) {
  return error?.code === 'SCAN_DEADLINE_EXCEEDED' || deadline.controller.signal.aborted;
}

async function boundedCleanup(promises, timeoutMs = 1000) {
  let timer;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function assessVisualProgress(candidates, viewportHeight) {
  if (!Array.isArray(candidates) || candidates.length < 2) return null;
  const scrollValues = candidates.map((candidate) => candidate.plannedScrollY);
  const significantSpan = Math.max(...scrollValues) - Math.min(...scrollValues) >= viewportHeight * 0.5;
  if (!significantSpan) return null;
  return new Set(candidates.map((candidate) => candidate.frameSha256)).size === 1
    ? 'no-visual-progress-across-scroll' : null;
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

function validateTotalTimeoutMs(value) {
  const timeout = value === undefined ? DEFAULT_TOTAL_TIMEOUT_MS : value;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TOTAL_TIMEOUT_MS) {
    throw new Error(`totalTimeoutMs must be an integer from 1 to ${MAX_TOTAL_TIMEOUT_MS}`);
  }
  return timeout;
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
  const totalTimeoutMs = validateTotalTimeoutMs(options.totalTimeoutMs);
  const url = validatePublicUrl(options.url, { allowPrivateNetwork: options.allowPrivateNetwork === true });
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
  let browser;
  let probeContext;
  const activeContexts = new Set();
  let cleanupPromise;
  const closeResources = () => {
    if (cleanupPromise) return cleanupPromise;
    const contexts = [...activeContexts];
    cleanupPromise = boundedCleanup([
      ...contexts.map((context) => context.close().catch(() => {})),
      ...(browser ? [browser.close().catch(() => {})] : []),
    ]);
    return cleanupPromise;
  };
  const deadline = new ScanDeadline(totalTimeoutMs, closeResources);
  const manifest = {
    schemaVersion: SCAN_SCHEMA_VERSION,
    scanId,
    budgetPolicyVersion: BUDGET_POLICY_VERSION,
    capturedAt: new Date().toISOString(),
    sourceUrl,
    runtimeBudget: deadline.budget(),
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
  const writeJson = options.atomicJsonWriter || atomicJson;
  let terminalPersisted = false;
  const persist = ({ terminal = false } = {}) => {
    if (terminalPersisted) return;
    writeJson(evidencePath, evidence);
    manifest.scanEvidence = { path: 'scan-evidence.json', sha256: sha256(fs.readFileSync(evidencePath)) };
    writeJson(manifestPath, manifest);
    if (terminal) terminalPersisted = true;
  };
  let initialPersisted = false;
  let currentStage = 'network-policy';
  const setStage = (stage) => {
    currentStage = stage;
    deadline.setStage(stage);
  };
  setStage(currentStage);
  const runScan = async () => {
    await deadline.race(
      assertPublicNetworkTarget(
        url,
        { allowPrivateNetwork: options.allowPrivateNetwork === true },
        options.networkResolver || dns.lookup,
      ),
      'network-policy',
    );
    setStage('playwright-load');
    const { chromium } = (options.playwrightLoader || loadPlaywright)();
    setStage('browser-launch');
    browser = await deadline.race(
      chromium.launch(launchOptions()).then(async (launchedBrowser) => {
        if (deadline.controller.signal.aborted) {
          await boundedCleanup([launchedBrowser.close().catch(() => {})]);
          throw deadline.reason;
        }
        return launchedBrowser;
      }),
      'browser-launch',
    );
    evidence.runtimeProvenance.browser.version = browser.version();
    probeContext = await browser.newContext({ viewport: { width: 380, height: 1200 } });
    activeContexts.add(probeContext);
    const probePage = await probeContext.newPage();
    const resources = new Map();
    const interactionKeys = new Set();
    setStage('viewport-scan');
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      activeContexts.add(context);
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
        deadline.throwIfExpired('viewport-scan');
        if (evidence.runtimeProvenance.webgl.status === 'unknown') {
          evidence.runtimeProvenance.webgl = await probeWebgl(page);
        }
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);
        if (!evidence.page.finalUrl) evidence.page.finalUrl = scrubUrl(page.url());
        if (evidence.page.status === null) evidence.page.status = response?.status() ?? null;
        evidence.page.mainPath.push({ action: 'open', viewport: viewport.name, url: scrubUrl(page.url()) });
        readiness = await probeReadiness(page, options.timing || {});
        deadline.throwIfExpired('viewport-scan');
        if (response && response.status() >= 400) {
          readiness = {
            ...readiness,
            status: 'blocked',
            reasons: [...new Set([...(readiness.reasons || []), `http-status-${response.status()}`])],
          };
        }
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
          deadline.throwIfExpired('viewport-scan');
          const scrollY = await page.evaluate(() => window.scrollY);
          const geometry = await page.evaluate(() => ({ documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight }));
          const maximum = Math.max(0, geometry.documentHeight - geometry.viewportHeight);
          const id = `${viewport.name}-${String(ordinal).padStart(3, '0')}`;
          const framePath = `.staging/frames/${id}.png`;
          const probePath = `probes/${id}.jpg`;
          await page.screenshot({ path: path.join(outputDirectory, framePath), type: 'png', fullPage: false });
          deadline.throwIfExpired('viewport-scan');
          const frameSha256 = sha256(fs.readFileSync(path.join(outputDirectory, framePath)));
          await renderProbeFromFrame(probePage, path.join(outputDirectory, framePath), path.join(outputDirectory, probePath));
          deadline.throwIfExpired('viewport-scan');
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
        const viewportCandidates = manifest.candidates.filter((item) => item.viewport === viewport.name);
        const progressReason = assessVisualProgress(viewportCandidates, viewport.height);
        if (progressReason) {
          readiness = { ...readiness, status: 'partial', reasons: [...new Set([...(readiness.reasons || []), progressReason])] };
          for (const candidate of viewportCandidates) candidate.readinessStatus = 'partial';
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
        if (isDeadlineExceeded(error, deadline)) throw deadline.reason || deadline.expire('viewport-scan');
        const reason = scrubText(error.message || String(error));
        for (const candidate of manifest.candidates.filter((item) => item.viewport === viewport.name)) candidate.readinessStatus = 'blocked';
        manifest.viewports[viewport.name] = { ...viewport, status: 'blocked', reasons: [reason] };
        evidence.page.viewports[viewport.name] = { profile: viewport, captureStatus: { status: 'blocked', reasons: [reason] } };
      } finally {
        await boundedCleanup([context.close().catch(() => {})]);
        activeContexts.delete(context);
      }
    }
    evidence.page.publicResources = [...resources.values()];
    manifest.scanStatus = aggregateScanStatus(manifest.viewports);
    setStage('contact-sheet');
    for (const viewportName of Object.keys(manifest.viewports)) {
      const candidates = manifest.candidates.filter((candidate) => candidate.viewport === viewportName);
      if (!candidates.length) {
        manifest.contactSheets[viewportName] = { status: 'blocked', reasons: ['no candidates'] };
        continue;
      }
      try {
        const sheet = await deadline.race(
          (options.contactSheetRenderer || renderContactSheet)(browser, outputDirectory, viewportName, candidates),
          'contact-sheet',
        );
        const sheetPath = path.join(outputDirectory, sheet);
        manifest.contactSheets[viewportName] = {
          status: 'complete', path: sheet, sha256: sha256(fs.readFileSync(sheetPath)),
          candidateIds: candidates.map((candidate) => candidate.id),
        };
      } catch (error) {
        if (isDeadlineExceeded(error, deadline)) throw deadline.reason || deadline.expire('contact-sheet');
        manifest.contactSheets[viewportName] = { status: 'blocked', reasons: [scrubText(error.message || String(error))] };
      }
    }
    manifest.scanStatus = aggregateScanStatus(manifest.viewports, manifest.contactSheets);
    deadline.throwIfExpired('finalize-scan');
    assertScanManifestShape(manifest);
    manifest.runtimeBudget.elapsedMs = deadline.elapsedMs();
    persist({ terminal: true });
    return { outputDirectory, manifest, evidence };
  };
  try {
    persist();
    initialPersisted = true;
    return await deadline.race(runScan(), currentStage);
  } catch (error) {
    const deadlineFailure = isDeadlineExceeded(error, deadline);
    const failure = deadlineFailure ? (deadline.reason || deadline.expire(currentStage)) : error;
    const failureStage = deadlineFailure ? deadline.activeStage : currentStage;
    manifest.scanStatus = { status: 'blocked', stage: failureStage, reasons: [scrubText(failure.message || String(failure))] };
    manifest.artifactValid = false;
    manifest.operationalFailure = {
      stage: failureStage,
      reasons: manifest.scanStatus.reasons,
      ...(deadlineFailure ? { code: 'SCAN_DEADLINE_EXCEEDED' } : {}),
    };
    manifest.runtimeBudget.elapsedMs = deadline.elapsedMs();
    let failurePersistError;
    try {
      persist({ terminal: true });
    } catch (persistError) {
      failurePersistError = persistError;
      failure.persistError = persistError;
    }
    if (initialPersisted && !failurePersistError) {
      failure.siteStyleResult = { outputDirectory, manifest, evidence };
    }
    throw failure;
  } finally {
    deadline.finish();
    await closeResources();
  }
}

module.exports = {
  DEFAULT_TOTAL_TIMEOUT_MS,
  MAX_TOTAL_TIMEOUT_MS,
  assessVisualProgress,
  collectScan,
  renderContactSheet,
  renderProbeFromFrame,
  validateTotalTimeoutMs,
  validateViewports,
  visibleTextFingerprint,
};
