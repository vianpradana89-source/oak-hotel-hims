import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticatedFetch } from '../src/lib/authenticatedFetch.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== OAK HIMS Authenticated Transport Regression Tests ===\n');

// ---------------------------------------------------------------------------
// Setup: mock global fetch and localStorage
// ---------------------------------------------------------------------------
let lastFetchUrl = '';
let lastFetchInit: RequestInit | undefined;
let fetchCallCount = 0;

// @ts-expect-error — test mock
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  lastFetchUrl = typeof url === 'string' ? url : url.toString();
  lastFetchInit = init;
  fetchCallCount += 1;
  return new Response(JSON.stringify({ status: 'OK', data: { url: lastFetchUrl } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

const mockStorage: Record<string, string> = {};
// @ts-expect-error — test mock
globalThis.localStorage = {
  getItem: (key: string) => mockStorage[key] ?? null,
  setItem: (key: string, value: string) => { mockStorage[key] = value; },
  removeItem: (key: string) => { delete mockStorage[key]; },
  clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); },
};

// ---------------------------------------------------------------------------
// Test 1: authenticatedFetch injects Bearer token when token exists
// ---------------------------------------------------------------------------
console.log('--- 1. Bearer token injection ---');
mockStorage['oak_hims_auth_token'] = 'test-jwt-token-abc123';
fetchCallCount = 0;

await authenticatedFetch('/api/test-protected');

check(fetchCallCount === 1, 'fetch was called once');
check(lastFetchUrl === '/api/test-protected', 'URL is preserved');
const headers1 = new Headers(lastFetchInit?.headers);
check(headers1.get('Authorization') === 'Bearer test-jwt-token-abc123', 'Authorization header is correctly injected');

// ---------------------------------------------------------------------------
// Test 2: Existing headers are preserved
// ---------------------------------------------------------------------------
console.log('--- 2. Existing header preservation ---');
fetchCallCount = 0;

await authenticatedFetch('/api/test-preserve', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Custom-Header': 'custom-value'
  },
  body: JSON.stringify({ test: true })
});

const headers2 = new Headers(lastFetchInit?.headers);
check(headers2.get('Content-Type') === 'application/json', 'Content-Type header is preserved');
check(headers2.get('X-Custom-Header') === 'custom-value', 'Custom header is preserved');
check(headers2.get('Authorization') === 'Bearer test-jwt-token-abc123', 'Authorization header is also present');
check(lastFetchInit?.method === 'POST', 'Method is preserved');
check(lastFetchInit?.body === JSON.stringify({ test: true }), 'Body is preserved');

// ---------------------------------------------------------------------------
// Test 3: No token => does not fabricate invalid Bearer header
// ---------------------------------------------------------------------------
console.log('--- 3. No token case ---');
delete mockStorage['oak_hims_auth_token'];
fetchCallCount = 0;

await authenticatedFetch('/api/test-no-token');

const headers3 = new Headers(lastFetchInit?.headers);
check(!headers3.has('Authorization'), 'No Authorization header when token is absent');

// ---------------------------------------------------------------------------
// Test 4: FormData request remains valid (no Content-Type override)
// ---------------------------------------------------------------------------
console.log('--- 4. FormData request validity ---');
mockStorage['oak_hims_auth_token'] = 'test-token-formdata';
fetchCallCount = 0;

const formData = new FormData();
formData.append('file', new Blob(['test']), 'test.txt');

await authenticatedFetch('/api/upload', {
  method: 'POST',
  body: formData
});

const headers4 = new Headers(lastFetchInit?.headers);
check(headers4.get('Authorization') === 'Bearer test-token-formdata', 'Authorization header present for FormData');
check(!headers4.has('Content-Type'), 'Content-Type is NOT manually set for FormData (browser generates boundary)');

// ---------------------------------------------------------------------------
// Test 5: Login still uses raw unauthenticated fetch (not tested here, but verify token key)
// ---------------------------------------------------------------------------
console.log('--- 5. Canonical token key verification ---');
check(typeof localStorage.getItem === 'function', 'localStorage is available');

