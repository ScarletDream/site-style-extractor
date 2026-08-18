const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { assertCaptureReportShape } = require('./package-schema.cjs');
const {
  BEGIN_MARKER,
  END_MARKER,
  renderDecisionBlock,
} = require('./render-analysis-decisions.cjs');

function diagnostic(code, message, file) {
  return { code, message, ...(file ? { file } : {}) };
}

function readJson(file, errors, code) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(diagnostic(code, error.message, path.basename(file)));
    return null;
  }
}

function safeArtifactPath(directory, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(directory);
  const resolved = path.resolve(root, relativePath);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function captureIndex(report) {
  const screenshots = new Map();
  const resources = new Set();
  for (const page of report.pages || []) {
    for (const screenshot of page.screenshots || []) screenshots.set(screenshot.path, screenshot);
    for (const resource of page.publicResources || []) {
      if (resource.resourceId) resources.add(resource.resourceId);
    }
  }
  return { screenshots, resources };
}

function validateCapturePackage(directory) {
  const errors = [];
  const warnings = [];
  const evidenceFile = path.join(directory, 'evidence.json');
  if (!fs.existsSync(evidenceFile)) {
    errors.push(diagnostic('missing-artifact', 'evidence.json is required', 'evidence.json'));
    return { ok: false, stage: 'capture', errors, warnings };
  }
  const report = readJson(evidenceFile, errors, 'evidence-json-invalid');
  if (!report) return { ok: false, stage: 'capture', errors, warnings };
  try {
    assertCaptureReportShape(report);
  } catch (error) {
    errors.push(diagnostic('capture-schema-invalid', error.message, 'evidence.json'));
  }
  const { screenshots } = captureIndex(report);
  for (const [relativePath, record] of screenshots) {
    const file = safeArtifactPath(directory, relativePath);
    if (!file || !fs.existsSync(file)) {
      errors.push(diagnostic('screenshot-missing', `Screenshot does not exist: ${relativePath}`, relativePath));
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(record.sha256 || '') || sha256(file) !== record.sha256) {
      errors.push(diagnostic('screenshot-hash-mismatch', `Screenshot hash differs: ${relativePath}`, relativePath));
    }
  }
  return { ok: errors.length === 0, stage: 'capture', errors, warnings, report };
}

function collectScreenshotReferences(value, output = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/screenshots\/[A-Za-z0-9._/-]+/g)) {
      output.add(match[0].replace(/[),.;:`]+$/g, ''));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectScreenshotReferences(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectScreenshotReferences(item, output);
  }
  return output;
}

function validateDecisions(profile, errors) {
  const decisions = profile?.sourceSpecificDecisions;
  const required = [
    'visibleTrigger', 'choice', 'plausibleUnchosenAlternative', 'tradeOff', 'confidence',
  ];
  if (!Array.isArray(decisions) || decisions.length < 3 || decisions.length > 5) {
    errors.push(diagnostic('decision-count-invalid', 'sourceSpecificDecisions must contain 3 to 5 decisions', 'style-profile.yaml'));
    return;
  }
  decisions.forEach((decision, index) => {
    for (const field of required) {
      if (typeof decision?.[field] !== 'string' || !decision[field].trim()) {
        errors.push(diagnostic('decision-field-missing', `Decision ${index + 1} is missing ${field}`, 'style-profile.yaml'));
      }
    }
    if (decision?.confidence && !['O', 'R', 'I', 'U'].includes(decision.confidence)) {
      errors.push(diagnostic('confidence-invalid', `Decision ${index + 1} has invalid confidence`, 'style-profile.yaml'));
    }
    if (!Array.isArray(decision?.evidenceRefs) || decision.evidenceRefs.length === 0) {
      errors.push(diagnostic('decision-evidence-refs-invalid', `Decision ${index + 1} requires structured evidenceRefs`, 'style-profile.yaml'));
    }
  });
}

function selectorObserved(report, reference) {
  const viewports = (report.pages || []).flatMap((page) => Object.entries(page.viewports || {}));
  const selected = reference.viewport
    ? viewports.filter(([name]) => name === reference.viewport)
    : viewports;
  return selected.some(([, viewport]) => (viewport.elements || []).some((element) => {
    if (reference.id.startsWith('#')) return element.id === reference.id.slice(1);
    if (reference.id.startsWith('.')) return (element.classes || []).includes(reference.id.slice(1));
    const role = reference.id.match(/^\[role=["']?([^"'\]]+)["']?\]$/);
    if (role) return element.role === role[1];
    return /^[a-z][a-z0-9-]*$/i.test(reference.id) && element.tag === reference.id.toLowerCase();
  }));
}

function validateEvidenceRefs(refs, context, indexes, errors) {
  if (!Array.isArray(refs) || refs.length === 0) return;
  refs.forEach((reference, index) => {
    if (!reference || typeof reference !== 'object' || typeof reference.kind !== 'string'
      || typeof reference.id !== 'string' || !reference.id) {
      errors.push(diagnostic('evidence-reference-invalid', `${context} evidenceRefs[${index}] is invalid`));
      return;
    }
    if (reference.kind === 'screenshot') {
      const screenshot = indexes.screenshots.get(reference.id);
      if (!screenshot) errors.push(diagnostic('unknown-screenshot-reference', `${context} references unknown screenshot ${reference.id}`));
      else if (screenshot.kind !== 'evidence') {
        errors.push(diagnostic('diagnostic-cited-as-evidence', `${context} cites diagnostic screenshot ${reference.id}`));
      }
    } else if (reference.kind === 'resource') {
      if (!indexes.resources.has(reference.id)) {
        errors.push(diagnostic('unknown-resource-reference', `${context} references unknown resourceId ${reference.id}`));
      }
    } else if (reference.kind === 'selector') {
      if (!selectorObserved(indexes.report, reference)) {
        errors.push(diagnostic('unknown-selector-reference', `${context} references an unobserved selector ${reference.id}`));
      }
    } else {
      errors.push(diagnostic('evidence-reference-kind-invalid', `${context} has unsupported evidence kind ${reference.kind}`));
    }
  });
}

function validateDeliveryPackage(directory) {
  const capture = validateCapturePackage(directory);
  const errors = [...capture.errors];
  const warnings = [...capture.warnings];
  const required = ['public-code-map.json', 'style-profile.yaml', 'analysis.md'];
  for (const name of required) {
    if (!fs.existsSync(path.join(directory, name))) errors.push(diagnostic('missing-artifact', `${name} is required`, name));
  }
  if (!capture.report || required.some((name) => !fs.existsSync(path.join(directory, name)))) {
    return { ok: false, stage: 'delivery', errors, warnings };
  }

  const publicCodeMap = readJson(
    path.join(directory, 'public-code-map.json'), errors, 'public-code-map-json-invalid',
  );
  let profile = null;
  try {
    profile = YAML.parse(fs.readFileSync(path.join(directory, 'style-profile.yaml'), 'utf8'));
  } catch (error) {
    errors.push(diagnostic('yaml-invalid', error.message, 'style-profile.yaml'));
  }
  if (!profile || !publicCodeMap) return { ok: false, stage: 'delivery', errors, warnings };
  if (profile.schemaVersion !== capture.report.schemaVersion) {
    errors.push(diagnostic('profile-schema-mismatch', 'style-profile schemaVersion must match evidence.json', 'style-profile.yaml'));
  }
  validateDecisions(profile, errors);

  const captured = captureIndex(capture.report);
  const indexes = { ...captured, report: capture.report };
  for (const [index, decision] of (profile.sourceSpecificDecisions || []).entries()) {
    validateEvidenceRefs(decision.evidenceRefs, `Decision ${index + 1}`, indexes, errors);
  }
  if (!Array.isArray(publicCodeMap.mechanisms)) {
    errors.push(diagnostic('public-code-map-shape-invalid', 'mechanisms must be an array', 'public-code-map.json'));
  } else {
    publicCodeMap.mechanisms.forEach((mechanism, index) => {
      const requiredStrings = ['visibleEffect', 'keyDeclarationOrResource', 'confidence'];
      const stringsValid = requiredStrings.every((field) => typeof mechanism?.[field] === 'string' && mechanism[field].trim());
      const targetValid = typeof mechanism?.selector === 'string' && mechanism.selector.trim()
        || typeof mechanism?.target === 'string' && mechanism.target.trim();
      if (!stringsValid || !targetValid || !['O', 'R', 'I', 'U'].includes(mechanism?.confidence)
        || !Array.isArray(mechanism?.evidenceRefs) || mechanism.evidenceRefs.length === 0) {
        errors.push(diagnostic('mechanism-shape-invalid', `Mechanism ${index + 1} is incomplete`, 'public-code-map.json'));
        return;
      }
      validateEvidenceRefs(mechanism.evidenceRefs, `Mechanism ${index + 1}`, indexes, errors);
      if (mechanism.selector && !mechanism.evidenceRefs.some(
        (reference) => reference.kind === 'selector' && reference.id === mechanism.selector,
      )) {
        errors.push(diagnostic('mechanism-selector-unreferenced', `Mechanism ${index + 1} selector lacks a matching evidenceRef`, 'public-code-map.json'));
      }
    });
  }
  if ('resources' in publicCodeMap) {
    warnings.push(diagnostic('deprecated-resource-duplication', 'public-code-map.json resources duplicates evidence.json; reference resourceId instead', 'public-code-map.json'));
  }

  const markdown = fs.readFileSync(path.join(directory, 'analysis.md'), 'utf8');
  const starts = markdown.split(BEGIN_MARKER).length - 1;
  const ends = markdown.split(END_MARKER).length - 1;
  const start = markdown.indexOf(BEGIN_MARKER);
  const end = markdown.indexOf(END_MARKER);
  const expected = renderDecisionBlock(profile);
  const actual = start >= 0 && end >= start
    ? markdown.slice(start, end + END_MARKER.length)
    : '';
  if (starts !== 1 || ends !== 1 || actual !== expected) {
    errors.push(diagnostic('generated-block-stale', 'analysis.md decision block is missing or differs from style-profile.yaml', 'analysis.md'));
  }
  const narrative = start >= 0 && end >= start
    ? `${markdown.slice(0, start)}${markdown.slice(end + END_MARKER.length)}`
    : markdown;
  for (const reference of collectScreenshotReferences(narrative)) {
    const screenshot = captured.screenshots.get(reference);
    if (!screenshot || screenshot.kind !== 'evidence') {
      warnings.push(diagnostic('unverified-narrative-reference', `Narrative reference is not structured evidence: ${reference}`, 'analysis.md'));
    }
  }
  return { ok: errors.length === 0, stage: 'delivery', errors, warnings };
}

module.exports = { validateCapturePackage, validateDeliveryPackage };
