#!/usr/bin/env node

const fs = require('node:fs');
const dns = require('node:dns').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { SCHEMA_VERSION } = require('./package-schema.cjs');
const { createRuntimeProvenance, probeWebgl } = require('./runtime-provenance.cjs');
const { aggregateScanStatus } = require('./status-record.cjs');
const {
  createRequestPolicy, resourceId, scrubText, scrubUrl,
} = require('./url-policy.cjs');

function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(
      `StyleJuicer requires Node.js 20 or newer; current version is ${version}. `
      + 'Install or select a supported runtime, then run the command again.',
    );
  }
}

function loadPlaywright(environment = process.env, requirePackage = require) {
  assertSupportedNodeVersion();
  try {
    return requirePackage('playwright');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && !String(error.message).includes('Cannot find module')) throw error;
  }

  throw new Error('Playwright is unavailable. Install this package dependencies with `npm install`.');
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}

async function assertPublicNetworkTarget(value, options = {}, resolver = dns.lookup) {
  const parsed = new URL(validatePublicUrl(value, options));
  if (options.allowPrivateNetwork) return;
  let addresses;
  try {
    addresses = await resolver(parsed.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`Could not resolve target hostname ${parsed.hostname}: ${error.message}`);
  }
  const records = Array.isArray(addresses) ? addresses : [addresses];
  const blocked = records.find((record) => isPrivateHostname(record.address || String(record)));
  if (blocked) {
    throw new Error(
      `Expected a public network target; ${parsed.hostname} resolves to a non-public address (${blocked.address}).`,
    );
  }
}

function validatePublicUrl(value, options = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Expected a public http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Expected a public http(s) URL.');
  }
  if (!options.allowPrivateNetwork && isPrivateHostname(parsed.hostname)) {
    throw new Error('Expected a public network target; loopback, link-local, and private-network URLs are blocked.');
  }
  return parsed.toString();
}

function launchOptions(environment = process.env, platform = process.platform, pathExists = fs.existsSync) {
  const executablePath = environment.SITE_STYLE_BROWSER;
  if (!executablePath) return { headless: true };
  if (!pathExists(executablePath)) {
    throw new Error(`SITE_STYLE_BROWSER does not exist on ${platform}: ${executablePath}`);
  }
  return { headless: true, executablePath };
}

async function takeScreenshot(page, absolutePath, metadata = {}, options = {}) {
  await page.screenshot({ path: absolutePath, ...options });
  const scrollY = await page.evaluate(() => window.scrollY);
  return {
    path: `screenshots/${path.basename(absolutePath)}`,
    viewport: metadata.viewport,
    state: metadata.state,
    kind: metadata.kind || 'evidence',
    scrollY,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
  };
}

const DEFAULT_TIMING = {
  readinessTimeoutMs: 5000,
  readinessPollMs: 200,
  settleTimeoutMs: 1000,
  settlePollMs: 80,
  traversalTimeoutMs: 12000,
  maxTraversalPositions: 16,
};

function timingOptions(overrides = {}) {
  return { ...DEFAULT_TIMING, ...overrides };
}

function pushDiagnostic(collection, value, limit = 50) {
  if (collection.length >= limit) return;
  collection.push(value);
}

function scrubRenderedEvidenceUrls(evidence) {
  evidence.finalUrl = scrubUrl(evidence.finalUrl);
  evidence.inaccessibleStyleSheets = evidence.inaccessibleStyleSheets.map((value) => scrubText(value));
  evidence.media.images = evidence.media.images.map((image) => ({
    ...image,
    src: scrubUrl(image.src),
  }));
  evidence.customProperties = Object.fromEntries(Object.entries(evidence.customProperties).map(
    ([key, value]) => [key, scrubText(value)],
  ));
  evidence.publicMechanismCandidates = (evidence.publicMechanismCandidates || []).map((candidate) => ({
    ...candidate,
    sourceStylesheet: scrubText(candidate.sourceStylesheet),
    declarations: Object.fromEntries(Object.entries(candidate.declarations || {}).map(
      ([key, value]) => [key, scrubText(value)],
    )),
  }));
  return evidence;
}

