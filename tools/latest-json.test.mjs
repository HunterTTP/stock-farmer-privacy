// Self-tests for latest-json.mjs, with made-up App Store Connect answers and no network: node --test tools/
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildsURL, fetchBuilds, main, makeToken, nextContent, pickEntries, releaseTag, tagFor } from './latest-json.mjs';

let next = 0;
/** One build as App Store Connect returns it: the build, its beta detail, pre-release version and notes. */
function build({ version, number = '1', processing = 'VALID', expired = false, internal = 'IN_BETA_TESTING', external = 'READY_FOR_BETA_SUBMISSION', notes }) {
  const id = String(++next);
  const data = {
    type: 'builds', id,
    attributes: { version: number, processingState: processing, expired, uploadedDate: '2026-11-16T12:00:00Z' },
    relationships: {
      buildBetaDetail: { data: { type: 'buildBetaDetails', id: `d${id}` } },
      preReleaseVersion: { data: { type: 'preReleaseVersions', id: `v${version}` } },
      betaBuildLocalizations: { data: notes === undefined ? [] : [{ type: 'betaBuildLocalizations', id: `l${id}` }] },
    },
  };
  const included = [
    { type: 'buildBetaDetails', id: `d${id}`, attributes: { internalBuildState: internal, externalBuildState: external } },
    { type: 'preReleaseVersions', id: `v${version}`, attributes: { version, platform: 'IOS' } },
    ...(notes === undefined ? [] : [{ type: 'betaBuildLocalizations', id: `l${id}`, attributes: { locale: 'en-US', whatsNew: notes } }]),
  ];
  return { data, included };
}

