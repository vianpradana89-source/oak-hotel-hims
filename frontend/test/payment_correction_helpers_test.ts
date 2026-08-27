import assert from 'node:assert/strict';
import {
  isPaymentEligibleForCorrection,
  calculateCorrectionDifference,
  validateCorrectionForm,
  validateVoidForm,
  formatHotelTimestamp,
  formatActorName,
  getPaymentStatusVisual,
  getReasonLabel,
  type PaymentTransactionItem
} from '../src/features/transactions/paymentCorrectionHelpers.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Payment Correction & Void Helpers Tests ===\n');

// ============================================================================
// Test 1: isPaymentEligibleForCorrection
// ============================================================================
console.log('--- Test 1: isPaymentEligibleForCorrection ---');

const activeSuccessPayment: PaymentTransactionItem = {
  id: 1,
  reservation_id: 10,
  transaction_type: 'PAYMENT',
  amount: 500000,
  status: 'SUCCESS'
};
check(isPaymentEligibleForCorrection(activeSuccessPayment) === true, '1.1 active SUCCESS payment is eligible');

const correctedPayment: PaymentTransactionItem = {
  id: 2,
  reservation_id: 10,
  transaction_type: 'PAYMENT',
  amount: 500000,
  status: 'CORRECTED'
};
check(isPaymentEligibleForCorrection(correctedPayment) === false, '1.2 CORRECTED payment is NOT eligible');

const voidedPayment: PaymentTransactionItem = {
  id: 3,
  reservation_id: 10,
  transaction_type: 'PAYMENT',
  amount: 500000,
  status: 'VOIDED'
};
check(isPaymentEligibleForCorrection(voidedPayment) === false, '1.3 VOIDED payment is NOT eligible');

const reversalPayment: PaymentTransactionItem = {
  id: 4,
  reservation_id: 10,
  transaction_type: 'REVERSAL',
  amount: 500000,
  status: 'SUCCESS'
};
check(isPaymentEligibleForCorrection(reversalPayment) === false, '1.4 REVERSAL transaction is NOT eligible');

check(isPaymentEligibleForCorrection(null) === false, '1.5 null payment is NOT eligible');
check(isPaymentEligibleForCorrection(undefined) === false, '1.6 undefined payment is NOT eligible');

const failedPayment: PaymentTransactionItem = {
  id: 5,
  reservation_id: 10,
  transaction_type: 'PAYMENT',
  amount: 100,
  status: 'FAILED'
};
check(isPaymentEligibleForCorrection(failedPayment) === false, '1.7 FAILED payment is NOT eligible');

// ============================================================================
// Test 2: calculateCorrectionDifference
// ============================================================================
console.log('--- Test 2: calculateCorrectionDifference ---');

const diffInc = calculateCorrectionDifference(500000, 750000);
check(diffInc.oldAmount === 500000, '2.1 old amount preserved');
check(diffInc.newAmount === 750000, '2.2 new amount preserved');
check(diffInc.difference === 250000, '2.3 positive difference calculated');
check(diffInc.isIncrease === true, '2.4 isIncrease is true');
check(diffInc.isDecrease === false, '2.5 isDecrease is false');
check(diffInc.isSame === false, '2.6 isSame is false');
check(diffInc.absDifference === 250000, '2.7 absDifference is 250000');

const diffDec = calculateCorrectionDifference(1000000, 100000);
check(diffDec.difference === -900000, '2.8 negative difference calculated');
check(diffDec.isIncrease === false, '2.9 isIncrease is false');
check(diffDec.isDecrease === true, '2.10 isDecrease is true');
check(diffDec.absDifference === 900000, '2.11 absDifference is 900000');

const diffSame = calculateCorrectionDifference(500000, 500000);
check(diffSame.difference === 0, '2.12 zero difference for same amount');
check(diffSame.isSame === true, '2.13 isSame is true');

// ============================================================================
// Test 3: validateCorrectionForm
// ============================================================================
console.log('--- Test 3: validateCorrectionForm ---');

const valValid = validateCorrectionForm({
  originalAmount: 500000,
  newAmount: 600000,
  maxAllowedNewAmount: 1000000,
  reasonCode: 'WRONG_AMOUNT'
});
check(valValid.valid === true, '3.1 valid correction accepted');
check(Object.keys(valValid.errors).length === 0, '3.2 no error keys');

const valZero = validateCorrectionForm({
  originalAmount: 500000,
  newAmount: 0,
  maxAllowedNewAmount: 1000000,
  reasonCode: 'WRONG_AMOUNT'
});
check(valZero.valid === false, '3.3 zero amount rejected');
check(valZero.errors.amount !== undefined, '3.4 amount error present');

const valNeg = validateCorrectionForm({
  originalAmount: 500000,
  newAmount: -10000,
  maxAllowedNewAmount: 1000000,
  reasonCode: 'WRONG_AMOUNT'
});
check(valNeg.valid === false, '3.5 negative amount rejected');

const valOver = validateCorrectionForm({
  originalAmount: 500000,
  newAmount: 1200000,
  maxAllowedNewAmount: 1000000,
  reasonCode: 'WRONG_AMOUNT'
});
check(valOver.valid === false, '3.6 exceeding max allowed payment rejected');

const valSameWrongAmt = validateCorrectionForm({
  originalAmount: 500000,
  newAmount: 500000,
  maxAllowedNewAmount: 1000000,
  reasonCode: 'WRONG_AMOUNT'
});
check(valSameWrongAmt.valid === false, '3.7 same amount with WRONG_AMOUNT rejected');