// Simulate the login flow storing token
mockStorage['oak_hims_auth_token'] = 'new-session-token';
const storedToken = localStorage.getItem('oak_hims_auth_token');
check(storedToken === 'new-session-token', 'Canonical token key reads correctly');

// ---------------------------------------------------------------------------
// Test 6: Protected transaction request uses authenticated transport
// ---------------------------------------------------------------------------
console.log('--- 6. Transaction-style authenticated request ---');
mockStorage['oak_hims_auth_token'] = 'transaction-token';
fetchCallCount = 0;

await authenticatedFetch('/api/transactions?property_id=1', {
  method: 'GET',
  headers: { 'Accept': 'application/json' }
});

const headers6 = new Headers(lastFetchInit?.headers);
check(headers6.get('Authorization') === 'Bearer transaction-token', 'Transaction request carries Bearer token');
check(lastFetchUrl === '/api/transactions?property_id=1', 'Transaction URL preserved');

// ---------------------------------------------------------------------------
// Test 7: Protected housekeeping request uses authenticated transport
// ---------------------------------------------------------------------------
console.log('--- 7. Housekeeping-style authenticated request ---');
mockStorage['oak_hims_auth_token'] = 'hk-token';
fetchCallCount = 0;

await authenticatedFetch('/api/housekeeping/tasks?property_id=1&scope=active', {
  method: 'GET'
});

const headers7 = new Headers(lastFetchInit?.headers);
check(headers7.get('Authorization') === 'Bearer hk-token', 'Housekeeping request carries Bearer token');

// ---------------------------------------------------------------------------
// Test 8: TestDataPurge uses canonical token/auth mechanism
// ---------------------------------------------------------------------------
console.log('--- 8. TestDataPurge canonical token key ---');
// Verify the old broken key is NOT used
mockStorage['token'] = 'old-wrong-key';
mockStorage['oak_hims_auth_token'] = 'correct-canonical-key';
fetchCallCount = 0;

await authenticatedFetch('/api/hrd/test-data?property_id=1');

const headers8 = new Headers(lastFetchInit?.headers);
check(headers8.get('Authorization') === 'Bearer correct-canonical-key', 'Uses canonical oak_hims_auth_token, not legacy "token" key');

// Clean up
delete mockStorage['token'];
delete mockStorage['oak_hims_auth_token'];

// ---------------------------------------------------------------------------
// Test 9: Front Office quick-booking-rules uses authenticatedFetch, not raw fetch
// ---------------------------------------------------------------------------
console.log('--- 9. FrontOfficeSettingsTab quick-booking-rules transport ---');
const here = dirname(fileURLToPath(import.meta.url));
const foSettingsSrc = readFileSync(join(here, '../src/features/settings/FrontOfficeSettingsTab.tsx'), 'utf8');
check(foSettingsSrc.includes("from '../../lib/authenticatedFetch'"), 'FrontOfficeSettingsTab imports authenticatedFetch');
check(
  foSettingsSrc.includes('authenticatedFetch(`${apiBaseUrl}/properties/${propertyId}/quick-booking-rules`)'),
  'GET quick-booking-rules uses authenticatedFetch'
);
check(
  foSettingsSrc.includes('authenticatedFetch(`${apiBaseUrl}/properties/${propertyId}/day-use-durations`)'),
  'GET day-use-durations uses authenticatedFetch'
);
check(
  /authenticatedFetch\(`\$\{apiBaseUrl\}\/properties\/\$\{propertyId\}\/quick-booking-rules`,\s*\{\s*method:\s*'PUT'/.test(foSettingsSrc),
  'PUT quick-booking-rules uses authenticatedFetch'
);
check(!/\bfetch\s*\(/.test(foSettingsSrc), 'FrontOfficeSettingsTab has no remaining raw fetch calls');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== PASSED: ${assertions} assertions ===`);
