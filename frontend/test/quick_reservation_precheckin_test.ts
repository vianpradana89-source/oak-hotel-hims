import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CANONICAL_CHECKIN_REQUIREMENT_LABELS,
  getMissingRequirementLabel,
  evaluatePrecheckinReadiness,
} from '../src/features/calendar/precheckinGateUi.ts';

const here = dirname(fileURLToPath(import.meta.url));
const quickSrc = readFileSync(join(here, '../src/features/calendar/QuickReservationDetail.tsx'), 'utf8');
const depositSrc = readFileSync(join(here, '../src/features/deposits/DepositGuaranteeSection.tsx'), 'utf8');

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== PRECHECKIN-GATE-1C — Quick Reservation Card Canonical Gate Tests ===\n');

// --------------------------------------------------------------------------
// 1. CANONICAL LABELS CONTRACT
// --------------------------------------------------------------------------
console.log('--- 1. Canonical Requirement Labels ---');
check(
  CANONICAL_CHECKIN_REQUIREMENT_LABELS.PRIMARY_GUEST_NAME_MISSING === 'Nama tamu menginap belum lengkap',
  'PRIMARY_GUEST_NAME_MISSING label matches specification'
);
check(
  CANONICAL_CHECKIN_REQUIREMENT_LABELS.PRIMARY_GUEST_PHONE_MISSING === 'No. telepon tamu menginap belum lengkap',
  'PRIMARY_GUEST_PHONE_MISSING label matches specification'
);
check(
  CANONICAL_CHECKIN_REQUIREMENT_LABELS.IDENTITY_DOCUMENT_MISSING === 'Dokumen identitas tamu belum tersedia',
  'IDENTITY_DOCUMENT_MISSING label matches specification'
);
check(
  CANONICAL_CHECKIN_REQUIREMENT_LABELS.PAYMENT_MISSING === 'Pembayaran belum tercatat',
  'PAYMENT_MISSING label matches specification'
);
check(
  CANONICAL_CHECKIN_REQUIREMENT_LABELS.PAYMENT_EVIDENCE_MISSING === 'Bukti pembayaran belum tersedia',
  'PAYMENT_EVIDENCE_MISSING label matches specification'
);
check(
  CANONICAL_CHECKIN_REQUIREMENT_LABELS.GUARANTEE_MISSING === 'Jaminan belum ditambahkan',
  'GUARANTEE_MISSING label matches specification'
);
check(
  CANONICAL_CHECKIN_REQUIREMENT_LABELS.ROOM_NOT_READY === 'Kamar belum siap',
  'ROOM_NOT_READY label matches specification'
);
check(
  CANONICAL_CHECKIN_REQUIREMENT_LABELS.PRECHECKIN_EVALUATION_FAILED === 'Kesiapan check-in belum dapat diverifikasi',
  'PRECHECKIN_EVALUATION_FAILED fallback label matches fail-closed specification'
);

// Fallback helper checks
check(
  getMissingRequirementLabel({ code: 'GUARANTEE_MISSING', label: 'Custom Label' }) === 'Custom Label',
  'getMissingRequirementLabel prioritizes backend provided label'
);
check(
  getMissingRequirementLabel({ code: 'ROOM_NOT_READY' }) === 'Kamar belum siap',
  'getMissingRequirementLabel falls back to canonical label table when label is missing'
);

// --------------------------------------------------------------------------
// 2. FAIL-CLOSED AND ELIGIBILITY LOGIC
// --------------------------------------------------------------------------
console.log('--- 2. Fail-Closed & Canonical Readiness Semantics ---');

// Case A: precheckin_eligibility is undefined/null (fail-closed)
{
  const evalNull = evaluatePrecheckinReadiness({ id: 101, status: 'BOOKED' });
  check(evalNull.isCheckinEligible === false, 'Case A: Missing precheckin_eligibility is not eligible (fail-closed)');
  check(evalNull.missingRequirements.length === 0, 'Case A: missing array defaults to empty');
}

// Case B: Local phone and identity exist, but canonical precheckin_eligibility has missing guarantee
{
  const dataWithPhoneAndKtp = {
    id: 102,
    status: 'BOOKED',
    guest_phone: '081234567890',
    ktp_image_url: 'https://storage/ktp.jpg',
    precheckin_eligibility: {
      eligible: false,
      guarantee_ok: false,
      missing: [{ code: 'GUARANTEE_MISSING', label: 'Jaminan belum ditambahkan' }]
    }
  };
  const evalLocalVsCanonical = evaluatePrecheckinReadiness(dataWithPhoneAndKtp);
  check(evalLocalVsCanonical.isCheckinEligible === false, 'Case B: Local phone+ktp cannot override canonical ineligible state');
  check(evalLocalVsCanonical.missingRequirements[0].code === 'GUARANTEE_MISSING', 'Case B: Guarantee is missing');
}

// Case C: Canonical eligibility is true
{
  const eligibleData = {
    id: 103,
    status: 'BOOKED',
    precheckin_eligibility: {
      eligible: true,
      guest_name_ok: true,
      guest_phone_ok: true,
      identity_ok: true,
      payment_ok: true,
      payment_evidence_ok: true,
      guarantee_ok: true,
      room_ready_ok: true,
      missing: []
    }
  };
  const evalEligible = evaluatePrecheckinReadiness(eligibleData);
  check(evalEligible.isCheckinEligible === true, 'Case C: eligible === true is recognized as ready');
  check(evalEligible.missingRequirements.length === 0, 'Case C: No missing requirements');
}

