const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

const TRACKING_QUERY_KEY = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|ref)$/i;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizedHostname(value) {
  return String(value).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '').split('%')[0];
}

function isPrivateIpv4(host) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 2)
    || (first === 192 && second === 168)
    || (first === 192 && second === 88)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51)
    || (first === 203 && second === 0)
    || first >= 224;
}

function ipv6Hextets(host) {
  const pieces = host.split('::');
  if (pieces.length > 2) return null;
  const parseSide = (side) => {
    if (!side) return [];
    const tokens = side.split(':');
    const last = tokens.at(-1);
    if (last?.includes('.')) {
      if (net.isIP(last) !== 4) return null;
      const octets = last.split('.').map(Number);
      tokens.splice(-1, 1, ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
    }
    if (tokens.some((token) => !/^[0-9a-f]{1,4}$/i.test(token))) return null;
    return tokens.map((token) => Number.parseInt(token, 16));
  };
  const left = parseSide(pieces[0]);
  const right = parseSide(pieces[1] || '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || missing < 0) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function isPrivateHostname(hostname) {
  const host = normalizedHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = net.isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family !== 6) return false;
  const words = ipv6Hextets(host);
  if (!words) return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const embedded = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    return isPrivateIpv4(embedded);
  }
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return true;
  if ((words[0] & 0xe000) !== 0x2000) return true;
  if (words[0] === 0x2001 && [0x0000, 0x0010, 0x0020, 0x0db8].includes(words[1])) return true;
  if (words[0] === 0x2002) return true;
  return false;
}

function canonicalUrl(value) {
  const parsed = new URL(value);
  parsed.hash = '';
  return parsed.toString();
}

function scrubUrl(value) {
  const raw = new URL(value);
  const fingerprint = `sha256:${sha256(canonicalUrl(raw.toString()))}`;
  const queryKeys = [];
  const scrubbed = new URL(raw.toString());
  scrubbed.username = '';
  scrubbed.password = '';
  scrubbed.hash = '';
  scrubbed.search = '';
  for (const [key] of raw.searchParams) {
    if (TRACKING_QUERY_KEY.test(key)) continue;
    if (!queryKeys.includes(key)) queryKeys.push(key);
    scrubbed.searchParams.append(key, '<redacted>');
  }
  return {
    displayUrl: scrubbed.toString(),
    queryKeys,
    urlFingerprint: fingerprint,
  };
}

function resourceId(rawUrl, resourceType) {
  return `res_${sha256(`${canonicalUrl(rawUrl)}\n${resourceType}`).slice(0, 16)}`;
}

function scrubText(value, maximumLength = 2048) {
  const absoluteUrlsScrubbed = String(value).replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      return scrubUrl(candidate).displayUrl;
    } catch {
      return '<invalid-url>';
    }
  });
  const relativeQueriesScrubbed = absoluteUrlsScrubbed.replace(
    /([?&][a-z0-9_.~-]{1,128}=)([^&#\s;,"']+)/gi,
    (match, prefix, parameterValue) => (
      /^%3credacted%3e$/i.test(parameterValue) ? match : `${prefix}<redacted>`
    ),
  );
  return relativeQueriesScrubbed.slice(0, maximumLength);
}

function createRequestPolicy(options = {}) {
  const resolver = options.resolver || dns.lookup;
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  const decisions = new Map();

  async function resolvePublic(hostname) {
    const host = normalizedHostname(hostname);
    if (decisions.has(host)) return decisions.get(host);
    const pending = (async () => {
      if (isPrivateHostname(host)) return { allowed: false, reason: 'private-address' };
      if (net.isIP(host)) return { allowed: true };
      try {
        const result = await resolver(host, { all: true, verbatim: true });
        const records = Array.isArray(result) ? result : [result];
        if (!records.length || records.some((record) => net.isIP(record?.address || '') === 0)) {
          return { allowed: false, reason: 'dns-failure' };
        }
        return records.every((record) => !isPrivateHostname(record.address))
          ? { allowed: true }
          : { allowed: false, reason: 'private-address' };
      } catch {
        return { allowed: false, reason: 'dns-failure' };
      }
    })();
    decisions.set(host, pending);
    return pending;
  }

  return {
    async check(value) {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        return { allowed: false, reason: 'invalid-url' };
      }
      if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return { allowed: true, localScheme: true };
      if (!['http:', 'https:'].includes(parsed.protocol)) return { allowed: false, reason: 'unsupported-scheme' };
      if (allowPrivateNetwork) return { allowed: true };
      return resolvePublic(parsed.hostname);
    },
  };
}

module.exports = {
  createRequestPolicy,
  isPrivateHostname,
  resourceId,
  scrubText,
  scrubUrl,
};
