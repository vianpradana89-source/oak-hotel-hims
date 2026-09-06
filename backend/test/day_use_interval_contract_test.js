const {
  canonicalizeHotelTimestamp,
  compareCanonicalTimestamps,
  isValidHotelLocalTimestamp,
  validateDayUseInterval,
} = require('../dist/utils/dayUseInterval');
const {
  resolvePropertyTimezone,
  requirePropertyTimezone,
  resolveTimezoneOffsetForLocalDateTime,
} = require('../dist/utils/propertyTimezone');

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrow(fn, code, message) {
  try {
    fn();
    throw new Error(message);
  } catch (err) {
    if (err.message === message) throw err;
    expect(err.code === code, `${message} (got ${err.code})`);
  }
}

expect(resolvePropertyTimezone(null) === 'Asia/Jakarta', 'empty timezone falls back to Asia/Jakarta');
expect(resolvePropertyTimezone('Asia/Singapore') === 'Asia/Singapore', 'explicit property timezone is preserved');
expect(requirePropertyTimezone(null) === 'Asia/Jakarta', 'blank timezone may use the established Jakarta fallback');
expect(requirePropertyTimezone('America/New_York') === 'America/New_York', 'valid non-empty IANA is accepted');
expectThrow(
  () => requirePropertyTimezone('Not/ARealZone'),
  'PROPERTY_TIMEZONE_INVALID',
  'invalid non-empty IANA timezone must fail deterministically'
);

expect(
  resolveTimezoneOffsetForLocalDateTime('Asia/Jakarta', '2026-09-06', 10, 0, 0) === '+07:00',
  'Asia/Jakarta remains +07:00 on the reservation date'
);
expect(
  resolveTimezoneOffsetForLocalDateTime('Asia/Singapore', '2026-09-06', 10, 0, 0) === '+08:00',
  'Asia/Singapore remains +08:00 on the reservation date'
);
expect(
  resolveTimezoneOffsetForLocalDateTime('America/New_York', '2026-01-15', 10, 0, 0) === '-05:00',
  'America/New_York winter offset is -05:00'
);
expect(
  resolveTimezoneOffsetForLocalDateTime('America/New_York', '2026-07-15', 10, 0, 0) === '-04:00',
  'America/New_York summer offset is -04:00'
);

expect(isValidHotelLocalTimestamp('2026-09-06T10:00:00') === true, 'naive hotel-local timestamp should be valid');
expect(isValidHotelLocalTimestamp('2026-09-06T10:00:00+07:00') === true, 'offset hotel-local timestamp should be valid');
expect(isValidHotelLocalTimestamp('2026-09-06T10:00:00Z') === true, 'Zulu timestamp should be valid');
expect(isValidHotelLocalTimestamp('2026-09-06 10:00:00') === false, 'space-separated timestamp should be rejected');
expect(isValidHotelLocalTimestamp('not-a-date') === false, 'garbage timestamp should be rejected');

expect(
  canonicalizeHotelTimestamp('2026-09-06T10:00:00', 'Asia/Jakarta') === '2026-09-06T10:00:00+07:00',
  'Jakarta timezone-less 10:00 is stored as 10:00+07:00'
);
expect(
  canonicalizeHotelTimestamp('2026-09-06T10:00:00', 'Asia/Singapore') === '2026-09-06T10:00:00+08:00',
  'Singapore timezone-less 10:00 is stored as 10:00+08:00'
);
expect(
  canonicalizeHotelTimestamp('2026-01-15T10:00:00', 'America/New_York') === '2026-01-15T10:00:00-05:00',
  'New York winter timezone-less 10:00 uses -05:00, not a year-2000 reference'
);
expect(
  canonicalizeHotelTimestamp('2026-07-15T10:00:00', 'America/New_York') === '2026-07-15T10:00:00-04:00',
  'New York summer timezone-less 10:00 uses -04:00, not a year-2000 reference'
);
expect(
  canonicalizeHotelTimestamp('2026-11-20T09:00:00+07:00', 'America/New_York') === '2026-11-20T09:00:00+07:00',
  'explicit +07:00 is preserved'
);
expect(
  canonicalizeHotelTimestamp('2026-09-06T10:00:00Z', 'America/New_York') === '2026-09-06T10:00:00Z',
  'explicit Z is preserved'
);
expect(
  canonicalizeHotelTimestamp('2026-03-08T02:30:00', 'America/New_York') === null,
  'nonexistent DST-gap wall time is rejected instead of silently shifted'
);

