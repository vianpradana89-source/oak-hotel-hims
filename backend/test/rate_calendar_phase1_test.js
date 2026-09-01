'use strict';

require('dotenv').config({ path: 'E:/oak-hotel-hims/backend/.env' });
const http = require('http');
const { once } = require('events');
const { app, pool } = require('../dist/index');

let server;
let baseUrl;
let passed = 0;
let failed = 0;

function expect(condition, msg) {
  if (condition) {
    passed += 1;
    console.log('PASS | ' + msg);
  } else {
    failed += 1;
    console.error('FAIL | ' + msg);
    throw new Error('Assertion failed: ' + msg);
  }
}

async function api(method, path, body, customHeaders = {}) {
  const opts = {
    method,
    headers: { ...customHeaders }
  };
  if (body && method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(baseUrl + path, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// FIXTURE DATA
let propIdA;
let propIdB;
let roomTypeIdA;
let roomTypeIdB;
let ratePlanIdA1;
let ratePlanIdA2;
let ratePlanIdB;

async function setupFixtures() {
  // Discover or create Property A and Property B
  const pRows = await pool.query('SELECT id, name FROM properties ORDER BY id');
  if (pRows.rows.length < 2) {
    const randA = Math.floor(1000 + Math.random() * 9000);
    const randB = Math.floor(1000 + Math.random() * 9000);
    const p1 = await pool.query(
      `INSERT INTO properties (property_code, name, address, phone, timezone, currency, is_active)
       VALUES ($1, 'Test Property A', 'Street A', '081111', 'Asia/Jakarta', 'IDR', true)
       RETURNING id`,
      [`PA${randA}`]
    );
    const p2 = await pool.query(
      `INSERT INTO properties (property_code, name, address, phone, timezone, currency, is_active)
       VALUES ($1, 'Test Property B', 'Street B', '082222', 'Asia/Jakarta', 'IDR', true)
       RETURNING id`,
      [`PB${randB}`]
    );
    propIdA = p1.rows[0].id;
    propIdB = p2.rows[0].id;
  } else {
    propIdA = pRows.rows[0].id;
    propIdB = pRows.rows[1].id;
  }

  const randS = Math.floor(1000 + Math.random() * 9000);
  // Ensure Room Types
  const rtA = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active)
     VALUES ($1, $2, 'Test Room Type A', 500000, 2, true)
     RETURNING id`,
    [propIdA, `CTA_${randS}`]
  );
  roomTypeIdA = rtA.rows[0].id;

  const rtB = await pool.query(
    `INSERT INTO room_types (property_id, code, name, base_rate, capacity, is_active)
     VALUES ($1, $2, 'Test Room Type B', 600000, 2, true)
     RETURNING id`,
    [propIdB, `CTB_${randS}`]
  );
  roomTypeIdB = rtB.rows[0].id;

  // Ensure Rate Plans
  const rpA1 = await pool.query(
    `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, is_active)
     VALUES ($1, $2, $3, 'Rate Plan A1 Standard', 500000, true)
     RETURNING id`,
    [propIdA, roomTypeIdA, `RPA1_${randS}`]
  );
  ratePlanIdA1 = rpA1.rows[0].id;

  const rpA2 = await pool.query(
    `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, is_active)
     VALUES ($1, $2, $3, 'Rate Plan A2 Deluxe', 750000, true)
     RETURNING id`,
    [propIdA, roomTypeIdA, `RPA2_${randS}`]
  );
  ratePlanIdA2 = rpA2.rows[0].id;

  const rpB = await pool.query(
    `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate, is_active)
     VALUES ($1, $2, $3, 'Rate Plan B Standard', 600000, true)
     RETURNING id`,
    [propIdB, roomTypeIdB, `RPB_${randS}`]
  );
  ratePlanIdB = rpB.rows[0].id;

  console.log(`Fixtures ready: PropA=${propIdA}, PropB=${propIdB}, PlanA1=${ratePlanIdA1}, PlanA2=${ratePlanIdA2}, PlanB=${ratePlanIdB}`);
}

async function cleanupFixtures() {
  try {
    if (ratePlanIdA1) {
      await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id IN ($1, $2, $3)', [
        ratePlanIdA1,
        ratePlanIdA2,
        ratePlanIdB
      ]);
      await pool.query('DELETE FROM rate_plans WHERE id IN ($1, $2, $3)', [
        ratePlanIdA1,
        ratePlanIdA2,
        ratePlanIdB
      ]);
    }
    if (roomTypeIdA) {
      await pool.query('DELETE FROM room_types WHERE id IN ($1, $2)', [roomTypeIdA, roomTypeIdB]);
    }
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

async function runTests() {
  console.log('--- STARTING RATE CALENDAR PHASE 1 TEST SUITE ---');

  // TEST A: Single date override [2026-10-01, 2026-10-02)
  console.log('\n[Test A] Single date override [2026-10-01, 2026-10-02)');
  {
    const res = await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2026-10-01',
      end_date: '2026-10-02',
      override_rate: 650000,
      reason: 'Single test date',
      replace_existing: true
    });
    expect(res.status === 201, `Status 201 created single override (got ${res.status})`);
    expect(Number(res.json.override_rate) === 650000, 'Override rate saved as 650000');

    // Verify matrix
    const mat = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2026-10-01&end_date=2026-10-03`
    );
    expect(mat.status === 200, 'Matrix loaded');
    const day1 = mat.json.days.find((d) => d.date === '2026-10-01');
    const day2 = mat.json.days.find((d) => d.date === '2026-10-02');
    expect(day1 && day1.effective_rate === 650000 && day1.is_overridden === true, 'Oct 01 is overridden to 650,000');
    expect(day2 && day2.effective_rate === 500000 && day2.is_overridden === false, 'Oct 02 is base rate 500,000');
  }

  // TEST B: Single date reset (soft-archive + slice preservation)
  console.log('\n[Test B] Single date reset');
  {
    // Find active override id for Oct 01
    const mat = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2026-10-01&end_date=2026-10-02`
    );
    const day1 = mat.json.days[0];
    expect(day1.override_id !== null, 'Found override id for reset test');

    const delRes = await api(
      'DELETE',
      `/api/pricing/rate-overrides/${day1.override_id}?property_id=${propIdA}&target_date=2026-10-01`
    );
    expect(delRes.status === 200, 'Reset returns 200');

    // Verify day 1 is back to base rate
    const matAfter = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2026-10-01&end_date=2026-10-02`
    );
    expect(matAfter.json.days[0].effective_rate === 500000, 'Oct 01 reset to base rate 500,000');
    expect(matAfter.json.days[0].is_overridden === false, 'Oct 01 is_overridden is false');
  }

  // TEST C: Left-slice overlap
  // Original [2026-10-10, 2026-10-20) @ 550,000
  // New [2026-10-15, 2026-10-25) @ 700,000
  // Result: Left slice [2026-10-10, 2026-10-15) @ 550k preserved, new [2026-10-15, 2026-10-25) @ 700k active, original archived intact
  console.log('\n[Test C] Left-slice overlap');
  {
    const orig = await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2026-10-10',
      end_date: '2026-10-20',
      override_rate: 550000,
      reason: 'Original span'
    });
    const origId = orig.json.id;

    const overlap = await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2026-10-15',
      end_date: '2026-10-25',
      override_rate: 700000,
      reason: 'New span overlapping right',
      replace_existing: true
    });
    expect(overlap.status === 201, 'Overlap applied');

    // Check original row is archived and intact (start_date/end_date unchanged)
    const checkOrig = await pool.query(
      'SELECT *, start_date::text AS start_str, end_date::text AS end_str FROM rate_overrides WHERE id = $1',
      [origId]
    );
    expect(checkOrig.rows.length === 1, 'Original row still exists');
    expect(checkOrig.rows[0].is_archived === true, 'Original row is archived');
    expect(checkOrig.rows[0].start_str === '2026-10-10', 'Original start_date untouched');
    expect(checkOrig.rows[0].end_str === '2026-10-20', 'Original end_date untouched');

    // Verify calendar matrix across [2026-10-10, 2026-10-25)
    const mat = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2026-10-10&end_date=2026-10-25`
    );
    const d10 = mat.json.days.find((d) => d.date === '2026-10-10');
    const d14 = mat.json.days.find((d) => d.date === '2026-10-14');
    const d15 = mat.json.days.find((d) => d.date === '2026-10-15');
    const d24 = mat.json.days.find((d) => d.date === '2026-10-24');

    expect(d10.effective_rate === 550000, 'Oct 10 (left slice) has 550,000');
    expect(d14.effective_rate === 550000, 'Oct 14 (left slice) has 550,000');
    expect(d15.effective_rate === 700000, 'Oct 15 (new span) has 700,000');
    expect(d24.effective_rate === 700000, 'Oct 24 (new span) has 700,000');

    // Clean up
    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST D: Right-slice overlap
  // Original [2026-11-10, 2026-11-20) @ 550,000
  // New [2026-11-05, 2026-11-15) @ 700,000
  // Result: new [2026-11-05, 2026-11-15) @ 700k, right slice [2026-11-15, 2026-11-20) @ 550k preserved
  console.log('\n[Test D] Right-slice overlap');
  {
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2026-11-10',
      end_date: '2026-11-20',
      override_rate: 550000,
      reason: 'Original span'
    });

    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2026-11-05',
      end_date: '2026-11-15',
      override_rate: 700000,
      reason: 'New span overlapping left',
      replace_existing: true
    });

    const mat = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2026-11-05&end_date=2026-11-20`
    );
    const d05 = mat.json.days.find((d) => d.date === '2026-11-05');
    const d14 = mat.json.days.find((d) => d.date === '2026-11-14');
    const d15 = mat.json.days.find((d) => d.date === '2026-11-15');
    const d19 = mat.json.days.find((d) => d.date === '2026-11-19');

    expect(d05.effective_rate === 700000, 'Nov 05 (new span) has 700,000');
    expect(d14.effective_rate === 700000, 'Nov 14 (new span) has 700,000');
    expect(d15.effective_rate === 550000, 'Nov 15 (right slice) has 550,000');
    expect(d19.effective_rate === 550000, 'Nov 19 (right slice) has 550,000');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST E: Inner split
  // Original [2026-12-01, 2026-12-31) @ 500,000
  // New [2026-12-10, 2026-12-20) @ 850,000
  // Result: Left slice [2026-12-01, 2026-12-10) @ 500k, Center [2026-12-10, 2026-12-20) @ 850k, Right slice [2026-12-20, 2026-12-31) @ 500k
  console.log('\n[Test E] Inner split');
  {
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2026-12-01',
      end_date: '2026-12-31',
      override_rate: 500000,
      reason: 'Month long promo'
    });

    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2026-12-10',
      end_date: '2026-12-20',
      override_rate: 850000,
      reason: 'Peak mid-month',
      replace_existing: true
    });

    const mat = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2026-12-01&end_date=2026-12-31`
    );
    const d05 = mat.json.days.find((d) => d.date === '2026-12-05');
    const d15 = mat.json.days.find((d) => d.date === '2026-12-15');
    const d25 = mat.json.days.find((d) => d.date === '2026-12-25');

    expect(d05.effective_rate === 500000, 'Dec 05 (left slice) has 500,000');
    expect(d15.effective_rate === 850000, 'Dec 15 (inner new) has 850,000');
    expect(d25.effective_rate === 500000, 'Dec 25 (right slice) has 500,000');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST F: Full coverage
  // Original [2027-01-10, 2027-01-20) @ 500,000
  // New [2027-01-05, 2027-01-25) @ 900,000
  // Result: Original fully archived, zero slices, new row covers everything
  console.log('\n[Test F] Full coverage');
  {
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-01-10',
      end_date: '2027-01-20',
      override_rate: 500000
    });

    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-01-05',
      end_date: '2027-01-25',
      override_rate: 900000,
      replace_existing: true
    });

    const mat = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2027-01-05&end_date=2027-01-25`
    );
    const allCovered = mat.json.days.every((d) => d.effective_rate === 900000);
    expect(allCovered, 'All dates in [Jan 05, Jan 25) have 900,000');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST G: DOW disjoint
  // Original [2027-02-01, 2027-02-28) DOW [1,2,3,4,5] (weekdays) @ 450,000
  // New [2027-02-01, 2027-02-28) DOW [6,7] (weekends) @ 650,000
  // Result: Weekdays remain 450,000, Weekends become 650,000
  console.log('\n[Test G] DOW disjoint');
  {
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-02-01',
      end_date: '2027-02-28',
      override_rate: 450000,
      days_of_week: [1, 2, 3, 4, 5]
    });

    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-02-01',
      end_date: '2027-02-28',
      override_rate: 650000,
      days_of_week: [6, 7],
      replace_existing: true
    });

    const mat = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2027-02-01&end_date=2027-02-28`
    );
    for (const d of mat.json.days) {
      if (d.day_of_week >= 6) {
        expect(d.effective_rate === 650000, `${d.date} (weekend) is 650,000`);
      } else {
        expect(d.effective_rate === 450000, `${d.date} (weekday) is 450,000`);
      }
    }

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST H: DOW partial overlap
  // Original [2027-03-01, 2027-03-31) DOW [5,6,7] (Fri, Sat, Sun) @ 600,000
  // New [2027-03-10, 2027-03-20) DOW [6,7] (Sat, Sun) @ 800,000
  // Result: Friday in middle remains 600k; outside weekends remain 600k; inner Sat/Sun become 800k
  console.log('\n[Test H] DOW partial overlap');
  {
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-03-01',
      end_date: '2027-03-31',
      override_rate: 600000,
      days_of_week: [5, 6, 7]
    });

    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-03-10',
      end_date: '2027-03-20',
      override_rate: 800000,
      days_of_week: [6, 7],
      replace_existing: true
    });

    // Check Friday 2027-03-12 (dow=5) -> should remain 600,000
    // Check Saturday 2027-03-13 (dow=6) -> should be 800,000
    // Check Saturday 2027-03-27 (dow=6) -> should remain 600,000
    const mat = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2027-03-01&end_date=2027-03-31`
    );
    const fri12 = mat.json.days.find((d) => d.date === '2027-03-12');
    const sat13 = mat.json.days.find((d) => d.date === '2027-03-13');
    const sat27 = mat.json.days.find((d) => d.date === '2027-03-27');

    expect(fri12.effective_rate === 600000, 'Fri 2027-03-12 preserved at 600,000');
    expect(sat13.effective_rate === 800000, 'Sat 2027-03-13 updated to 800,000');
    expect(sat27.effective_rate === 600000, 'Sat 2027-03-27 preserved at 600,000');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST I & J: Bulk Preview Zero-Writes & Affected Counts
  console.log('\n[Test I & J] Bulk Preview Zero-Writes & Count Calculations');
  {
    // Setup 1 existing override on Plan A1 for [2027-04-01, 2027-04-05)
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-04-01',
      end_date: '2027-04-05',
      override_rate: 550000
    });

    const countBefore = (await pool.query('SELECT count(*) FROM rate_overrides')).rows[0].count;

    // Preview bulk override across Plan A1 and Plan A2 for [2027-04-01, 2027-04-10)
    const prev = await api('POST', `/api/pricing/bulk-overrides/preview`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1, ratePlanIdA2],
      start_date: '2027-04-01',
      end_date: '2027-04-10',
      override_rate: 990000,
      days_of_week: null,
      reason: 'Bulk April Promo'
    });

    expect(prev.status === 200, 'Preview succeeded with 200');
    const countAfter = (await pool.query('SELECT count(*) FROM rate_overrides')).rows[0].count;
    expect(countBefore === countAfter, 'Zero writes during preview');

    expect(prev.json.preview_token.startsWith('sha256:'), 'Deterministic preview_token generated');
    // 9 nights * 2 plans = 18 total items
    expect(prev.json.affected_dates_count === 18, `Affected dates count = 18 (got ${prev.json.affected_dates_count})`);
    // 4 nights on Plan A1 replace existing
    expect(prev.json.replacements_count === 4, `Replacements count = 4 (got ${prev.json.replacements_count})`);

    // Clean up
    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id IN ($1, $2)', [ratePlanIdA1, ratePlanIdA2]);
  }

  // TEST K: Bulk Apply Atomicity & Invariant Integrity
  console.log('\n[Test K] Bulk Apply Atomicity');
  {
    const prev = await api('POST', `/api/pricing/bulk-overrides/preview`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1, ratePlanIdA2],
      start_date: '2027-05-01',
      end_date: '2027-05-06',
      override_rate: 770000,
      days_of_week: null,
      reason: 'May Bulk'
    });

    const applyRes = await api('POST', `/api/pricing/bulk-overrides/apply`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1, ratePlanIdA2],
      start_date: '2027-05-01',
      end_date: '2027-05-06',
      override_rate: 770000,
      days_of_week: null,
      reason: 'May Bulk',
      preview_token: prev.json.preview_token
    });

    expect(applyRes.status === 200, 'Bulk apply succeeded with 200');

    // Verify matrix on both plans
    const matA1 = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA1}/calendar?property_id=${propIdA}&start_date=2027-05-01&end_date=2027-05-06`
    );
    const matA2 = await api(
      'GET',
      `/api/pricing/rate-plans/${ratePlanIdA2}/calendar?property_id=${propIdA}&start_date=2027-05-01&end_date=2027-05-06`
    );

    expect(matA1.json.days.every((d) => d.effective_rate === 770000), 'Plan A1 all days updated to 770,000');
    expect(matA2.json.days.every((d) => d.effective_rate === 770000), 'Plan A2 all days updated to 770,000');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id IN ($1, $2)', [ratePlanIdA1, ratePlanIdA2]);
  }

  // TEST L: Stale Token 409 Conflict Detection
  console.log('\n[Test L] Stale Token 409 Conflict Detection');
  {
    // Generate preview
    const prev = await api('POST', `/api/pricing/bulk-overrides/preview`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-06-01',
      end_date: '2027-06-10',
      override_rate: 880000,
      days_of_week: null
    });

    // Concurrent mutation occurs
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-06-05',
      end_date: '2027-06-06',
      override_rate: 999000
    });

    // Attempt to apply with now-stale token
    const applyStale = await api('POST', `/api/pricing/bulk-overrides/apply`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-06-01',
      end_date: '2027-06-10',
      override_rate: 880000,
      days_of_week: null,
      preview_token: prev.json.preview_token
    });

    expect(applyStale.status === 409, `409 conflict returned on stale token (got ${applyStale.status})`);
    expect(applyStale.json.code === 'RATE_CALENDAR_CHANGED', 'Code is RATE_CALENDAR_CHANGED');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST M1: Concurrency simulation / double apply rejection (Bulk Apply vs Bulk Apply)
  console.log('\n[Test M1] Bulk Apply vs Bulk Apply concurrency');
  {
    const prev = await api('POST', `/api/pricing/bulk-overrides/preview`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-07-01',
      end_date: '2027-07-05',
      override_rate: 620000
    });

    const apply1 = await api('POST', `/api/pricing/bulk-overrides/apply`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-07-01',
      end_date: '2027-07-05',
      override_rate: 620000,
      preview_token: prev.json.preview_token
    });
    expect(apply1.status === 200, 'First apply passes');

    // Second apply with identical token must 409 because state changed from apply 1
    const apply2 = await api('POST', `/api/pricing/bulk-overrides/apply`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-07-01',
      end_date: '2027-07-05',
      override_rate: 620000,
      preview_token: prev.json.preview_token
    });
    expect(apply2.status === 409, 'Second apply rejected with 409 conflict');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST M2: Bulk Apply vs Single-Date Override Race
  console.log('\n[Test M2] Bulk Apply vs Single-Date Writer Race');
  {
    const prev = await api('POST', `/api/pricing/bulk-overrides/preview`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-07-10',
      end_date: '2027-07-15',
      override_rate: 700000
    });

    // Concurrent single-date writer modifies a date in the window
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-07-12',
      end_date: '2027-07-13',
      override_rate: 850000,
      replace_existing: true
    });

    // Bulk apply with original preview token must detect the change and 409
    const applyRes = await api('POST', `/api/pricing/bulk-overrides/apply`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-07-10',
      end_date: '2027-07-15',
      override_rate: 700000,
      preview_token: prev.json.preview_token
    });
    expect(applyRes.status === 409, 'Bulk Apply rejected with 409 when single date was modified');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST M3: Bulk Apply vs Reset/Delete Race
  console.log('\n[Test M3] Bulk Apply vs Reset/Delete Race');
  {
    // First create an existing override
    const initialOverride = await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-07-20',
      end_date: '2027-07-25',
      override_rate: 750000
    });

    // Preview bulk update
    const prev = await api('POST', `/api/pricing/bulk-overrides/preview`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-07-20',
      end_date: '2027-07-25',
      override_rate: 800000
    });

    // Concurrent writer resets one date
    await api('DELETE', `/api/pricing/rate-overrides/${initialOverride.json.id}?property_id=${propIdA}&target_date=2027-07-22`);

    // Bulk apply with preview token must detect change and 409
    const applyRes = await api('POST', `/api/pricing/bulk-overrides/apply`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-07-20',
      end_date: '2027-07-25',
      override_rate: 800000,
      preview_token: prev.json.preview_token
    });
    expect(applyRes.status === 409, 'Bulk Apply rejected with 409 after concurrent reset/delete');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST N: Cross-Property Isolation
  console.log('\n[Test N] Cross-Property Isolation');
  {
    // Property A tries to preview/apply Rate Plan belonging to Property B
    const crossPrev = await api('POST', `/api/pricing/bulk-overrides/preview`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdB],
      start_date: '2027-08-01',
      end_date: '2027-08-05',
      override_rate: 700000
    });
    expect(crossPrev.status === 400 || crossPrev.status === 403, `Cross-property preview rejected (status ${crossPrev.status})`);

    const crossApply = await api('POST', `/api/pricing/bulk-overrides/apply`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdB],
      start_date: '2027-08-01',
      end_date: '2027-08-05',
      override_rate: 700000,
      preview_token: 'sha256:fake'
    });
    expect(crossApply.status === 400 || crossApply.status === 403, `Cross-property apply rejected (status ${crossApply.status})`);
  }

  // TEST O: Historical reservation snapshots remain untouched
  console.log('\n[Test O] Historical Reservation Snapshots Untouched');
  {
    const randO = Math.floor(1000 + Math.random() * 9000);
    // Create a mock reservation snapshot in reservation_nightly_rates
    const guest = await pool.query(
      `INSERT INTO guests (full_name, email, phone, created_property_id)
       VALUES ('Snapshot Guest', 'snap@guest.com', '081234', $1)
       RETURNING id`,
      [propIdA]
    );
    const guestId = guest.rows[0].id;

    const bkg = await pool.query(
      `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_source, booking_status)
       VALUES ($1, $2, 'Snapshot Guest', 'WALKIN', 'ACTIVE')
       RETURNING id`,
      [propIdA, `BID-SNAP-${randO}`]
    );
    const bkgId = bkg.rows[0].id;

    const resv = await pool.query(
      `INSERT INTO reservations (booking_id, check_in, check_out, guest_name, status, rate_plan_id, booked_room_type_id_snapshot, stay_sequence)
       VALUES ($1, '2027-09-01 14:00:00', '2027-09-03 12:00:00', 'Snapshot Guest', 'BOOKED', $2, $3, 1)
       RETURNING id`,
      [bkgId, ratePlanIdA1, roomTypeIdA]
    );
    const resvId = resv.rows[0].id;

    await pool.query(
      `INSERT INTO reservation_nightly_rates (reservation_id, property_id, stay_date, room_type_id, base_rate, final_room_rate, total_amount)
       VALUES ($1, $2, '2027-09-01', $3, 500000, 500000, 500000),
              ($1, $2, '2027-09-02', $3, 500000, 500000, 500000)`,
      [resvId, propIdA, roomTypeIdA]
    );

    // Now set an aggressive bulk override for September 2027
    const prev = await api('POST', `/api/pricing/bulk-overrides/preview`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-09-01',
      end_date: '2027-09-05',
      override_rate: 999999
    });

    await api('POST', `/api/pricing/bulk-overrides/apply`, {
      property_id: propIdA,
      rate_plan_ids: [ratePlanIdA1],
      start_date: '2027-09-01',
      end_date: '2027-09-05',
      override_rate: 999999,
      preview_token: prev.json.preview_token
    });

    // Verify reservation_nightly_rates are still exactly 500,000
    const snapshotRows = await pool.query(
      'SELECT final_room_rate FROM reservation_nightly_rates WHERE reservation_id = $1 ORDER BY stay_date',
      [resvId]
    );
    expect(snapshotRows.rows.length === 2, '2 snapshot rows found');
    expect(
      Number(snapshotRows.rows[0].final_room_rate) === 500000 && Number(snapshotRows.rows[1].final_room_rate) === 500000,
      'Historical reservation_nightly_rates snapshots untouched at 500,000'
    );

    // Clean up reservation & booking
    await pool.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = $1', [resvId]);
    await pool.query('DELETE FROM reservations WHERE id = $1', [resvId]);
    await pool.query('DELETE FROM bookings WHERE id = $1', [bkgId]);
    await pool.query('DELETE FROM guests WHERE id = $1', [guestId]);
    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  // TEST P: Multi-Night Quote calculation [check_in, check_out)
  console.log('\n[Test P] Multi-Night Quote Calculation');
  {
    // Override on Oct 02 only
    await api('POST', `/api/pricing/rate-plans/${ratePlanIdA1}/overrides?property_id=${propIdA}`, {
      start_date: '2027-10-02',
      end_date: '2027-10-03',
      override_rate: 800000
    });

    // Quote for 3 nights: Oct 01, Oct 02, Oct 03 (checkout Oct 04)
    // Oct 01 = 500k base
    // Oct 02 = 800k override
    // Oct 03 = 500k base
    // Oct 04 is checkout (not counted)
    const quoteRes = await api('POST', `/api/pricing/quote`, {
      property_id: propIdA,
      room_type_id: roomTypeIdA,
      rate_plan_id: ratePlanIdA1,
      check_in: '2027-10-01',
      check_out: '2027-10-04'
    });

    expect(quoteRes.status === 200, 'Quote calculated');
    expect(quoteRes.json.nightly_breakdown.length === 3, '3 occupied nights returned');
    expect(quoteRes.json.nightly_breakdown[0].final_room_rate === 500000, 'Night 1 = 500,000');
    expect(quoteRes.json.nightly_breakdown[1].final_room_rate === 800000, 'Night 2 = 800,000 (override)');
    expect(quoteRes.json.nightly_breakdown[2].final_room_rate === 500000, 'Night 3 = 500,000');
    expect(quoteRes.json.room_subtotal === 1800000, 'Total subtotal = 1,800,000');

    await pool.query('DELETE FROM rate_overrides WHERE rate_plan_id = $1', [ratePlanIdA1]);
  }

  console.log(`\n========================================`);
  console.log(`TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log(`========================================\n`);
}

async function main() {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  try {
    await setupFixtures();
    await runTests();
  } catch (err) {
    console.error('Fatal test runner error:', err);
    process.exitCode = 1;
  } finally {
    await cleanupFixtures();
    server.close();
    await pool.end();
  }
}

main();
