import assert from 'node:assert/strict';
import {
  calculateDaysBetween,
  deriveBehavioralSegment,
  filterGuestsBySegment,
  filterGuestsBySearch,
  paginateGuests,
  formatDateIndonesian,
  formatStayPeriodDisplay,
  getVipBadgeClass,
  getSegmentBadgeClass,
  getRoleBadgeClass,
  getRelationFidelityBadgeClass,
  getIdentityVerifiedBadgeClass
} from '../src/features/guests/guestCrmHelpers.ts';
import type { Guest } from '../src/features/guests/guestTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Guest CRM Helpers Tests ===\n');

// 1. calculateDaysBetween
console.log('--- Test 1: calculateDaysBetween ---');
check(calculateDaysBetween('2026-08-01', '2026-08-10') === 9, '1.1 9 days between 1st and 10th');
check(calculateDaysBetween('2026-08-10', '2026-08-01') === -9, '1.2 -9 days in reverse order');
check(calculateDaysBetween('2026-08-10', '2026-08-10') === 0, '1.3 0 days on same date');

// 2. deriveBehavioralSegment
console.log('\n--- Test 2: deriveBehavioralSegment ---');
const hotelDate = '2026-08-27';

const guestRepeat: Guest = {
  id: 1,
  full_name: 'Pak Ahmad',
  vip_status: 'STANDARD',
  visit_count: 3,
  first_stay: '2025-01-01',
  last_stay: '2026-08-20'
};
check(deriveBehavioralSegment(guestRepeat, hotelDate) === 'REPEAT', '2.1 guest with 3 visits is REPEAT');

const guestNew: Guest = {
  id: 2,
  full_name: 'Ibu Dewi',
  vip_status: 'STANDARD',
  visit_count: 1,
  first_stay: '2026-08-15',
  last_stay: '2026-08-17'
};
check(deriveBehavioralSegment(guestNew, hotelDate) === 'BARU', '2.2 guest with 1 visit 12 days ago is BARU');

const guestDormant: Guest = {
  id: 3,
  full_name: 'Pak Budi',
  vip_status: 'STANDARD',
  visit_count: 1,
  first_stay: '2026-01-10',
  last_stay: '2026-01-12'
};
check(deriveBehavioralSegment(guestDormant, hotelDate) === 'TIDAK_AKTIF', '2.3 guest stayed >90 days ago is TIDAK_AKTIF');

const guestRegular: Guest = {
  id: 4,
  full_name: 'Pak Charlie',
  vip_status: 'STANDARD',
  visit_count: 1,
  first_stay: '2026-07-01',
  last_stay: '2026-07-03'
};
check(deriveBehavioralSegment(guestRegular, hotelDate) === 'REGULER', '2.4 guest stayed 55 days ago is REGULER');

// 3. filterGuestsBySegment
console.log('\n--- Test 3: filterGuestsBySegment ---');
const allGuests: Guest[] = [
  { id: 1, full_name: 'A', vip_status: 'VIP', visit_count: 2 },
  { id: 2, full_name: 'B', vip_status: 'VVIP', visit_count: 1, first_stay: '2026-08-20' },
  { id: 3, full_name: 'C', vip_status: 'STANDARD', visit_count: 1, first_stay: '2026-01-01', last_stay: '2026-01-02' }
];

check(filterGuestsBySegment(allGuests, 'SEMUA', hotelDate).length === 3, '3.1 SEMUA returns 3');
check(filterGuestsBySegment(allGuests, 'VIP', hotelDate).length === 1, '3.2 VIP returns 1');
check(filterGuestsBySegment(allGuests, 'VVIP', hotelDate).length === 1, '3.3 VVIP returns 1');
check(filterGuestsBySegment(allGuests, 'REPEAT', hotelDate).length === 1, '3.4 REPEAT returns 1');
check(filterGuestsBySegment(allGuests, 'BARU', hotelDate).length === 1, '3.5 BARU returns 1 (id 2)');
check(filterGuestsBySegment(allGuests, 'TIDAK_AKTIF', hotelDate).length === 1, '3.6 TIDAK_AKTIF returns 1 (id 3)');

