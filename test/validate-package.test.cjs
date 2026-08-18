const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scrubUrl } = require('../src/url-policy.cjs');
const {
  renderDecisionBlock,
  replaceGeneratedDecisionBlock,
} = require('../src/render-analysis-decisions.cjs');
const {
  validateCapturePackage,
  validateDeliveryPackage,
} = require('../src/validate-package.cjs');

const runtimeProvenance = {
  node: '24.19.0', playwright: '1.62.1',
  browser: { name: 'chromium', version: '151.0.7922.34' },
  platform: 'win32', arch: 'x64', headless: true, deviceScaleFactor: 1,
  webgl: { status: 'unknown', vendor: 'unknown', renderer: 'unknown' },
};

function makePackage(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-package-'));
  fs.mkdirSync(path.join(directory, 'screenshots'));
  const screenshotBytes = Buffer.from('not-a-real-png-but-hashable');
  fs.writeFileSync(path.join(directory, 'screenshots', 'desktop.png'), screenshotBytes);
  const screenshot = {
    path: 'screenshots/desktop.png',
    viewport: 'desktop',
    state: 'opening',
    kind: options.screenshotKind || 'evidence',
    sha256: crypto.createHash('sha256').update(screenshotBytes).digest('hex'),
  };
  const report = {
    schemaVersion: options.schemaVersion || '2.0.0',
    requestedUrl: scrubUrl('https://example.com/?ref=test'),
    captureStatus: { status: options.captureStatus || 'complete', stage: 'complete', reasons: [] },
    runtimeDiagnostics: {},
    runtimeProvenance,
    pages: [{
      finalUrl: scrubUrl('https://example.com/'),
      publicResources: [{ resourceId: 'res-style', displayUrl: 'https://example.com/app.css' }],
      viewports: { desktop: {
        captureStatus: { status: options.viewportStatus || 'complete' },
        elements: [{ tag: 'article', id: '', classes: ['card'], role: '' }],
      } },
      screenshots: [screenshot],
    }],
  };
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(report, null, 2));
  const profile = `schemaVersion: "2.0.0"
source:
  requestedUrl: "https://example.com/"
sourceSpecificDecisions:
  - visibleTrigger: "Opening composition"
    choice: "Use one quiet centered column."
    plausibleUnchosenAlternative: "Use a split hero."
    tradeOff: "Clarity over density."
    evidenceRefs: [{kind: screenshot, id: "screenshots/desktop.png"}]
    confidence: O
  - visibleTrigger: "Primary action"
    choice: "Use one restrained action."
    plausibleUnchosenAlternative: "Use two equal actions."
    tradeOff: "Focus over optionality."
    evidenceRefs: [{kind: screenshot, id: "screenshots/desktop.png"}]
    confidence: R
  - visibleTrigger: "Surface edge"
    choice: "Use a fine border."
    plausibleUnchosenAlternative: "Use a shadow."
    tradeOff: "Precision over depth."
    evidenceRefs: [{kind: screenshot, id: "screenshots/desktop.png"}]
    confidence: I
`;
  fs.writeFileSync(path.join(directory, 'style-profile.yaml'), profile);
  fs.writeFileSync(path.join(directory, 'public-code-map.json'), JSON.stringify({
    mechanisms: [{
      visibleEffect: 'fine surface edge', selector: '.card',
      keyDeclarationOrResource: 'border: 1px solid',
      evidenceRefs: [
        { kind: 'screenshot', id: 'screenshots/desktop.png' },
        { kind: 'resource', id: 'res-style' },
        { kind: 'selector', id: '.card', viewport: 'desktop' },
      ],
      confidence: 'O',
    }],
    frameworkHints: [], limits: [],
  }, null, 2));
  const parsedProfile = require('yaml').parse(profile);
  const narrative = '# Example style extraction\n\nHuman-authored scope and interpretation.\n';
  fs.writeFileSync(
    path.join(directory, 'analysis.md'),
    replaceGeneratedDecisionBlock(narrative, renderDecisionBlock(parsedProfile)),
  );
  return { directory, report };
}

