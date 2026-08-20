#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stylejuicer-release-'));
const packDirectory = path.join(temporaryRoot, 'pack');
const installDirectory = path.join(temporaryRoot, 'consumer');
const scanDirectory = path.join(temporaryRoot, 'scan');
const outputDirectory = path.join(temporaryRoot, 'output');
let succeeded = false;
let server;

function npmInvocation(args) {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs || 15 * 60 * 1000,
  });
  if (result.error) {
    const suffix = result.error.code === 'ETIMEDOUT'
      ? ` exceeded ${options.timeoutMs || 15 * 60 * 1000} ms`
      : ` could not start: ${result.error.message}`;
    throw new Error(`${command} ${args.join(' ')}${suffix}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}\n${detail}`);
  }
  return result.stdout.trim();
}

function runNpm(args, options = {}) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, options);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function chooseCandidates(manifest) {
  const chosen = [];
  for (const viewport of Object.keys(manifest.viewports)) {
    const candidates = manifest.candidates
      .filter((candidate) => candidate.viewport === viewport
        && candidate.readinessStatus === 'complete')
      .sort((left, right) => left.ordinal - right.ordinal);
    assert.ok(candidates.length >= 2, `${viewport} needs opening and lower-page candidates`);
    const opening = candidates[0];
    const lower = [...candidates].reverse()
      .find((candidate) => candidate.frameSha256 !== opening.frameSha256);
    assert.ok(lower, `${viewport} lower-page frame must differ from opening`);
    chosen.push(opening, lower);
  }
  assert.ok(chosen.length >= 2 && chosen.length <= 6, 'selection must fit the evidence budget');
  return chosen;
}

function observedSelector(report) {
  for (const page of report.pages || []) {
    for (const [viewportName, viewport] of Object.entries(page.viewports || {})) {
      for (const element of viewport.elements || []) {
        if (element.id) return { id: `#${element.id}`, viewport: viewportName };
        if (element.classes?.length) return { id: `.${element.classes[0]}`, viewport: viewportName };
        if (element.role) return { id: `[role="${element.role}"]`, viewport: viewportName };
        if (/^[a-z][a-z0-9-]*$/i.test(element.tag || '')) {
          return { id: element.tag.toLowerCase(), viewport: viewportName };
        }
      }
    }
  }
  throw new Error('synthetic capture did not retain an observed selector');
}

