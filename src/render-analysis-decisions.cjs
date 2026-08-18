const BEGIN_MARKER = '<!-- BEGIN GENERATED SOURCE-SPECIFIC DECISIONS -->';
const END_MARKER = '<!-- END GENERATED SOURCE-SPECIFIC DECISIONS -->';
const FIELDS = [
  'visibleTrigger',
  'choice',
  'plausibleUnchosenAlternative',
  'tradeOff',
  'evidenceRefs',
  'confidence',
];

function markdownCell(value) {
  const rendered = Array.isArray(value)
    ? value.map((reference) => `${reference.kind}:${reference.id}${reference.viewport ? `@${reference.viewport}` : ''}`).join('; ')
    : String(value ?? '');
  if (rendered.includes(BEGIN_MARKER) || rendered.includes(END_MARKER)) {
    throw new Error('decision content cannot contain generated block markers');
  }
  return rendered
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function renderDecisionBlock(profile) {
  const decisions = profile?.sourceSpecificDecisions;
  if (!Array.isArray(decisions)) throw new Error('style-profile.yaml must contain sourceSpecificDecisions');
  const lines = [
    BEGIN_MARKER,
    '### Source-specific decisions',
    '',
    `| ${FIELDS.join(' | ')} |`,
    `|${FIELDS.map(() => '---').join('|')}|`,
    ...decisions.map((decision) => `| ${FIELDS.map((field) => markdownCell(decision[field])).join(' | ')} |`),
    END_MARKER,
  ];
  return lines.join('\n');
}

function replaceGeneratedDecisionBlock(markdown, block) {
  const starts = markdown.split(BEGIN_MARKER).length - 1;
  const ends = markdown.split(END_MARKER).length - 1;
  if (starts > 1 || ends > 1) throw new Error('analysis.md must contain at most one generated decision block');
  const start = markdown.indexOf(BEGIN_MARKER);
  const end = markdown.indexOf(END_MARKER);
  if (start === -1 && end === -1) return `${markdown.trimEnd()}\n\n${block}\n`;
  if (start === -1 || end === -1 || end < start) throw new Error('analysis.md has malformed generated decision markers');
  const suffixStart = end + END_MARKER.length;
  return `${markdown.slice(0, start)}${block}${markdown.slice(suffixStart)}`;
}

module.exports = {
  BEGIN_MARKER,
  END_MARKER,
  renderDecisionBlock,
  replaceGeneratedDecisionBlock,
};