test('validates a complete capture package', () => {
  const fixture = makePackage();
  try {
    assert.equal(validateCapturePackage(fixture.directory).ok, true);
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('capture validation rejects a wrong screenshot hash and unsupported schema', () => {
  const fixture = makePackage();
  try {
    fs.writeFileSync(path.join(fixture.directory, 'screenshots', 'desktop.png'), 'changed');
    let result = validateCapturePackage(fixture.directory);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'screenshot-hash-mismatch'));
    fixture.report.schemaVersion = '1.0.0';
    fs.writeFileSync(path.join(fixture.directory, 'evidence.json'), JSON.stringify(fixture.report));
    result = validateCapturePackage(fixture.directory);
    assert.ok(result.errors.some((error) => error.code === 'capture-schema-invalid'));
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('delivery validation rejects diagnostic screenshots cited as style evidence', () => {
  const fixture = makePackage({ captureStatus: 'partial', viewportStatus: 'partial', screenshotKind: 'diagnostic' });
  try {
    const result = validateDeliveryPackage(fixture.directory);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'diagnostic-cited-as-evidence'));
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('delivery validation rejects a mechanism resource reference missing from capture', () => {
  const fixture = makePackage();
  try {
    const mapPath = path.join(fixture.directory, 'public-code-map.json');
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    map.mechanisms[0].evidenceRefs[1].id = 'res-missing';
    fs.writeFileSync(mapPath, JSON.stringify(map));
    const result = validateDeliveryPackage(fixture.directory);
    assert.ok(result.errors.some((error) => error.code === 'unknown-resource-reference'));
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('delivery validation requires structured decision and mechanism evidence references', () => {
  const fixture = makePackage();
  try {
    const profilePath = path.join(fixture.directory, 'style-profile.yaml');
    const profile = require('yaml').parse(fs.readFileSync(profilePath, 'utf8'));
    delete profile.sourceSpecificDecisions[0].evidenceRefs;
    fs.writeFileSync(profilePath, require('yaml').stringify(profile));
    let result = validateDeliveryPackage(fixture.directory);
    assert.ok(result.errors.some((error) => error.code === 'decision-evidence-refs-invalid'));

    const clean = makePackage();
    try {
      const mapPath = path.join(clean.directory, 'public-code-map.json');
      fs.writeFileSync(mapPath, JSON.stringify({ mechanisms: [{}], frameworkHints: [], limits: [] }));
      result = validateDeliveryPackage(clean.directory);
      assert.ok(result.errors.some((error) => error.code === 'mechanism-shape-invalid'));
    } finally { fs.rmSync(clean.directory, { recursive: true, force: true }); }
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});

test('delivery validation rejects malformed YAML and a stale generated Markdown block', () => {
  const malformed = makePackage();
  const stale = makePackage();
  try {
    fs.writeFileSync(path.join(malformed.directory, 'style-profile.yaml'), 'sourceSpecificDecisions: [');
    assert.ok(validateDeliveryPackage(malformed.directory).errors.some((error) => error.code === 'yaml-invalid'));
    fs.appendFileSync(path.join(stale.directory, 'analysis.md'), '\n<!-- stale -->\n');
    const markdown = fs.readFileSync(path.join(stale.directory, 'analysis.md'), 'utf8')
      .replace('Use one quiet centered column.', 'Use a loud scattered grid.');
    fs.writeFileSync(path.join(stale.directory, 'analysis.md'), markdown);
    assert.ok(validateDeliveryPackage(stale.directory).errors.some((error) => error.code === 'generated-block-stale'));
  } finally {
    fs.rmSync(malformed.directory, { recursive: true, force: true });
    fs.rmSync(stale.directory, { recursive: true, force: true });
  }
});

test('validates a complete five-artifact delivery package', () => {
  const fixture = makePackage();
  try {
    const result = validateDeliveryPackage(fixture.directory);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.stage, 'delivery');
  } finally { fs.rmSync(fixture.directory, { recursive: true, force: true }); }
});
