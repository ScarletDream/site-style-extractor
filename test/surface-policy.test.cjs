const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const skillRoot = path.resolve(__dirname, '..', 'skills', 'site-style-extractor');

function read(relativePath) {
  return fs.readFileSync(path.join(skillRoot, relativePath), 'utf8');
}

test('defaults to one representative surface path and judges branches', () => {
  const skill = read('SKILL.md');

  assert.match(skill, /`surface` is the default mode/i);
  assert.match(skill, /one main path/i);
  assert.match(skill, /sample one representative/i);
  assert.match(skill, /ask the user only when[^.]+materially change/i);
  assert.match(skill, /skipped branches/i);
});

test('keeps screenshot evidence without presenting a gallery by default', () => {
  const contract = read('references/output-contract.md');

  assert.match(contract, /mainPath/);
  assert.match(contract, /representativeStates/);
  assert.match(contract, /skippedBranches/);
  assert.match(contract, /at most three representative previews/i);
  assert.match(contract, /unless the user asks/i);
});

test('requires screenshot-first synthesis and source-specific decisions in both outputs', () => {
  const skill = read('SKILL.md');
  const rubric = read('references/analysis-rubric.md');
  const contract = read('references/output-contract.md');
  const combined = `${skill}\n${rubric}\n${contract}`;

  assert.match(combined, /screenshots? (?:before|first)/i);
  assert.match(combined, /three to five source-specific decisions/i);
  assert.match(combined, /visible trigger/i);
  assert.match(combined, /plausible unchosen alternative/i);
  assert.match(combined, /trade-off/i);
  assert.match(contract, /evidenceRefs:[^]*kind: screenshot[^]*screenshots\/example\.png/i);
  assert.match(contract, /sourceSpecificDecisions/);
  assert.match(contract, /analysis\.md[^]*sourceSpecificDecisions/i);
  assert.match(contract, /style-profile\.yaml[^]*sourceSpecificDecisions/i);
});

test('limits representative clicks and requires visible-effect mechanism mappings', () => {
  const skill = read('SKILL.md');
  const contract = read('references/output-contract.md');
  const combined = `${skill}\n${contract}`;

  assert.match(combined, /at most one representative reversible interaction/i);
  assert.match(combined, /non-navigating tab/i);
  assert.match(combined, /never click[^.]+generic CTA/i);
  assert.match(contract, /visibleEffect/);
  assert.match(contract, /selector/);
  assert.match(contract, /keyDeclarationOrResource/);
  assert.match(contract, /confidence/);
});

test('documents the implemented Capture Synthesize Validate boundary without overstating automation', () => {
  const skill = read('SKILL.md');
  const rubric = read('references/analysis-rubric.md');
  const contract = read('references/output-contract.md');
  const agent = read('agents/openai.yaml');
  const combined = `${skill}\n${rubric}\n${contract}\n${agent}`;

  assert.match(skill, /Capture[^]*Synthesize[^]*Validate/i);
  assert.match(contract, /style-profile\.yaml[^.]+machine source of truth/i);
  assert.match(contract, /BEGIN GENERATED SOURCE-SPECIFIC DECISIONS/);
  assert.match(contract, /site-style render/);
  assert.match(contract, /site-style validate/);
  assert.match(combined, /public mechanism clues/i);
  assert.match(combined, /narrow viewport/i);
  assert.doesNotMatch(combined, /mobile `390×844`/i);
  assert.doesNotMatch(skill, /inspect up to two additional safe, same-origin representative pages/i);
  assert.doesNotMatch(skill, /Inspect delivered CSS\/JavaScript to explain/i);
});

test('documents staged scan selection as the default evidence path', () => {
  const skill = read('SKILL.md');
  const contract = read('references/output-contract.md');
  const agent = read('agents/openai.yaml');
  const combined = `${skill}\n${contract}\n${agent}`;

  assert.match(combined, /contact sheet/i);
  assert.match(combined, /candidate ID/i);
  assert.match(combined, /site-style finalize/i);
  assert.match(combined, /exact[^.]+staged[^.]+bytes/i);
  assert.match(combined, /two to six|2–6/i);
  assert.match(combined, /internal[^.]+not[^.]+user/i);
});
