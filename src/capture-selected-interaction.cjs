#!/usr/bin/env node

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');

const {
  assertPublicNetworkTarget, captureRepresentativeInteraction, launchOptions, loadPlaywright,
  probeReadiness, representativeInteractionFingerprint, representativeInteractionMetadata,
  settlePage, validatePublicUrl,
} = require('./capture-site.cjs');
const { visibleTextFingerprint } = require('./scan-site.cjs');
const { assertScanManifestShape, assertSelectionShape } = require('./scan-schema.cjs');
const { createRequestPolicy, scrubText, scrubUrl } = require('./url-policy.cjs');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

async function captureSelectedInteraction(options) {
  const runDirectory = fs.realpathSync.native(path.resolve(options.runDirectory));
  const selectionPath = path.resolve(options.selectionPath);
  const manifestPath = path.join(runDirectory, 'scan-manifest.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const selectionBytes = fs.readFileSync(selectionPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const selection = JSON.parse(selectionBytes.toString('utf8'));
  assertScanManifestShape(manifest);
  assertSelectionShape(selection, manifest, sha256(manifestBytes));
  if (!selection.interactionCandidateId) throw new Error('selection.json does not choose an interactionCandidateId');
  const resultPath = path.join(runDirectory, 'interaction-result.json');
  fs.rmSync(resultPath, { force: true });
  const url = validatePublicUrl(options.url, { allowPrivateNetwork: options.allowPrivateNetwork === true });
  if (scrubUrl(url).urlFingerprint !== manifest.sourceUrl.urlFingerprint) throw new Error('Interaction URL fingerprint does not match scan');
  const interaction = manifest.interactionCandidates.find((candidate) => candidate.id === selection.interactionCandidateId);
  const near = manifest.candidates.find((candidate) => candidate.id === interaction.nearCandidateId);
  const viewport = manifest.viewports[interaction.viewport];
  const result = {
    schemaVersion: '1.0.0', scanId: manifest.scanId,
    scanManifestSha256: selection.scanManifestSha256,
    selectionSha256: sha256(selectionBytes),
    interactionCandidateId: interaction.id,
    requestedUrl: scrubUrl(url), attemptId: crypto.randomUUID(),
    status: 'blocked', stage: 'pending', reasons: [],
  };
  atomicJson(resultPath, result);
  let browser;
  let context;
  try {
    result.stage = 'network-preflight';
    await assertPublicNetworkTarget(url, { allowPrivateNetwork: options.allowPrivateNetwork === true }, options.networkResolver || dns.lookup);
    const scanEvidenceBytes = fs.readFileSync(path.join(runDirectory, manifest.scanEvidence.path));
    if (sha256(scanEvidenceBytes) !== manifest.scanEvidence.sha256) throw new Error('Scan evidence hash does not match manifest');
    const scanEvidence = JSON.parse(scanEvidenceBytes.toString('utf8'));
    const { chromium } = (options.playwrightLoader || loadPlaywright)();
    result.stage = 'browser-launch';
    browser = await chromium.launch(launchOptions());
    context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const requestPolicy = createRequestPolicy({ allowPrivateNetwork: options.allowPrivateNetwork === true, resolver: options.networkResolver || dns.lookup });
    let initialNavigation = true;
    const safetyViolations = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (!['GET', 'HEAD'].includes(request.method())) {
        safetyViolations.push(`blocked ${request.method()} request during interaction`);
        return route.abort('blockedbyclient');
      }
      if (!initialNavigation && request.isNavigationRequest()) {
        safetyViolations.push('blocked navigation during interaction');
        return route.abort('blockedbyclient');
      }
      const decision = await requestPolicy.check(request.url());
      return decision.allowed ? route.continue() : route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('popup', async (popup) => {
      safetyViolations.push('blocked popup during interaction');
      await popup.close().catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      if (!initialNavigation && frame === page.mainFrame()) safetyViolations.push('main frame navigated during interaction');
    });
    result.stage = 'navigation';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs || 45000 });
    initialNavigation = false;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    if (safetyViolations.length) {
      result.status = 'blocked';
      result.stage = 'navigation';
      result.reasons = [...new Set(safetyViolations)];
      atomicJson(resultPath, result);
      return result;
    }
    if (scrubUrl(page.url()).urlFingerprint !== scanEvidence.page?.finalUrl?.urlFingerprint) {
      throw new Error('Interaction replay final URL differs from scanned final URL');
    }
    const readiness = await probeReadiness(page, options.timing || {});
    if (readiness.status !== 'complete') {
      result.status = readiness.status;
      result.stage = 'readiness';
      result.reasons = readiness.reasons || [];
      atomicJson(resultPath, result);
      return result;
    }
    await page.evaluate((y) => window.scrollTo(0, y), near.scrollY);
    await settlePage(page, options.timing || {});
    const currentGeometry = await page.evaluate(() => ({ documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight }));
    if (Math.abs(currentGeometry.documentHeight - near.documentHeight) / Math.max(1, near.documentHeight) > 0.35) {
      throw new Error('Interaction replay document geometry drifted from scan');
    }
    if (await visibleTextFingerprint(page) !== near.visibleTextHash) {
      result.status = 'blocked';
      result.stage = 'context-match';
      result.reasons = ['selected interaction visible text context drifted from scan'];
      atomicJson(resultPath, result);
      return result;
    }
    const replayTargets = page.locator('[role="tab"][aria-selected="false"], button[aria-expanded][aria-controls]');
    const replayTargetCount = await replayTargets.count();
    const maximumReplayTargets = 200;
    if (replayTargetCount > maximumReplayTargets) {
      result.status = 'blocked';
      result.stage = 'target-match';
      result.reasons = [`interaction surface has more than ${maximumReplayTargets} candidate targets`];
      atomicJson(resultPath, result);
      return result;
    }
    let matchedTarget = null;
    let matchCount = 0;
    for (let index = 0; index < replayTargetCount; index += 1) {
      const candidate = replayTargets.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const metadata = await representativeInteractionMetadata(candidate);
      if (representativeInteractionFingerprint(metadata) !== interaction.targetFingerprint) continue;
      matchCount += 1;
      if (matchCount === 1) matchedTarget = candidate;
      if (matchCount > 1) break;
    }
    if (matchCount !== 1) {
      result.status = 'blocked';
      result.stage = 'target-match';
      result.reasons = [`selected interaction target has ${matchCount} visible fingerprint matches`];
      atomicJson(resultPath, result);
      return result;
    }
    const targetNonce = crypto.randomUUID();
    await matchedTarget.evaluate((element, nonce) => element.setAttribute('data-site-style-replay-target', nonce), targetNonce);
    const interactionDirectory = path.join(runDirectory, '.staging', 'interactions');
    fs.mkdirSync(interactionDirectory, { recursive: true });
    result.stage = 'interaction';
    const observed = await captureRepresentativeInteraction(page, interactionDirectory, interaction.id, {
      ...(options.timing || {}), targetFingerprint: interaction.targetFingerprint, targetNonce,
    });
    if (!observed) {
      result.reasons = ['selected interaction target was not uniquely reachable'];
    } else {
      const beforeName = `${interaction.id}-interaction-before.png`;
      const afterName = `${interaction.id}-interaction-after.png`;
      const beforePath = path.join(interactionDirectory, beforeName);
      const afterPath = path.join(interactionDirectory, afterName);
      result.kind = observed.kind;
      result.reversible = observed.reversible;
      result.changed = observed.changed;
      result.beforeState = observed.beforeState;
      result.afterState = observed.afterState;
      result.restoredState = observed.restoredState;
      result.before = { path: `.staging/interactions/${beforeName}`, sha256: sha256(fs.readFileSync(beforePath)) };
      result.after = { path: `.staging/interactions/${afterName}`, sha256: sha256(fs.readFileSync(afterPath)) };
      if (safetyViolations.length) {
        result.status = 'blocked';
        result.reasons = [...new Set(safetyViolations)];
      } else if (!observed.changed) {
        result.status = 'partial';
        result.reasons = ['interaction produced no observable structural state change'];
      } else {
        result.status = observed.reversible ? 'complete' : 'partial';
        result.reasons = observed.reversible ? [] : ['interaction state could not be structurally restored'];
      }
    }
    result.stage = 'complete';
    atomicJson(resultPath, result);
    return result;
  } catch (error) {
    result.status = 'blocked';
    result.reasons = [scrubText(error.message || String(error))];
    atomicJson(resultPath, result);
    return result;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { captureSelectedInteraction };
