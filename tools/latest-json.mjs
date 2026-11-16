#!/usr/bin/env node
// Keeps latest.json in step with TestFlight, for the iOS game's Update popup.
//
// Asks the App Store Connect API which Stock Farmer builds testers can install right now and rewrites
// latest.json's ios.dev and ios.beta to match: ios.dev is the highest version whose build is Testing for
// the internal (Dev) group, ios.beta the highest one Testing for the external (Beta) group. Expiring a
// build in TestFlight therefore moves its entry back to the previous installable build. A channel with no
// installable build keeps its entry. Every other key in the file is kept, and `updated` changes only when
// the content does.
//
//   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_PRIVATE_KEY="$(cat AuthKey_….p8)" node tools/latest-json.mjs [--dry-run] [--file latest.json]
//
// Node 20 or later, no dependencies. Self-tests: node --test tools/
// It prints versions and build states only, never the key or the token.

import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The app's Apple ID, which is also its App Store Connect resource id. DEV and BETA builds are one app
// (bundle id com.hunter.stockfarmer); the two Xcode Cloud workflows send every build to the internal Dev
// group and, for a beta- tag, also to the external Beta group after Beta App Review.
export const APP_ID = '6831784973';
export const SCHEMA = 1;
const API = 'https://api.appstoreconnect.apple.com';
const TOKEN_LIFE_SECONDS = 15 * 60; // Apple refuses tokens that live longer than 20 minutes.
const MAX_PAGES = 20;
const TESTING = 'IN_BETA_TESTING';
// External states a build has only after being submitted for Beta App Review, which only beta- tags are.
const SUBMITTED_EXTERNALLY = new Set(['WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_REJECTED', 'BETA_APPROVED', 'READY_FOR_BETA_TESTING', TESTING]);

/** A signed ES256 JWT for the App Store Connect API. */
export function makeToken({ keyId, issuerId, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${part({ iss: issuerId, iat, exp: iat + TOKEN_LIFE_SECONDS, aud: 'appstoreconnect-v1' })}`;
  const key = createPrivateKey(privateKey.replace(/\\n/g, '\n'));
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

export function buildsURL(appId = APP_ID) {
  const query = new URLSearchParams({
    'filter[app]': appId,
    'filter[expired]': 'false',
    'filter[preReleaseVersion.platform]': 'IOS',
    sort: '-uploadedDate',
    limit: '200',
    include: 'buildBetaDetail,preReleaseVersion,betaBuildLocalizations',
    'fields[builds]': 'version,uploadedDate,processingState,expired,buildBetaDetail,preReleaseVersion,betaBuildLocalizations',
    'fields[buildBetaDetails]': 'internalBuildState,externalBuildState',
    'fields[preReleaseVersions]': 'version,platform',
    'fields[betaBuildLocalizations]': 'locale,whatsNew',
  });
  return `${API}/v1/builds?${query}`;
}

async function getJSON(url, token, fetchImpl, wait) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (error) {
      if (attempt >= 3) throw new Error(`App Store Connect could not be reached: ${error.message}`);
      await wait(attempt);
      continue;
    }
    if (response.ok) return response.json();
    const retry = response.status === 429 || response.status >= 500;
    if (!retry || attempt >= 3) {
      let detail = '';
      try {
        detail = ((await response.json()).errors || []).map((e) => `${e.code}: ${e.title}`).join('; ');
      } catch {}
      throw new Error(`App Store Connect answered ${response.status}${detail ? ` (${detail})` : ''}`);
    }
    await wait(attempt);
  }
}

/** Every build of the app, following the pages, flattened to what the choice needs. */
export async function fetchBuilds({ token, fetchImpl = fetch, appId = APP_ID, wait = (n) => new Promise((r) => setTimeout(r, 2000 * n)) }) {
  const data = [];
  const included = new Map();
  let url = buildsURL(appId);
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages of builds`);
    const body = await getJSON(url, token, fetchImpl, wait);
    data.push(...(body.data || []));
    for (const item of body.included || []) included.set(`${item.type}/${item.id}`, item);
    url = body.links?.next || null;
  }
  const related = (build, name) => {
    const link = build.relationships?.[name]?.data;
    if (Array.isArray(link)) return link.map((l) => included.get(`${l.type}/${l.id}`)).filter(Boolean);
    return link ? included.get(`${link.type}/${link.id}`) : undefined;
  };
  return data.map((build) => {
    const detail = related(build, 'buildBetaDetail')?.attributes || {};
    const pre = related(build, 'preReleaseVersion')?.attributes || {};
    const notes = (related(build, 'betaBuildLocalizations') || []).map((l) => l.attributes?.whatsNew || '');
    return {
      version: pre.version,
      platform: pre.platform,
      build: build.attributes?.version,
      uploadedDate: build.attributes?.uploadedDate,
      processingState: build.attributes?.processingState,
      expired: build.attributes?.expired,
      internal: detail.internalBuildState,
      external: detail.externalBuildState,
      notes,
    };
  });
}