// Case D: Transition simulation — guarantee is added and canonical data re-hydrated
{
  let currentReservation: any = {
    id: 104,
    status: 'BOOKED',
    precheckin_eligibility: {
      eligible: false,
      guest_name_ok: true,
      guest_phone_ok: true,
      identity_ok: true,
      payment_ok: true,
      payment_evidence_ok: true,
      guarantee_ok: false,
      room_ready_ok: true,
      missing: [{ code: 'GUARANTEE_MISSING', label: 'Jaminan belum ditambahkan' }]
    }
  };

  const before = evaluatePrecheckinReadiness(currentReservation);
  check(before.isCheckinEligible === false, 'Transition test: initially ineligible due to guarantee missing');

  // Simulated re-hydration from GET /api/reservations/:id after guarantee received
  currentReservation = {
    ...currentReservation,
    precheckin_eligibility: {
      eligible: true,
      guest_name_ok: true,
      guest_phone_ok: true,
      identity_ok: true,
      payment_ok: true,
      payment_evidence_ok: true,
      guarantee_ok: true,
      room_ready_ok: true,
      missing: []
    }
  };

  const after = evaluatePrecheckinReadiness(currentReservation);
  check(after.isCheckinEligible === true, 'Transition test: re-hydrated reservation becomes eligible without reload');
  check(after.missingRequirements.length === 0, 'Transition test: missing requirements cleared');
}

// --------------------------------------------------------------------------
// 3. SOURCE CODE VERIFICATION: QuickReservationDetail.tsx
// --------------------------------------------------------------------------
console.log('--- 3. Static Inspection: QuickReservationDetail.tsx ---');

// Check canonical gate definition
check(
  quickSrc.includes('const { isCheckinEligible, missingRequirements, precheckinEligibility } = evaluatePrecheckinReadiness(data);') ||
  quickSrc.includes('const isCheckinEligible = precheckinEligibility?.eligible === true;'),
  'Quick card uses canonical precheckin readiness check'
);
check(
  !quickSrc.includes('const isCheckinReady = hasPhone && hasIdentity;'),
  'Old local isCheckinReady = hasPhone && hasIdentity is removed'
);

// Check Check-in button gate
check(
  quickSrc.includes('if (!isCheckinEligible) {') && quickSrc.includes('onOpenFullDetail(data);'),
  'Check-in button redirects to onOpenFullDetail when !isCheckinEligible and prevents check-in'
);
check(
  quickSrc.includes("isCheckinEligible") && quickSrc.includes("'Lengkapi persyaratan check-in'"),
  'Check-in button tooltip informs user to complete requirements when ineligible'
);

// Check Persyaratan Check-in section in quick card
check(
  quickSrc.includes('Persyaratan Check-in'),
  'Quick card renders Persyaratan Check-in section'
);
check(
  quickSrc.includes('Persyaratan Check-in Lengkap'),
  'Quick card renders complete state text when eligible'
);
check(
  quickSrc.includes('Siap Check-in'),
  'Quick card displays Siap Check-in badge when eligible'
);
check(
  quickSrc.includes('Wajib Dilengkapi'),
  'Quick card displays Wajib Dilengkapi badge when ineligible'
);

// Check re-hydration wiring
check(
  quickSrc.includes('handleRefresh') && quickSrc.includes('loadData(false);'),
  'handleRefresh reloads local reservation data and notifies parent grid'
);
check(
  quickSrc.includes('onRefresh={handleRefresh}'),
  'DepositGuaranteeSection receives handleRefresh as onRefresh prop'
);

// --------------------------------------------------------------------------
// 4. SOURCE CODE VERIFICATION: DepositGuaranteeSection.tsx
// --------------------------------------------------------------------------
console.log('--- 4. Static Inspection: DepositGuaranteeSection.tsx ---');

// Check compact mode Add Guarantee button
check(
  depositSrc.includes('!isClosed && capabilities.canReceiveDeposit'),
  'DepositGuaranteeSection checks !isClosed && capabilities.canReceiveDeposit in compact mode'
);
check(
  depositSrc.includes('Tambah Jaminan'),
  'Compact mode renders Tambah Jaminan button'
);
check(
  depositSrc.includes("onClick={() => { setError(null); setShowChooser(true); }}"),
  'Compact mode Tambah Jaminan triggers setShowChooser(true)'
);

// Check modals are available in compact mode (no early return before modals)
check(
  !depositSrc.includes('if (compact) {\n    return ('),
  'DepositGuaranteeSection does not early-return before modal JSX'
);
check(
  depositSrc.includes('isOpen={showChooser}'),
  'showChooser modal is rendered for both compact and full modes'
);
check(
  depositSrc.includes('isOpen={showReceive}'),
  'ReceiveDepositModal is rendered for both compact and full modes'
);
check(
  depositSrc.includes('isOpen={showHoldId}'),
  'HoldIdentityForm is rendered for both compact and full modes'
);

console.log(`\nAll ${assertions} test assertions passed successfully!`);
