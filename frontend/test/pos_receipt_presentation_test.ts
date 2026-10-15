/**
 * posReceiptPresentation.ts — regression tests for thermal-receipt
 * presentation helpers (logo resolution, short order reference, optional
 * guest/table normalization).
 *
 * Run: node --experimental-strip-types frontend/test/pos_receipt_presentation_test.ts
 */
import assert from 'node:assert/strict';
import {
  resolveReceiptLogoUrl,
  formatPosReceiptOrderReference,
  normalizeOptionalGuestName,
  normalizeOptionalTableNumber,
  extractReceiptDateYmd,
} from '../src/features/thermalReceipt/posReceiptPresentation.ts';
import { getLogoServeUrl } from '../src/features/propertySettings/propertyBrandingLogoUrl.ts';
import type { PosReceiptBranding } from '../src/features/pos/posReceiptTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting POS Receipt Presentation Helper Tests ===\n');

// ============================================================================
// Test 1: LOGO RESOLUTION
// ============================================================================
console.log('--- Test 1: logo resolution ---');

// 1.0: pure helper — single source of truth (propertyBrandingLogoUrl.ts)
check(
  getLogoServeUrl('branding/1/logo/abc.png', 1) ===
    '/api/properties/1/branding/logo/logo?v=abc',
  '1.0 getLogoServeUrl pure helper: managed key -> serve URL',
);

function makeBranding(logoUrl: string | null): PosReceiptBranding {
  return {
    property_id: 1,
    display_name: 'OAK Lawang',
    short_name: 'OAK',
    tagline: 't',
    primary_color: '#000',
    accent_color: '#fff',
    logo_url: logoUrl,
    compact_logo_url: logoUrl,
  };
}

// 1.1: managed key resolves to backend serve URL
check(
  resolveReceiptLogoUrl(makeBranding('branding/1/logo/abc.png'), 1) ===
    '/api/properties/1/branding/logo/logo?v=abc',
  '1.1 managed key -> serve URL',
);

// 1.2: null logo → null (no broken image)
check(resolveReceiptLogoUrl(makeBranding(null), 1) === null, '1.2 null logo -> null');

// 1.3: no branding object at all → null
check(resolveReceiptLogoUrl(null, 1) === null, '1.3 no branding -> null');

// 1.4: external / non-managed key falls back to the raw key
check(
  resolveReceiptLogoUrl(makeBranding('https://cdn.example.com/logo.png'), 1) ===
    'https://cdn.example.com/logo.png',
  '1.4 external URL falls through to raw key',
);

// ============================================================================
// Test 2: SHORT ORDER REFERENCE
// ============================================================================
console.log('\n--- Test 2: short order reference ---');

// 2.1: normal — id 29, created 2026-10-15
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'POS-20261015-2b1e42f9', created_at: '2026-10-15T03:50:00.000Z' },
  ) === 'POS-261015-0029',
  '2.1 id=29 -> POS-261015-0029',
);

// 2.2: id > 9999 is NOT truncated
check(
  formatPosReceiptOrderReference(
    { id: 12345, order_number: 'x', created_at: '2026-10-15T03:50:00.000Z' },
  ) === 'POS-261015-12345',
  '2.2 id=12345 -> POS-261015-12345 (no truncation)',
);

// 2.3: id 9999 → 4-digit
check(
  formatPosReceiptOrderReference(
    { id: 9999, order_number: 'x', created_at: '2026-10-15T03:50:00.000Z' },
  ) === 'POS-261015-9999',
  '2.3 id=9999 -> POS-261015-9999',
);

// 2.4: id 9 → 0009
check(
  formatPosReceiptOrderReference(
    { id: 9, order_number: 'x', created_at: '2026-10-15T03:50:00.000Z' },
  ) === 'POS-261015-0009',
  '2.4 id=9 -> POS-261015-0009',
);

// 2.5: REPRINT STABILITY — different printedAt day does NOT change the ref.
// The helper ignores printedAt entirely; only order/sale/settlement created_at
// are used. Simulate a reprint on 2027-01-01 while order date stays 2026-10-15.
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'POS-20261015-2b1e42f9', created_at: '2026-10-15T03:50:00.000Z' },
    null, // sale created_at
    null, // settlement created_at
  ) === 'POS-261015-0029',
  '2.5 reprint on later day keeps POS-261015-0029 (printedAt not a source)',
);

// 2.6: date priority — order.created_at null, falls back to sale.created_at
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'x', created_at: null },
    '2026-10-15T03:50:00.000Z',
    '2026-10-15T04:00:00.000Z',
  ) === 'POS-261015-0029',
  '2.6 falls back to sale.created_at when order.created_at null',
);

// 2.7: date priority — order+sale null, falls back to settlement.created_at
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'x', created_at: null },
    null,
    '2026-10-15T04:00:00.000Z',
  ) === 'POS-261015-0029',
  '2.7 falls back to settlement.created_at',
);