const valSameMethod = validateCorrectionForm({
  originalAmount: 500000,
  newAmount: 500000,
  maxAllowedNewAmount: 1000000,
  reasonCode: 'WRONG_PAYMENT_METHOD'
});
check(valSameMethod.valid === true, '3.8 same amount with WRONG_PAYMENT_METHOD allowed');

const valOtherEmpty = validateCorrectionForm({
  originalAmount: 500000,
  newAmount: 600000,
  maxAllowedNewAmount: 1000000,
  reasonCode: 'OTHER',
  reasonText: '   '
});
check(valOtherEmpty.valid === false, '3.9 reason OTHER with empty text rejected');
check(valOtherEmpty.errors.reasonText !== undefined, '3.10 reasonText error present');

const valOtherFilled = validateCorrectionForm({
  originalAmount: 500000,
  newAmount: 600000,
  maxAllowedNewAmount: 1000000,
  reasonCode: 'OTHER',
  reasonText: 'Instruksi manajer'
});
check(valOtherFilled.valid === true, '3.11 reason OTHER with note accepted');

// ============================================================================
// Test 4: validateVoidForm
// ============================================================================
console.log('--- Test 4: validateVoidForm ---');

const valVoidValid = validateVoidForm({
  reasonCode: 'PAYMENT_CANCELLED'
});
check(valVoidValid.valid === true, '4.1 valid void accepted');

const valVoidMissing = validateVoidForm({
  reasonCode: ''
});
check(valVoidMissing.valid === false, '4.2 missing reason code rejected');

const valVoidOtherEmpty = validateVoidForm({
  reasonCode: 'OTHER',
  reasonText: ''
});
check(valVoidOtherEmpty.valid === false, '4.3 void reason OTHER without note rejected');

const valVoidOtherFilled = validateVoidForm({
  reasonCode: 'OTHER',
  reasonText: 'Double swipe kartu EDC'
});
check(valVoidOtherFilled.valid === true, '4.4 void reason OTHER with note accepted');

// ============================================================================
// Test 5: formatHotelTimestamp & Visuals
// ============================================================================
console.log('--- Test 5: formatHotelTimestamp & Visuals ---');

const ts = formatHotelTimestamp('2026-08-27T12:31:00.000Z');
check(ts.includes('27'), '5.1 timestamp contains day 27');
check(ts.includes('Agu'), '5.2 timestamp contains month Agu');
check(ts.includes('2026'), '5.3 timestamp contains year 2026');
check(ts.includes('19:31'), '5.4 timestamp contains 19:31 WIB');
check(ts.includes('WIB'), '5.5 timestamp contains WIB');

const visSuccess = getPaymentStatusVisual('SUCCESS', 'PAYMENT');
check(visSuccess.label === 'BERHASIL', '5.6 SUCCESS status label');
check(!visSuccess.strikeThrough, '5.7 SUCCESS has no strikeThrough');

const visCorr = getPaymentStatusVisual('CORRECTED', 'PAYMENT');
check(visCorr.label === 'DIKOREKSI', '5.8 CORRECTED status label');
check(visCorr.strikeThrough === true, '5.9 CORRECTED has strikeThrough');

const visVoid = getPaymentStatusVisual('VOIDED', 'PAYMENT');
check(visVoid.label === 'DIBATALKAN', '5.10 VOIDED status label');
check(visVoid.strikeThrough === true, '5.11 VOIDED has strikeThrough');

const visRev = getPaymentStatusVisual('SUCCESS', 'REVERSAL');
check(visRev.label === 'REVERSAL', '5.12 REVERSAL status label');

const visRepl = getPaymentStatusVisual('SUCCESS', 'CORRECTION_REPLACEMENT');
check(visRepl.label === 'PENGGANTI', '5.13 CORRECTION_REPLACEMENT status label');

check(getReasonLabel('WRONG_AMOUNT') === 'Salah input nominal', '5.14 reason label WRONG_AMOUNT');
check(getReasonLabel('WRONG_PAYMENT_METHOD') === 'Salah metode pembayaran', '5.15 reason label WRONG_PAYMENT_METHOD');
check(getReasonLabel('DUPLICATE_ENTRY') === 'Duplikasi input', '5.16 reason label DUPLICATE_ENTRY');
check(getReasonLabel('PAYMENT_CANCELLED') === 'Pembayaran dibatalkan', '5.17 reason label PAYMENT_CANCELLED');
check(getReasonLabel('OTHER') === 'Lainnya (wajib catatan)', '5.18 reason label OTHER');

// ============================================================================
// Test 6: formatActorName (Truthful Presentation Fallback)
// ============================================================================
console.log('--- Test 6: formatActorName ---');

check(formatActorName(null) === 'Pelaku tidak tersedia', '6.1 null actor renders "Pelaku tidak tersedia"');
check(formatActorName(undefined) === 'Pelaku tidak tersedia', '6.2 undefined actor renders "Pelaku tidak tersedia"');
check(formatActorName('') === 'Pelaku tidak tersedia', '6.3 empty string actor renders "Pelaku tidak tersedia"');
check(formatActorName('   ') === 'Pelaku tidak tersedia', '6.4 whitespace actor renders "Pelaku tidak tersedia"');
check(formatActorName('Budi Front Office') === 'Budi Front Office', '6.5 valid actor name preserved exactly');
check(formatActorName('  Siti Kasir  ') === 'Siti Kasir', '6.6 trimmed valid actor name');

console.log(`\nAll ${assertions} tests PASSED successfully!\n`);
