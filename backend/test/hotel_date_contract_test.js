const {
  addHotelDays,
  enumerateHotelDates,
  hotelDateFromInstant,
  normalizeHotelDate
} = require('../dist/utils/hotelDate');

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

expect(normalizeHotelDate('2026-08-17') === '2026-08-17', 'valid hotel date was not preserved');
expect(normalizeHotelDate('2026-02-29') === null, 'invalid non-leap date was accepted');
expect(normalizeHotelDate('2028-02-29') === '2028-02-29', 'valid leap date was rejected');
expect(normalizeHotelDate('2026-08-16T17:00:00.000Z') === null, 'timestamp was accepted as a hotel date');

expect(addHotelDays('2026-08-31', 1) === '2026-09-01', 'month rollover failed');
expect(addHotelDays('2026-01-01', -1) === '2025-12-31', 'year rollback failed');
expect(
  JSON.stringify(enumerateHotelDates('2026-08-17', '2026-08-18')) === JSON.stringify(['2026-08-17']),
  '[check_in, check_out) one-night enumeration failed'
);
expect(
  JSON.stringify(enumerateHotelDates('2026-08-17', '2026-08-20')) === JSON.stringify(['2026-08-17', '2026-08-18', '2026-08-19']),
  '[check_in, check_out) multi-night enumeration failed'
);
expect(enumerateHotelDates('2026-08-18', '2026-08-17').length === 0, 'reversed date range was accepted');
expect(
  hotelDateFromInstant('2026-08-16T17:00:00.000Z') === '2026-08-17',
  'Asia/Jakarta instant conversion failed'
);

console.log('Hotel date contract');
console.log('PASS | strict YYYY-MM-DD validation and Asia/Jakarta conversion');
console.log('PASS | checkout-exclusive date enumeration');
