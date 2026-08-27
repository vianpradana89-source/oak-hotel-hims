import assert from 'node:assert/strict';
import {
  validateEvidenceFile,
  formatEvidenceType,
  formatEvidenceFileSize,
  getPaymentEvidenceStatus,
  getActiveEvidences,
  getInactiveEvidences,
  isEvidenceImage,
  isEvidencePdf,
  formatEvidenceDate,
  ALLOWED_EVIDENCE_MIME_TYPES,
  MAX_EVIDENCE_FILE_SIZE_BYTES
} from '../src/features/transactions/paymentEvidenceHelpers.ts';
import type { PaymentEvidenceItem } from '../src/features/transactions/paymentEvidenceTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Payment Evidence Helpers Tests ===\n');

// ============================================================================
// Test 1: validateEvidenceFile
// ============================================================================
console.log('--- Test 1: validateEvidenceFile ---');

check(validateEvidenceFile(null).valid === false, '1.1 null file returns invalid');
check(validateEvidenceFile(undefined).valid === false, '1.2 undefined file returns invalid');
check(validateEvidenceFile(null).code === 'FILE_REQUIRED', '1.3 null file error code is FILE_REQUIRED');

// Allowed MIME types
for (const mime of ALLOWED_EVIDENCE_MIME_TYPES) {
  const result = validateEvidenceFile({ type: mime, size: 1024 * 100 });
  check(result.valid === true, `1.4 allowed mime ${mime} is valid`);
}

// Disallowed MIME types
const disallowed = ['application/msword', 'text/plain', 'application/zip', 'image/gif'];
for (const mime of disallowed) {
  const result = validateEvidenceFile({ type: mime, size: 1024 * 100 });
  check(result.valid === false, `1.5 disallowed mime ${mime} is invalid`);
  check(result.code === 'UNSUPPORTED_MIME_TYPE', `1.6 code is UNSUPPORTED_MIME_TYPE for ${mime}`);
}

// File size limits
const okSize = validateEvidenceFile({ type: 'image/jpeg', size: MAX_EVIDENCE_FILE_SIZE_BYTES });
check(okSize.valid === true, '1.7 exactly 10MB is valid');

const overSize = validateEvidenceFile({ type: 'image/jpeg', size: MAX_EVIDENCE_FILE_SIZE_BYTES + 1 });
check(overSize.valid === false, '1.8 >10MB is invalid');
check(overSize.code === 'FILE_TOO_LARGE', '1.9 oversize code is FILE_TOO_LARGE');

// ============================================================================
// Test 2: formatEvidenceType
// ============================================================================
console.log('--- Test 2: formatEvidenceType ---');

check(formatEvidenceType('CASH_RECEIPT') === 'Kwitansi / Tanda Terima Tunai', '2.1 CASH_RECEIPT');
check(formatEvidenceType('BANK_TRANSFER') === 'Bukti Transfer Bank', '2.2 BANK_TRANSFER');
check(formatEvidenceType('QRIS_RECEIPT') === 'Struk QRIS', '2.3 QRIS_RECEIPT');
check(formatEvidenceType('EDC_SLIP') === 'Slip EDC / Kartu', '2.4 EDC_SLIP');
check(formatEvidenceType('DEPOSIT_PROOF') === 'Bukti Deposit / Uang Muka', '2.5 DEPOSIT_PROOF');
check(formatEvidenceType('BANK_RECEIPT') === 'Rekening Koran / Bukti Bank', '2.6 BANK_RECEIPT');
check(formatEvidenceType('OTHER') === 'Bukti Lainnya', '2.7 OTHER');
check(formatEvidenceType('UNKNOWN' as any) === 'UNKNOWN', '2.8 fallback to raw string');

// ============================================================================
// Test 3: formatEvidenceFileSize
// ============================================================================
console.log('--- Test 3: formatEvidenceFileSize ---');

check(formatEvidenceFileSize(0) === '0 B', '3.1 0 bytes');
check(formatEvidenceFileSize(500) === '500 B', '3.2 500 bytes');
check(formatEvidenceFileSize(1024) === '1.0 KB', '3.3 1024 bytes -> 1.0 KB');
check(formatEvidenceFileSize(1536) === '1.5 KB', '3.4 1536 bytes -> 1.5 KB');
check(formatEvidenceFileSize(1048576) === '1.00 MB', '3.5 1MB -> 1.00 MB');
check(formatEvidenceFileSize(2621440) === '2.50 MB', '3.6 2.5MB -> 2.50 MB');

// ============================================================================
// Test 4: getPaymentEvidenceStatus, getActiveEvidences, getInactiveEvidences
// ============================================================================
console.log('--- Test 4: Evidence Status & Filtering ---');

