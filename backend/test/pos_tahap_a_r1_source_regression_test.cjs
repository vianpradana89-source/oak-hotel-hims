'use strict';

/**
 * OAK HIMS — Tahap A R1 Source-Level Deterministic Regression Suite
 * Memverifikasi penutupan TA-F01, TA-F02 (aturan CSS @page A4 landscape & ancestor reset),
 * TA-F03 (regex SQL metadata.grn_id & safe cast), TA-O01 (presisi NUMERIC(18,3)),
 * dan TA-O02 (batas maksimum limit API = 200) secara deterministik pada source aktual.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');

const repoRoot = path.resolve(__dirname, '..', '..');
const outPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

const backPath = path.join(repoRoot, 'backend', 'src', 'domains', 'pos', 'stockInventoryService.ts');
const frontPath = path.join(repoRoot, 'frontend', 'src', 'features', 'posInventory', 'StockMovementHistorySection.tsx');

const backend = fs.readFileSync(backPath, 'utf8');
const frontend = fs.readFileSync(frontPath, 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const results = {
  generated_at: new Date().toISOString(),
  node: process.version,
  scope:
    'Deterministic regression suite on actual TypeScript/TSX source (TA-F01, TA-F02 CSS, TA-F03 SQL regex/cast, TA-O01 exact NUMERIC(18,3), TA-O02 limit<=200).',
  inputs: {
    backend_sha256: sha256(backend),
    frontend_sha256: sha256(frontend),
  },
  checks: [],
};

function record(id, outcome, details) {
  results.checks.push({ id, outcome, details });
}

const start = backend.indexOf('export interface AsiaJakartaHalfOpenDateBounds');
const end = backend.indexOf('// POS Sale Automatic Stock Deduction', start);
assert(start > 0 && end > start, 'Tahap A section must exist in stockInventoryService.ts');
let section = backend.slice(start, end);
section = stripTypeScriptTypes(section, { mode: 'strip' }).replace(/^export /gm, '');
const ctx = vm.createContext({
  console,
  BigInt,
  checkInventoryPermission: async () => true,
  invokeAssertPropertyScope: async (fn, req, res, pid) => fn?.(req, res, pid),
});
vm.runInContext(
  section +
    '\nthis.api = { parseAsiaJakartaHalfOpenDateBounds, formatNumeric18_3Exact, getGlobalStockMovements, resolveGlobalMovementOperationDisplay };',
  ctx
);
const api = ctx.api;

function poolDouble({ totalRows = 1, quantity = '24.000' } = {}) {
  const queries = [];
  let released = false;
  const row = {
    movement_id: 11,
    operation_id: 10,
    property_id: 1,
    product_id: 101,
    product_code: 'FIXTURE-101',
    product_name: 'Fixture',
    location_id: 11,
    location_code: 'WH-01',
    location_name: 'Fixture WH',
    location_type: 'WAREHOUSE',
    operation_type: 'PURCHASE_RECEIPT',
    operation_key: 'fixture-operation',
    created_at: '2026-11-01T00:00:00Z',
    movement_date_wib: '2026-11-01',
    movement_time_wib: '2026-11-01 07:00:00',
    base_unit_code: 'BOTOL',
    quantity_delta: quantity,
    quantity_in: quantity.startsWith('-') ? '0.000' : quantity,
    quantity_out: quantity.startsWith('-') ? quantity.slice(1) : '0.000',
    balance_before: '0.000',
    balance_after: quantity,
    unit_cost: '2000.00',
    metadata: { grn_id: 42 },
  };
  const client = {
    release() {
      released = true;
    },
    async query(sql, params) {
      queries.push({ sql, params: params || [] });
      if (/SELECT NOW\(\)/.test(sql)) {
        return {
          rows: [
            {
              as_of_utc: '2026-11-05T00:00:00Z',
              as_of_wib: '2026-11-05 07:00:00',
              property_name: 'Fixture',
            },
          ],
        };
      }
      if (/COUNT\(DISTINCT product_id\)/.test(sql)) {
        return {
          rows: [
            {
              base_unit_code: 'BOTOL',
              movement_count: totalRows,
              distinct_product_count: 1,
              distinct_partition_count: 1,
              total_in: row.quantity_in,
              total_out: row.quantity_out,
              net_delta: quantity,
            },
          ],
        };
      }
      if (/ranked_partitions AS/.test(sql)) {
        return {
          rows: [
            {
              ...row,
              movement_count: totalRows,
              opening_balance: '0.000',
              closing_balance: quantity,
              total_in: row.quantity_in,
              total_out: row.quantity_out,
              net_delta: quantity,
            },
          ],
        };
      }
      if (/SELECT \*\s+FROM filtered_movements/.test(sql)) {
        return { rows: [row] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    pool: { connect: async () => client },
    queries,
    get released() {
      return released;
    },
  };
}

function frontendHarness() {
  const renderStart = frontend.indexOf('  return (\n    <div className="space-y-5"');
  assert(renderStart > 0, 'Render start must be found in StockMovementHistorySection.tsx');
  let src = frontend
    .slice(0, renderStart)
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace('export default function StockMovementHistorySection', 'function StockMovementHistorySection');
  src +=
    '\nreturn { loadMovements, loadPreviewSnapshot, handleOpenPreview, handlePrintFromPreview, setSelectedWarehouseId, setPreviewOpen, setPage, canPrintPreview };\n}\nthis.Component = StockMovementHistorySection;';
  src = stripTypeScriptTypes(src, { mode: 'strip' });

  const names = [...frontend.matchAll(/const \[([A-Za-z]+), set[A-Za-z]+\] = useState/g)].map((m) => m[1]);
  const states = [];
  let index = 0;
  let printCalls = 0;
  const pending = [];
  const cleanups = [];

  const c = vm.createContext({
    console,
    Intl,
    Date,
    useState(initial) {
      const i = index++;
      if (!(i in states)) states[i] = initial;
      return [
        states[i],
        (value) => {
          states[i] = typeof value === 'function' ? value(states[i]) : value;
        },
      ];
    },
    useEffect(fn) {
      // Capture unmount cleanup from mount guard effect
      if (typeof fn === 'function' && fn.toString().includes('asyncGuard.mounted')) {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
    },
    useCallback(fn) {
      return fn;
    },
    fetchStockTrackedProducts: async () => [],
    fetchGlobalStockMovements(propertyId, params) {
      return new Promise((resolve, reject) => pending.push({ propertyId, params, resolve, reject }));
    },
    window: {
      print() {
        printCalls++;
      },
    },
  });
  vm.runInContext(src, c);
  return {
    render(propertyId = 1) {
      index = 0;
      return c.Component({ propertyId, locations: [] });
    },
    unmount() {
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        fn();
      }
    },
    state(name) {
      const i = names.indexOf(name);
      assert(i >= 0, `State ${name} not found`);
      return states[i];
    },
    pending,
    get printCalls() {
      return printCalls;
    },
  };
}

const fakeReport = (propertyId, warehouseId, marker) => ({
  property_id: propertyId,
  filters: { warehouse_id: warehouseId },
  pagination: { page: 1, limit: 50, total_rows: 1, total_pages: 1, is_export_all: false },
  snapshot: { as_of_wib: '2026-11-05 09:00:00', as_of_timestamp: '2026-11-05T02:00:00Z' },
  totals_by_unit: [],
  partition_summaries: [],
  movements: [],
  marker,
});

(async () => {
  // 1. C01: Half-open date bounds
  const normal = api.parseAsiaJakartaHalfOpenDateBounds('2026-11-01', '2026-11-04');
  assert.equal(normal.startBoundInclusive, '2026-11-01T00:00:00+07:00');
  assert.equal(normal.endBoundExclusive, '2026-11-05T00:00:00+07:00');
  assert.equal(
    api.parseAsiaJakartaHalfOpenDateBounds('2028-02-29', '2028-02-29').endBoundExclusive,
    '2028-03-01T00:00:00+07:00'
  );
  for (const args of [
    ['2026-02-30', '2026-03-01'],
    ['2026-11-05', '2026-11-04'],
    ['2026-2-01', null],
  ]) {
    assert.throws(() => api.parseAsiaJakartaHalfOpenDateBounds(...args), (e) => e.statusCode === 400);
  }
  record('C01_DATE_BOUNDS', 'PASS', { normal, invalid_dates_and_reverse_range: '400', leap_day: 'PASS' });

  // 2. C02: SQL Snapshot Shape
  const db = poolDouble();
  await api.getGlobalStockMovements(db.pool, {
    property_id: 1,
    start_date: '2026-11-01',
    end_date: '2026-11-04',
    operation_type: 'STOCK_OPNAME',
    direction: 'OUT',
    search: 'fixture',
    page: 2,
    limit: 25,
  });
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(db.queries.at(-1).sql, 'COMMIT');
  assert(db.released);
  const detail = db.queries.find((q) => /SELECT \*\s+FROM filtered_movements/.test(q.sql));
  assert(detail.sql.includes('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW'));
  const ledgerPart = detail.sql.split('filtered_movements AS')[0];
  assert(!ledgerPart.includes('pl.created_at >='));
  assert(detail.sql.includes('pl.created_at < $3::timestamptz'));
  assert.equal(detail.params.at(-2), 25);
  assert.equal(detail.params.at(-1), 25);
  record('C02_SQL_SNAPSHOT_SHAPE', 'PASS', {
    transactions: [db.queries[0].sql, db.queries.at(-1).sql],
    query_count: db.queries.length,
    full_partition_before_filters: true,
    final_page_limit_offset: [25, 25],
    release: db.released,
  });

  // 3. C03: Export Guard
  const limitDb = poolDouble({ totalRows: 10001 });
  await assert.rejects(
    api.getGlobalStockMovements(limitDb.pool, { property_id: 1, export_all: true }),
    (e) => e.statusCode === 422 && e.code === 'EXPORT_LIMIT_EXCEEDED'
  );
  assert.equal(limitDb.queries.at(-1).sql, 'ROLLBACK');
  assert(limitDb.released);
  record('C03_EXPORT_GUARD', 'PASS', { rows: 10001, status: 422, rollback: true, release: true });

  // 4. TA-F03: GRN regex & safe cast
  const regexMatch = detail.sql.match(/\(so\.metadata->>'grn_id'\) ~ '([^']+)'/);
  assert(regexMatch, 'GRN regex must exist in emitted SQL');
  assert.equal(regexMatch[1], '^[0-9]+$');
  const compiledRegex = new RegExp(regexMatch[1]);
  assert.equal(compiledRegex.test('42'), true);
  assert.equal(compiledRegex.test('ddd'), false);
  assert.equal(compiledRegex.test('42abc'), false);
  assert(detail.sql.includes("jsonb_typeof(so.metadata) = 'object'"));
  assert(detail.sql.includes("LENGTH(so.metadata->>'grn_id') <= 9"));
  record('TA_F03_GRN_REGEX_FIXED', 'PASS', {
    emitted_sql_pattern: regexMatch[1],
    valid_grn_id_42_matches: true,
    alphabetic_ddd_matches: false,
    safe_case_cast_present: true,
  });

  // 5. TA-O02: API limit <= 200
  const limit200Db = poolDouble();
  const res200 = await api.getGlobalStockMovements(limit200Db.pool, { property_id: 1, limit: 200 });
  assert.equal(res200.pagination.limit, 200);
  await assert.rejects(
    api.getGlobalStockMovements(poolDouble().pool, { property_id: 1, limit: 201 }),
    (e) => e.statusCode === 400 && e.code === 'VALIDATION_ERROR'
  );
  record('TA_O02_API_LIMIT_200_FIXED', 'PASS', {
    max_limit_accepted: 200,
    limit_201_rejected_status: 400,
  });

  // 6. TA-O01: Exact NUMERIC(18,3) preservation
  const precisionDb = poolDouble({ quantity: '999999999999999.999' });
  const mappedPos = await api.getGlobalStockMovements(precisionDb.pool, { property_id: 1 });
  assert.equal(mappedPos.movements[0].quantity_in, '999999999999999.999');
  assert.equal(mappedPos.movements[0].balance_after, '999999999999999.999');
  assert.equal(mappedPos.totals_by_unit[0].total_in, '999999999999999.999');
  assert.equal(mappedPos.partition_summaries[0].closing_balance, '999999999999999.999');

  const negPrecisionDb = poolDouble({ quantity: '-999999999999999.999' });
  const mappedNeg = await api.getGlobalStockMovements(negPrecisionDb.pool, { property_id: 1 });
  assert.equal(mappedNeg.movements[0].direction, 'OUT');
  assert.equal(mappedNeg.movements[0].quantity_out, '999999999999999.999');
  assert.equal(mappedNeg.movements[0].quantity_delta, '-999999999999999.999');
  record('TA_O01_NUMERIC_18_3_EXACT_FIXED', 'PASS', {
    positive_extreme: mappedPos.movements[0].quantity_in,
    negative_extreme: mappedNeg.movements[0].quantity_delta,
  });

  // 7. TA-F01 (A): Filter Race (Warehouse 11 -> 12, B resolves then A resolves)
  const h = frontendHarness();
  let cb = h.render();
  cb.setSelectedWarehouseId(11);
  cb = h.render();
  const oldReq = cb.loadMovements();
  cb.setSelectedWarehouseId(12);
  cb = h.render();
  const latestReq = cb.loadMovements();
  h.pending[1].resolve(fakeReport(1, 12, 'LATEST'));
  await latestReq;
  h.pending[0].resolve(fakeReport(1, 11, 'OLD'));
  await oldReq;
  assert.equal(h.state('selectedWarehouseId'), 12);
  assert.equal(h.state('report').filters.warehouse_id, 12);
  assert.equal(h.state('report').marker, 'LATEST');
  record('TA_F01_A_FILTER_RACE_FIXED', 'PASS', {
    selected_warehouse: h.state('selectedWarehouseId'),
    displayed_report_warehouse: h.state('report').filters.warehouse_id,
    marker: h.state('report').marker,
  });

  // 8. TA-F01 (B): Property Race (Property 1 -> 2, B resolves then A resolves)
  const hp = frontendHarness();
  const oldProp = hp.render(1).loadMovements();
  const newProp = hp.render(2).loadMovements();
  hp.pending[1].resolve(fakeReport(2, null, 'LATEST_PROPERTY'));
  await newProp;
  hp.pending[0].resolve(fakeReport(1, null, 'OLD_PROPERTY'));
  await oldProp;
  assert.equal(hp.state('report').property_id, 2);
  assert.equal(hp.state('report').marker, 'LATEST_PROPERTY');
  record('TA_F01_B_PROPERTY_RACE_FIXED', 'PASS', {
    active_property: 2,
    displayed_property: hp.state('report').property_id,
    marker: hp.state('report').marker,
  });

  // 9. TA-F01 (C): Filter Change when previous page > 1 resets to page 1 immediately
  const hPage = frontendHarness();
  let cbp = hPage.render(1);
  cbp.setSelectedWarehouseId(11);
  cbp = hPage.render(1);
  cbp.setPage(3);
  cbp = hPage.render(1);
  const page3Req = cbp.loadMovements();
  assert.equal(hPage.pending.at(-1).params.page, 3);
  // Now change filter to warehouse 12 while page was 3
  cbp.setSelectedWarehouseId(12);
  cbp = hPage.render(1);
  const afterFilterChangeReq = cbp.loadMovements();
  assert.equal(hPage.state('page'), 1);
  assert.equal(hPage.pending.at(-1).params.page, 1);
  assert.equal(hPage.pending.at(-1).params.warehouse_id, 12);
  hPage.pending.at(-1).resolve(fakeReport(1, 12, 'WH12_PAGE1'));
  await afterFilterChangeReq;
  hPage.pending[0].resolve(fakeReport(1, 11, 'WH11_PAGE3_STALE'));
  await page3Req;
  assert.equal(hPage.state('report').marker, 'WH12_PAGE1');
  record('TA_F01_C_FILTER_CHANGE_RESETS_PAGE_FIXED', 'PASS', {
    previous_page: 3,
    new_page_after_filter_change: hPage.state('page'),
    displayed_marker: hPage.state('report').marker,
  });

  // 10. TA-F01 (D): Preview Close-Reopen Race & Reload Error Blocks Print
  const pv = frontendHarness();
  let pc = pv.render();
  pc.setSelectedWarehouseId(11);
  pc = pv.render();
  pc.handleOpenPreview(); // pending[0] for WH 11
  pc = pv.render();
  pc.setPreviewOpen(false);
  pc.setSelectedWarehouseId(12);
  pc = pv.render();
  pc.handleOpenPreview(); // pending[1] for WH 12
  pv.pending[1].resolve(fakeReport(1, 12, 'LATEST_PREVIEW'));
  await Promise.resolve();
  await Promise.resolve();
  pv.pending[0].resolve(fakeReport(1, 11, 'OLD_PREVIEW'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pv.state('previewReport').filters.warehouse_id, 12);
  assert.equal(pv.state('previewReport').marker, 'LATEST_PREVIEW');

  // Print when valid preview is open -> succeeds (printCalls = 1) matching same snapshot without new fetch
  const pendingCountBeforeValidPrint = pv.pending.length;
  pv.render().handlePrintFromPreview();
  assert.equal(pv.printCalls, 1);
  assert.equal(pv.pending.length, pendingCountBeforeValidPrint);

  // Now reload preview and fail -> print must be blocked and old previewReport invalidated
  const errPromise = pv.render().loadPreviewSnapshot();
  pv.pending[2].reject(new Error('fixture network failure'));
  await errPromise;
  const renderedAfterError = pv.render();
  assert.equal(Boolean(pv.state('previewError')), true);
  assert.equal(pv.state('previewReport'), null);
  assert.equal(renderedAfterError.canPrintPreview, false);
  renderedAfterError.handlePrintFromPreview();
  assert.equal(pv.printCalls, 1, 'Print must NOT be called when preview reload failed');
  record('TA_F01_D_PREVIEW_RACE_AND_ERROR_GUARD_FIXED', 'PASS', {
    preview_warehouse_after_race: 12,
    valid_print_calls: 1,
    preview_report_after_reload_error: pv.state('previewReport'),
    can_print_after_reload_error: renderedAfterError.canPrintPreview,
    print_calls_after_blocked_attempt: pv.printCalls,
  });

  // 11. TA-F01 (E): Stale response does NOT clear loading or error of active request + Unmount guard
  const hStale = frontendHarness();
  let cs = hStale.render(1);
  cs.setSelectedWarehouseId(11);
  cs = hStale.render(1);
  const reqA = cs.loadMovements(); // pending[0]
  cs.setSelectedWarehouseId(12);
  cs = hStale.render(1);
  const reqB = cs.loadMovements(); // pending[1]
  // Resolve stale reqA while reqB is still in flight -> loading must stay true!
  hStale.pending[0].resolve(fakeReport(1, 11, 'STALE_A'));
  await reqA;
  assert.equal(hStale.state('loading'), true, 'Stale request A must not clear active loading state of request B');
  assert.equal(hStale.state('report'), null);
  // Now reject active reqB with error
  hStale.pending[1].reject(new Error('Active request B failed'));
  await reqB;
  assert.equal(hStale.state('loading'), false);
  assert.equal(hStale.state('errorMsg'), 'Active request B failed');

  // Subcase: reqC starts, reqD starts, reqD rejects first, then reqC resolves -> error from reqD must remain!
  cs.setSelectedWarehouseId(11);
  cs = hStale.render(1);
  const reqC = cs.loadMovements(); // pending[2]
  cs.setSelectedWarehouseId(12);
  cs = hStale.render(1);
  const reqD = cs.loadMovements(); // pending[3]
  hStale.pending[3].reject(new Error('Latest request D failed'));
  await reqD;
  assert.equal(hStale.state('errorMsg'), 'Latest request D failed');
  hStale.pending[2].resolve(fakeReport(1, 11, 'STALE_C'));
  await reqC;
  assert.equal(hStale.state('errorMsg'), 'Latest request D failed', 'Stale success C must not clear error of D');
  assert.equal(hStale.state('report'), null);

  // Unmount guard
  cs.setSelectedWarehouseId(11);
  cs = hStale.render(1);
  const reqAfterUnmount = cs.loadMovements(); // pending[4]
  hStale.unmount();
  hStale.pending[4].resolve(fakeReport(1, 11, 'AFTER_UNMOUNT'));
  await reqAfterUnmount;
  assert.equal(hStale.state('report'), null, 'Response after unmount must be ignored');
  record('TA_F01_E_STALE_LOADING_ERROR_AND_UNMOUNT_FIXED', 'PASS', {
    loading_preserved_during_stale_finish: true,
    error_preserved_after_stale_success: true,
    unmount_ignored: true,
  });

  // 12. TA-F02: Verify explicit A4 landscape @page rule and ancestor print reset in TSX stylesheet
  const printStyle = frontend.split('<style>{`')[1].split('`}</style>')[0];
  assert(printStyle.includes('@page'), 'Print stylesheet must include @page rule');
  assert(printStyle.includes('size: A4 landscape'), 'Print stylesheet must specify size: A4 landscape');
  assert(
    printStyle.includes('body *:has(#oak-mutation-report-printable)'),
    'Print stylesheet must reset modal/layout ancestors via :has(#oak-mutation-report-printable)'
  );
  record('TA_F02_PRINT_CSS_A4_LANDSCAPE_AND_ANCESTOR_RESET', 'PASS', {
    has_page_a4_landscape: true,
    has_ancestor_overflow_reset: true,
  });

  results.summary = {
    total_checks: results.checks.length,
    passed: results.checks.filter((c) => c.outcome === 'PASS').length,
    failed: results.checks.filter((c) => c.outcome !== 'PASS').length,
  };

  const jsonOutput = JSON.stringify(results, null, 2) + '\n';
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, jsonOutput, 'utf8');
  }
  console.log(jsonOutput);
})().catch((err) => {
  console.error('[SOURCE REGRESSION FAIL]', err);
  process.exitCode = 1;
});
