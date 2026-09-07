import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDailyKpiCards,
  formatOccupancyPercent,
  formatOccupancyPrimary,
} from '../src/features/calendar/dailyKpiFormat.ts';
import type { DailyKpiData } from '../src/features/calendar/calendarApi.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '../src/App.tsx'), 'utf8');
const apiSrc = readFileSync(join(here, '../src/features/calendar/calendarApi.ts'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== DASHBOARD-DAILY-KPI-1 frontend ===\n');

const sample: DailyKpiData = {
  property_id: 1,
  business_date: '2026-09-07',
  timezone: 'Asia/Jakarta',
  occupancy: {
    occupied_rooms: 7,
    sellable_rooms: 23,
    occupancy_pct: 30.4,
    ooo_oos_rooms: 2,
  },
  booked_today: { rooms: 7, bookings: 3 },
  check_in_today: { rooms: 5 },
  check_out_today: { rooms: 8 },
  rooms: { dirty: 2, vacant_clean: 8, maintenance_ooo_oos: 2 },
  checkout_check: { pending: 1 },
};

console.log('--- U. KPI strip primary/secondary ---');
const cards = buildDailyKpiCards(sample);
check(cards.length === 8, 'U1. eight cards');
check(cards[0].title === 'Okupansi Hari Ini', 'U2. occupancy title');
check(cards[0].value === '7 / 23 kamar', 'U3. occupancy primary');
check(cards[0].secondary === '30,4%', 'U4. occupancy secondary Indonesian percent');
check(cards[1].title === 'Booked Hari Ini', 'U5. booked title');
check(cards[1].value === '7 kamar', 'U6. booked primary rooms');
check(cards[1].secondary === '3 booking', 'U7. booked secondary BID count');
check(cards[2].title === 'Check-in Hari Ini' && cards[2].value === '5 kamar', 'U8. check-in primary');
check(cards[3].title === 'Check-out Hari Ini' && cards[3].value === '8 kamar', 'U9. check-out primary');
check(cards[4].secondary === 'kamar' && cards[5].secondary === 'kamar', 'U10. dirty/vacant secondary');
check(cards[6].secondary === 'pending', 'U11. checkout check secondary');
check(cards[7].title === 'Maintenance' && cards[7].value === '2' && cards[7].secondary === 'kamar', 'U12. maintenance rooms');

console.log('--- W. occupancy percentage formatted Indonesian ---');
check(formatOccupancyPercent(30.4) === '30,4%', 'W1. 30.4 => 30,4%');
check(formatOccupancyPercent(0) === '0,0%', 'W2. 0 => 0,0%');
check(formatOccupancyPercent(null) === null, 'W3. null pct hidden');
check(formatOccupancyPrimary(7, 23) === '7 / 23 kamar', 'W4. occupancy primary helper');

const emptyCards = buildDailyKpiCards(null);
check(emptyCards[0].value === '0 / 0 kamar', 'U13. null KPI still renders compact zeros');
check(emptyCards[0].secondary === null, 'U14. null occupancy pct has no secondary');

console.log('--- V. search does not mutate KPI values ---');
check(appSrc.includes('const dailyKpiCards = useMemo(() => buildDailyKpiCards(dailyKpis), [dailyKpis])'), 'V1. KPI cards memo depends only on dailyKpis');
check(!/dailyKpiCards[\s\S]{0,200}calendarSearchQuery/.test(appSrc), 'V2. KPI cards are not tied to calendarSearchQuery');
check(appSrc.includes('{dailyKpiCards.map((card) => ('), 'V3. Kalender strip maps dailyKpiCards');

console.log('--- X. first four KPI cards are not calendarSummary stock ---');
check(!appSrc.includes('title="Total Reservasi"'), 'X1. Total Reservasi stock card removed');
check(!appSrc.includes('value={String(calendarSummary.bookedReservations)}'), 'X2. booked card not calendarSummary stock');
check(!appSrc.includes('value={String(calendarSummary.checkedInReservations)}'), 'X3. check-in card not calendarSummary stock');
check(!appSrc.includes('value={String(calendarSummary.checkedOutReservations)}'), 'X4. check-out card not calendarSummary stock');
check(!appSrc.includes('maintenanceTasks.length'), 'X5. maintenance card not task list length');
check(appSrc.includes('fetchDailyKpisApi(propId, undefined, authFetch)'), 'X6. KPI fetch uses canonical authFetch transport');
check(apiSrc.includes('/api/reports/daily-kpis?'), 'X7. client calls daily-kpis endpoint');
check(appSrc.includes('secondary={card.secondary}'), 'X8. StatCard receives secondary text');
check(appSrc.includes('function StatCard({ title, value, secondary, color, onClick, isActive, badge }: any)'), 'X9. StatCard supports secondary');

console.log(`\n=== PASSED: ${assertions} assertions ===`);