async function samplePageState(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    };
    const allNodes = document.querySelectorAll('body *');
    const sampleLimit = 2000;
    const sampleStride = Math.max(1, Math.ceil(allNodes.length / sampleLimit));
    const sampledNodes = [];
    for (let index = 0; index < allNodes.length && sampledNodes.length < sampleLimit; index += sampleStride) {
      sampledNodes.push(allNodes[index]);
    }
    const elements = sampledNodes.filter(visible);
    const loaderSelectors = [
      '[aria-busy="true"]', '[role="progressbar"]', '.loading', '.loader',
      '[class*="loading" i]', '[class*="loader" i]', '[id*="loading" i]', '[id*="loader" i]',
    ];
    const intersectsViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const loaderElements = [...document.querySelectorAll(loaderSelectors.join(','))]
      .filter((element) => visible(element) && intersectsViewport(element));
    const statusLoaders = [...document.querySelectorAll('[role="status"]')]
      .filter((element) => visible(element) && intersectsViewport(element)
        && /load|wait|载入|加载|请稍候/i.test(element.textContent || ''));
    const explicitLoaders = [...new Set([...loaderElements, ...statusLoaders])];
    const bodyRect = document.body?.getBoundingClientRect();
    const activeAnimations = document.getAnimations();
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    let sampledArea = 0;
    let lowOpacityArea = 0;
    const visualLeaves = elements.filter((element) => (
      element.children.length === 0 || ['IMG', 'VIDEO', 'CANVAS', 'SVG'].includes(element.tagName)
    ));
    for (const element of visualLeaves.slice(0, 1500)) {
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const area = Math.min(viewportArea, width * height);
      if (!area) continue;
      let effectiveOpacity = 1;
      for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
        effectiveOpacity *= Number(getComputedStyle(current).opacity) || 0;
      }
      sampledArea += area;
      if (effectiveOpacity < 0.65) lowOpacityArea += area;
    }
    const viewportElements = elements.filter(intersectsViewport);
    const viewportText = viewportElements
      .filter((element) => element.children.length === 0)
      .map((element) => (element.textContent || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean).join(' ').slice(0, 20000);
    const substantiveSelector = 'main,section,article,nav,header,footer,form,table,[role="main"]';
    const substantiveBlockCount = [...document.querySelectorAll(substantiveSelector)]
      .filter((element) => visible(element) && intersectsViewport(element)).length;
    const interactiveCount = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="tab"]')]
      .filter((element) => visible(element) && intersectsViewport(element)).length;
    const centeredGraphicCount = [...document.querySelectorAll('svg,canvas,img,video,picture')]
      .filter((element) => visible(element) && intersectsViewport(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const areaRatio = (rect.width * rect.height) / viewportArea;
        return centerX > innerWidth * 0.3 && centerX < innerWidth * 0.7
          && centerY > innerHeight * 0.3 && centerY < innerHeight * 0.7
          && areaRatio > 0.00005 && areaRatio < 0.55;
      }).length;
    let blockingLoaderCount = 0;
    for (const element of explicitLoaders) {
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const areaRatio = (width * height) / viewportArea;
      const style = getComputedStyle(element);
      const positionedOverlay = ['fixed', 'sticky'].includes(style.position)
        && areaRatio >= 0.08;
      let overlayAncestor = element.parentElement;
      let blockingAncestor = false;
      while (overlayAncestor && overlayAncestor !== document.documentElement) {
        const ancestorStyle = getComputedStyle(overlayAncestor);
        if (['fixed', 'sticky'].includes(ancestorStyle.position)) {
          const ancestorRect = overlayAncestor.getBoundingClientRect();
          const ancestorWidth = Math.max(0, Math.min(ancestorRect.right, innerWidth) - Math.max(ancestorRect.left, 0));
          const ancestorHeight = Math.max(0, Math.min(ancestorRect.bottom, innerHeight) - Math.max(ancestorRect.top, 0));
          blockingAncestor = (ancestorWidth * ancestorHeight) / viewportArea >= 0.5;
          break;
        }
        overlayAncestor = overlayAncestor.parentElement;
      }
      const lacksSubstantiveContent = viewportText.length < 80 && substantiveBlockCount <= 1
        && interactiveCount <= 1;
      if (areaRatio >= 0.18 || positionedOverlay || blockingAncestor || lacksSubstantiveContent) blockingLoaderCount += 1;
    }
    const sparseGraphicalShell = viewportText.length < 24
      && substantiveBlockCount <= 1 && interactiveCount === 0 && centeredGraphicCount > 0;
    return {
      readyState: document.readyState,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      bodyWidth: bodyRect?.width || 0,
      bodyHeight: bodyRect?.height || 0,
      visibleCount: elements.length,
      textLength: (document.body?.textContent || '').trim().length,
      mediaCount: document.querySelectorAll('img,svg,canvas,video,picture').length,
      explicitLoaderCount: explicitLoaders.length,
      blockingLoaderCount,
      explicitLoaderText: explicitLoaders.slice(0, 5).map((element) => (element.textContent || '').trim().slice(0, 80)),
      viewportTextLength: viewportText.length,
      substantiveBlockCount,
      interactiveCount,
      centeredGraphicCount,
      sparseGraphicalShell,
      activeAnimationCount: activeAnimations.filter((animation) => animation.playState === 'running').length,
      infiniteAnimationCount: activeAnimations.filter((animation) => {
        const iterations = animation.effect?.getTiming?.().iterations;
        return animation.playState === 'running' && iterations === Infinity;
      }).length,
      lowOpacityRatio: sampledArea ? Math.round((lowOpacityArea / sampledArea) * 1000) / 1000 : 0,
      scrollY: window.scrollY,
    };
  });
}

function stateSignature(state) {
  return [
    state.documentWidth, state.documentHeight, state.bodyWidth, state.bodyHeight,
    state.visibleCount, state.lowOpacityRatio,
  ].join(':');
}

async function probeReadiness(page, overrides = {}) {
  const timing = timingOptions(overrides);
  const deadline = Date.now() + timing.readinessTimeoutMs;
  let attempts = 0;
  let previousSignature = '';
  let stableSamples = 0;
  let latest = await samplePageState(page);

  do {
    attempts += 1;
    latest = await samplePageState(page);
    const signature = stateSignature(latest);
    stableSamples = signature === previousSignature ? stableSamples + 1 : 0;
    previousSignature = signature;
    if (
      latest.readyState === 'complete'
      && latest.bodyWidth > 0
      && latest.bodyHeight > 0
      && latest.blockingLoaderCount === 0
      && !latest.sparseGraphicalShell
      && stableSamples >= 1
    ) break;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(timing.readinessPollMs);
  } while (Date.now() <= deadline);

  const hardReasons = [];
  if (latest.bodyWidth <= 0 || latest.bodyHeight <= 0) hardReasons.push('zero-body-layout');
  if (latest.blockingLoaderCount > 0) hardReasons.push('persistent-explicit-loader');
  if (latest.sparseGraphicalShell) hardReasons.push('sparse-graphical-shell');
  const softSignals = [];
  if (latest.visibleCount <= 3 || (latest.textLength < 80 && latest.mediaCount === 0)) softSignals.push('sparse-content');
  if (latest.lowOpacityRatio >= 0.45) softSignals.push('low-aggregate-opacity');
  if (latest.activeAnimationCount > 0) softSignals.push('active-motion');
  if (latest.explicitLoaderCount > latest.blockingLoaderCount) softSignals.push('visible-loader-marker');
  return {
    status: hardReasons.length ? 'partial' : 'complete',
    attempts,
    stable: stableSamples >= 1,
    reasons: hardReasons,
    softSignals,
    finalSample: latest,
  };
}

