const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchOptions, loadPlaywright } = require('./capture-site.cjs');

async function defaultProbeWritableDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-style-doctor-'));
  try {
    const probe = path.join(directory, 'write-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return directory;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function defaultRuntimeOptions() {
  const playwright = loadPlaywright();
  const pkg = require('playwright/package.json');
  const selectedLaunchOptions = launchOptions();
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    playwrightVersion: pkg.version,
    chromiumExecutablePath: () => playwright.chromium.executablePath(),
    pathExists: fs.existsSync,
    probeWritableDirectory: defaultProbeWritableDirectory,
    launchChromium: () => playwright.chromium.launch(selectedLaunchOptions),
  };
}

async function runDoctor(options = {}) {
  let defaults;
  try {
    defaults = { ...defaultRuntimeOptions(), ...options };
  } catch (error) {
    return {
      status: 'blocked',
      checks: [{ name: 'playwright-package', status: 'fail' }],
      errors: [error.message || String(error)],
      runtime: {
        node: options.nodeVersion || process.versions.node,
        platform: options.platform || process.platform,
        arch: options.arch || process.arch,
        headless: true,
      },
    };
  }

  const checks = [];
  const errors = [];
  const runtime = {
    node: defaults.nodeVersion,
    playwright: defaults.playwrightVersion,
    browser: 'unknown',
    platform: defaults.platform,
    arch: defaults.arch,
    headless: true,
  };

  const major = Number.parseInt(String(defaults.nodeVersion).split('.')[0], 10);
  if (!Number.isFinite(major) || major < 20) {
    checks.push({ name: 'node-version', status: 'fail', value: defaults.nodeVersion });
    errors.push(`Node.js 20 or newer is required; current version is ${defaults.nodeVersion}.`);
    return { status: 'blocked', checks, errors, runtime };
  }
  checks.push({ name: 'node-version', status: 'pass', value: defaults.nodeVersion });
  checks.push({ name: 'playwright-package', status: 'pass', value: defaults.playwrightVersion });

  const executable = defaults.chromiumExecutablePath();
  if (!executable || !defaults.pathExists(executable)) {
    checks.push({ name: 'chromium-executable', status: 'fail', value: executable || 'missing' });
    errors.push('Chromium executable is missing. Run `npx playwright install chromium`.');
    return { status: 'blocked', checks, errors, runtime };
  }
  checks.push({ name: 'chromium-executable', status: 'pass', value: executable });

  try {
    const directory = await defaults.probeWritableDirectory();
    checks.push({ name: 'writable-output', status: 'pass', value: directory });
  } catch (error) {
    checks.push({ name: 'writable-output', status: 'fail' });
    errors.push(`Output directory is not writable: ${error.message || error}`);
    return { status: 'blocked', checks, errors, runtime };
  }

  let browser;
  try {
    browser = await defaults.launchChromium();
    runtime.browser = browser.version();
    checks.push({ name: 'chromium-launch', status: 'pass', value: runtime.browser });
  } catch (error) {
    checks.push({ name: 'chromium-launch', status: 'fail' });
    errors.push(`Chromium failed to launch: ${error.message || error}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { status: errors.length ? 'blocked' : 'complete', checks, errors, runtime };
}

module.exports = { defaultProbeWritableDirectory, runDoctor };
