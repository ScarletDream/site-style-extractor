const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('repository is a public single-engine package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.dependencies.playwright, '1.62.1');
  assert.equal(pkg.dependencies.yaml, '2.9.0');
  assert.equal(pkg.bin.stylejuicer, 'bin/stylejuicer.cjs');
  assert.equal(pkg.bin['site-style'], 'bin/stylejuicer.cjs');

  assert.equal(fs.existsSync(path.join(root, 'src', 'capture-site.cjs')), true);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'stylejuicer', 'scripts')), false);
  assert.equal(pkg.files.includes('node_modules/'), false);

  const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2026 ScarletDream/);
});

test('distribution metadata excludes generated and private evidence', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const entry of ['node_modules/', 'output/', 'results/', '.staging/']) {
    assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }

  const files = fs.readdirSync(root);
  assert.equal(files.includes('screenshots'), false);
});

test('public repository surfaces use the StyleJuicer identity', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const issueConfig = fs.readFileSync(path.join(root, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'utf8');
  const pullRequestTemplate = fs.readFileSync(path.join(root, '.github', 'pull_request_template.md'), 'utf8');
  const skill = fs.readFileSync(path.join(root, 'skills', 'stylejuicer', 'SKILL.md'), 'utf8');
  const outputContract = fs.readFileSync(path.join(root, 'skills', 'stylejuicer', 'references', 'output-contract.md'), 'utf8');

  assert.match(workflow, /docker build -t stylejuicer:ci/);
  assert.match(issueConfig, /github\.com\/ScarletDream\/stylejuicer\/security\/advisories\/new/);
  assert.match(pullRequestTemplate, /`stylejuicer doctor --json`/);
  assert.match(skill, /unified `stylejuicer` CLI/);
  assert.match(outputContract, /^stylejuicer-output\//m);
});