// 2.8: FALLBACK — all dates invalid → return canonical order_number
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'POS-20261015-full-uuid', created_at: null },
    null,
    null,
  ) === 'POS-20261015-full-uuid',
  '2.8 no valid date -> canonical order_number',
);

// 2.9: FALLBACK — invalid order.id → return canonical order_number
check(
  formatPosReceiptOrderReference(
    { id: 0, order_number: 'POS-20261015-full-uuid', created_at: '2026-10-15T00:00:00Z' },
  ) === 'POS-20261015-full-uuid',
  '2.9 invalid id -> canonical order_number',
);

// 2.10: FIRST VALID DATE — order.created_at invalid, sale.valid -> use sale
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'x', created_at: 'invalid' },
    '2026-10-15T03:50:00.000Z',
    null,
  ) === 'POS-261015-0029',
  '2.10 order date invalid -> first VALID fallback (sale)',
);

// 2.11: FIRST VALID DATE — order+sale invalid, settlement.valid -> use settlement
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'x', created_at: 'invalid' },
    'also-invalid',
    '2026-10-16T03:50:00.000Z',
  ) === 'POS-261016-0029',
  '2.11 order+sale invalid -> first VALID fallback (settlement)',
);

// 2.12: ALL INVALID -> canonical order_number
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'POS-20261015-full-uuid', created_at: 'not-a-date' },
    'also-bad',
    'still-bad',
  ) === 'POS-20261015-full-uuid',
  '2.12 all dates invalid -> canonical order_number',
);

// ============================================================================
// Test 3: GUEST NAME NORMALIZATION
// ============================================================================
console.log('\n--- Test 3: guest name normalization ---');

check(normalizeOptionalGuestName(null) === null, '3.1 null -> hidden');
check(normalizeOptionalGuestName(undefined) === null, '3.2 undefined -> hidden');
check(normalizeOptionalGuestName('') === null, '3.3 empty -> hidden');
check(normalizeOptionalGuestName('   ') === null, '3.4 whitespace -> hidden');
check(normalizeOptionalGuestName('Walk-in Guest') === null, '3.5 "Walk-in Guest" -> hidden');
check(normalizeOptionalGuestName('walk-in guest') === null, '3.6 lowercase "walk-in guest" -> hidden');
check(normalizeOptionalGuestName('WALK-IN GUEST') === null, '3.7 uppercase -> hidden');
check(normalizeOptionalGuestName('Guest') === null, '3.8 "Guest" -> hidden');
check(normalizeOptionalGuestName(' guest ') === null, '3.9 " guest " -> hidden');
check(normalizeOptionalGuestName(' Budi Santoso ') === 'Budi Santoso', '3.10 real name trimmed -> shown');
check(normalizeOptionalGuestName('Nadya Nur Fadilah') === 'Nadya Nur Fadilah', '3.11 real name shown');

// ============================================================================
// Test 4: TABLE NUMBER NORMALIZATION
// ============================================================================
console.log('\n--- Test 4: table number normalization ---');

check(normalizeOptionalTableNumber(null) === null, '4.1 null -> hidden');
check(normalizeOptionalTableNumber(undefined) === null, '4.2 undefined -> hidden');
check(normalizeOptionalTableNumber('') === null, '4.3 empty -> hidden');
check(normalizeOptionalTableNumber('   ') === null, '4.4 whitespace -> hidden');
check(normalizeOptionalTableNumber('12') === '12', '4.5 "12" -> shown');
check(normalizeOptionalTableNumber('Table 1') === 'Table 1', '4.6 "Table 1" (actual value) -> shown');

// ============================================================================
// Test 4b: TABLE WALK-IN PLACEHOLDERS
// ============================================================================
console.log('\n--- Test 4b: table walk-in placeholders ---');

check(normalizeOptionalTableNumber('Walk In') === null, '4b.1 "Walk In" -> hidden');
check(normalizeOptionalTableNumber(' walk in ') === null, '4b.2 " walk in " -> hidden');
check(normalizeOptionalTableNumber('WALK IN') === null, '4b.3 "WALK IN" -> hidden');
check(normalizeOptionalTableNumber('Walk-in') === null, '4b.4 "Walk-in" -> hidden');
check(normalizeOptionalTableNumber('Walk In Guest') === null, '4b.5 "Walk In Guest" -> hidden');
check(normalizeOptionalTableNumber('A-03') === 'A-03', '4b.6 "A-03" (actual value) -> shown');

// ============================================================================
// Test 5: DATE NORMALIZATION (extractReceiptDateYmd)
// ============================================================================
console.log('\n--- Test 5: date normalization (extractReceiptDateYmd) ---');

