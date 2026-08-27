import assert from 'node:assert/strict';
import {
  getFirstDateOfMonth,
  getFirstDateOfNextMonth,
  buildOccupancyQueryConfig,
  formatDateIndonesian,
  formatInclusivePeriodDisplay,
  getKpiLabels,
} from '../src/features/reports/occupancyDateHelpers.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Occupancy Reporting Date Helpers Tests ===\n');

// 1. Month boundaries
const augStart = getFirstDateOfMonth('2026-08-27');
const augEndExclusive = getFirstDateOfNextMonth('2026-08-27');
check(augStart === '2026-08-01', 'August month start must be 2026-08-01');
check(augEndExclusive === '2026-09-01', 'August month exclusive end must be 2026-09-01');

const decStart = getFirstDateOfMonth('2026-12-15');
const decEndExclusive = getFirstDateOfNextMonth('2026-12-15');
check(decStart === '2026-12-01', 'December month start must be 2026-12-01');
check(decEndExclusive === '2027-01-01', 'December month exclusive end must roll over to next year 2027-01-01');

// 2. Today query config
const todayConfig = buildOccupancyQueryConfig('today', 1, '2026-08-27', '', '');
check(todayConfig !== null, 'today config must not be null');
check(todayConfig?.startDate === '2026-08-27', 'today startDate must match requested date');
check(todayConfig?.endDateExclusive === '2026-08-28', 'today endDateExclusive must be next day');
check(todayConfig?.isSingleDay === true, 'today isSingleDay must be true');
check(todayConfig?.urlParams.includes('date=2026-08-27'), 'today urlParams must contain date parameter');

// 3. 7-days trailing query config
const sevenDaysConfig = buildOccupancyQueryConfig('7days', 1, '2026-08-27', '', '');
check(sevenDaysConfig !== null, '7days config must not be null');
check(sevenDaysConfig?.startDate === '2026-08-21', '7days trailing start must be 6 days prior (2026-08-21)');
check(sevenDaysConfig?.endDateExclusive === '2026-08-28', '7days exclusive end must be today + 1 day (2026-08-28)');
check(sevenDaysConfig?.isSingleDay === false, '7days isSingleDay must be false');
check(sevenDaysConfig?.urlParams.includes('start_date=2026-08-21'), '7days urlParams must contain start_date');
check(sevenDaysConfig?.urlParams.includes('end_date=2026-08-28'), '7days urlParams must contain end_date');

// 4. This month query config
const monthConfig = buildOccupancyQueryConfig('this_month', 1, '2026-08-27', '', '');
check(monthConfig !== null, 'this_month config must not be null');
check(monthConfig?.startDate === '2026-08-01', 'this_month start must be 2026-08-01');
check(monthConfig?.endDateExclusive === '2026-09-01', 'this_month exclusive end must be 2026-09-01 (NOT 2026-08-31)');
check(monthConfig?.isSingleDay === false, 'this_month isSingleDay must be false');

// 5. Custom range query config (inclusive end converted to exclusive)
const customRangeConfig = buildOccupancyQueryConfig('custom', 1, '2026-08-27', '2026-08-10', '2026-08-15');
check(customRangeConfig !== null, 'custom range config must not be null');
check(customRangeConfig?.startDate === '2026-08-10', 'custom range start must be 2026-08-10');
check(customRangeConfig?.endDateExclusive === '2026-08-16', 'custom range exclusive end must be 2026-08-16 for inclusive end 2026-08-15');
check(customRangeConfig?.isSingleDay === false, 'custom multi-day range isSingleDay must be false');

const customSingleDayConfig = buildOccupancyQueryConfig('custom', 1, '2026-08-27', '2026-08-10', '2026-08-10');
check(customSingleDayConfig !== null, 'custom single day config must not be null');
check(customSingleDayConfig?.startDate === '2026-08-10', 'custom single day start must be 2026-08-10');
check(customSingleDayConfig?.endDateExclusive === '2026-08-11', 'custom single day exclusive end must be 2026-08-11');
check(customSingleDayConfig?.isSingleDay === true, 'custom single day isSingleDay must be true');

// 6. Invalid custom range returns null
const invalidCustom = buildOccupancyQueryConfig('custom', 1, '2026-08-27', '2026-08-15', '2026-08-10');
check(invalidCustom === null, 'invalid custom range (start > end) must return null');

// 7. KPI Labels single-day vs multi-day
const singleLabels = getKpiLabels(true);
check(singleLabels.gross === 'Total Kamar Fisik', 'single day gross label must be Total Kamar Fisik');
check(singleLabels.sellable === 'Kamar Sellable', 'single day sellable label must be Kamar Sellable');
check(singleLabels.available === 'Kamar Tersedia', 'single day available label must be Kamar Tersedia');

const multiLabels = getKpiLabels(false);
check(multiLabels.gross === 'Total Gross Room Nights', 'multi day gross label must be Total Gross Room Nights');
check(multiLabels.sellable === 'Sellable Room Nights', 'multi day sellable label must be Sellable Room Nights');
check(multiLabels.available === 'Room Nights Tersedia', 'multi day available label must be Room Nights Tersedia');

// 8. Date formatting Indonesian
check(formatDateIndonesian('2026-08-27') === '27/08/2026', 'formatDateIndonesian converts YYYY-MM-DD to DD/MM/YYYY');
check(formatDateIndonesian(null) === '—', 'formatDateIndonesian returns dash for null');

// 9. Period Display formatting (Human inclusive)
const singleDateDisplay = formatInclusivePeriodDisplay('2026-08-27', '2026-08-28', 1);
check(singleDateDisplay === 'Tanggal Hotel: 27/08/2026', `Single date display must be "Tanggal Hotel: 27/08/2026", got "${singleDateDisplay}"`);

const monthDisplay = formatInclusivePeriodDisplay('2026-08-01', '2026-09-01', 31);
check(monthDisplay === 'Periode: 01/08/2026 – 31/08/2026 (31 malam)', `Month display must show inclusive end 31/08/2026, got "${monthDisplay}"`);

const sevenDaysDisplay = formatInclusivePeriodDisplay('2026-08-21', '2026-08-28', 7);
check(sevenDaysDisplay === 'Periode: 21/08/2026 – 27/08/2026 (7 malam)', `7 days display must show inclusive end 27/08/2026, got "${sevenDaysDisplay}"`);

console.log(`\n=== All ${assertions} Occupancy Reporting Date Helper Assertions PASSED ===\n`);
