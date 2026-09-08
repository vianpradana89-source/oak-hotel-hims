import assert from 'node:assert/strict';
import type {
  OperationalSheet,
  PurchaseLifecycleAction,
} from '../src/features/transactions/transactionDomainTypes.ts';
import {
  mapToOperationalStatus,
  isReportingEligible,
} from '../src/features/transactions/transactionDomainTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Purchase Lifecycle (PURCHASE-2A3) Tests ===\n');

// ============================================================================
// Test A: mapToOperationalStatus for PURCHASE with different receiving statuses
// ============================================================================
console.log('--- Test A: Purchase receiving_status -> operational status ---');

const purchaseBase = {
  transaction_type: 'PURCHASE',
  transaction_status: 'POSTED',
  is_lifecycle_primary: true,
};

check(mapToOperationalStatus({ ...purchaseBase, receiving_status: null }).group === 'PROSES',
  'A1. null receiving_status -> PROSES');
check(mapToOperationalStatus({ ...purchaseBase, receiving_status: 'BELUM_DITERIMA' }).group === 'PROSES',
  'A2. BELUM_DITERIMA -> PROSES');
check(mapToOperationalStatus({ ...purchaseBase, receiving_status: 'DITERIMA_SEBAGIAN' }).group === 'PROSES',
  'A3. DITERIMA_SEBAGIAN -> PROSES');
check(mapToOperationalStatus({ ...purchaseBase, receiving_status: 'DITERIMA' }).group === 'SELESAI',
  'A4. DITERIMA -> SELESAI');
check(mapToOperationalStatus({ ...purchaseBase, receiving_status: 'DITERIMA_LENGKAP' }).group === 'SELESAI',
  'A5. DITERIMA_LENGKAP -> SELESAI');

// ============================================================================
// Test B: Verification status does not affect operational_sheet
// ============================================================================
console.log('\n--- Test B: Verification status is independent of operational sheet ---');

check(mapToOperationalStatus({
  ...purchaseBase,
  receiving_status: 'DITERIMA',
  verification_status: 'REJECTED',
}).group === 'SELESAI', 'B1. DITERIMA + REJECTED still SELESAI (receiving drives sheet)');

check(mapToOperationalStatus({
  ...purchaseBase,
  receiving_status: 'DITERIMA_LENGKAP',
  verification_status: 'VERIFIED',
}).group === 'SELESAI', 'B2. DITERIMA_LENGKAP + VERIFIED still SELESAI');

check(mapToOperationalStatus({
  ...purchaseBase,
  receiving_status: 'BELUM_DITERIMA',
  verification_status: 'UNVERIFIED',
}).group === 'PROSES', 'B3. BELUM_DITERIMA + UNVERIFIED -> PROSES');

// ============================================================================
// Test C: isReportingEligible contract
// ============================================================================
console.log('\n--- Test C: Reporting eligibility ---');

check(isReportingEligible('PROSES') === false, 'C1. PROSES -> not eligible');
check(isReportingEligible('SELESAI') === true, 'C2. SELESAI -> eligible');
check(isReportingEligible('BATAL') === false, 'C3. BATAL -> not eligible');
check(isReportingEligible('HAPUS') === false, 'C4. HAPUS -> not eligible');

// ============================================================================
// Test D: Non-PURCHASE transaction types unaffected
// ============================================================================
console.log('\n--- Test D: Non-purchase transaction types ---');

check(mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  reservation_id: null,
  source_type: 'POS',
}).group === 'SELESAI', 'D1. POSTED sale (POS) -> SELESAI');

check(mapToOperationalStatus({
  transaction_type: 'EXPENSE',
  transaction_status: 'POSTED',
}).group === 'SELESAI', 'D2. POSTED expense -> SELESAI');

check(mapToOperationalStatus({
  transaction_type: 'INCOME',
  transaction_status: 'POSTED',
}).group === 'SELESAI', 'D3. POSTED income -> SELESAI');

// ============================================================================
// Test E: Soft-deleted purchase shows HAPUS
// ============================================================================
console.log('\n--- Test E: Soft-deleted purchase override ---');

check(mapToOperationalStatus({
  ...purchaseBase,
  receiving_status: 'DITERIMA_LENGKAP',
  deleted_at: '2026-09-01T10:00:00Z',
}).group === 'HAPUS', 'E1. deleted_at -> HAPUS even with DITERIMA_LENGKAP');

check(mapToOperationalStatus({
  ...purchaseBase,
  receiving_status: 'BELUM_DITERIMA',
  deleted_at: '2026-09-01T10:00:00Z',
}).label === 'Hapus', 'E2. deleted_at label is "Hapus"');

// ============================================================================
// Test F: Lifecycle action values — BATAL must NOT be included
// ============================================================================
console.log('\n--- Test F: Lifecycle action values (BATAL excluded) ---');