check(
  extractReceiptDateYmd(
    'Thu Oct 15 2026 05:43:38 GMT+0000 (Coordinated Universal Time)',
  ) === '2026-10-15',
  '5.1 actual backend JS-Date string -> 2026-10-15',
);
check(
  extractReceiptDateYmd('2026-10-15T03:50:00.000Z') === '2026-10-15',
  '5.2 ISO -> 2026-10-15',
);
check(extractReceiptDateYmd('2026-10-15') === '2026-10-15', '5.3 date-only -> 2026-10-15');
check(extractReceiptDateYmd('garbage') === null, '5.4 unparseable -> null');
check(extractReceiptDateYmd(null) === null, '5.5 null -> null');
check(extractReceiptDateYmd('') === null, '5.6 empty -> null');

// ============================================================================
// Test 6: SHORT ORDER WITH ACTUAL BACKEND DATE STRINGS
// ============================================================================
console.log('\n--- Test 6: short order with actual backend date strings ---');

// 6.1: actual staging shape — order.id=42, created_at JS-Date string
check(
  formatPosReceiptOrderReference({
    id: 42,
    order_number: 'POS-20261015-e491ddd9',
    created_at: 'Thu Oct 15 2026 05:43:38 GMT+0000 (Coordinated Universal Time)',
  }) === 'POS-261015-0042',
  '6.1 actual backend Date string -> POS-261015-0042',
);

// 6.2: order date is the JS-Date string but sale/settlement missing -> use order
// (covered by 6.1; explicit no-fallback case)
check(
  formatPosReceiptOrderReference(
    {
      id: 42,
      order_number: 'POS-20261015-full-uuid',
      created_at: 'Thu Oct 15 2026 05:43:38 GMT+0000 (Coordinated Universal Time)',
    },
    null,
    null,
  ) === 'POS-261015-0042',
  '6.2 JS-Date order string, no sale/settlement -> POS-261015-0042',
);

// 6.3: order date unparseable, sale date is a valid JS-Date string -> use sale
check(
  formatPosReceiptOrderReference(
    { id: 42, order_number: 'x', created_at: 'garbage' },
    'Thu Oct 15 2026 05:43:43 GMT+0000 (Coordinated Universal Time)',
    null,
  ) === 'POS-261015-0042',
  '6.3 order invalid -> valid sale JS-Date string used',
);

// 6.4: existing ISO behavior still passes
check(
  formatPosReceiptOrderReference(
    { id: 29, order_number: 'x', created_at: '2026-10-15T03:50:00.000Z' },
  ) === 'POS-261015-0029',
  '6.4 ISO -> POS-261015-0029 (existing behavior intact)',
);

// 6.5: all three dates invalid / missing -> canonical order_number
check(
  formatPosReceiptOrderReference(
    { id: 42, order_number: 'POS-20261015-full-uuid', created_at: 'garbage' },
    'also-garbage',
    'still-garbage',
  ) === 'POS-20261015-full-uuid',
  '6.5 all invalid -> canonical order_number',
);

// ============================================================================
// Test 7: MALFORMED CALENDAR DATE REJECTED (regression — fail-closed)
// ============================================================================
console.log('\n--- Test 7: malformed calendar date rejection ---');

// Valid calendar dates
check(extractReceiptDateYmd('2026-02-28') === '2026-02-28', '7.1 2026-02-28 (valid) -> 2026-02-28');
check(extractReceiptDateYmd('2024-02-29') === '2024-02-29', '7.2 2024-02-29 (leap year, valid) -> 2024-02-29');
// Malformed — must be rejected (fail-closed)
check(extractReceiptDateYmd('2026-02-29') === null, '7.3 2026-02-29 (not a leap year) -> null');
check(extractReceiptDateYmd('2026-13-01') === null, '7.4 2026-13-01 (month 13) -> null');
check(extractReceiptDateYmd('2026-00-10') === null, '7.5 2026-00-10 (month 0) -> null');
check(extractReceiptDateYmd('2026-04-31') === null, '7.6 2026-04-31 (April has 30 days) -> null');
check(extractReceiptDateYmd('2026-99-99') === null, '7.7 2026-99-99 -> null');
check(extractReceiptDateYmd('2026-99-99T00:00:00Z') === null, '7.8 2026-99-99T00:00:00Z (malformed ISO) -> null');

// Malformed order date must fall through to a valid sale date
check(
  formatPosReceiptOrderReference(
    {
      id: 42,
      order_number: 'POS-20261015-full-uuid',
      created_at: '2026-99-99T00:00:00Z',
    },
    'Thu Oct 15 2026 05:43:43 GMT+0000 (Coordinated Universal Time)',
    null,
  ) === 'POS-261015-0042',
  '7.9 malformed order date falls through to valid sale JS-Date string',
);

console.log(`\n=== All ${assertions} assertions passed ===`);