/** The tag a version Y.M.(D*100+N) was built from, for a kind dev or beta; null when the version is of no release form. */
export function tagFor(version, kind) {
  const match = /^(\d{4})\.([1-9]\d?)\.([1-9]\d{2,3})$/.exec(version || '');
  if (!match) return null;
  const [, year, month, rest] = match;
  const day = Math.floor(Number(rest) / 100);
  const count = Number(rest) % 100;
  if (Number(month) > 12 || day < 1 || day > 31 || count < 1) return null;
  return `${kind}-${year}.${month}.${day}-${count}`;
}

/** The release tag of a build: from the "Release <tag>, version …" line Xcode Cloud puts at the top of its What to Test notes,
 *  else rebuilt from the version, as beta- when it was ever submitted for Beta App Review. */
export function releaseTag(build) {
  for (const text of build.notes || []) {
    const named = /^Release ((?:dev|beta)-\S+), version /.exec(text);
    if (named && tagFor(build.version, named[1].split('-')[0]) === named[1]) return named[1];
  }
  return tagFor(build.version, SUBMITTED_EXTERNALLY.has(build.external) ? 'beta' : 'dev');
}

function compareNumbers(a, b) {
  const left = String(a ?? '').split('.').map(Number);
  const right = String(b ?? '').split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

/** The newest installable build of each channel, as latest.json entries; a channel with none is left out. */
export function pickEntries(builds) {
  const installable = builds
    .filter((b) => b.processingState === 'VALID' && b.expired !== true && (!b.platform || b.platform === 'IOS') && releaseTag(b))
    .sort((a, b) => compareNumbers(b.version, a.version) || compareNumbers(b.build, a.build));
  const entry = (build) => build && { build, value: { tag: releaseTag(build), version: build.version } };
  return {
    dev: entry(installable.find((b) => b.internal === TESTING)),
    beta: entry(installable.find((b) => b.external === TESTING)),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** latest.json's next content and whether it changed; `previous` is the parsed file or null. */
export function nextContent(previous, picked, now = new Date()) {
  if (previous && previous.schema !== SCHEMA) throw new Error(`latest.json is schema ${JSON.stringify(previous.schema)}; this writes schema ${SCHEMA}`);
  const ios = { appleId: APP_ID, ...(previous?.ios || {}) };
  for (const channel of ['dev', 'beta']) if (picked[channel]) ios[channel] = picked[channel].value;
  const content = { schema: SCHEMA, ...(previous || {}), ios };
  const { updated: _old, ...before } = previous || {};
  const { updated: _new, ...after } = content;
  const changed = !previous || canonical(before) !== canonical(after);
  content.updated = changed || !previous?.updated ? now.toISOString().replace(/\.\d{3}Z$/, 'Z') : previous.updated;
  return { content, changed };
}

function describe(channel, entry, previous) {
  if (!entry) return `${channel}: no installable build, kept ${previous?.version ?? 'nothing'}`;
  const b = entry.build;
  return `${channel}: ${entry.value.tag} (${b.version}, build ${b.build}) internal=${b.internal} external=${b.external}`;
}

function parseArgs(argv) {
  const options = { dryRun: false, file: join(dirname(fileURLToPath(import.meta.url)), '..', 'latest.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--file') options.file = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}; use --dry-run and --file <path>`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId, ASC_PRIVATE_KEY: privateKey } = env;
  if (!keyId || !issuerId || !privateKey) throw new Error('set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY');
  const builds = await fetchBuilds({ token: makeToken({ keyId, issuerId, privateKey }) });
  const previous = existsSync(options.file) ? JSON.parse(readFileSync(options.file, 'utf8')) : null;
  const picked = pickEntries(builds);
  const { content, changed } = nextContent(previous, picked);
  const lines = [
    `${builds.length} unexpired builds; newest upload: ${builds[0] ? `${builds[0].version} (${builds[0].build}) ${builds[0].processingState} internal=${builds[0].internal} external=${builds[0].external}` : 'none'}`,
    describe('dev', picked.dev, previous?.ios?.dev),
    describe('beta', picked.beta, previous?.ios?.beta),
    changed ? 'latest.json changes' : 'latest.json is current',
  ];
  console.log(lines.join('\n'));
  const text = `${JSON.stringify(content, null, 2)}\n`;
  if (options.dryRun) {
    console.log(`--dry-run, would write:\n${text}`);
  } else if (changed) {
    writeFileSync(options.file, text);
  }
  const message = `latest.json: ${['dev', 'beta'].map((c) => content.ios[c] && `${c} ${content.ios[c].version}`).filter(Boolean).join(', ')}`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `changed=${changed && !options.dryRun}\nmessage=${message}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### latest.json${options.dryRun ? ' (dry run)' : ''}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
  return { content, changed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`latest-json: ${error.message}`);
    process.exit(1);
  });
}
