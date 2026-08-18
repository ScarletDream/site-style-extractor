const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('repository is a public single-engine package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.dependencies.playwright, '1.62.1');
  assert.equal(pkg.dependencies.yaml, '2.8.1');
  assert.equal(pkg.bin['site-style'], 'bin/site-style.cjs');

  assert.equal(fs.existsSync(path.join(root, 'src', 'capture-site.cjs')), true);
  assert.equal(fs.existsSync(path.join(root, 'skills', 'site-style-extractor', 'scripts')), false);
  assert.equal(pkg.files.includes('node_modules/'), false);
});

test('distribution metadata excludes generated and private evidence', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const entry of ['node_modules/', 'output/', 'results/', '.staging/']) {
    assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }

  const files = fs.readdirSync(root);
  assert.equal(files.includes('screenshots'), false);
});
