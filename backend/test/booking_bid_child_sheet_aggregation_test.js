import assert from 'node:assert/strict';
import {
  deriveGroupOperationalSheet,
  buildChild,
} from '../dist/domains/transactions/bookingBidGrouping.js';

/**
 * REGRESSION TEST: BID Child Sheet Aggregation — Order Independence
 *
 * ROOT CAUSE: buildChild() previously used members[0] to determine the canonical
 * operational sheet, making the result dependent on member order. This test
 * proves that the sheet is now derived from ALL members via
 * deriveGroupOperationalSheet() and is therefore order-independent.
 *
 * Scenarios:
 * 1. BOOKED reservation child with PROSES + PROSES + BATAL => PROSES
 * 2. Same result when BATAL is members[0] (reversed order)
 * 3. All-BATAL child => BATAL
 * 4. All-SELESAI child => SELESAI
 * 5. Mixed PROSES + SELESAI => PROSES (not all same, not all BATAL/SELESAI)
 */

function makeRow(overrides = {}) {
  return {
    id: Math.floor(Math.random() * 10000),
    amount: 100000,
    discount_amount: 0,
    net_amount: 100000,
    paid_amount: 0,
    transaction_status: 'POSTED',
    operational_sheet: 'PROSES',
    reservation_id: 42,
    booking_id: 1,
    property_id: 1,
    booking_bid: 'TEST-BID-ORDER',
    room_number_snapshot: '208',
    check_in: '2025-01-01',
    check_out: '2025-01-03',
    stay_type: 'OVERNIGHT',
    stay_sequence: 1,
    payment_responsibility: 'HOTEL_COLLECT',
    ...overrides,
  };
}

function runScenarios() {
  console.log('=== BID CHILD SHEET AGGREGATION — ORDER-INDEPENDENCE TEST ===\n');

  // ------------------------------------------------------------------
  // Test 1: PROSES + PROSES + BATAL => PROSES (BATAL is not all)
  // ------------------------------------------------------------------
  {
    const membersForward = [
      makeRow({ id: 101, operational_sheet: 'PROSES' }),
      makeRow({ id: 102, operational_sheet: 'PROSES' }),
      makeRow({ id: 103, operational_sheet: 'BATAL' }),
    ];
    const child1 = buildChild(42, membersForward);
    assert.strictEqual(child1.operational_sheet, 'PROSES',
      'Test 1a: PROSES+PROSES+BATAL must yield PROSES');
    assert.strictEqual(child1.canonical_operational_sheet, 'PROSES',
      'Test 1a: canonical sheet must be PROSES (aggregated)');

    console.log('[PASS] Test 1a: PROSES + PROSES + BATAL => PROSES');
  }

  // ------------------------------------------------------------------
  // Test 2: Same result when order reversed — BATAL becomes members[0]
  // ------------------------------------------------------------------
  {
    const membersReversed = [
      makeRow({ id: 103, operational_sheet: 'BATAL' }),
      makeRow({ id: 101, operational_sheet: 'PROSES' }),
      makeRow({ id: 102, operational_sheet: 'PROSES' }),
    ];
    const child2 = buildChild(42, membersReversed);
    assert.strictEqual(child2.operational_sheet, 'PROSES',
      'Test 2: BATAL+PROSES+PROSES (BATAL first) must still yield PROSES');
    assert.strictEqual(child2.canonical_operational_sheet, 'PROSES',
      'Test 2: canonical sheet order-independent');

    // Cross-check with deriveGroupOperationalSheet directly
    const expected = deriveGroupOperationalSheet(
      membersReversed.map((m) => m.operational_sheet)
    );
    assert.strictEqual(expected, 'PROSES', 'Test 2: deriveGroupOperationalSheet consistency');

    console.log('[PASS] Test 2: Reversed order (BATAL first) => PROSES');
  }

  // ------------------------------------------------------------------
  // Test 3: All-BATAL => BATAL
  // ------------------------------------------------------------------
  {
    const membersAllBatal = [
      makeRow({ id: 201, operational_sheet: 'BATAL' }),
      makeRow({ id: 202, operational_sheet: 'BATAL' }),
      makeRow({ id: 203, operational_sheet: 'BATAL' }),
    ];
    const child3 = buildChild(42, membersAllBatal);
    assert.strictEqual(child3.operational_sheet, 'BATAL',
      'Test 3: all-BATAL must yield BATAL');
    assert.strictEqual(child3.canonical_operational_sheet, 'BATAL',
      'Test 3: canonical sheet all-BATAL => BATAL');

    console.log('[PASS] Test 3: All-BATAL => BATAL');
  }

  // ------------------------------------------------------------------
  // Test 4: All-SELESAI => SELESAI
  // ------------------------------------------------------------------
  {
    const membersAllSelesai = [
      makeRow({ id: 301, operational_sheet: 'SELESAI' }),
      makeRow({ id: 302, operational_sheet: 'SELESAI' }),
    ];
    const child4 = buildChild(42, membersAllSelesai);
    assert.strictEqual(child4.operational_sheet, 'SELESAI',
      'Test 4: all-SELESAI must yield SELESAI');
    assert.strictEqual(child4.canonical_operational_sheet, 'SELESAI',
      'Test 4: canonical sheet all-SELESAI => SELESAI');

    console.log('[PASS] Test 4: All-SELESAI => SELESAI');
  }

  // ------------------------------------------------------------------
  // Test 5: PROSES + SELESAI (mixed, not all same) => PROSES
  // ------------------------------------------------------------------
  {
    const membersMixed = [
      makeRow({ id: 401, operational_sheet: 'PROSES' }),
      makeRow({ id: 402, operational_sheet: 'SELESAI' }),
    ];
    const child5 = buildChild(42, membersMixed);
    assert.strictEqual(child5.operational_sheet, 'PROSES',
      'Test 5: PROSES+SELESAI mixed must yield PROSES (not SELESAI, not BATAL)');

    // Reversed
    const membersMixedReversed = [
      makeRow({ id: 402, operational_sheet: 'SELESAI' }),
      makeRow({ id: 401, operational_sheet: 'PROSES' }),
    ];
    const child5b = buildChild(42, membersMixedReversed);
    assert.strictEqual(child5b.operational_sheet, 'PROSES',
      'Test 5b: SELESAI+PROSES reversed must also yield PROSES');

    console.log('[PASS] Test 5: PROSES + SELESAI mixed => PROSES (order-independent)');
  }

  // ------------------------------------------------------------------
  // Test 6: Single member PROSES => PROSES (sanity)
  // ------------------------------------------------------------------
  {
    const single = [makeRow({ id: 501, operational_sheet: 'PROSES' })];
    const child6 = buildChild(42, single);
    assert.strictEqual(child6.operational_sheet, 'PROSES',
      'Test 6: single PROSES member => PROSES');

    console.log('[PASS] Test 6: Single PROSES => PROSES');
  }

  // ------------------------------------------------------------------
  // Test 7: Single member BATAL => BATAL (sanity)
  // ------------------------------------------------------------------
  {
    const singleBatal = [makeRow({ id: 502, operational_sheet: 'BATAL' })];
    const child7 = buildChild(42, singleBatal);
    assert.strictEqual(child7.operational_sheet, 'BATAL',
      'Test 7: single BATAL member => BATAL');

    console.log('[PASS] Test 7: Single BATAL => BATAL');
  }

  console.log('\n=== ALL BID CHILD AGGREGATION ORDER-INDEPENDENCE TESTS PASSED ===');
}

runScenarios();