const mockEvidences: PaymentEvidenceItem[] = [
  {
    id: 1,
    property_id: 1,
    reservation_id: 100,
    payment_transaction_id: 10,
    evidence_type: 'BANK_TRANSFER',
    original_filename: 'receipt1.jpg',
    storage_key: 'key1.jpg',
    mime_type: 'image/jpeg',
    file_size_bytes: 204800,
    note: 'Transfer via BCA',
    uploaded_at: '2026-08-27T10:00:00Z',
    uploaded_by_name_snapshot: 'Rian Front Office',
    is_active: true
  },
  {
    id: 2,
    property_id: 1,
    reservation_id: 100,
    payment_transaction_id: 10,
    evidence_type: 'EDC_SLIP',
    original_filename: 'edc_slip.png',
    storage_key: 'key2.png',
    mime_type: 'image/png',
    file_size_bytes: 150000,
    uploaded_at: '2026-08-27T10:05:00Z',
    is_active: true
  },
  {
    id: 3,
    property_id: 1,
    reservation_id: 100,
    payment_transaction_id: 10,
    evidence_type: 'CASH_RECEIPT',
    original_filename: 'old_receipt.jpg',
    storage_key: 'key3.jpg',
    mime_type: 'image/jpeg',
    file_size_bytes: 100000,
    uploaded_at: '2026-08-27T09:00:00Z',
    is_active: false,
    deactivation_reason: 'Foto buram',
    deactivated_at: '2026-08-27T09:10:00Z',
    deactivated_by_name_snapshot: 'Supervisor Maya'
  },
  {
    id: 4,
    property_id: 1,
    reservation_id: 100,
    payment_transaction_id: 20,
    evidence_type: 'QRIS_RECEIPT',
    original_filename: 'qris.png',
    storage_key: 'key4.png',
    mime_type: 'image/png',
    file_size_bytes: 300000,
    uploaded_at: '2026-08-27T11:00:00Z',
    is_active: true
  }
];

// Active & Inactive filtering for payment 10
const activeP10 = getActiveEvidences(mockEvidences, 10);
check(activeP10.length === 2, '4.1 payment 10 has 2 active evidences');
check(activeP10[0].id === 1 && activeP10[1].id === 2, '4.2 correct active IDs');

const inactiveP10 = getInactiveEvidences(mockEvidences, 10);
check(inactiveP10.length === 1, '4.3 payment 10 has 1 inactive evidence');
check(inactiveP10[0].id === 3, '4.4 inactive ID is 3');

// Status badge info
const statusP10 = getPaymentEvidenceStatus(mockEvidences, 10);
check(statusP10.status === 'ATTACHED', '4.5 payment 10 status is ATTACHED');
check(statusP10.count === 2, '4.6 payment 10 count is 2');
check(statusP10.label === '2 Bukti', '4.7 payment 10 label is "2 Bukti"');

// Payment with 0 evidences
const statusP99 = getPaymentEvidenceStatus(mockEvidences, 99);
check(statusP99.status === 'MISSING', '4.8 payment 99 status is MISSING');
check(statusP99.count === 0, '4.9 payment 99 count is 0');
check(statusP99.label === 'Belum ada bukti', '4.10 payment 99 label is "Belum ada bukti"');

// Single evidence payment (payment 20)
const statusP20 = getPaymentEvidenceStatus(mockEvidences, 20);
check(statusP20.status === 'ATTACHED', '4.11 payment 20 status is ATTACHED');
check(statusP20.count === 1, '4.12 payment 20 count is 1');
check(statusP20.label === '1 Bukti', '4.13 payment 20 label is "1 Bukti"');

// ============================================================================
// Test 5: isEvidenceImage & isEvidencePdf
// ============================================================================
console.log('--- Test 5: isEvidenceImage & isEvidencePdf ---');

check(isEvidenceImage('image/jpeg') === true, '5.1 image/jpeg is image');
check(isEvidenceImage('image/png') === true, '5.2 image/png is image');
check(isEvidenceImage('image/webp') === true, '5.3 image/webp is image');
check(isEvidenceImage('application/pdf') === false, '5.4 pdf is NOT image');
check(isEvidencePdf('application/pdf') === true, '5.5 application/pdf is PDF');
check(isEvidencePdf('image/jpeg') === false, '5.6 image is NOT PDF');

// ============================================================================
// Test 6: formatEvidenceDate
// ============================================================================
console.log('--- Test 6: formatEvidenceDate ---');

check(formatEvidenceDate(null) === '-', '6.1 null date returns -');
check(formatEvidenceDate(undefined) === '-', '6.2 undefined date returns -');
check(typeof formatEvidenceDate('2026-08-27T10:00:00Z') === 'string', '6.3 valid date returns formatted string');

console.log(`\n✅ All ${assertions} Payment Evidence Helpers Tests Passed!\n`);
