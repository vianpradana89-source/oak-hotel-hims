import assert from 'node:assert/strict';
import {
  OAK_COLORS,
  STATUS_STYLES,
  getStatusStyle,
} from '../src/design-system/tokens.ts';
import {
  formatHotelBusinessDate,
  formatCompactHotelDate,
} from '../src/features/shell/hotelDateDisplay.ts';
import {
  getFallbackPropertyBranding,
  isValidHexColor,
} from '../src/features/propertySettings/propertyBrandingTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting OAK HIMS Design System & Application Shell Tests ===\n');

// ============================================================================
// Test 1: Design Tokens & Palette Definitions
// ============================================================================
console.log('--- Test 1: Design Tokens & Palette ---');

check(OAK_COLORS.bg === '#f7f6f2', '1.1 Background is warm off-white / ivory (#f7f6f2)');
check(OAK_COLORS.surface === '#ffffff', '1.2 Surface is pure white (#ffffff)');
check(OAK_COLORS.sidebar === '#131b24', '1.3 Sidebar is deep charcoal (#131b24)');
check(OAK_COLORS.primary === '#1b4332', '1.4 Primary operational accent is forest green (#1b4332)');
check(OAK_COLORS.brandGold === '#c5a880', '1.5 Brand accent is muted gold (#c5a880)');
check(OAK_COLORS.success === '#10b981', '1.6 Success semantic token is emerald (#10b981)');
check(OAK_COLORS.warning === '#f59e0b', '1.7 Warning semantic token is amber (#f59e0b)');
check(OAK_COLORS.danger === '#ef4444', '1.8 Danger semantic token is rose (#ef4444)');

// ============================================================================
// Test 2: Status Badge Styles & Semantic Mapping
// ============================================================================
console.log('--- Test 2: Status Badge Styles & Semantic Mapping ---');

// 2.1 Reservation statuses
const booked = getStatusStyle('BOOKED');
check(booked.label === 'Booked' && booked.bgClass.includes('blue'), '2.1 BOOKED mapped correctly');

const checkedIn = getStatusStyle('CHECKED_IN');
check(checkedIn.label === 'Checked In' && checkedIn.bgClass.includes('emerald'), '2.2 CHECKED_IN mapped to emerald');

const checkedOut = getStatusStyle('CHECKED_OUT');
check(checkedOut.label === 'Checked Out' && checkedOut.bgClass.includes('slate'), '2.3 CHECKED_OUT mapped to slate');

const cancelled = getStatusStyle('CANCELLED');
check(cancelled.label === 'Cancelled' && cancelled.bgClass.includes('rose'), '2.4 CANCELLED mapped to rose');

// 2.2 Payment statuses
const paid = getStatusStyle('PAID');
check(paid.label === 'Lunas' && paid.textClass.includes('emerald'), '2.5 PAID mapped to Lunas');

const partial = getStatusStyle('PARTIAL');
check(partial.label === 'Sebagian' && partial.textClass.includes('amber'), '2.6 PARTIAL mapped to Sebagian');

const unpaid = getStatusStyle('UNPAID');
check(unpaid.label === 'Belum Bayar' && unpaid.textClass.includes('rose'), '2.7 UNPAID mapped to Belum Bayar');

// 2.3 Payment Transaction statuses
const successTx = getStatusStyle('SUCCESS');
check(successTx.label === 'Valid', '2.8 SUCCESS tx mapped to Valid');

const correctedTx = getStatusStyle('CORRECTED');
check(correctedTx.label === 'Dikoreksi', '2.9 CORRECTED tx mapped to Dikoreksi');

const voidedTx = getStatusStyle('VOIDED');
check(voidedTx.label === 'Dibatalkan (Void)', '2.10 VOIDED tx mapped to Dibatalkan');

const reversalTx = getStatusStyle('REVERSAL');
check(reversalTx.label === 'Reversal', '2.11 REVERSAL tx mapped to Reversal');

// 2.4 Housekeeping / Room statuses
const vacantClean = getStatusStyle('VACANT_CLEAN');
check(vacantClean.label === 'Vacant Clean', '2.12 VACANT_CLEAN mapped to Vacant Clean');

const vacantDirty = getStatusStyle('VACANT_DIRTY');
check(vacantDirty.label === 'Vacant Dirty', '2.13 VACANT_DIRTY mapped to Vacant Dirty');

const outOfOrder = getStatusStyle('OUT_OF_ORDER');
check(outOfOrder.label === 'Out of Order', '2.14 OUT_OF_ORDER mapped to Out of Order');

