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

console.log(`\n=== All ${assertions} assertions passed ===`);