async function settlePage(page, overrides = {}) {
  const timing = timingOptions(overrides);
  const startedAt = Date.now();
  const deadline = Date.now() + timing.settleTimeoutMs;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let latest = await samplePageState(page);
  let previousSignature = '';
  let stableSamples = 0;
  do {
    latest = await samplePageState(page);
    const signature = stateSignature(latest);
    stableSamples = signature === previousSignature ? stableSamples + 1 : 0;
    previousSignature = signature;
    const transitionalLowOpacity = latest.lowOpacityRatio >= 0.45 && latest.activeAnimationCount > 0;
    if (stableSamples >= 1 && !transitionalLowOpacity) break;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(timing.settlePollMs);
  } while (Date.now() <= deadline);
  return {
    stable: stableSamples >= 1,
    unresolvedMotion: latest.infiniteAnimationCount > 0 || (!stableSamples && latest.activeAnimationCount > 0),
    durationMs: Date.now() - startedAt,
    finalSample: latest,
  };
}

function planScrollPositions(maximum, viewportHeight, maxPositions = 16) {
  if (maximum <= 0) return [0];
  const step = Math.max(1, Math.round(viewportHeight * 0.75));
  const natural = [];
  for (let position = 0; position < maximum; position += step) natural.push(position);
  if (!natural.includes(maximum)) natural.push(maximum);
  if (natural.length <= maxPositions) return natural;
  return Array.from({ length: maxPositions }, (_, index) => (
    Math.round((maximum * index) / (maxPositions - 1))
  ));
}

async function traverseSurface(page, viewport, overrides = {}) {
  const timing = timingOptions(overrides);
  const deadline = Date.now() + timing.traversalTimeoutMs;
  const maximum = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
  const plannedPositions = planScrollPositions(maximum, viewport.height, timing.maxTraversalPositions);
  const positions = [];
  let unresolvedMotion = false;
  let maxSettleDurationMs = 0;
  let truncated = false;
  for (const position of plannedPositions) {
    if (positions.length && Date.now() >= deadline) {
      truncated = true;
      break;
    }
    await page.evaluate((y) => window.scrollTo(0, y), position);
    const remainingMs = Math.max(1, deadline - Date.now());
    const settled = await settlePage(page, {
      ...timing,
      settleTimeoutMs: Math.min(timing.settleTimeoutMs, remainingMs),
    });
    positions.push(position);
    unresolvedMotion ||= settled.unresolvedMotion;
    maxSettleDurationMs = Math.max(maxSettleDurationMs, settled.durationMs);
  }
  return { positions, plannedPositions: plannedPositions.length, truncated, unresolvedMotion, maxSettleDurationMs };
}