// 4. filterGuestsBySearch
console.log('\n--- Test 4: filterGuestsBySearch ---');
const searchList: Guest[] = [
  { id: 1, full_name: 'Budi Santoso', phone: '08123456789', email: 'budi@test.com', vip_status: 'STANDARD' },
  { id: 2, full_name: 'Siti Aminah', preferred_name: 'Mimi', phone: '08987654321', email: 'siti@test.com', vip_status: 'STANDARD' }
];
check(filterGuestsBySearch(searchList, 'budi').length === 1, '4.1 Search by full_name');
check(filterGuestsBySearch(searchList, 'mimi').length === 1, '4.2 Search by preferred_name');
check(filterGuestsBySearch(searchList, '0898').length === 1, '4.3 Search by phone');
check(filterGuestsBySearch(searchList, 'budi@test').length === 1, '4.4 Search by email');
check(filterGuestsBySearch(searchList, '').length === 2, '4.5 Empty search returns all');

// 5. paginateGuests
console.log('\n--- Test 5: paginateGuests ---');
const paginated = paginateGuests(searchList, 1, 1);
check(paginated.items.length === 1, '5.1 items count on page 1 of size 1');
check(paginated.total === 2, '5.2 total is 2');
check(paginated.totalPages === 2, '5.3 totalPages is 2');
check(paginated.startRecord === 1, '5.4 startRecord is 1');
check(paginated.endRecord === 1, '5.5 endRecord is 1');

// 6. Formatting & Badges
console.log('\n--- Test 6: Formatting & Badges ---');
check(formatDateIndonesian('2026-08-27') === '27/08/2026', '6.1 Indonesian date format');
check(formatDateIndonesian(null) === '—', '6.2 null date returns em-dash');
check(formatStayPeriodDisplay('2026-08-10', '2026-08-13').includes('3 malam'), '6.3 Stay period shows 3 nights');
check(getVipBadgeClass('VVIP').label === 'VVIP', '6.4 VVIP badge label');
check(getVipBadgeClass('VIP').label === 'VIP', '6.5 VIP badge label');
check(getRoleBadgeClass('PRIMARY_GUEST').label === 'Tamu Utama', '6.6 Primary guest role label');

// 7. Relation Fidelity & Identity Verification Semantics Gate
console.log('\n--- Test 7: Relation Fidelity & Identity Verification Semantics ---');
const legacyFidelity = getRelationFidelityBadgeClass(true);
check(legacyFidelity.label === 'Data Legacy', '7.1 is_legacy_inferred=true maps to "Data Legacy"');

const explicitFidelity = getRelationFidelityBadgeClass(false);
check(explicitFidelity.label === 'Relasi Tercatat', '7.2 is_legacy_inferred=false maps to "Relasi Tercatat"');
check(!explicitFidelity.label.toLowerCase().includes('tervalidasi'), '7.3 Relasi Tercatat does NOT contain "Tervalidasi"');
check(!explicitFidelity.label.toLowerCase().includes('verified'), '7.4 Relasi Tercatat does NOT contain "Verified"');

check(getIdentityVerifiedBadgeClass(false) === null, '7.5 identity_verified=false returns null (no verified badge)');
check(getIdentityVerifiedBadgeClass(undefined) === null, '7.6 identity_verified=undefined returns null');
const verifiedBadge = getIdentityVerifiedBadgeClass(true);
check(verifiedBadge !== null && verifiedBadge.label === 'Identitas Terverifikasi', '7.7 identity_verified=true returns "Identitas Terverifikasi"');

console.log(`\n================================`);
console.log(`Summary: ${assertions} assertions PASSED`);
console.log(`================================`);
