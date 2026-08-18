const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRequestPolicy,
  isPrivateHostname,
  resourceId,
  scrubText,
  scrubUrl,
} = require('../src/url-policy.cjs');

test('persisted URL keeps query keys but never query values', () => {
  const scrubbed = scrubUrl('https://example.com/page?theme=dark&token=super-secret&utm_source=feed#hero');

  assert.equal(
    scrubbed.displayUrl,
    'https://example.com/page?theme=%3Credacted%3E&token=%3Credacted%3E',
  );
  assert.deepEqual(scrubbed.queryKeys, ['theme', 'token']);
  assert.match(scrubbed.urlFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(scrubbed), /dark|super-secret|feed/);
});

test('persisted URL removes userinfo and fragments that may carry credentials', () => {
  const scrubbed = scrubUrl('https://alice:super-secret@example.com/page?theme=dark#access_token=fragment-secret');

  assert.equal(scrubbed.displayUrl, 'https://example.com/page?theme=%3Credacted%3E');
  assert.doesNotMatch(JSON.stringify(scrubbed), /alice|super-secret|fragment-secret|access_token/);
});

test('URL fingerprint and resource ID are stable but do not reveal query values', () => {
  const first = scrubUrl('https://cdn.example.com/font.woff2?v=42');
  const second = scrubUrl('https://cdn.example.com/font.woff2?v=42');
  const id = resourceId('https://cdn.example.com/font.woff2?v=42', 'font');

  assert.equal(first.urlFingerprint, second.urlFingerprint);
  assert.match(id, /^res_[a-f0-9]{16}$/);
  assert.doesNotMatch(id, /42|font/);
});

test('text scrubber removes query values from embedded URLs', () => {
  const scrubbed = scrubText('GET https://example.com/api?token=secret failed; retry https://cdn.example/x.js?v=9; relative /api?key=relative-secret');

  assert.doesNotMatch(scrubbed, /secret|=9/);
  assert.match(scrubbed, /token=%3Credacted%3E/);
  assert.match(scrubbed, /v=%3Credacted%3E/);
});

test('private and reserved IPv4 and IPv6 literals are rejected', () => {
  for (const host of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1',
    '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '2001:db8::1',
  ]) {
    assert.equal(isPrivateHostname(host), true, host);
  }
  assert.equal(isPrivateHostname('2606:4700:4700::1111'), false);
  assert.equal(isPrivateHostname('93.184.216.34'), false);
});

test('request policy rejects normalized IPv4-mapped IPv6 loopback', async () => {
  const policy = createRequestPolicy();
  assert.equal((await policy.check('http://[::ffff:127.0.0.1]/')).allowed, false);
  assert.equal((await policy.check('http://[::ffff:7f00:1]/')).allowed, false);
});

test('request policy caches a public DNS decision for one capture', async () => {
  let calls = 0;
  const policy = createRequestPolicy({
    resolver: async () => {
      calls += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });

  assert.equal((await policy.check('https://example.com/a.js')).allowed, true);
  assert.equal((await policy.check('https://example.com/b.css')).allowed, true);
  assert.equal(calls, 1);
});

test('concurrent first requests share one pending DNS decision', async () => {
  let calls = 0;
  const policy = createRequestPolicy({
    resolver: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });

  const [first, second] = await Promise.all([
    policy.check('https://example.com/a'),
    policy.check('https://example.com/b'),
  ]);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(calls, 1);
});

test('malformed DNS records fail closed', async () => {
  const policy = createRequestPolicy({ resolver: async () => [{ family: 4 }] });
  const decision = await policy.check('https://malformed.example/');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'dns-failure');
});

test('request policy rejects a public-looking host that resolves privately', async () => {
  const policy = createRequestPolicy({
    resolver: async () => [{ address: '192.168.20.4', family: 4 }],
  });

  const decision = await policy.check('https://public-looking.example/path');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'private-address');
  assert.doesNotMatch(JSON.stringify(decision), /path/);
});
