function normalizedReasons(record) {
  return Array.isArray(record?.reasons) && record.reasons.length
    ? record.reasons.map(String)
    : [`${record?.status || 'blocked'} without a recorded reason`];
}

function aggregateScanStatus(viewports, contactSheets = {}) {
  const viewportEntries = Object.entries(viewports || {});
  if (!viewportEntries.length) return { status: 'blocked', reasons: ['no viewport results'] };
  const statuses = viewportEntries.map(([, viewport]) => viewport?.status || 'blocked');
  let status = statuses.length && statuses.every((value) => value === 'complete') ? 'complete'
    : statuses.length && statuses.every((value) => value === 'blocked') ? 'blocked'
      : 'partial';

  const reasons = [];
  for (const [name, viewport] of viewportEntries) {
    if (viewport?.status === 'complete') continue;
    for (const reason of normalizedReasons(viewport)) reasons.push(`${name}: ${reason}`);
  }
  for (const [name, sheet] of Object.entries(contactSheets || {})) {
    if (sheet?.status !== 'blocked') continue;
    for (const reason of normalizedReasons(sheet)) reasons.push(`contact-sheet ${name}: ${reason}`);
    if (status === 'complete') status = 'partial';
  }
  return { status, reasons: [...new Set(reasons)] };
}

module.exports = { aggregateScanStatus };