async function inspectRenderedPage(page) {
  return page.evaluate(() => {
    const isRendered = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    };
    const styleShape = (style) => ({
      display: style.display,
      position: style.position,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      color: style.color,
      backgroundColor: style.backgroundColor,
      border: style.border,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      opacity: style.opacity,
      transform: style.transform,
      transition: style.transition,
      animation: style.animation,
      gridTemplateColumns: style.gridTemplateColumns,
      gap: style.gap,
      padding: style.padding,
      margin: style.margin,
    });

    const allElements = document.querySelectorAll('body *');
    const maximumCandidates = 2000;
    const selectedCandidates = [];
    const selectedSet = new Set();
    const addCandidate = (element) => {
      if (!element || selectedSet.has(element) || selectedCandidates.length >= maximumCandidates) return;
      selectedSet.add(element);
      selectedCandidates.push(element);
    };
    const prioritySelector = 'h1,h2,h3,nav,header,main,section,article,footer,a,button,input,select,textarea,[role]';
    for (const element of document.querySelectorAll(prioritySelector)) {
      addCandidate(element);
      if (selectedCandidates.length >= Math.min(600, maximumCandidates)) break;
    }
    const stride = Math.max(1, Math.ceil(allElements.length / Math.max(1, maximumCandidates - selectedCandidates.length)));
    for (let index = 0; index < allElements.length && selectedCandidates.length < maximumCandidates; index += stride) {
      addCandidate(allElements[index]);
    }

    const stableSelector = (element) => {
      if (element.id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(element.id)) return `#${element.id}`;
      const className = [...element.classList].find((value) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value));
      return className ? `.${className}` : element.tagName.toLowerCase();
    };
    const renderedCandidates = selectedCandidates.filter(isRendered).slice(0, 800);
    const elements = renderedCandidates
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        return {
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          selector: stableSelector(element),
          id: element.id || '',
          classes: [...element.classList].slice(0, 8),
          text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180),
          rect: {
            x: Math.round(rect.x * 100) / 100,
            y: Math.round(rect.y * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          },
          style: styleShape(getComputedStyle(element)),
        };
      });

    const rootStyle = getComputedStyle(document.documentElement);
    const customProperties = {};
    for (let index = 0; index < rootStyle.length; index += 1) {
      const property = rootStyle[index];
      if (property.startsWith('--')) customProperties[property] = rootStyle.getPropertyValue(property).trim();
    }

    const mediaQueries = new Set();
    const keyframes = new Set();
    const inaccessibleStyleSheets = [];
    const maximumStyleRules = 5000;
    const maximumMechanismCandidates = 250;
    const publicMechanismCandidates = [];
    const mechanismKeys = new Set();
    const interestingProperties = new Set([
      'animation', 'animation-name', 'backdrop-filter', 'background', 'background-color',
      'background-image', 'border', 'border-radius', 'box-shadow', 'clip-path', 'display',
      'filter', 'gap', 'grid-template-columns', 'mask-image', 'mix-blend-mode', 'position',
      'top', 'transform', 'transition',
    ]);
    let inspectedStyleRules = 0;
    let styleRuleScanTruncated = false;
    const walkRules = (rules) => {
      for (const rule of rules || []) {
        if (inspectedStyleRules >= maximumStyleRules) {
          styleRuleScanTruncated = true;
          return;
        }
        inspectedStyleRules += 1;
        if (rule.type === CSSRule.MEDIA_RULE) mediaQueries.add(rule.conditionText || rule.media?.mediaText || '');
        if (rule.type === CSSRule.KEYFRAMES_RULE) keyframes.add(rule.name || '');
        if (rule.type === CSSRule.STYLE_RULE && publicMechanismCandidates.length < maximumMechanismCandidates
          && typeof rule.selectorText === 'string' && rule.selectorText.length <= 300) {
          const declarations = {};
          for (const property of rule.style || []) {
            if (interestingProperties.has(property)) declarations[property] = rule.style.getPropertyValue(property).trim();
          }
          if (Object.keys(declarations).length) {
            for (const element of renderedCandidates.slice(0, 200)) {
              let matches = false;
              try { matches = element.matches(rule.selectorText); } catch { matches = false; }
              if (!matches) continue;
              const targetSelector = stableSelector(element);
              const key = `${targetSelector}\n${rule.selectorText}\n${JSON.stringify(declarations)}`;
              if (!mechanismKeys.has(key)) {
                mechanismKeys.add(key);
                publicMechanismCandidates.push({
                  targetSelector,
                  matchedRuleSelector: rule.selectorText,
                  declarations,
                  sourceStylesheet: rule.parentStyleSheet?.href || 'inline stylesheet',
                  confidence: 'O',
                });
              }
              break;
            }
          }
        }
        if (rule.cssRules) walkRules(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walkRules(sheet.cssRules);
      } catch {
        inaccessibleStyleSheets.push(sheet.href || 'inline stylesheet');
      }
    }

    return {
      title: document.title,
      finalUrl: location.href,
      lang: document.documentElement.lang || '',
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      domSampling: {
        totalCandidates: allElements.length,
        candidatesInspected: selectedCandidates.length,
        renderedRecords: elements.length,
        truncated: allElements.length > selectedCandidates.length,
      },
      elements,
      customProperties,
      mediaQueries: [...mediaQueries].filter(Boolean),
      keyframes: [...keyframes].filter(Boolean),
      publicMechanismCandidates,
      inaccessibleStyleSheets,
      styleRuleScan: {
        inspected: inspectedStyleRules,
        maximum: maximumStyleRules,
        truncated: styleRuleScanTruncated,
      },
      loadedFonts: [...document.fonts].map((font) => ({
        family: font.family,
        style: font.style,
        weight: font.weight,
        status: font.status,
      })),
      activeAnimations: document.getAnimations().slice(0, 100).map((animation) => ({
        playState: animation.playState,
        duration: animation.effect?.getTiming?.().duration ?? null,
        delay: animation.effect?.getTiming?.().delay ?? null,
        easing: animation.effect?.getTiming?.().easing ?? null,
      })),
      media: {
        images: [...document.images].slice(0, 200).map((image) => ({
          src: image.currentSrc || image.src,
          alt: image.alt || '',
          width: image.naturalWidth,
          height: image.naturalHeight,
        })),
        svgCount: document.querySelectorAll('svg').length,
        canvasCount: document.querySelectorAll('canvas').length,
        videoCount: document.querySelectorAll('video').length,
        iframeCount: document.querySelectorAll('iframe').length,
      },
    };
  });
}

