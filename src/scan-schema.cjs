const SCAN_SCHEMA_VERSION = '1.0.0';
const BUDGET_POLICY_VERSION = '1.0.0';
const HASH = /^[a-f0-9]{64}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const CANDIDATE_ID = /^[a-z0-9][a-z0-9-]*$/;
const { aggregateScanStatus } = require('./status-record.cjs');

function fail(message) {
  throw new Error(`Invalid scan package: ${message}`);
}

function assertScanManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest must be an object');
  if (manifest.schemaVersion !== SCAN_SCHEMA_VERSION) fail(`unsupported schemaVersion ${manifest.schemaVersion || '<missing>'}`);
  if (typeof manifest.scanId !== 'string' || !manifest.scanId) fail('scanId is required');
  if (manifest.budgetPolicyVersion !== BUDGET_POLICY_VERSION) fail('unsupported budget policy');
  if (manifest.runtimeBudget !== undefined) {
    const budget = manifest.runtimeBudget;
    const startedAt = Date.parse(budget?.startedAt || '');
    const deadlineAt = Date.parse(budget?.deadlineAt || '');
    if (!Number.isInteger(budget?.totalTimeoutMs) || budget.totalTimeoutMs < 1 || budget.totalTimeoutMs > 900000
      || !Number.isFinite(startedAt) || !Number.isFinite(deadlineAt)
      || deadlineAt - startedAt !== budget.totalTimeoutMs
      || (budget.elapsedMs !== undefined && (!Number.isInteger(budget.elapsedMs) || budget.elapsedMs < 0))) {
      fail('runtimeBudget is invalid');
    }
  }
  if (!manifest.sourceUrl || !FINGERPRINT.test(manifest.sourceUrl.urlFingerprint || '')) fail('source URL fingerprint is required');
  if (!manifest.scanStatus || !['complete', 'partial', 'blocked'].includes(manifest.scanStatus.status)) fail('scanStatus is invalid');
  if (!manifest.viewports || typeof manifest.viewports !== 'object') fail('viewports are required');
  if (!Array.isArray(manifest.candidates)) fail('candidates must be an array');
  if (!Array.isArray(manifest.interactionCandidates || [])) fail('interactionCandidates must be an array');
  if (!manifest.scanEvidence || manifest.scanEvidence.path !== 'scan-evidence.json'
    || !HASH.test(manifest.scanEvidence.sha256 || '')) fail('scanEvidence identity is invalid');
  if (!manifest.contactSheets || typeof manifest.contactSheets !== 'object') fail('contactSheets are required');
  const ids = new Set();
  for (const candidate of manifest.candidates) {
    if (!CANDIDATE_ID.test(candidate?.id || '')) fail(`candidate ID is invalid: ${candidate?.id || '<missing>'}`);
    if (ids.has(candidate.id)) fail(`duplicate candidate ID ${candidate.id}`);
    ids.add(candidate.id);
    if (!manifest.viewports[candidate.viewport]) fail(`candidate ${candidate.id} has unknown viewport`);
    if (!Number.isInteger(candidate.ordinal) || !Number.isFinite(candidate.scrollY)
      || !Number.isFinite(candidate.plannedScrollY)
      || !Number.isFinite(candidate.scrollRatio) || !Number.isFinite(candidate.documentHeight)
      || !Number.isFinite(candidate.viewportHeight)) fail(`candidate ${candidate.id} geometry is invalid`);
    if (!/^\.staging\/frames\/[A-Za-z0-9._-]+\.png$/.test(candidate.framePath || '')) {
      fail(`candidate ${candidate.id} framePath is invalid`);
    }
    if (!/^probes\/[A-Za-z0-9._-]+\.jpg$/.test(candidate.probePath || '')) {
      fail(`candidate ${candidate.id} probePath is invalid`);
    }
    if (!HASH.test(candidate.frameSha256 || '') || !HASH.test(candidate.probeSha256 || '')
      || candidate.probeSourceFrameSha256 !== candidate.frameSha256) {
      fail(`candidate ${candidate.id} hashes are invalid`);
    }
    if (!['complete', 'partial', 'blocked'].includes(candidate.readinessStatus)) {
      fail(`candidate ${candidate.id} readinessStatus is invalid`);
    }
    if (!['complete', 'unresolved'].includes(candidate.settleStatus)) {
      fail(`candidate ${candidate.id} settleStatus is invalid`);
    }
    if (!FINGERPRINT.test(candidate.visibleTextHash || '')) fail(`candidate ${candidate.id} visibleTextHash is invalid`);
  }
  const statuses = Object.entries(manifest.viewports).map(([name, viewport]) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`viewport name is invalid: ${name}`);
    if (!['complete', 'partial', 'blocked'].includes(viewport?.status)) fail(`viewport ${name} status is invalid`);
    const candidates = manifest.candidates.filter((candidate) => candidate.viewport === name);
    if (viewport.status === 'complete') {
      if (!candidates.length) fail(`complete viewport ${name} requires candidates`);
      if (candidates[0].scrollY !== 0) fail(`complete viewport ${name} requires an opening candidate`);
      if (candidates.length > 1 && !candidates.some((candidate) => candidate.scrollRatio >= 0.95)) {
        fail(`complete viewport ${name} requires a terminal traversal candidate`);
      }
    }
    const allowed = viewport.status === 'complete' ? new Set(['complete', 'partial', 'blocked'])
      : viewport.status === 'partial' ? new Set(['partial', 'blocked']) : new Set(['blocked']);
    if (candidates.some((candidate) => !allowed.has(candidate.readinessStatus))) {
      fail(`candidate status contradicts viewport ${name} status`);
    }
    candidates.forEach((candidate, index) => {
      if (candidate.ordinal !== index) fail(`candidate ordinal is invalid for viewport ${name}`);
      if (index && candidate.plannedScrollY < candidates[index - 1].plannedScrollY) fail(`candidate plannedScrollY is not monotonic for viewport ${name}`);
    });
    const sheet = manifest.contactSheets[name];
    if (!sheet || !['complete', 'blocked'].includes(sheet.status)) fail(`contact sheet status is invalid for ${name}`);
    if (sheet.status === 'complete') {
      if (!new RegExp(`^contact-sheet-${name}\\.png$`).test(sheet.path || '') || !HASH.test(sheet.sha256 || '')) {
        fail(`contact sheet identity is invalid for ${name}`);
      }
      if (!Array.isArray(sheet.candidateIds)
        || sheet.candidateIds.join('\n') !== candidates.map((candidate) => candidate.id).join('\n')) {
        fail(`contact sheet candidates do not match viewport ${name}`);
      }
    }
    return viewport.status;
  });
  const aggregate = aggregateScanStatus(manifest.viewports, manifest.contactSheets);
  if (manifest.scanStatus.status !== aggregate.status) {
    fail(`scanStatus ${manifest.scanStatus.status} contradicts aggregate viewport/contact-sheet status ${aggregate.status}`);
  }
  const interactionIds = new Set();
  for (const interaction of manifest.interactionCandidates || []) {
    if (!/^interaction-[a-z0-9][a-z0-9-]*-\d{3}$/.test(interaction?.id || '') || interactionIds.has(interaction.id)) {
      fail(`interaction candidate ID is invalid or duplicated: ${interaction?.id || '<missing>'}`);
    }
    interactionIds.add(interaction.id);
    const near = manifest.candidates.find((candidate) => candidate.id === interaction.nearCandidateId);
    if (!near || near.viewport !== interaction.viewport || !manifest.viewports[interaction.viewport]) {
      fail(`interaction candidate ${interaction.id} has invalid viewport or nearCandidateId`);
    }
    if (!['tab', 'accordion'].includes(interaction.kindHint)
      || !FINGERPRINT.test(interaction.targetFingerprint || '')) fail(`interaction candidate ${interaction.id} is invalid`);
  }
  return manifest;
}