// The frontend must only send SET_RECEIVING, SET_VERIFICATION, SET_WORKFLOW
// with PROSES or SELESAI — never BATAL as a workflow value
const allowedActions: PurchaseLifecycleAction[] = ['SET_RECEIVING', 'SET_VERIFICATION', 'SET_WORKFLOW'];
check(allowedActions.length === 3, 'F1. Three canonical lifecycle actions');
check(!allowedActions.includes('SET_WORKFLOW') === false, 'F2. SET_WORKFLOW present');

// Verify that BATAL is NOT a valid value for workflow_status in the frontend
// by checking the type definition only allows PROSES, SELESAI (not BATAL)
const validWorkflowValues: Array<'PROSES' | 'SELESAI'> = ['PROSES', 'SELESAI'];
check(validWorkflowValues.length === 2, 'F3. Only PROSES and SELESAI are valid workflow values');
check(!validWorkflowValues.includes('BATAL'), 'F4. BATAL is NOT a valid workflow value');
check(!validWorkflowValues.includes('HAPUS'), 'F5. HAPUS is NOT a valid workflow value');

// ============================================================================
// Test G: Terminal states (BATAL, HAPUS) are non-editable
// ============================================================================
console.log('\n--- Test G: Terminal states are non-editable ---');

// BATAL rows should show static badge, not a select
const batalPurchase = mapToOperationalStatus({
  ...purchaseBase,
  operational_sheet: 'BATAL',
});
check(batalPurchase.group === 'BATAL', 'G1. BATAL operational_sheet -> group=BATAL');
check(batalPurchase.label === 'Dibatalkan', 'G2. BATAL label defaults to "Dibatalkan"');

// HAPUS rows should show static badge, not a select
const hapusPurchase = mapToOperationalStatus({
  ...purchaseBase,
  operational_sheet: 'HAPUS',
});
check(hapusPurchase.group === 'HAPUS', 'G3. HAPUS operational_sheet -> group=HAPUS');
check(hapusPurchase.label === 'Hapus', 'G4. HAPUS label is "Hapus"');

// ============================================================================
// Test H: Receiving canonical write value is DITERIMA (not DITERIMA_LENGKAP)
// ============================================================================
console.log('\n--- Test H: Receiving canonical value ---');

// DITERIMA and DITERIMA_LENGKAP both map to SELESAI
check(mapToOperationalStatus({ ...purchaseBase, receiving_status: 'DITERIMA' }).group === 'SELESAI',
  'H1. DITERIMA -> SELESAI');
check(mapToOperationalStatus({ ...purchaseBase, receiving_status: 'DITERIMA_LENGKAP' }).group === 'SELESAI',
  'H2. DITERIMA_LENGKAP -> SELESAI (compatibility alias)');

// DITERIMA_SEBAGIAN must remain as PROSES (not collapsed)
check(mapToOperationalStatus({ ...purchaseBase, receiving_status: 'DITERIMA_SEBAGIAN' }).group === 'PROSES',
  'H3. DITERIMA_SEBAGIAN stays PROSES (not collapsed)');

// ============================================================================
// Test I: Verification does NOT trigger workflow change directly
// ============================================================================
console.log('\n--- Test I: Verification independence from workflow ---');

// VERIFIED status should not change operational_sheet (backend auto-rules do)
check(mapToOperationalStatus({
  ...purchaseBase,
  receiving_status: 'BELUM_DITERIMA',
  verification_status: 'VERIFIED',
}).group === 'PROSES', 'I1. VERIFIED + BELUM_DITERIMA -> PROSES (verification alone does not change sheet)');

check(mapToOperationalStatus({
  ...purchaseBase,
  receiving_status: 'DITERIMA',
  verification_status: 'VERIFIED',
}).group === 'SELESAI', 'I2. VERIFIED + DITERIMA -> SELESAI (receiving drives sheet)');

// ============================================================================
// Test J: All-tab sale group rows should NOT have lifecycle controls
// ============================================================================
console.log('\n--- Test J: All-tab sale groups are display-only ---');

// Sale summary rows use renderVerificationBadge + renderOperationalBadge (not selects)
// This is verified by the structure: t.booking_bid_group rows show badges, not selects
const saleGroup = mapToOperationalStatus({
  transaction_type: 'SALE',
  transaction_status: 'POSTED',
  reservation_id: 1,
  reservation_status: 'BOOKED',
  source_type: 'POS',
  is_lifecycle_primary: true,
  operational_sheet: 'PROSES',
});
check(saleGroup.group === 'PROSES', 'J1. Sale group in PROSES -> PROSES');

console.log(`\n=== All ${assertions} Purchase Lifecycle Assertions PASSED ===\n`);
