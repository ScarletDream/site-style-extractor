const SCHEMA_VERSION = '2.0.0';
const CAPTURE_STATUSES = Object.freeze(['complete', 'partial', 'blocked']);
const SCREENSHOT_KINDS = Object.freeze(['evidence', 'diagnostic']);

function fail(message) {
  throw new Error(`Invalid capture report: ${message}`);
}

function assertStatus(value, field) {
  if (!value || !CAPTURE_STATUSES.includes(value.status)) {
    fail(`${field}.status must be one of ${CAPTURE_STATUSES.join(', ')}`);
  }
}

function assertRuntimeProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('runtimeProvenance must be an object');
  }
  for (const field of ['node', 'playwright', 'platform', 'arch']) {
    if (typeof value[field] !== 'string' || value[field].length === 0 || value[field].length > 100) {
      fail(`runtimeProvenance.${field} must be a bounded non-empty string`);
    }
  }
  if (!value.browser || typeof value.browser.name !== 'string'
    || typeof value.browser.version !== 'string'
    || value.browser.name.length > 100 || value.browser.version.length > 100) {
    fail('runtimeProvenance.browser must contain bounded name and version strings');
  }
  if (typeof value.headless !== 'boolean') fail('runtimeProvenance.headless must be boolean');
  if (!Number.isFinite(value.deviceScaleFactor) || value.deviceScaleFactor <= 0 || value.deviceScaleFactor > 10) {
    fail('runtimeProvenance.deviceScaleFactor must be between 0 and 10');
  }
  if (!value.webgl || !['observed', 'unknown'].includes(value.webgl.status)) {
    fail('runtimeProvenance.webgl.status must be observed or unknown');
  }
  for (const field of ['vendor', 'renderer']) {
    if (typeof value.webgl[field] !== 'string' || value.webgl[field].length > 500) {
      fail(`runtimeProvenance.webgl.${field} must be a bounded string`);
    }
  }
}

function assertCaptureReportShape(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('expected an object');
  if (report.schemaVersion !== SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${report.schemaVersion || '<missing>'}; expected ${SCHEMA_VERSION}`);
  }
  assertStatus(report.captureStatus, 'captureStatus');
  if (!report.requestedUrl || typeof report.requestedUrl.displayUrl !== 'string'
    || !Array.isArray(report.requestedUrl.queryKeys)
    || !/^sha256:[a-f0-9]{64}$/.test(report.requestedUrl.urlFingerprint || '')) {
    fail('requestedUrl must be a scrubbed URL identity');
  }
  let persistedUrl;
  try {
    persistedUrl = new URL(report.requestedUrl.displayUrl);
  } catch {
    fail('requestedUrl.displayUrl must be a valid URL');
  }
  if (persistedUrl.username || persistedUrl.password || persistedUrl.hash
    || [...persistedUrl.searchParams.values()].some((value) => value !== '<redacted>')) {
    fail('requestedUrl.displayUrl contains unsanitized URL material');
  }
  if (!Array.isArray(report.pages)) fail('pages must be an array');
  if (!report.runtimeDiagnostics || typeof report.runtimeDiagnostics !== 'object'
    || Array.isArray(report.runtimeDiagnostics)) {
    fail('runtimeDiagnostics must be an object');
  }
  assertRuntimeProvenance(report.runtimeProvenance);

  const viewportStatuses = [];
  const selectedInteractionStatuses = [];
  const screenshotPaths = new Set();
  const resourceIds = new Set();
  let completeEvidenceCount = 0;
  for (const [pageIndex, page] of report.pages.entries()) {
    if (page.representativeInteraction && ['complete', 'partial', 'blocked'].includes(page.representativeInteraction.status)) {
      selectedInteractionStatuses.push(page.representativeInteraction.status);
    }
    const viewports = page.viewports || {};
    for (const [name, viewport] of Object.entries(viewports)) {
      assertStatus(viewport.captureStatus, `pages[${pageIndex}].viewports.${name}.captureStatus`);
      viewportStatuses.push(viewport.captureStatus.status);
    }
    for (const screenshot of page.screenshots || []) {
      if (typeof screenshot.path !== 'string' || !/^screenshots\/[A-Za-z0-9._/-]+$/.test(screenshot.path)
        || screenshot.path.includes('..')) {
        fail(`screenshot path must start with screenshots/ and remain inside it: ${screenshot.path || '<missing>'}`);
      }
      if (screenshotPaths.has(screenshot.path)) fail(`duplicate screenshot path ${screenshot.path}`);
      screenshotPaths.add(screenshot.path);
      if (!SCREENSHOT_KINDS.includes(screenshot.kind)) {
        fail(`screenshot ${screenshot.path || '<unknown>'} has unsupported kind ${screenshot.kind}`);
      }
      const viewportStatus = viewports[screenshot.viewport]?.captureStatus?.status;
      if (viewportStatus && viewportStatus !== 'complete' && screenshot.kind !== 'diagnostic') {
        fail(`${viewportStatus} viewport ${screenshot.viewport} screenshots must be diagnostic`);
      }
      if (viewportStatus === 'complete' && screenshot.kind === 'evidence') completeEvidenceCount += 1;
    }
    for (const resource of page.publicResources || []) {
      if (typeof resource.resourceId !== 'string' || !resource.resourceId) fail('public resource requires resourceId');
      if (resourceIds.has(resource.resourceId)) fail(`duplicate resourceId ${resource.resourceId}`);
      resourceIds.add(resource.resourceId);
    }
  }
  if (viewportStatuses.length > 0) {
    let aggregateStatus = viewportStatuses.every((status) => status === 'complete')
      ? 'complete'
      : viewportStatuses.every((status) => status === 'blocked') ? 'blocked' : 'partial';
    if (aggregateStatus === 'complete' && selectedInteractionStatuses.some((status) => status !== 'complete')) {
      aggregateStatus = 'partial';
    }
    if (report.captureStatus.status !== aggregateStatus) {
      fail(`captureStatus ${report.captureStatus.status} contradicts aggregate viewport status ${aggregateStatus}`);
    }
  }
  if (report.captureStatus.status === 'complete') {
    if (report.pages.length === 0) fail('complete capture requires at least one page');
    if (!viewportStatuses.includes('complete')) fail('complete capture requires a complete viewport');
    if (completeEvidenceCount === 0) fail('complete capture requires at least one evidence screenshot');
  }
  return report;
}

module.exports = {
  CAPTURE_STATUSES,
  SCHEMA_VERSION,
  SCREENSHOT_KINDS,
  assertCaptureReportShape,
  assertRuntimeProvenance,
};