function assertSelectionShape(selection, manifest, manifestSha256) {
  assertScanManifestShape(manifest);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) fail('selection must be an object');
  if (selection.schemaVersion !== SCAN_SCHEMA_VERSION) fail('selection schemaVersion is invalid');
  if (selection.scanId !== manifest.scanId) fail('selection scanId does not match manifest');
  if (!HASH.test(selection.scanManifestSha256 || '') || selection.scanManifestSha256 !== manifestSha256) {
    fail('selection manifest hash does not match');
  }
  if (selection.sourceUrlFingerprint !== manifest.sourceUrl.urlFingerprint) fail('selection URL fingerprint does not match');
  if (selection.budgetPolicyVersion !== BUDGET_POLICY_VERSION) fail('selection budget policy is unsupported');
  if (!selection.contactSheetSha256ByViewport || typeof selection.contactSheetSha256ByViewport !== 'object') {
    fail('selection contact sheet hashes are required');
  }
  for (const [viewportName, sheet] of Object.entries(manifest.contactSheets)) {
    if (sheet.status === 'complete' && selection.contactSheetSha256ByViewport[viewportName] !== sheet.sha256) {
      fail(`selection contact sheet hash does not match for ${viewportName}`);
    }
  }
  const ids = selection.selectedCandidateIds;
  const interactionCandidateId = selection.interactionCandidateId || null;
  const maximumStatic = interactionCandidateId ? 4 : 6;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > maximumStatic) {
    fail(`selectedCandidateIds must contain 2 to ${maximumStatic} IDs`);
  }
  if (new Set(ids).size !== ids.length) fail('selectedCandidateIds must be unique');
  const candidates = new Map(manifest.candidates.map((candidate) => [candidate.id, candidate]));
  for (const id of ids) {
    if (!CANDIDATE_ID.test(id || '')) fail(`candidate ID is invalid: ${id}`);
    if (!candidates.has(id)) fail(`selection contains unknown candidate ${id}`);
  }
  if (interactionCandidateId
    && !(manifest.interactionCandidates || []).some((candidate) => candidate.id === interactionCandidateId)) {
    fail(`selection contains unknown interaction candidate ${interactionCandidateId}`);
  }
  for (const [viewportName, viewport] of Object.entries(manifest.viewports)) {
    if (viewport.status !== 'complete') continue;
    const available = manifest.candidates.filter(
      (candidate) => candidate.viewport === viewportName && candidate.readinessStatus === 'complete',
    );
    const chosen = ids.map((id) => candidates.get(id)).filter((candidate) => candidate.viewport === viewportName);
    const opening = available.reduce((best, candidate) => !best || candidate.scrollY < best.scrollY ? candidate : best, null);
    if (opening && !chosen.some((candidate) => candidate.id === opening.id)) {
      fail(`selection must include opening candidate for ${viewportName}`);
    }
    if (available.some((candidate) => candidate.scrollY > 0)
      && !chosen.some((candidate) => candidate.scrollY > 0)) {
      fail(`selection must include a lower-page candidate for ${viewportName}`);
    }
    if (chosen.length > 1) {
      const planned = chosen.map((candidate) => candidate.plannedScrollY);
      const significantSpan = Math.max(...planned) - Math.min(...planned) >= (chosen[0].viewportHeight || 1) * 0.5;
      if (significantSpan && new Set(chosen.map((candidate) => candidate.frameSha256)).size === 1) {
        fail(`selection for ${viewportName} reuses the same rendered frame across opening and lower-page evidence`);
      }
    }
  }
  return selection;
}

module.exports = {
  BUDGET_POLICY_VERSION,
  SCAN_SCHEMA_VERSION,
  assertScanManifestShape,
  assertSelectionShape,
};