async function main() {
  fs.mkdirSync(packDirectory, { recursive: true });
  fs.mkdirSync(installDirectory, { recursive: true });
  fs.writeFileSync(path.join(installDirectory, 'package.json'), JSON.stringify({
    name: 'stylejuicer-release-consumer', private: true, version: '0.0.0',
  }, null, 2));

  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', packDirectory]));
  assert.equal(packed.length, 1, 'npm pack must produce one tarball');
  const tarball = path.join(packDirectory, packed[0].filename);
  assert.ok(fs.existsSync(tarball), 'npm tarball was not created');

  runNpm([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', tarball,
  ], { cwd: installDirectory });

  const installedRoot = path.join(installDirectory, 'node_modules', 'stylejuicer');
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json')));
  const installedRequire = createRequire(path.join(installedRoot, 'package.json'));
  assert.equal(installedPackage.version, '0.1.0-beta.2');
  assert.equal(installedPackage.publishConfig.registry, 'https://registry.npmjs.org/');

  runNpm(['exec', '--', 'stylejuicer', '--help'], { cwd: installDirectory });
  const playwrightRoot = path.dirname(installedRequire.resolve('playwright/package.json'));
  run(process.execPath, [path.join(playwrightRoot, 'cli.js'), 'install', 'chromium'], {
    cwd: installDirectory,
  });
  const doctor = JSON.parse(runNpm([
    'exec', '--', 'stylejuicer', 'doctor', '--json',
  ], { cwd: installDirectory }));
  assert.equal(doctor.status, 'complete', JSON.stringify(doctor));
  assert.deepEqual(doctor.errors, [], JSON.stringify(doctor));

  const fixture = fs.readFileSync(path.join(installedRoot, 'examples', 'synthetic-site', 'index.html'));
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { collectScan } = require(path.join(installedRoot, 'src', 'scan-site.cjs'));
  const scan = await collectScan({
    url: `http://127.0.0.1:${server.address().port}/`,
    outputDirectory: scanDirectory,
    allowPrivateNetwork: true,
    viewports: [
      { name: 'desktop', width: 960, height: 600 },
      { name: 'narrow', width: 390, height: 844 },
    ],
    timing: { readinessTimeoutMs: 1600, traversalTimeoutMs: 12000, maxTraversalPositions: 8 },
  });
  assert.equal(scan.manifest.scanStatus.status, 'complete');

  const manifestPath = path.join(scanDirectory, 'scan-manifest.json');
  const selected = chooseCandidates(scan.manifest);
  const selection = {
    schemaVersion: scan.manifest.schemaVersion,
    scanId: scan.manifest.scanId,
    scanManifestSha256: sha256(fs.readFileSync(manifestPath)),
    sourceUrlFingerprint: scan.manifest.sourceUrl.urlFingerprint,
    budgetPolicyVersion: scan.manifest.budgetPolicyVersion,
    selectedCandidateIds: selected.map((candidate) => candidate.id),
    contactSheetSha256ByViewport: Object.fromEntries(
      Object.entries(scan.manifest.contactSheets)
        .map(([viewport, sheet]) => [viewport, sheet.sha256]),
    ),
  };
  const selectionPath = path.join(scanDirectory, 'selection.json');
  fs.writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);

  runNpm([
    'exec', '--', 'stylejuicer', 'finalize', '--run', scanDirectory,
    '--selection', selectionPath, '--out', outputDirectory, '--json',
  ], { cwd: installDirectory });
  const captureValidation = JSON.parse(runNpm([
    'exec', '--', 'stylejuicer', 'validate', 'capture', outputDirectory, '--json',
  ], { cwd: installDirectory }));
  assert.equal(captureValidation.ok, true, JSON.stringify(captureValidation));

  const evidence = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'evidence.json')));
  const screenshot = evidence.pages.flatMap((page) => page.screenshots || [])
    .find((item) => item.kind === 'evidence');
  assert.ok(screenshot, 'final package needs one evidence screenshot');
  const selector = observedSelector(evidence);
  const decisions = [
    ['Alternating field', 'Use contrasting page fields to separate chapters.', 'Use one continuous canvas.', 'Section clarity over visual continuity.', 'O'],
    ['Compact cards', 'Use bordered compact cards inside the main field.', 'Use floating shadow cards.', 'Crisp grouping over depth.', 'R'],
    ['Strong action', 'Reserve the strongest accent for the primary action.', 'Distribute the accent across utilities.', 'Focus over decoration.', 'I'],
  ].map(([visibleTrigger, choice, plausibleUnchosenAlternative, tradeOff, confidence]) => ({
    visibleTrigger, choice, plausibleUnchosenAlternative, tradeOff, confidence,
    evidenceRefs: [{ kind: 'screenshot', id: screenshot.path }],
  }));
  const YAML = installedRequire('yaml');
  fs.writeFileSync(path.join(outputDirectory, 'style-profile.yaml'), YAML.stringify({
    schemaVersion: evidence.schemaVersion,
    source: { status: evidence.captureStatus.status },
    sourceSpecificDecisions: decisions,
  }));
  fs.writeFileSync(path.join(outputDirectory, 'public-code-map.json'), `${JSON.stringify({
    mechanisms: [{
      visibleEffect: 'bounded synthetic surface', selector: selector.id,
      keyDeclarationOrResource: 'observed rendered selector in the packaged fixture',
      evidenceRefs: [
        { kind: 'screenshot', id: screenshot.path },
        { kind: 'selector', id: selector.id, viewport: selector.viewport },
      ],
      confidence: 'O',
    }],
    frameworkHints: [], limits: ['Synthetic release rehearsal only.'],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDirectory, 'analysis.md'), '# Packaged synthetic release rehearsal\n');

  runNpm([
    'exec', '--', 'stylejuicer', 'render', '--profile',
    path.join(outputDirectory, 'style-profile.yaml'), '--analysis',
    path.join(outputDirectory, 'analysis.md'), '--json',
  ], { cwd: installDirectory });
  const deliveryValidation = JSON.parse(runNpm([
    'exec', '--', 'stylejuicer', 'validate', 'delivery', outputDirectory, '--json',
  ], { cwd: installDirectory }));
  assert.equal(deliveryValidation.ok, true, JSON.stringify(deliveryValidation));

  succeeded = true;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: `${installedPackage.name}@${installedPackage.version}`,
    tarballSha256: sha256(fs.readFileSync(tarball)),
    browser: doctor.runtime.browser,
    selectedScreenshots: selected.length,
    capture: captureValidation.stage,
    delivery: deliveryValidation.stage,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.stderr.write(`Release rehearsal retained at ${temporaryRoot}\n`);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (succeeded && process.env.STYLEJUICER_KEEP_RELEASE_SMOKE !== '1') {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  } else if (succeeded) {
    process.stderr.write(`Release rehearsal retained at ${temporaryRoot}\n`);
  }
});
