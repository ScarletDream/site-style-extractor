#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SCHEMA_VERSION, assertCaptureReportShape } = require('./package-schema.cjs');
const { assertScanManifestShape, assertSelectionShape } = require('./scan-schema.cjs');
const { validateCapturePackage } = require('./validate-package.cjs');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function realpathInside(root, relativePath) {
  const realRoot = fs.realpathSync.native(root);
  const target = fs.realpathSync.native(path.resolve(root, relativePath));
  const relative = path.relative(realRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Selected frame escapes scan directory: ${relativePath}`);
  }
  return target;
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function finalizeScan(runDirectoryValue, selectionPathValue, outputDirectoryValue) {
  const runDirectory = fs.realpathSync.native(path.resolve(runDirectoryValue));
  const selectionPath = path.resolve(selectionPathValue);
  const outputDirectory = path.resolve(outputDirectoryValue);
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length > 0) {
    throw new Error(`Finalize output directory must not exist or must be empty: ${outputDirectory}`);
  }
  const manifestPath = path.join(runDirectory, 'scan-manifest.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = readJson(manifestPath);
  const selectionBytes = fs.readFileSync(selectionPath);
  const selection = JSON.parse(selectionBytes.toString('utf8'));
  assertScanManifestShape(manifest);
  assertSelectionShape(selection, manifest, sha256(manifestBytes));

  const evidencePath = realpathInside(runDirectory, manifest.scanEvidence?.path || '');
  const evidenceBytes = fs.readFileSync(evidencePath);
  if (sha256(evidenceBytes) !== manifest.scanEvidence?.sha256) {
    throw new Error('Scan evidence hash does not match manifest');
  }
  const scanEvidence = JSON.parse(evidenceBytes.toString('utf8'));
  if (scanEvidence.scanId !== manifest.scanId) throw new Error('Scan evidence ID does not match manifest');

  for (const [viewportName, sheet] of Object.entries(manifest.contactSheets)) {
    if (sheet.status !== 'complete') continue;
    const sheetPath = realpathInside(runDirectory, sheet.path);
    if (sha256(fs.readFileSync(sheetPath)) !== sheet.sha256
      || selection.contactSheetSha256ByViewport[viewportName] !== sheet.sha256) {
      throw new Error(`Contact sheet hash does not match for ${viewportName}`);
    }
  }

  const byId = new Map(manifest.candidates.map((candidate) => [candidate.id, candidate]));
  const selectedFrames = [];
  for (const id of selection.selectedCandidateIds) {
    const candidate = byId.get(id);
    const source = realpathInside(runDirectory, candidate.framePath);
    const bytes = fs.readFileSync(source);
    if (sha256(bytes) !== candidate.frameSha256) throw new Error(`Candidate ${id} frame hash does not match manifest`);
    selectedFrames.push({ id, candidate, source, bytes });
  }
  let interactionResult = null;
  let selectedInteractionFrames = [];
  if (selection.interactionCandidateId) {
    const interactionResultPath = realpathInside(runDirectory, 'interaction-result.json');
    const interactionResultBytes = fs.readFileSync(interactionResultPath);
    interactionResult = JSON.parse(interactionResultBytes.toString('utf8'));
    if (interactionResult.scanId !== manifest.scanId
      || interactionResult.scanManifestSha256 !== selection.scanManifestSha256
      || interactionResult.selectionSha256 !== sha256(selectionBytes)
      || interactionResult.interactionCandidateId !== selection.interactionCandidateId
      || !['complete', 'partial', 'blocked'].includes(interactionResult.status)) {
      throw new Error('Interaction result provenance does not match selection');
    }
    interactionResult.resultSha256 = sha256(interactionResultBytes);
    if (interactionResult.status === 'complete') {
      if (!interactionResult.reversible || !interactionResult.changed || !interactionResult.before || !interactionResult.after
        || interactionResult.before.sha256 === interactionResult.after.sha256) {
        throw new Error('Complete interaction result must be changed, reversible, and contain distinct before/after frames');
      }
      selectedInteractionFrames = ['before', 'after'].map((state) => {
        const record = interactionResult[state];
        const source = realpathInside(runDirectory, record.path);
        const bytes = fs.readFileSync(source);
        if (sha256(bytes) !== record.sha256) throw new Error(`Interaction ${state} frame hash does not match result`);
        return { state, source, sha256: record.sha256 };
      });
    }
  }

  const temporaryDirectory = `${outputDirectory}.finalizing-${crypto.randomUUID()}`;
  fs.mkdirSync(path.join(temporaryDirectory, 'screenshots'), { recursive: true });
  const screenshotsDirectory = path.join(temporaryDirectory, 'screenshots');
  const screenshots = [];
  const screenshotByHash = new Map();
  const interactionScreenshotRefs = {};
  for (const { id, candidate, source } of selectedFrames) {
    const filename = `${id}.png`;
    fs.copyFileSync(source, path.join(screenshotsDirectory, filename));
    const screenshot = {
      path: `screenshots/${filename}`,
      viewport: candidate.viewport,
      state: candidate.scrollY === 0 ? 'opening' : 'selected-section',
      kind: candidate.readinessStatus === 'complete' && manifest.viewports[candidate.viewport].status === 'complete'
        ? 'evidence' : 'diagnostic',
      scrollY: candidate.scrollY,
      sha256: candidate.frameSha256,
      candidateId: candidate.id,
      scrollRatio: candidate.scrollRatio,
      visibleTextHash: candidate.visibleTextHash,
    };
    screenshots.push(screenshot);
    screenshotByHash.set(screenshot.sha256, screenshot);
  }
  if (interactionResult?.status === 'complete') {
    const interaction = manifest.interactionCandidates.find((candidate) => candidate.id === selection.interactionCandidateId);
    for (const frame of selectedInteractionFrames) {
      const existing = screenshotByHash.get(frame.sha256);
      if (existing) {
        interactionScreenshotRefs[frame.state] = existing.path;
        continue;
      }
      const filename = `${interaction.id}-${frame.state}.png`;
      fs.copyFileSync(frame.source, path.join(screenshotsDirectory, filename));
      const screenshot = {
        path: `screenshots/${filename}`,
        viewport: interaction.viewport,
        state: `representative-interaction-${frame.state}`,
        kind: manifest.viewports[interaction.viewport].status === 'complete' ? 'evidence' : 'diagnostic',
        scrollY: byId.get(interaction.nearCandidateId).scrollY,
        sha256: frame.sha256,
        interactionCandidateId: interaction.id,
      };
      screenshots.push(screenshot);
      screenshotByHash.set(screenshot.sha256, screenshot);
      interactionScreenshotRefs[frame.state] = screenshot.path;
    }
  }
  if (screenshots.length > 6) throw new Error('Finalized screenshot budget exceeds six');

  const viewports = {};
  for (const [name, viewport] of Object.entries(manifest.viewports)) {
    const scanned = scanEvidence.page?.viewports?.[name] || {};
    viewports[name] = {
      ...(scanned.rendered || {}),
      profile: scanned.profile || { name, width: viewport.width, height: viewport.height },
      captureStatus: {
        status: viewport.status,
        reasons: viewport.reasons || [],
        source: 'staged-scan-finalization',
      },
      scanTraversal: scanned.traversal || null,
    };
  }
  const statuses = Object.values(viewports).map((viewport) => viewport.captureStatus.status);
  let aggregateStatus = statuses.every((status) => status === 'complete') ? 'complete'
    : statuses.every((status) => status === 'blocked') ? 'blocked' : 'partial';
  if (aggregateStatus === 'complete' && interactionResult && interactionResult.status !== 'complete') {
    aggregateStatus = 'partial';
  }
  const report = {
    schemaVersion: SCHEMA_VERSION,
    outputDirectory,
    requestedUrl: manifest.sourceUrl,
    capturedAt: scanEvidence.capturedAt || manifest.capturedAt,
    finalizedAt: new Date().toISOString(),
    captureStatus: { status: aggregateStatus, stage: 'finalized-scan', reasons: statuses.filter((status) => status !== 'complete') },
    runtimeDiagnostics: scanEvidence.runtimeDiagnostics || {},
    runtimeProvenance: scanEvidence.runtimeProvenance,
    scope: 'Public client-delivered and rendered evidence selected from an immutable staged scan.',
    pages: [{
      requestedUrl: manifest.sourceUrl,
      finalUrl: scanEvidence.page?.finalUrl || manifest.sourceUrl,
      status: scanEvidence.page?.status ?? null,
      publicResources: scanEvidence.page?.publicResources || [],
      resourceInventoryTruncated: scanEvidence.page?.resourceInventoryTruncated === true,
      viewports,
      mainPath: scanEvidence.page?.mainPath || [],
      selectionTrace: selection.selectedCandidateIds.map((id) => {
        const candidate = byId.get(id);
        return { action: 'promote-scan-candidate', viewport: candidate.viewport, candidateId: id, scrollY: candidate.scrollY };
      }),
      representativeStates: [
        ...screenshots.map((shot) => ({ viewport: shot.viewport, state: shot.state, screenshot: shot.path, status: shot.kind === 'evidence' ? 'complete' : 'partial' })),
        ...(interactionResult?.status === 'complete' && screenshotByHash.get(interactionResult.before.sha256)?.state !== 'representative-interaction-before'
          ? [{ viewport: manifest.interactionCandidates.find((candidate) => candidate.id === selection.interactionCandidateId).viewport,
            state: 'representative-interaction-before', screenshot: interactionScreenshotRefs.before, status: 'complete' }]
          : []),
      ],
      representativeInteraction: interactionResult ? {
        interactionCandidateId: selection.interactionCandidateId,
        status: interactionResult.status,
        kind: interactionResult.kind || null,
        reversible: interactionResult.reversible === true,
        beforeScreenshot: interactionScreenshotRefs.before || null,
        afterScreenshot: interactionScreenshotRefs.after || null,
        reasons: interactionResult.reasons || [],
        resultSha256: interactionResult.resultSha256,
      } : null,
      skippedBranches: [],
      outliers: [],
      screenshots,
      scanProvenance: {
        scanId: manifest.scanId,
        scanManifestSha256: selection.scanManifestSha256,
        scanEvidenceSha256: manifest.scanEvidence.sha256,
        selectionSha256: sha256(selectionBytes),
        selectedCandidateIds: [...selection.selectedCandidateIds],
        contactSheetSha256ByViewport: { ...selection.contactSheetSha256ByViewport },
        interactionResultSha256: interactionResult?.resultSha256 || null,
        budgetPolicyVersion: selection.budgetPolicyVersion,
        selectionRationale: selection.rationale || [],
      },
    }],
    limits: [
      'Selected screenshots are exact bytes from the staged scan; unselected candidates are not delivery evidence.',
      'No server source, private design files, authenticated states, or inaccessible cross-origin code.',
      'Interaction branches are outside this staged static-selection pass.',
    ],
  };
  try {
    assertCaptureReportShape(report);
    atomicJson(path.join(temporaryDirectory, 'evidence.json'), report);
    const validation = validateCapturePackage(temporaryDirectory);
    if (!validation.ok) throw new Error(`Finalized capture validation failed: ${JSON.stringify(validation.errors)}`);
    if (fs.existsSync(outputDirectory)) fs.rmdirSync(outputDirectory);
    fs.renameSync(temporaryDirectory, outputDirectory);
    return report;
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { finalizeScan, realpathInside };
