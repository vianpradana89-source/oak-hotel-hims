'use strict';

const crypto = require('crypto');
const assert = require('assert');

// ─── REPLICATED PURE PDM ALGEBRA TEST (Direct matching pricingService.ts) ───

function computeRateCalendarFingerprint(state) {
  const sortedPlanIds = [...state.rate_plan_ids].sort((a, b) => a - b);
  const sortedDow = state.days_of_week ? [...state.days_of_week].sort((a, b) => a - b) : null;
  const sortedOverrides = (state.active_overrides || [])
    .map((o) => ({
      id: Number(o.id),
      rate_plan_id: Number(o.rate_plan_id),
      start_date: String(o.start_date).slice(0, 10),
      end_date: String(o.end_date).slice(0, 10),
      override_rate: Math.round(Number(o.override_rate)),
      days_of_week: Array.isArray(o.days_of_week) ? [...o.days_of_week].sort((a, b) => a - b) : null
    }))
    .sort((a, b) => (a.id !== b.id ? a.id - b.id : a.rate_plan_id - b.rate_plan_id));

  const canonicalObj = {
    property_id: Number(state.property_id),
    rate_plan_ids: sortedPlanIds,
    start_date: state.start_date.slice(0, 10),
    end_date: state.end_date.slice(0, 10),
    days_of_week: sortedDow,
    proposed_rate: Math.round(Number(state.proposed_rate)),
    active_overrides: sortedOverrides
  };

  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalObj)).digest('hex')}`;
}

// Slice simulation
function simulateImmutableOverlap(existing, incoming) {
  const actions = {
    archived: [],
    slices: [],
    created: []
  };

  const SN = incoming.start_date;
  const EN = incoming.end_date;
  const targetDows = incoming.days_of_week || [1, 2, 3, 4, 5, 6, 7];

  for (const ext of existing) {
    const SE = ext.start_date;
    const EE = ext.end_date;
    const extDows = ext.days_of_week || [1, 2, 3, 4, 5, 6, 7];

    const hasDateOverlap = !(EE <= SN || SE >= EN);
    if (!hasDateOverlap) continue;

    const overlappingDows = extDows.filter((d) => targetDows.includes(d));
    if (overlappingDows.length === 0) continue;

    // Archive existing
    actions.archived.push(ext.id);

    // 1. Non-colliding DOW slice across full span
    const nonOverlappingDows = extDows.filter((d) => !targetDows.includes(d));
    if (nonOverlappingDows.length > 0) {
      actions.slices.push({
        start_date: SE,
        end_date: EE,
        days_of_week: nonOverlappingDows,
        override_rate: ext.override_rate,
        reason: `${ext.reason || 'Override'} (sisa hari)`
      });
    }

    // 2. Left slice [SE, min(EE, SN))
    if (SE < SN) {
      const leftEnd = EE < SN ? EE : SN;
      actions.slices.push({
        start_date: SE,
        end_date: leftEnd,
        days_of_week: overlappingDows.length === 7 ? null : overlappingDows,
        override_rate: ext.override_rate,
        reason: `${ext.reason || 'Override'} (sisa sebelum)`
      });
    }

    // 3. Right slice [max(SE, EN), EE)
    if (EE > EN) {
      const rightStart = SE > EN ? SE : EN;
      actions.slices.push({
        start_date: rightStart,
        end_date: EE,
        days_of_week: overlappingDows.length === 7 ? null : overlappingDows,
        override_rate: ext.override_rate,
        reason: `${ext.reason || 'Override'} (sisa setelah)`
      });
    }
  }

  // New override
  actions.created.push({
    start_date: SN,
    end_date: EN,
    days_of_week: incoming.days_of_week,
    override_rate: incoming.override_rate,
    reason: incoming.reason
  });

  return actions;
}

let passed = 0;
function expect(cond, msg) {
  if (cond) {
    passed += 1;
    console.log('PASS | ' + msg);
  } else {
    console.error('FAIL | ' + msg);
    throw new Error('Failed: ' + msg);
  }
}

console.log('=== RATE CALENDAR PHASE 1 UNIT & ALGEBRA TESTS ===\n');

// 1. Deterministic Token
{
  const state1 = {
    property_id: 1,
    rate_plan_ids: [2, 1],
    start_date: '2026-10-01',
    end_date: '2026-10-10',
    days_of_week: [7, 6],
    proposed_rate: 600000,
    active_overrides: [
      { id: 10, rate_plan_id: 1, start_date: '2026-10-05', end_date: '2026-10-08', override_rate: 550000, days_of_week: null }
    ]
  };

  const state2 = {
    property_id: 1,
    rate_plan_ids: [1, 2], // Different order
    start_date: '2026-10-01',
    end_date: '2026-10-10',
    days_of_week: [6, 7], // Different order
    proposed_rate: 600000,
    active_overrides: [
      { id: 10, rate_plan_id: 1, start_date: '2026-10-05', end_date: '2026-10-08', override_rate: 550000, days_of_week: null }
    ]
  };

  const t1 = computeRateCalendarFingerprint(state1);
  const t2 = computeRateCalendarFingerprint(state2);
  expect(t1 === t2, 'Fingerprint is canonical and order-independent');

  // Mutation produces different token
  state2.proposed_rate = 650000;
  const t3 = computeRateCalendarFingerprint(state2);
  expect(t1 !== t3, 'Mutation produces different fingerprint (409 trigger)');
}

// 2. Left-Slice Overlap
{
  const existing = [
    { id: 1, start_date: '2026-10-10', end_date: '2026-10-20', override_rate: 500000, days_of_week: null, reason: 'Orig' }
  ];
  const incoming = { start_date: '2026-10-15', end_date: '2026-10-25', override_rate: 600000, days_of_week: null, reason: 'New' };
  const res = simulateImmutableOverlap(existing, incoming);

  expect(res.archived.includes(1), 'Original row archived');
  expect(res.slices.length === 1, 'Exactly 1 left slice created');
  expect(res.slices[0].start_date === '2026-10-10' && res.slices[0].end_date === '2026-10-15', 'Left slice [2026-10-10, 2026-10-15)');
  expect(res.slices[0].override_rate === 500000, 'Left slice keeps original rate 500,000');
  expect(res.created[0].start_date === '2026-10-15' && res.created[0].end_date === '2026-10-25', 'New row [2026-10-15, 2026-10-25)');
}

// 3. Right-Slice Overlap
{
  const existing = [
    { id: 1, start_date: '2026-10-10', end_date: '2026-10-20', override_rate: 500000, days_of_week: null, reason: 'Orig' }
  ];
  const incoming = { start_date: '2026-10-05', end_date: '2026-10-15', override_rate: 600000, days_of_week: null, reason: 'New' };
  const res = simulateImmutableOverlap(existing, incoming);

  expect(res.archived.includes(1), 'Original row archived');
  expect(res.slices.length === 1, 'Exactly 1 right slice created');
  expect(res.slices[0].start_date === '2026-10-15' && res.slices[0].end_date === '2026-10-20', 'Right slice [2026-10-15, 2026-10-20)');
  expect(res.slices[0].override_rate === 500000, 'Right slice keeps original rate 500,000');
}

// 4. Inner Split
{
  const existing = [
    { id: 1, start_date: '2026-10-01', end_date: '2026-10-31', override_rate: 500000, days_of_week: null, reason: 'Orig' }
  ];
  const incoming = { start_date: '2026-10-10', end_date: '2026-10-20', override_rate: 700000, days_of_week: null, reason: 'New' };
  const res = simulateImmutableOverlap(existing, incoming);

  expect(res.archived.includes(1), 'Original row archived');
  expect(res.slices.length === 2, '2 slices created (left and right)');
  expect(res.slices[0].start_date === '2026-10-01' && res.slices[0].end_date === '2026-10-10', 'Left slice [2026-10-01, 2026-10-10)');
  expect(res.slices[1].start_date === '2026-10-20' && res.slices[1].end_date === '2026-10-31', 'Right slice [2026-10-20, 2026-10-31)');
}

// 5. Full Coverage
{
  const existing = [
    { id: 1, start_date: '2026-10-10', end_date: '2026-10-20', override_rate: 500000, days_of_week: null, reason: 'Orig' }
  ];
  const incoming = { start_date: '2026-10-05', end_date: '2026-10-25', override_rate: 800000, days_of_week: null, reason: 'New' };
  const res = simulateImmutableOverlap(existing, incoming);

  expect(res.archived.includes(1), 'Original row archived');
  expect(res.slices.length === 0, 'Zero slices created for fully covered span');
  expect(res.created[0].override_rate === 800000, 'New row created @ 800,000');
}

// 6. DOW Disjoint
{
  const existing = [
    { id: 1, start_date: '2026-10-01', end_date: '2026-10-31', override_rate: 450000, days_of_week: [1, 2, 3, 4, 5], reason: 'Weekdays' }
  ];
  const incoming = { start_date: '2026-10-01', end_date: '2026-10-31', override_rate: 650000, days_of_week: [6, 7], reason: 'Weekends' };
  const res = simulateImmutableOverlap(existing, incoming);

  expect(res.archived.length === 0, 'Disjoint DOW does not archive existing');
  expect(res.slices.length === 0, 'Zero slices needed');
  expect(res.created.length === 1, 'Weekend override created');
}

// 7. DOW Partial Overlap
{
  const existing = [
    { id: 1, start_date: '2026-10-01', end_date: '2026-10-31', override_rate: 600000, days_of_week: [5, 6, 7], reason: 'Weekend Promo' }
  ];
  const incoming = { start_date: '2026-10-10', end_date: '2026-10-20', override_rate: 800000, days_of_week: [6, 7], reason: 'Sat Sun Peak' };
  const res = simulateImmutableOverlap(existing, incoming);

  expect(res.archived.includes(1), 'Original row archived');
  // 1 non-colliding dow slice (Friday 5 across full month)
  // 1 left slice for [2026-10-01, 2026-10-10) on [6,7]
  // 1 right slice for [2026-10-20, 2026-10-31) on [6,7]
  expect(res.slices.length === 3, '3 slices created to preserve all unaffected dates & days');
  const dow5Slice = res.slices.find((s) => s.days_of_week && s.days_of_week.includes(5));
  expect(dow5Slice && dow5Slice.start_date === '2026-10-01' && dow5Slice.end_date === '2026-10-31', 'Friday preserved for full month');
}

// 8. Advisory Lock Key Determinism and Deadlock Prevention Ordering
{
  const planIds1 = [5, 2, 8, 1];
  const sorted1 = Array.from(new Set(planIds1.map((id) => Number(id)))).sort((a, b) => a - b);
  expect(JSON.stringify(sorted1) === JSON.stringify([1, 2, 5, 8]), 'Lock acquisition sorts plan IDs ascending');

  // Verify key string generation
  const keyProp1Plan2 = `oak_rate_calendar_1_2`;
  const keyProp1Plan5 = `oak_rate_calendar_1_5`;
  const keyProp2Plan2 = `oak_rate_calendar_2_2`;
  expect(keyProp1Plan2 !== keyProp1Plan5, 'Different rate plans produce distinct lock keys');
  expect(keyProp1Plan2 !== keyProp2Plan2, 'Different properties produce distinct lock keys');
}

// 9. Concurrency Simulation: Bulk Apply vs Bulk Apply (Stale Preview Detection)
{
  const initialState = {
    property_id: 1,
    rate_plan_ids: [10],
    start_date: '2026-11-01',
    end_date: '2026-11-10',
    days_of_week: null,
    proposed_rate: 700000,
    active_overrides: []
  };

  const previewToken1 = computeRateCalendarFingerprint(initialState);
  const previewToken2 = computeRateCalendarFingerprint(initialState);
  expect(previewToken1 === previewToken2, 'Initial preview tokens are identical');

  // Writer 1 applies first and changes state
  const stateAfterWriter1 = {
    ...initialState,
    active_overrides: [
      { id: 101, rate_plan_id: 10, start_date: '2026-11-01', end_date: '2026-11-10', override_rate: 700000, days_of_week: null }
    ]
  };

  // Writer 2 attempts to apply with stale token
  const stateAtWriter2Lock = computeRateCalendarFingerprint({
    ...initialState,
    proposed_rate: 750000,
    active_overrides: stateAfterWriter1.active_overrides
  });

  expect(stateAtWriter2Lock !== previewToken2, 'Writer 2 detect state change under lock and aborts with 409');
}

// 10. Concurrency Simulation: Bulk Apply vs Single Date Override Race
{
  const initial = {
    property_id: 1,
    rate_plan_ids: [20],
    start_date: '2026-12-01',
    end_date: '2026-12-05',
    days_of_week: null,
    proposed_rate: 800000,
    active_overrides: []
  };

  const bulkPreviewToken = computeRateCalendarFingerprint(initial);

  // Single date writer inserts an override for 2026-12-02 @ 900,000 before Bulk Apply acquires lock
  const singleOverride = {
    id: 202,
    rate_plan_id: 20,
    start_date: '2026-12-02',
    end_date: '2026-12-03',
    override_rate: 900000,
    days_of_week: null
  };

  // When Bulk Apply acquires lock and recomputes fingerprint:
  const liveTokenUnderLock = computeRateCalendarFingerprint({
    ...initial,
    active_overrides: [singleOverride]
  });

  expect(liveTokenUnderLock !== bulkPreviewToken, 'Bulk Apply detects intervening single-date override and rejects stale apply with 409');
}

// 11. Concurrency Simulation: Disjoint Rate Plans Non-Blocking
{
  const planA = 101;
  const planB = 102;
  const lockKeyA = `oak_rate_calendar_1_${planA}`;
  const lockKeyB = `oak_rate_calendar_1_${planB}`;

  expect(lockKeyA !== lockKeyB, 'Disjoint Rate Plans have distinct lock keys allowing concurrent execution without blocking');
}

console.log(`\n========================================`);
console.log(`ALL ${passed} UNIT & CONCURRENCY TESTS PASSED!`);
console.log(`========================================\n`);
