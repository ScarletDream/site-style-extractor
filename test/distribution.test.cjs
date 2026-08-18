const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Codex Plugin manifest exposes exactly one Skill directory', () => {
  const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.equal(manifest.name, 'site-style-extractor');
  assert.match(manifest.version, /^0\.1\.0-beta\.1$/);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.author.name, 'Dorim');
  assert.equal(manifest.interface.displayName, 'Site Style Extractor');
  assert.equal(manifest.interface.category, 'Developer Tools');
  assert.equal('mcpServers' in manifest, false);
  assert.equal('apps' in manifest, false);
});

test('Skill delegates deterministic work to the unified CLI', () => {
  const skillRoot = path.join(root, 'skills', 'site-style-extractor');
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  assert.match(skill, /site-style doctor/);
  for (const command of ['scan', 'interact', 'finalize', 'render', 'validate']) {
    assert.match(skill, new RegExp(`site-style ${command}`));
  }
  assert.equal(fs.existsSync(path.join(skillRoot, 'scripts')), false);
  assert.doesNotMatch(skill, /codex-primary-runtime|node-v24\.19\.0-win-x64/i);
});

test('public documentation states safety and rendering limits', () => {
  const readme = read('README.md');
  const readmeEnglish = read('README_EN.md');
  const security = read('SECURITY.md');
  assert.match(readme, /partial.*blocked/is);
  assert.match(readme, /WebGL.*Canvas.*视频.*字体/is);
  assert.match(readme, /不承诺像素级复刻/is);
  assert.match(readmeEnglish, /partial.*blocked/is);
  assert.match(readmeEnglish, /WebGL.*Canvas.*video.*font/is);
  assert.match(readmeEnglish, /does not.*pixel/is);
  assert.match(security, /SSRF/i);
  assert.match(security, /GET.*side effect/is);
  assert.match(security, /cookies|browser profile/i);
  assert.match(security, /signed URL/i);
});

test('examples contain no captured third-party screenshots', () => {
  const examples = path.join(root, 'examples');
  if (!fs.existsSync(examples)) return;
  const queue = [examples];
  const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
  while (queue.length) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else assert.equal(imageExtensions.has(path.extname(entry.name).toLowerCase()), false, full);
    }
  }
});

test('public package includes a synthetic responsive fixture and CI', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.ok(packageJson.files.includes('examples/'));
  assert.ok(packageJson.scripts['test:fixture']);
  const fixture = read('examples/synthetic-site/index.html');
  assert.match(fixture, /data-style-system="light"/);
  assert.match(fixture, /role="tablist"/);
  assert.match(fixture, /aria-expanded="false"/);
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'ci.yml')));
});

test('Docker distribution is pinned and non-root', () => {
  const dockerfile = read('Dockerfile');
  const workflow = read('.github/workflows/ci.yml');
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/playwright:v1\.62\.1-noble$/m);
  assert.match(dockerfile, /^USER pwuser$/m);
  assert.doesNotMatch(dockerfile, /:latest\b/);
  assert.ok(fs.existsSync(path.join(root, '.dockerignore')));
  assert.match(workflow, /docker build/);
  assert.match(workflow, /docker run.*doctor --json/);
});

test('runtime selection cannot swap Playwright behind pinned provenance', () => {
  assert.doesNotMatch(read('src/capture-site.cjs'), /SITE_STYLE_PLAYWRIGHT_PATH/);
  assert.match(read('src/doctor.cjs'), /loadPlaywright/);
  assert.match(read('src/doctor.cjs'), /launchOptions/);
});

test('only the unified bin is an executable CLI surface', () => {
  for (const entry of fs.readdirSync(path.join(root, 'src'))) {
    if (entry.endsWith('.cjs')) assert.doesNotMatch(read(`src/${entry}`), /require\.main\s*===\s*module/, entry);
  }
});
