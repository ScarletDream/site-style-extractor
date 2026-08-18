function bounded(value, fallback = 'unknown', maximum = 500) {
  const text = typeof value === 'string' && value ? value : fallback;
  return text.slice(0, maximum);
}

function createRuntimeProvenance(options = {}) {
  return {
    node: bounded(options.nodeVersion || process.versions.node, 'unknown', 100),
    playwright: bounded(options.playwrightVersion, 'unknown', 100),
    browser: {
      name: bounded(options.browserName || 'chromium', 'chromium', 100),
      version: bounded(options.browserVersion, 'unknown', 100),
    },
    platform: bounded(options.platform || process.platform, 'unknown', 100),
    arch: bounded(options.arch || process.arch, 'unknown', 100),
    headless: options.headless !== false,
    deviceScaleFactor: Number.isFinite(options.deviceScaleFactor) ? options.deviceScaleFactor : 1,
    webgl: options.webgl || { status: 'unknown', vendor: 'unknown', renderer: 'unknown' },
  };
}

async function probeWebgl(page) {
  try {
    const result = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!context) return null;
      const extension = context.getExtension('WEBGL_debug_renderer_info');
      if (!extension) return { vendor: 'unknown', renderer: 'unknown' };
      return {
        vendor: String(context.getParameter(extension.UNMASKED_VENDOR_WEBGL) || 'unknown'),
        renderer: String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL) || 'unknown'),
      };
    });
    if (!result) return { status: 'unknown', vendor: 'unknown', renderer: 'unknown' };
    return {
      status: 'observed',
      vendor: bounded(result.vendor),
      renderer: bounded(result.renderer),
    };
  } catch {
    return { status: 'unknown', vendor: 'unknown', renderer: 'unknown' };
  }
}

module.exports = { bounded, createRuntimeProvenance, probeWebgl };