expectThrow(
  () => canonicalizeHotelTimestamp('2026-09-06T10:00:00', 'Not/ARealZone'),
  'DAY_USE_TIMEZONE_INVALID',
  'invalid non-empty IANA timezone is rejected during canonicalization'
);
expectThrow(
  () => validateDayUseInterval('2026-09-06T10:00:00', '2026-09-06T16:00:00', 'Not/ARealZone'),
  'DAY_USE_TIMEZONE_INVALID',
  'invalid non-empty IANA timezone is rejected for Day Use intervals'
);

const jakarta = validateDayUseInterval('2026-09-06T10:00:00', '2026-09-06T16:00:00', 'Asia/Jakarta');
expect(jakarta.startAt === '2026-09-06T10:00:00+07:00', 'Jakarta 10:00 is stored as 10:00+07:00');
expect(jakarta.endAt === '2026-09-06T16:00:00+07:00', 'Jakarta 10:00 + 6h is stored as 16:00+07:00');

const nySummer = validateDayUseInterval('2026-07-15T10:00:00', '2026-07-15T16:00:00', 'America/New_York');
expect(nySummer.startAt === '2026-07-15T10:00:00-04:00', 'New York summer start uses -04:00');
expect(nySummer.endAt === '2026-07-15T16:00:00-04:00', 'New York summer end uses -04:00');

const midnight = validateDayUseInterval('2026-09-06T22:00:00', '2026-09-07T02:00:00', 'Asia/Jakarta');
expect(midnight.startAt === '2026-09-06T22:00:00+07:00', 'late start stays on the hotel date with +07:00');
expect(midnight.endAt === '2026-09-07T02:00:00+07:00', 'midnight crossing keeps the next hotel date with +07:00');

const explicit = validateDayUseInterval(
  '2026-11-20T09:00:00+07:00',
  '2026-11-20T13:00:00+07:00',
  'America/New_York'
);
expect(explicit.startAt === '2026-11-20T09:00:00+07:00', 'explicit +07:00 start is preserved');
expect(explicit.endAt === '2026-11-20T13:00:00+07:00', 'explicit +07:00 end is preserved');

const explicitZ = validateDayUseInterval(
  '2026-09-06T03:00:00Z',
  '2026-09-06T09:00:00Z',
  'Asia/Jakarta'
);
expect(explicitZ.startAt === '2026-09-06T03:00:00Z', 'explicit Z start is preserved');
expect(explicitZ.endAt === '2026-09-06T09:00:00Z', 'explicit Z end is preserved');

expectThrow(() => validateDayUseInterval(null, '2026-09-06T16:00:00', 'Asia/Jakarta'), 'DAY_USE_START_AT_REQUIRED', 'missing start_at must be rejected');
expectThrow(() => validateDayUseInterval('2026-09-06T10:00:00', '', 'Asia/Jakarta'), 'DAY_USE_END_AT_REQUIRED', 'missing end_at must be rejected');
expectThrow(() => validateDayUseInterval('bad', '2026-09-06T16:00:00', 'Asia/Jakarta'), 'DAY_USE_START_AT_INVALID', 'invalid start_at must be rejected');
expectThrow(
  () => validateDayUseInterval('2026-09-06T10:00:00', '2026-09-06T10:00:00', 'Asia/Jakarta'),
  'DAY_USE_INTERVAL_INVALID',
  'start_at === end_at must be rejected after timezone normalization'
);
expectThrow(
  () => validateDayUseInterval('2026-03-08T02:30:00', '2026-03-08T10:00:00', 'America/New_York'),
  'DAY_USE_START_AT_INVALID',
  'DST-gap start must be rejected'
);

expectThrow(
  () => compareCanonicalTimestamps('2026-09-06T10:00:00', '2026-09-06T16:00:00'),
  'DAY_USE_INTERVAL_INVALID',
  'timezone-less strings must not be compared via Date.parse'
);

console.log('Day use interval contract');
console.log('PASS | date-aware IANA offsets (Jakarta, Singapore, New York winter/summer)');
console.log('PASS | invalid non-empty IANA timezone rejected');
console.log('PASS | explicit Z / ±HH:mm offsets preserved');
console.log('PASS | DST gap and end == start rejected');
