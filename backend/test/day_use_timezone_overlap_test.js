/* Captures actual production SQL from both functions; never imports the server or connects to a DB. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? null : process.argv[i + 1]; };
const root = path.resolve(arg('--source-root') || path.join(__dirname, '../..'));
const ts = require(arg('--typescript') || 'typescript');
let passed = 0;
function check(value, label) { assert.ok(value, label); passed++; }
function extract(file, name, scope) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0, file);
  const found = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.body && n.name?.text === name);
  assert.equal(found.length, 1, name);
  const code = found[0].getText(ast).replace(/^export\s+/, '') + '\nreturn ' + name + ';';
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return { fn: new Function(...Object.keys(scope), output)(...Object.values(scope)), text: found[0].getText(ast), source, ast };
}
const validationError = () => { throw new Error('Invalid test input'); };
const availability = extract('backend/src/domains/reservations/reservationEditService.ts', 'getBookingCreateAvailability', {
  isValidHotelDate: value => /^\d{4}-\d{2}-\d{2}$/.test(value),
  throwAvailabilityValidation: validationError,
  resolvePropertyTimezone: value => value,
  DEFAULT_PROPERTY_TIMEZONE: 'Asia/Jakarta',
  validateDayUseInterval: (startAt, endAt) => ({ startAt, endAt }),
  addDays: (date, count) => { const value = new Date(date + 'T00:00:00Z'); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); },
  CREATE_AVAILABILITY_DAY_USE_BUFFER_MINUTES: 60,
  groupEligibleRooms: rows => rows,
});
const overlap = extract('backend/src/index.ts', 'findActiveRoomOverlap', {});
const cases = [
  { name: 'Jakarta 14:00 after checkout', expected: false },
  { name: 'Jakarta 12:45 before buffer end', start: '2026-11-14T12:45:00+07:00', expected: true },
  { name: 'Jakarta 13:00 exact buffer end', start: '2026-11-14T13:00:00+07:00', expected: false },
  { name: 'Jakarta 12:00 checkout still in buffer', start: '2026-11-14T12:00:00+07:00', expected: true },
  { name: 'Checkin day ends at 13:00 boundary', existingIn: '2026-11-14', existingOut: '2026-11-15',
    start: '2026-11-14T07:00:00+07:00', end: '2026-11-14T13:00:00+07:00', expected: false },
  { name: 'Checkin day ends at 13:15 conflict', existingIn: '2026-11-14', existingOut: '2026-11-15',
    start: '2026-11-14T07:00:00+07:00', end: '2026-11-14T13:15:00+07:00', expected: true },
  { name: 'Inside multi-night stay', existingOut: '2026-11-15', expected: true },
  { name: 'Day before next overnight', existingIn: '2026-11-15', existingOut: '2026-11-17', expected: false },
  { name: 'Cross midnight ends before next checkin', existingIn: '2026-11-15', existingOut: '2026-11-17',
    start: '2026-11-14T23:30:00+07:00', end: '2026-11-15T05:30:00+07:00', expected: false },
  { name: 'Cross midnight reaches next checkin', existingIn: '2026-11-15', existingOut: '2026-11-17',
    start: '2026-11-14T23:30:00+07:00', end: '2026-11-15T14:15:00+07:00', expected: true },
  { name: 'UTC property after checkout', timezone: 'UTC', start: '2026-11-14T14:00:00Z', end: '2026-11-14T20:00:00Z', expected: false },
  { name: 'Makassar property after checkout', timezone: 'Asia/Makassar', start: '2026-11-14T14:00:00+08:00', end: '2026-11-14T20:00:00+08:00', expected: false },
  { name: 'Equivalent explicit UTC timestamps', start: '2026-11-14T07:00:00Z', end: '2026-11-14T13:00:00Z', expected: false },
  { name: 'DST property exact checkout buffer end', timezone: 'America/New_York', date: '2026-03-08',
    existingIn: '2026-03-07', existingOut: '2026-03-08', start: '2026-03-08T13:00:00-04:00', end: '2026-03-08T16:00:00-04:00', expected: false },
  { name: 'DST property before checkout buffer end', timezone: 'America/New_York', date: '2026-03-08',
    existingIn: '2026-03-07', existingOut: '2026-03-08', start: '2026-03-08T12:45:00-04:00', end: '2026-03-08T16:00:00-04:00', expected: true },
  { name: 'Day Use versus Day Use exact 60 minute boundary', existingKind: 'DAY_USE', existingIn: '2026-11-14',
    existingStart: '2026-11-14T08:00:00+07:00', existingEnd: '2026-11-14T12:00:00+07:00',
    start: '2026-11-14T13:00:00+07:00', expected: false },
  { name: 'Day Use versus Day Use inside buffer', existingKind: 'DAY_USE', existingIn: '2026-11-14',
    existingStart: '2026-11-14T08:00:00+07:00', existingEnd: '2026-11-14T12:00:00+07:00',
    start: '2026-11-14T12:45:00+07:00', expected: true },
  { name: 'Cancelled overnight does not block', status: 'CANCELLED', expected: false },
];
(async () => {
  const probes = [];
  for (const input of cases) {
    const item = { timezone: 'Asia/Jakarta', date: '2026-11-14', start: '2026-11-14T14:00:00+07:00',
      end: '2026-11-14T20:00:00+07:00', existingIn: '2026-11-13', existingOut: '2026-11-14',
      existingKind: 'OVERNIGHT', existingStart: null, existingEnd: null, status: 'BOOKED', ...input };
    let submitQuery;
    await overlap.fn({ query: async (sql, params) => { submitQuery = { sql, params }; return { rows: [] }; } },
      13, item.date, item.date, null, { stayType: 'DAY_USE', startAt: item.start, endAt: item.end,
        bufferMinutes: 60, propertyTimezone: item.timezone });
    check(submitQuery.params[5] === item.timezone, item.name + ' submit timezone bound');
    check(submitQuery.sql.includes('FOR UPDATE OF existing'), item.name + ' submit lock retained');
    check((submitQuery.sql.match(/AT TIME ZONE \$6/g) || []).length === 2, item.name + ' submit hotel-local gates');
    let availabilityQuery;
    await availability.fn({ query: async (sql, params) => {
      if (sql.includes('SELECT id, timezone FROM properties')) return { rows: [{ id: 3, timezone: item.timezone }] };
      availabilityQuery = { sql, params }; return { rows: [] };
    } }, { propertyId: 3, checkIn: item.date, checkOut: item.date, stayType: 'DAY_USE', startAt: item.start, endAt: item.end });
    check(availabilityQuery.params[6] === item.timezone, item.name + ' availability timezone bound');
    check((availabilityQuery.sql.match(/AT TIME ZONE \$7/g) || []).length === 2, item.name + ' availability hotel-local gates');
    check(availabilityQuery.params[3] === item.start && availabilityQuery.params[4] === item.end, item.name + ' canonical timestamps preserved');
    probes.push({ item, path: 'submit', ...submitQuery, expected_count: item.expected ? 1 : 0 });
    probes.push({ item, path: 'availability', ...availabilityQuery, expected_count: item.expected ? 0 : 1 });
  }
  let overnight;
  await overlap.fn({ query: async (sql, params) => { overnight = { sql, params }; return { rows: [] }; } },
    13, '2026-11-13', '2026-11-14', 73);
  check(overnight.params.length === 4, 'overnight bindings unchanged');
  check(!overnight.sql.includes('AT TIME ZONE'), 'overnight branch unchanged');
  check(overnight.sql.includes('FOR UPDATE OF existing'), 'overnight lock retained');
  const canonical = extract('backend/src/index.ts', 'createCanonicalBooking', {}).text;
  check(/bufferMinutes:\s*60,\s*propertyTimezone/.test(canonical), 'canonical caller passes its resolved property timezone');
  if (arg('--emit-probes')) fs.writeFileSync(arg('--emit-probes'), JSON.stringify(probes));
  console.log(`PASS ${passed} production SQL/binding checks; ${probes.length} SQL probes prepared; DB-free, no PostgreSQL/concurrency claim`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