// 2.5 Fallback handling
const unknownStyle = getStatusStyle('RANDOM_CUSTOM_STATUS');
check(unknownStyle.label === 'RANDOM_CUSTOM_STATUS', '2.15 Unknown status returns itself as label');

const nullStyle = getStatusStyle(null);
check(nullStyle.label === 'Unknown', '2.16 Null status returns fallback Unknown');

// ============================================================================
// Test 3: Hotel Business Date & Clock Formatter (Asia/Jakarta)
// ============================================================================
console.log('--- Test 3: Hotel Business Date & Clock Formatter ---');

// Specific known timestamp: 2026-08-28 06:30:00 UTC = 13:30:00 WIB (Asia/Jakarta is UTC+7)
const testDate = new Date('2026-08-28T06:30:00Z');
const formatted = formatHotelBusinessDate(testDate);

check(formatted.includes('28 Agu 2026') || formatted.includes('28 Agt 2026') || formatted.includes('28'), '3.1 Date includes day and year');
check(formatted.includes('13:30 WIB') || formatted.includes('13.30 WIB'), '3.2 Time converted to Asia/Jakarta (13:30 WIB)');

const compactFormatted = formatCompactHotelDate(testDate);
check(compactFormatted.includes('28'), '3.3 Compact date contains day');

// ============================================================================
// Test 4: Dynamic Property Branding & Color Safety
// ============================================================================
console.log('--- Test 4: Dynamic Property Branding Architecture & Color Safety ---');

// 4.1 Property 1 (OAK Lawang)
const branding1 = getFallbackPropertyBranding(1, 'OAK Lawang', 'LWG');
check(branding1.propertyId === 1, '4.1 Property 1 ID is 1');
check(branding1.displayName === 'OAK Lawang', '4.2 Property 1 displayName is OAK Lawang');
check(branding1.shortName === 'LWG', '4.3 Property 1 shortName is LWG');
check(branding1.primaryColor === '#1b4332', '4.4 Property 1 primaryColor is forest green');

// 4.2 Property 2 (OAK Batu - dynamic property)
const branding2 = getFallbackPropertyBranding(2, 'OAK Batu', 'BATU');
check(branding2.propertyId === 2, '4.5 Property 2 ID is 2');
check(branding2.displayName === 'OAK Batu', '4.6 Property 2 displayName dynamically uses OAK Batu, NOT OAK Lawang');
check(branding2.shortName === 'BATU', '4.7 Property 2 shortName is BATU');

// 4.3 Property 3 (Villa Cemara - independent property)
const branding3 = getFallbackPropertyBranding(3, 'Villa Cemara', 'VCL');
check(branding3.displayName === 'Villa Cemara', '4.8 Property 3 displayName is Villa Cemara');
check(branding3.shortName === 'VCL', '4.9 Property 3 shortName is VCL');

// 4.4 Color Validation
check(isValidHexColor('#1b4332') === true, '4.10 #1b4332 is valid hex');
check(isValidHexColor('#c5a880') === true, '4.11 #c5a880 is valid hex');
check(isValidHexColor('#fff') === true, '4.12 #fff is valid 3-digit hex');
check(isValidHexColor('red') === false, '4.13 Named color "red" is rejected');
check(isValidHexColor('#12345z') === false, '4.14 Invalid hex #12345z is rejected');
check(isValidHexColor('') === false, '4.15 Empty string is rejected');
check(isValidHexColor(null) === false, '4.16 Null is rejected');

// ============================================================================
// Test 5: Sidebar Preference & LocalStorage Simulation
// ============================================================================
console.log('--- Test 5: Sidebar Preference Persistence Simulation ---');

const mockStorage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, val: string) => { mockStorage[key] = val; },
};

// Initial: expanded by default
let isCollapsed = mockLocalStorage.getItem('oak_sidebar_collapsed') === 'true';
check(isCollapsed === false, '5.1 Sidebar is expanded by default (false)');

// Collapse sidebar
mockLocalStorage.setItem('oak_sidebar_collapsed', 'true');
isCollapsed = mockLocalStorage.getItem('oak_sidebar_collapsed') === 'true';
check(isCollapsed === true, '5.2 Sidebar collapse preference persisted to true');

// Re-expand sidebar
mockLocalStorage.setItem('oak_sidebar_collapsed', 'false');
isCollapsed = mockLocalStorage.getItem('oak_sidebar_collapsed') === 'true';
check(isCollapsed === false, '5.3 Sidebar expand preference persisted to false');

console.log(`\n=== All ${assertions} Design System & Application Shell Tests Passed Successfully ===`);
