#!/usr/bin/env node

/**
 * Manual integration test for updatePreferredWebexSite and getMeetingSiteList.
 *
 * Usage:
 *   # From repo root, with .env sourced:
 *   source .env
 *   node -e "require('@babel/register')({extensions:['.js','.ts'],sourceMaps:true}); \
 *     require('@webex/env-config-legacy'); \
 *     require('./packages/@webex/internal-plugin-user/test/integration/manual-site-test.js');"
 *
 *   # Or with a specific bearer token (from a user with multiple webex sites):
 *   WEBEX_ACCESS_TOKEN="eyJ..." node -e "require('@babel/register')(...); ..."
 *
 * What this tests:
 *   1. buildMeetingSiteList() - pure function that merges/filters/sorts site arrays
 *   2. buildPreferredSiteBody() - pure function that constructs SCIM PATCH body
 *   3. Real SCIM PATCH via @webex/test-users#setPreferredSite (validates network path)
 *
 * To test with a user that has multiple sites (e.g. from web.webex.com):
 *   1. Log into web.webex.com
 *   2. Open DevTools → Network → find any successful API request
 *   3. Copy the Authorization header value (Bearer eyJ...)
 *   4. Run: WEBEX_ACCESS_TOKEN="eyJ..." node -e "..."
 */

/* eslint-disable no-console */

// Stub Mocha globals so @webex/test-helper-test-users loads
if (typeof after === 'undefined') global.after = () => {};
if (typeof before === 'undefined') global.before = () => {};
if (typeof afterEach === 'undefined') global.afterEach = () => {};
if (typeof beforeEach === 'undefined') global.beforeEach = () => {};

const {setPreferredSite} = require('@webex/test-users');
const {
  buildPreferredSiteBody,
  buildMeetingSiteList,
  SCIM_SCHEMAS,
} = require('@webex/internal-plugin-user');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  }
}

async function testPureFunctions() {
  console.log('\n═══ Test 1: buildMeetingSiteList ═══');
  const user = {
    linkedTrainSiteNames: ['acme.webex.com', 'demo.webex.com'],
    trainSiteNames: ['test.webex.com', 'attendee#only.webex.com'],
  };
  const sites = buildMeetingSiteList(user);

  assert(Array.isArray(sites), 'returns an array');
  assert(sites.length === 3, `filters # sites (got ${sites.length}, expected 3)`);
  assert(!sites.includes('attendee#only.webex.com'), '# site filtered out');
  assert(
    JSON.stringify(sites) ===
      JSON.stringify(['acme.webex.com', 'demo.webex.com', 'test.webex.com']),
    'sorted alphabetically'
  );

  assert(buildMeetingSiteList(null).length === 0, 'null returns empty array');
  assert(buildMeetingSiteList(undefined).length === 0, 'undefined returns empty array');
  assert(buildMeetingSiteList({}).length === 0, 'empty object returns empty array');

  console.log('\n═══ Test 2: buildPreferredSiteBody ═══');
  const bodyAddOnly = buildPreferredSiteBody('new.webex.com');

  assert(bodyAddOnly.schemas.length === 2, 'has 2 SCIM schemas');
  assert(bodyAddOnly.schemas[0] === 'urn:scim:schemas:core:1.0', 'schema[0] is core:1.0');
  assert(bodyAddOnly.userPreferences.length === 1, 'add-only has 1 preference');
  assert(
    bodyAddOnly.userPreferences[0].value === '"preferredWebExSite":"new.webex.com"',
    'value format is correct'
  );

  const bodyDeleteAdd = buildPreferredSiteBody('new.webex.com', 'old.webex.com');

  assert(bodyDeleteAdd.userPreferences.length === 2, 'delete+add has 2 preferences');
  assert(bodyDeleteAdd.userPreferences[0].operation === 'delete', 'first pref is delete');
  assert(
    bodyDeleteAdd.userPreferences[1].value === '"preferredWebExSite":"new.webex.com"',
    'second pref is add'
  );

  console.log('\n═══ Test 3: SCIM_SCHEMAS constant ═══');
  assert(SCIM_SCHEMAS.length === 2, 'SCIM_SCHEMAS has 2 entries');
  assert(
    SCIM_SCHEMAS[1] === 'urn:scim:schemas:extension:cisco:commonidentity:1.0',
    'schema[1] is commonidentity:1.0'
  );
}

async function testNetworkCall() {
  let testUsers;

  try {
    testUsers = require('@webex/test-helper-test-users');
  } catch (e) {
    console.log('\n═══ Test 4: SCIM PATCH (skipped — test-helper-test-users not available) ═══');

    return;
  }

  console.log('\n═══ Test 4: Real SCIM PATCH to identity service ═══');
  console.log('  Creating test user...');

  const users = await testUsers.create({count: 1});
  const user = users[0];

  console.log(`  Created: ${user.email} (org: ${user.orgId})`);

  const identityServiceUrl = process.env.IDENTITY_BASE_URL || 'https://identitybts.webex.com';

  console.log(`  Identity service: ${identityServiceUrl}`);
  console.log('  Making SCIM PATCH...');

  const result = await setPreferredSite({
    authorization: user.token.authorization || `Bearer ${user.token.access_token}`,
    identityServiceUrl,
    orgId: user.orgId,
    userId: user.id,
    preferredSite: 'manual-test.webex.com',
  });

  assert(result.statusCode === 200, `SCIM PATCH returned ${result.statusCode}`);
  assert(!!result.body, 'response has body');
  assert(Array.isArray(result.body.userPreferences), 'userPreferences is array');

  const hasPref = result.body.userPreferences.some((p) => {
    const val = typeof p === 'string' ? p : p.value || '';

    return val.includes('preferredWebExSite');
  });

  assert(hasPref, 'preferredWebExSite present in response');
  console.log(`  Response: ${JSON.stringify(result.body.userPreferences)}`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  internal-plugin-user: Site Selection Integration Test  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  await testPureFunctions();

  try {
    await testNetworkCall();
  } catch (e) {
    console.error(`  ❌ Network test failed: ${e.message}`);
    failed++;
  }

  console.log('\n══════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