function countedValues(values, limit = 8) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function buildEvidenceSummary(evidence) {
  const semanticTags = new Set(['h1', 'h2', 'h3', 'p', 'a', 'button', 'nav', 'header', 'main', 'section', 'article', 'footer']);
  const candidates = evidence.elements.filter((element) => (
    semanticTags.has(element.tag) || element.role || Number.parseFloat(element.style.fontSize) >= 24
  ));
  const seen = new Set();
  const maximum = Math.max(1, Math.min(12, evidence.elements.length - 1));
  const representativeElements = [];
  for (const element of candidates) {
    const identity = `${element.tag}:${element.role}:${element.text}:${element.style.fontFamily}:${element.style.fontSize}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    representativeElements.push({
      index: element.index,
      tag: element.tag,
      role: element.role,
      text: element.text,
      rect: element.rect,
      style: {
        fontFamily: element.style.fontFamily,
        fontSize: element.style.fontSize,
        fontWeight: element.style.fontWeight,
        lineHeight: element.style.lineHeight,
        color: element.style.color,
        backgroundColor: element.style.backgroundColor,
        border: element.style.border,
        borderRadius: element.style.borderRadius,
      },
    });
    if (representativeElements.length >= maximum) break;
  }
  if (!representativeElements.length && evidence.elements.length) {
    representativeElements.push(evidence.elements[0]);
  }
  return {
    representativeElements,
    publicMechanismCandidates: (evidence.publicMechanismCandidates || []).slice(0, 20),
    typography: countedValues(evidence.elements.map((element) => (
      `${element.style.fontFamily} | ${element.style.fontSize} | ${element.style.fontWeight}`
    ))),
    colors: countedValues(evidence.elements.flatMap((element) => [
      element.style.color,
      !['rgba(0, 0, 0, 0)', 'transparent'].includes(element.style.backgroundColor)
        ? element.style.backgroundColor : '',
    ])),
    layout: {
      viewport: evidence.viewport,
      document: evidence.document,
      widestRepresentatives: representativeElements
        .slice().sort((left, right) => right.rect.width - left.rect.width).slice(0, 5)
        .map((element) => ({ index: element.index, tag: element.tag, text: element.text, rect: element.rect })),
    },
    motion: {
      keyframes: evidence.keyframes,
      activeAnimations: evidence.activeAnimations.slice(0, 20),
    },
  };
}

async function sampleInteractionStates(page, options = {}) {
  const locator = page.locator('a, button, input, select, textarea, [role="button"], [tabindex]');
  const count = Math.min(await locator.count(), 6);
  const states = [];
  const styleOf = (element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      border: style.border,
      boxShadow: style.boxShadow,
      opacity: style.opacity,
      transform: style.transform,
      outline: style.outline,
    };
  };

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const identity = await item.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    }));
    const initial = await item.evaluate(styleOf);

    if (options.hover !== false) {
      await item.hover({ trial: false, timeout: 1000 }).catch(() => {});
      const hovered = await item.evaluate(styleOf);
      states.push({ kind: 'hover', target: identity, initial, observed: hovered });
    }

    await item.focus({ timeout: 1000 }).catch(() => {});
    const focused = await item.evaluate(styleOf);
    states.push({ kind: 'focus', target: identity, initial, observed: focused });
  }
  await page.mouse.move(0, 0).catch(() => {});
  return states;
}

async function sampleRepresentativeInteractionState(item, controlsId) {
  return item.evaluate((element, id) => {
    const controlled = id ? document.getElementById(id) : null;
    const visible = (target) => {
      if (!target) return null;
      const style = getComputedStyle(target);
      const rect = target.getBoundingClientRect();
      return !target.hidden
        && target.getAttribute('aria-hidden') !== 'true'
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const tabList = element.closest('[role="tablist"]');
    return {
      triggerSelected: element.getAttribute('aria-selected'),
      triggerExpanded: element.getAttribute('aria-expanded'),
      controlledRole: controlled?.getAttribute('role') || null,
      controlledHidden: controlled ? Boolean(controlled.hidden) : null,
      controlledAriaHidden: controlled?.getAttribute('aria-hidden') ?? null,
      controlledVisible: visible(controlled),
      tabSelection: tabList
        ? [...tabList.querySelectorAll('[role="tab"]')].map((tab) => ({
          controls: tab.getAttribute('aria-controls') || '',
          selected: tab.getAttribute('aria-selected'),
        }))
        : null,
    };
  }, controlsId);
}

async function representativeInteractionMetadata(item) {
  return item.evaluate((element) => {
    const controlled = document.getElementById(element.getAttribute('aria-controls') || '');
    const landmark = element.closest('section,article,main,nav,header,footer,[role="region"],[role="dialog"],[role="alertdialog"]');
    const heading = landmark?.querySelector('h1,h2,h3,[role="heading"]');
    const tabList = element.closest('[role="tablist"]');
    return {
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      role: element.getAttribute('role') || '',
      expanded: element.getAttribute('aria-expanded') || '',
      selected: element.getAttribute('aria-selected') || '',
      controls: element.getAttribute('aria-controls') || '',
      controlledExists: Boolean(controlled),
      controlledTag: controlled?.tagName.toLowerCase() || '',
      controlledRole: controlled?.getAttribute('role') || '',
      landmark: [landmark?.tagName.toLowerCase() || '', landmark?.id || '', landmark?.getAttribute('aria-label') || ''].join(':'),
      nearbyHeading: (heading?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
      tabList: [tabList?.id || '', tabList?.getAttribute('aria-label') || ''].join(':'),
      inForm: Boolean(element.closest('form')),
      type: element.getAttribute('type') || '',
    };
  });
}

function representativeInteractionFingerprint(metadata) {
  const canonical = [
    metadata.tag, metadata.role, metadata.text, metadata.controls, metadata.expanded,
    metadata.controlledTag, metadata.controlledRole, metadata.landmark,
    metadata.nearbyHeading, metadata.tabList,
  ].join('\n');
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

async function discoverRepresentativeInteractions(page, viewport, nearCandidateId) {
  const locator = page.locator('[role="tab"][aria-selected="false"], button[aria-expanded][aria-controls]');
  const dangerousText = /delete|remove|purchase|buy|checkout|pay|publish|submit|upload|account|sign[ -]?in|log[ -]?in|删除|购买|支付|发布|提交|上传|登录|账户/i;
  const found = [];
  const count = Math.min(await locator.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const metadata = await representativeInteractionMetadata(item);
    if (!metadata.controlledExists || metadata.inForm || metadata.type.toLowerCase() === 'submit' || dangerousText.test(metadata.text)) continue;
    found.push({
      viewport,
      nearCandidateId,
      kindHint: metadata.role === 'tab' ? 'tab' : 'accordion',
      ...metadata,
      targetFingerprint: representativeInteractionFingerprint(metadata),
    });
  }
  return found;
}

async function captureRepresentativeInteraction(page, screenshotsDirectory, viewportName, overrides = {}) {
  const candidate = overrides.targetNonce
    ? page.locator(`[data-site-style-replay-target="${overrides.targetNonce}"]`)
    : page.locator('[role="tab"][aria-selected="false"], button[aria-expanded][aria-controls]');
  const dangerousText = /delete|remove|purchase|buy|checkout|pay|publish|submit|upload|account|sign[ -]?in|log[ -]?in|删除|购买|支付|发布|提交|上传|登录|账户/i;
  const count = overrides.targetNonce ? Math.min(await candidate.count(), 2) : Math.min(await candidate.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const candidateItem = candidate.nth(index);
    if (!(await candidateItem.isVisible().catch(() => false))) continue;
    const stableId = `site-style-candidate-${index}`;
    if (!overrides.targetNonce) {
      await candidateItem.evaluate((element, id) => element.setAttribute('data-site-style-candidate', id), stableId);
    }
    const item = overrides.targetNonce ? candidateItem : page.locator(`[data-site-style-candidate="${stableId}"]`).first();
    const metadata = await representativeInteractionMetadata(item);
    if (!metadata.controlledExists || metadata.inForm || metadata.type.toLowerCase() === 'submit' || dangerousText.test(metadata.text)) continue;
    if (overrides.targetFingerprint && representativeInteractionFingerprint(metadata) !== overrides.targetFingerprint) continue;

    let kind = metadata.role === 'tab' ? 'tab' : 'accordion';
    let originalTab = null;
    if (kind === 'tab') {
      const tabList = page.locator('[role="tablist"]').filter({ has: item }).first();
      if (await tabList.count()) {
        originalTab = await tabList.locator('[role="tab"][aria-selected="true"]').first().elementHandle();
      }
    }
    await item.scrollIntoViewIfNeeded();
    await settlePage(page, overrides);
    const beforeState = await sampleRepresentativeInteractionState(item, metadata.controls);
    const beforeScreenshot = `screenshots/${viewportName}-interaction-before.png`;
    const afterScreenshot = `screenshots/${viewportName}-interaction-after.png`;
    const beforeRecord = await takeScreenshot(
      page,
      path.join(screenshotsDirectory, `${viewportName}-interaction-before.png`),
      { viewport: viewportName, state: 'representative-interaction-before' },
    );
    await item.click({ timeout: 2000 });
    const settled = await settlePage(page, overrides);
    if (metadata.controls) {
      const controlledRole = await page.evaluate((id) => document.getElementById(id)?.getAttribute('role') || '', metadata.controls);
      if (['dialog', 'alertdialog'].includes(controlledRole)) kind = controlledRole;
    }
    const afterState = await sampleRepresentativeInteractionState(item, metadata.controls);
    const changed = JSON.stringify(afterState) !== JSON.stringify(beforeState);
    const afterRecord = await takeScreenshot(
      page,
      path.join(screenshotsDirectory, `${viewportName}-interaction-after.png`),
      { viewport: viewportName, state: `representative-${kind}-after` },
    );

    if (kind === 'tab' && originalTab) {
      await originalTab.click({ timeout: 2000 }).catch(() => {});
    } else if (['dialog', 'alertdialog'].includes(kind)) {
      const dialog = page.locator(`[role="${kind}"]`).first();
      const close = dialog.getByRole('button', { name: /close|cancel|dismiss|关闭|取消/i }).first();
      if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 1000 }).catch(() => {});
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    } else if (kind === 'accordion') {
      await item.click({ timeout: 2000 }).catch(() => {});
    }
    await settlePage(page, overrides);
    const restoredState = await sampleRepresentativeInteractionState(item, metadata.controls);
    const reversible = JSON.stringify(restoredState) === JSON.stringify(beforeState);
    return {
      kind,
      target: metadata,
      beforeScreenshot,
      afterScreenshot,
      beforeState,
      afterState,
      restoredState,
      reversible,
      changed,
      unresolvedMotion: settled.unresolvedMotion,
      screenshotRecords: [beforeRecord, afterRecord],
    };
  }
  return null;
}

async function collectSite(options) {
  const url = validatePublicUrl(options.url, { allowPrivateNetwork: options.allowPrivateNetwork === true });
  await assertPublicNetworkTarget(
    url,
    { allowPrivateNetwork: options.allowPrivateNetwork === true },
    options.networkResolver || dns.lookup,
  );
  const outputDirectory = path.resolve(options.outputDirectory || `site-style-${Date.now()}`);
  const viewports = options.viewports || [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'narrow', width: 390, height: 844 },
  ];
  const timing = timingOptions(options.timing);
  const progress = options.onProgress || ((event) => {
    if (process.env.SITE_STYLE_PROGRESS === '1') process.stderr.write(`[site-style] ${event}\n`);
  });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const screenshotsDirectory = path.join(outputDirectory, 'screenshots');
  fs.mkdirSync(screenshotsDirectory, { recursive: true });

  const report = {
    schemaVersion: SCHEMA_VERSION,
    outputDirectory,
    requestedUrl: scrubUrl(url),
    capturedAt: new Date().toISOString(),
    captureStatus: { status: 'blocked', stage: 'pending', reasons: [] },
    runtimeDiagnostics: {
      consoleErrors: [],
      pageErrors: [],
      requestFailures: [],
      policyBlockedRequests: [],
    },
    runtimeProvenance: createRuntimeProvenance({
      playwrightVersion: '1.62.1',
      deviceScaleFactor: 1,
    }),
    scope: 'Public client-delivered and rendered evidence only.',
    pages: [{
      requestedUrl: scrubUrl(url),
      finalUrl: '',
      status: null,
      publicResources: [],
      viewports: {},
      mainPath: [],
      representativeStates: [],
      skippedBranches: [],
      outliers: [],
      screenshots: [],
    }],
    limits: [
      'No server source, private design files, authenticated states, or inaccessible cross-origin code.',
      'Only tested viewports and safely reached states are observed.',
      'Resource URLs and rendered evidence are inventoried; third-party code is not copied into the output.',
    ],
  };
  const pageReport = report.pages[0];
  const resourceMap = new Map();
  const evidencePath = path.join(outputDirectory, 'evidence.json');
  const writeReport = () => {
    const temporaryPath = `${evidencePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(temporaryPath, evidencePath);
    } catch (error) {
      fs.rmSync(evidencePath, { force: true });
      fs.renameSync(temporaryPath, evidencePath);
      if (!fs.existsSync(evidencePath)) throw error;
    }
  };
  writeReport();

  let browser;
  let currentStage = 'playwright-load';
  try {
    const { chromium } = (options.playwrightLoader || loadPlaywright)();
    currentStage = 'browser-launch';
    browser = await chromium.launch(launchOptions());
    report.runtimeProvenance.browser.version = browser.version();
    currentStage = 'capture';
    const requestPolicy = options.requestPolicy || createRequestPolicy({
      allowPrivateNetwork: options.allowPrivateNetwork === true,
      resolver: options.networkResolver || dns.lookup,
    });
    for (const viewport of viewports) {
      let page;
      let context;
      let viewportStage = 'page-create';
      try {
        context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          serviceWorkers: 'block',
        });
        await context.route('**/*', async (route) => {
          const requestUrl = route.request().url();
          const decision = await requestPolicy.check(requestUrl);
          if (decision.allowed) {
            await route.continue();
            return;
          }
          pushDiagnostic(report.runtimeDiagnostics.policyBlockedRequests, {
            url: scrubUrl(requestUrl),
            reason: decision.reason || 'blocked-by-policy',
          });
          await route.abort('blockedbyclient');
        });
        page = await context.newPage();
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          pushDiagnostic(report.runtimeDiagnostics.consoleErrors, {
            viewport: viewport.name,
            message: scrubText(message.text()),
          });
        });
        page.on('pageerror', (error) => {
          pushDiagnostic(report.runtimeDiagnostics.pageErrors, {
            viewport: viewport.name,
            message: scrubText(error.message || String(error)),
          });
        });
        page.on('requestfailed', (request) => {
          pushDiagnostic(report.runtimeDiagnostics.requestFailures, {
            viewport: viewport.name,
            url: scrubUrl(request.url()),
            errorText: scrubText(request.failure()?.errorText || 'request failed'),
          });
        });
        page.on('response', (response) => {
          const request = response.request();
          const key = resourceId(response.url(), request.resourceType());
          if (!resourceMap.has(key)) {
            resourceMap.set(key, {
              resourceId: key,
              ...scrubUrl(response.url()),
              type: request.resourceType(),
              status: response.status(),
              contentType: response.headers()['content-type'] || '',
            });
          }
        });

        viewportStage = 'navigation';
        progress(`${viewport.name}:goto:start`);
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: options.navigationTimeoutMs || 45000,
        });
        if (report.runtimeProvenance.webgl.status === 'unknown') {
          report.runtimeProvenance.webgl = await probeWebgl(page);
        }
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);
        progress(`${viewport.name}:goto:done`);
        if (!pageReport.finalUrl) pageReport.finalUrl = scrubUrl(page.url());
        if (pageReport.status === null) pageReport.status = response?.status() ?? null;
        pageReport.mainPath.push({ action: 'open', viewport: viewport.name, url: scrubUrl(page.url()) });

        let readiness = await probeReadiness(page, timing);
        progress(`${viewport.name}:readiness:${readiness.status}`);
        await page.evaluate(() => window.scrollTo(0, 0));
        await settlePage(page, timing);
        const openingScrollY = await page.evaluate(() => window.scrollY);
        const openingRecord = await takeScreenshot(
          page,
          path.join(screenshotsDirectory, `${viewport.name}-viewport.png`),
          {
            viewport: viewport.name,
            state: 'opening',
            kind: readiness.status === 'complete' ? 'evidence' : 'diagnostic',
          },
          { fullPage: false },
        );
        pageReport.screenshots.push(openingRecord);
        pageReport.representativeStates.push({
          viewport: viewport.name,
          state: 'opening',
          screenshot: openingRecord.path,
          status: readiness.status,
        });
        progress(`${viewport.name}:opening-screenshot`);
        const openingScreenshot = {
          path: `screenshots/${viewport.name}-viewport.png`,
          scrollY: openingScrollY,
          kind: readiness.status === 'complete' ? 'evidence' : 'diagnostic',
        };
        let traversal = readiness.status === 'complete'
          ? await traverseSurface(page, viewport, timing)
          : { positions: [0], unresolvedMotion: readiness.finalSample.infiniteAnimationCount > 0, maxSettleDurationMs: 0 };
        progress(`${viewport.name}:traversal:${traversal.positions.length}`);
        for (const scrollY of traversal.positions) {
          pageReport.mainPath.push({ action: 'scroll', viewport: viewport.name, scrollY });
        }
        if (readiness.status === 'complete' && !pageReport.representativeInteraction) {
          pageReport.representativeInteraction = await captureRepresentativeInteraction(
            page, screenshotsDirectory, viewport.name, timing,
          );
          if (pageReport.representativeInteraction) {
            const interaction = pageReport.representativeInteraction;
            pageReport.screenshots.push(...interaction.screenshotRecords);
            pageReport.representativeStates.push({
              viewport: viewport.name,
              state: interaction.kind,
              screenshots: [
                interaction.beforeScreenshot,
                interaction.afterScreenshot,
              ],
            });
            pageReport.mainPath.push({
              action: interaction.reversible ? 'click-reversible' : 'click-unrestored',
              viewport: viewport.name,
              kind: interaction.kind,
              target: interaction.target.text,
            });
            if (!interaction.reversible) {
              try {
                await page.reload({
                  waitUntil: 'domcontentloaded',
                  timeout: options.navigationTimeoutMs || 45000,
                });
                await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
                await page.evaluate(() => document.fonts.ready);
                const recoveryReadiness = await probeReadiness(page, timing);
                interaction.recovery = {
                  status: recoveryReadiness.status,
                  method: 'reload',
                  reasons: recoveryReadiness.reasons,
                };
                if (recoveryReadiness.status !== 'complete') {
                  readiness = {
                    ...readiness,
                    status: 'partial',
                    reasons: [...new Set([
                      ...(readiness.reasons || []),
                      'representative interaction state could not be safely restored',
                      ...(recoveryReadiness.reasons || []),
                    ])],
                  };
                  for (const record of interaction.screenshotRecords) record.kind = 'diagnostic';
                } else {
                  pageReport.mainPath.push({ action: 'reload-recovery', viewport: viewport.name });
                  traversal = await traverseSurface(page, viewport, timing);
                  for (const scrollY of traversal.positions) {
                    pageReport.mainPath.push({ action: 'scroll', viewport: viewport.name, scrollY, after: 'reload-recovery' });
                  }
                }
              } catch (error) {
                interaction.recovery = {
                  status: 'blocked',
                  method: 'reload',
                  reasons: [scrubText(error.message || String(error))],
                };
                readiness = {
                  ...readiness,
                  status: 'partial',
                  reasons: [...new Set([
                    ...(readiness.reasons || []),
                    'representative interaction state could not be safely restored',
                  ])],
                };
                for (const record of interaction.screenshotRecords) record.kind = 'diagnostic';
              }
            } else {
              interaction.recovery = { status: 'complete', method: 'control' };
            }
            delete interaction.screenshotRecords;
          }
        }
        progress(`${viewport.name}:representative-interaction`);
        if (readiness.status !== 'complete') {
          openingScreenshot.kind = 'diagnostic';
          for (const record of pageReport.screenshots) {
            if (record.viewport === viewport.name) record.kind = 'diagnostic';
          }
          const openingState = pageReport.representativeStates.find(
            (state) => state.viewport === viewport.name && state.state === 'opening',
          );
          if (openingState) openingState.status = readiness.status;
        }
        progress(`${viewport.name}:inspect:start`);
        const evidence = scrubRenderedEvidenceUrls(await (options.inspectRenderedPage || inspectRenderedPage)(page));
        progress(`${viewport.name}:inspect:done`);
        evidence.evidenceSummary = buildEvidenceSummary(evidence);
        evidence.openingScreenshot = openingScreenshot;
        evidence.captureStatus = {
          status: readiness.status,
          reasons: readiness.reasons,
          softSignals: readiness.softSignals,
          readiness,
        };
        evidence.traversal = traversal;

        if (readiness.status !== 'complete') {
          progress(`${viewport.name}:diagnostic-only`);
        } else if (evidence.document.height <= viewport.height * 6) {
          pageReport.screenshots.push(await takeScreenshot(
            page,
            path.join(screenshotsDirectory, `${viewport.name}-full-page.png`),
            { viewport: viewport.name, state: 'full-page' },
            { fullPage: true },
          ));
          progress(`${viewport.name}:full-page-screenshot`);
        } else if (!pageReport.representativeInteraction?.beforeScreenshot.includes(`/${viewport.name}-interaction-`)) {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.5));
          await settlePage(page, timing);
          pageReport.screenshots.push(await takeScreenshot(
            page,
            path.join(screenshotsDirectory, `${viewport.name}-mid.png`),
            { viewport: viewport.name, state: 'mid-page' },
          ));
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await settlePage(page, timing);
          pageReport.screenshots.push(await takeScreenshot(
            page,
            path.join(screenshotsDirectory, `${viewport.name}-footer.png`),
            { viewport: viewport.name, state: 'footer' },
          ));
          progress(`${viewport.name}:section-screenshots`);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await settlePage(page, timing);
        evidence.interactionStates = await sampleInteractionStates(page, { hover: viewport.name !== 'narrow' });
        progress(`${viewport.name}:interaction-states`);
        await page.evaluate(() => window.scrollTo(0, 0));
        pageReport.viewports[viewport.name] = evidence;
      } catch (error) {
        for (const record of pageReport.screenshots) {
          if (record.viewport === viewport.name) record.kind = 'diagnostic';
        }
        for (const state of pageReport.representativeStates) {
          if (state.viewport === viewport.name) state.status = 'blocked';
        }
        pageReport.viewports[viewport.name] = {
          captureStatus: {
            status: 'blocked',
            stage: viewportStage,
            reasons: [scrubText(error.message || String(error))],
          },
          profile: {
            name: viewport.name,
            width: viewport.width,
            height: viewport.height,
            hoverSampled: viewport.name !== 'narrow',
          },
        };
        pageReport.mainPath.push({
          action: 'capture-error',
          viewport: viewport.name,
          stage: viewportStage,
        });
      } finally {
        if (context) await context.close().catch(() => {});
        else if (page) await page.close().catch(() => {});
      }
    }
    const aggregate = aggregateScanStatus(Object.fromEntries(Object.entries(pageReport.viewports).map(
      ([name, viewport]) => [name, viewport.captureStatus],
    )));
    report.captureStatus = {
      status: aggregate.status,
      stage: 'complete',
      reasons: aggregate.reasons,
    };
  } catch (error) {
    report.captureStatus = {
      status: 'blocked',
      stage: currentStage,
      reasons: [scrubText(error.message || String(error))],
    };
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    pageReport.publicResources = [...resourceMap.values()];
    writeReport();
  }
  return report;
}

function formatUrlIdentity(value) {
  return value && typeof value === 'object' && typeof value.displayUrl === 'string'
    ? value.displayUrl
    : String(value || '');
}

module.exports = {
  assertPublicNetworkTarget,
  assertSupportedNodeVersion,
  collectSite,
  buildEvidenceSummary,
  captureRepresentativeInteraction,
  discoverRepresentativeInteractions,
  formatUrlIdentity,
  inspectRenderedPage,
  launchOptions,
  loadPlaywright,
  probeReadiness,
  representativeInteractionFingerprint,
  representativeInteractionMetadata,
  planScrollPositions,
  sampleInteractionStates,
  settlePage,
  scrubRenderedEvidenceUrls,
  traverseSurface,
  validatePublicUrl,
};