/** A fetch that serves the builds as pages of `size`, linked by links.next, and records the calls. */
function fakeAPI(builds, size = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const page = Number(new URL(url).searchParams.get('cursor') || 0);
    const slice = builds.slice(page * size, (page + 1) * size);
    const body = { data: slice.map((b) => b.data), included: slice.flatMap((b) => b.included), links: {} };
    if ((page + 1) * size < builds.length) body.links.next = `${buildsURL()}&cursor=${page + 1}`;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const picked = async (builds) => pickEntries(await fetchBuilds({ token: 't', fetchImpl: fakeAPI(builds).fetchImpl }));
const values = (entries) => ({ dev: entries.dev?.value, beta: entries.beta?.value });

test('tags come back from versions', () => {
  assert.equal(tagFor('2026.11.1613', 'dev'), 'dev-2026.11.16-13');
  assert.equal(tagFor('2026.1.101', 'beta'), 'beta-2026.1.1-1');
  assert.equal(tagFor('2026.12.3199', 'dev'), 'dev-2026.12.31-99');
  for (const bad of ['1.0', '2026.11.1600', '2026.13.101', '2026.011.101', '2026.11.3201', '0.0.0']) assert.equal(tagFor(bad, 'dev'), null, bad);
  assert.equal(releaseTag({ version: '2026.11.1603', external: 'IN_BETA_REVIEW' }), 'beta-2026.11.16-3');
  assert.equal(releaseTag({ version: '2026.11.1603', external: 'READY_FOR_BETA_SUBMISSION' }), 'dev-2026.11.16-3');
  assert.equal(releaseTag({ version: '2026.11.1603', external: 'READY_FOR_BETA_SUBMISSION', notes: ['Release beta-2026.11.16-3, version 2026.11.1603 (40)\n\nIn this beta:'] }),
    'beta-2026.11.16-3', 'the What to Test header names the tag before review starts');
  assert.equal(releaseTag({ version: '2026.11.1603', external: 'IN_BETA_REVIEW', notes: ['Release dev-2026.11.16-4, version 2026.11.1604 (40)'] }),
    'beta-2026.11.16-3', 'a header for another version is ignored');
});

test('picks the newest build Testing for each group, comparing versions as numbers', async () => {
  const entries = await picked([
    build({ version: '2026.11.903', number: '30' }),
    build({ version: '2026.11.1613', number: '42' }),
    build({ version: '2026.11.1201', number: '35', external: 'IN_BETA_TESTING' }),
    build({ version: '2026.11.1602', number: '40', external: 'BETA_APPROVED' }),
  ]);
  assert.deepEqual(values(entries), {
    dev: { tag: 'dev-2026.11.16-13', version: '2026.11.1613' },
    beta: { tag: 'beta-2026.11.12-1', version: '2026.11.1201' },
  });
});

test('ignores builds still processing, failed, expired, rejected or waiting for review', async () => {
  const entries = await picked([
    build({ version: '2026.11.1701', processing: 'PROCESSING', internal: 'PROCESSING' }),
    build({ version: '2026.11.1702', processing: 'FAILED' }),
    build({ version: '2026.11.1703', internal: 'EXPIRED', external: 'EXPIRED', expired: true }),
    build({ version: '2026.11.1704', internal: 'READY_FOR_BETA_TESTING' }),
    build({ version: '2026.11.1705', internal: 'MISSING_EXPORT_COMPLIANCE' }),
    build({ version: '2026.11.1706', internal: 'IN_BETA_TESTING', external: 'BETA_REJECTED' }),
    build({ version: '2026.11.1707', internal: 'IN_BETA_TESTING', external: 'WAITING_FOR_BETA_REVIEW', processing: 'INVALID' }),
    build({ version: '2026.11.1601', external: 'IN_BETA_TESTING' }),
  ]);
  assert.deepEqual(values(entries), {
    dev: { tag: 'beta-2026.11.17-6', version: '2026.11.1706' },
    beta: { tag: 'beta-2026.11.16-1', version: '2026.11.1601' },
  }, 'a rejected beta stays on the Dev group but never reaches ios.beta');
});

test('a beta in review is already the dev entry, as the Dev group gets every beta', async () => {
  const entries = await picked([build({ version: '2026.11.1603', external: 'IN_BETA_REVIEW' }), build({ version: '2026.11.1501', external: 'IN_BETA_TESTING' })]);
  assert.deepEqual(values(entries).dev, { tag: 'beta-2026.11.16-3', version: '2026.11.1603' });
  assert.deepEqual(values(entries).beta, { tag: 'beta-2026.11.15-1', version: '2026.11.1501' });
});

test('a rebuild of the same version wins by build number', async () => {
  const entries = await picked([build({ version: '2026.11.1601', number: '9' }), build({ version: '2026.11.1601', number: '10', internal: 'EXPIRED', expired: true })]);
  assert.equal(entries.dev.build.build, '9');
  const newer = await picked([build({ version: '2026.11.1601', number: '9' }), build({ version: '2026.11.1601', number: '10' })]);
  assert.equal(newer.dev.build.build, '10');
});

test('expiring the newest build moves the entry back; no installable build keeps the entry', () => {
  const previous = { schema: 1, ios: { appleId: '6831784973', dev: { tag: 'dev-2026.11.16-13', version: '2026.11.1613' }, beta: { tag: 'beta-2026.11.15-2', version: '2026.11.1502' } }, updated: '2026-11-16T18:16:11Z' };
  return (async () => {
    const entries = await picked([
      build({ version: '2026.11.1613', internal: 'EXPIRED', expired: true }),
      build({ version: '2026.11.1612' }),
    ]);
    const { content, changed } = nextContent(previous, entries, new Date('2026-11-16T19:00:00.123Z'));
    assert.ok(changed);
    assert.deepEqual(content.ios.dev, { tag: 'dev-2026.11.16-12', version: '2026.11.1612' });
    assert.deepEqual(content.ios.beta, previous.ios.beta, 'no installable beta build: the beta entry is kept');
    assert.equal(content.updated, '2026-11-16T19:00:00Z');
    const none = nextContent(previous, await picked([]));
    assert.equal(none.changed, false);
    assert.deepEqual(none.content, previous);
  })();
});

test('keeps every other key, the Apple ID and the key order', async () => {
  const previous = { schema: 1, note: 'kept', ios: { appleId: '1234', dev: { tag: 'dev-2026.11.16-1', version: '2026.11.1601' }, extra: true }, android: { closed: { versionCode: 7 } }, updated: '2026-11-16T10:00:00Z' };
  const { content, changed } = nextContent(previous, await picked([build({ version: '2026.11.1602' })]), new Date('2026-11-16T11:00:00Z'));
  assert.ok(changed);
  assert.deepEqual(Object.keys(content), ['schema', 'note', 'ios', 'android', 'updated']);
  assert.deepEqual(Object.keys(content.ios), ['appleId', 'dev', 'extra']);
  assert.equal(content.ios.appleId, '1234');
  assert.equal(content.note, 'kept');
  assert.deepEqual(content.android, previous.android);
  assert.deepEqual(content.ios.dev, { tag: 'dev-2026.11.16-2', version: '2026.11.1602' });
  assert.throws(() => nextContent({ schema: 2, ios: {} }, {}), /schema 2/);
  const fresh = nextContent(null, await picked([build({ version: '2026.11.1602' })]), new Date('2026-11-16T11:00:00Z'));
  assert.deepEqual(fresh.content, { schema: 1, ios: { appleId: '6831784973', dev: { tag: 'dev-2026.11.16-2', version: '2026.11.1602' } }, updated: '2026-11-16T11:00:00Z' });
});

test('no change keeps updated and does not rewrite the file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'latest-json-'));
  const file = join(dir, 'latest.json');
  // The live file's compact form: a different layout is not a change.
  const original = '{"schema":1,"ios":{"appleId":"6831784973","dev":{"tag":"dev-2026.11.16-13","version":"2026.11.1613"}},"updated":"2026-11-16T18:16:11Z"}';
  writeFileSync(file, original);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const env = { ASC_KEY_ID: 'K', ASC_ISSUER_ID: 'I', ASC_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const api = fakeAPI([build({ version: '2026.11.1613' }), build({ version: '2026.11.1612' })]);
  t.mock.method(globalThis, 'fetch', api.fetchImpl);
  t.mock.method(console, 'log', () => {});
  const before = statSync(file).mtimeMs;
  const result = await main(['--file', file], env);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(statSync(file).mtimeMs, before);
  assert.match(api.calls[0].init.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

  // A newer build rewrites it; --dry-run never does.
  api.calls.length = 0;
  t.mock.method(globalThis, 'fetch', fakeAPI([build({ version: '2026.11.1701' })]).fetchImpl);
  assert.equal((await main(['--file', file, '--dry-run'], env)).changed, true);
  assert.equal(readFileSync(file, 'utf8'), original);
  await main(['--file', file], env);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(written.ios.dev, { tag: 'dev-2026.11.17-1', version: '2026.11.1701' });
  assert.notEqual(written.updated, '2026-11-16T18:16:11Z');
});

test('follows links.next across pages', async () => {
  const builds = [];
  for (let n = 1; n <= 7; n++) builds.push(build({ version: `2026.11.${1000 + n}`, internal: n === 6 ? 'IN_BETA_TESTING' : 'EXPIRED', expired: n !== 6 }));
  const api = fakeAPI(builds, 2);
  const all = await fetchBuilds({ token: 't', fetchImpl: api.fetchImpl });
  assert.equal(api.calls.length, 4);
  assert.equal(all.length, 7);
  assert.equal(pickEntries(all).dev.value.version, '2026.11.1006', 'the one installable build is on page 3 and its detail resolves');
  const query = new URL(api.calls[0].url).searchParams;
  assert.equal(query.get('filter[app]'), '6831784973');
  assert.equal(query.get('include'), 'buildBetaDetail,preReleaseVersion,betaBuildLocalizations');
});

test('retries a 429 or 5xx, then fails without printing the token', async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? { ok: false, status: calls === 1 ? 429 : 503, json: async () => ({}) } : fakeAPI([build({ version: '2026.11.1601' })]).fetchImpl(buildsURL()));
  assert.equal((await fetchBuilds({ token: 'secret-token', fetchImpl: flaky, wait: async () => {} })).length, 1);
  const denied = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ code: 'NOT_AUTHORIZED', title: 'Authentication credentials are missing or invalid.' }] }) });
  await assert.rejects(fetchBuilds({ token: 'secret-token', fetchImpl: denied, wait: async () => {} }), (error) => /401 \(NOT_AUTHORIZED/.test(error.message) && !error.message.includes('secret-token'));
});

test('the token is ES256 with a life under 20 minutes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const token = makeToken({ keyId: 'ABC123', issuerId: 'issuer', privateKey: pem.replace(/\n/g, '\\n'), now: 1_000_000_000_000 });
  const [header, payload, signature] = token.split('.');
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url'));
  assert.deepEqual(decode(header), { alg: 'ES256', kid: 'ABC123', typ: 'JWT' });
  const claims = decode(payload);
  assert.equal(claims.aud, 'appstoreconnect-v1');
  assert.equal(claims.iss, 'issuer');
  assert.ok(claims.exp - claims.iat > 0 && claims.exp - claims.iat <= 20 * 60);
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});
