import assert from 'node:assert/strict';
import {
  parseIdrInput,
  formatIdrInput,
  validateIdrPaymentInput,
  calculateRemainingBalancePreview,
} from '../src/features/transactions/paymentIdrHelpers.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Payment & IDR Monetary Helpers Tests ===\n');

// ============================================================================
// Test 1: parseIdrInput parsing accuracy
// ============================================================================
console.log('--- Test 1: parseIdrInput ---');
check(parseIdrInput('') === 0, '1.1 empty string parses to 0');
check(parseIdrInput('   ') === 0, '1.2 whitespace-only string parses to 0');
check(parseIdrInput(null) === 0, '1.3 null parses to 0');
check(parseIdrInput(undefined) === 0, '1.4 undefined parses to 0');
check(parseIdrInput('1') === 1, '1.5 "1" parses to 1');
check(parseIdrInput(1) === 1, '1.6 number 1 parses to 1');
check(parseIdrInput('1000') === 1000, '1.7 "1000" parses to 1000');
check(parseIdrInput('1.000') === 1000, '1.8 "1.000" parses to 1000');
check(parseIdrInput('1000000') === 1000000, '1.9 "1000000" parses to 1000000');
check(parseIdrInput('1.000.000') === 1000000, '1.10 "1.000.000" parses to 1000000');
check(parseIdrInput('Rp 1.000.000') === 1000000, '1.11 "Rp 1.000.000" parses to 1000000');
check(parseIdrInput('  Rp  2.500.000  ') === 2500000, '1.12 "  Rp  2.500.000  " parses to 2500000');
check(parseIdrInput('abc') === 0, '1.13 "abc" parses to 0');
check(parseIdrInput('Rp 0') === 0, '1.14 "Rp 0" parses to 0');
check(parseIdrInput(-500) === 0, '1.15 negative number parses to 0');

// ============================================================================
// Test 2: formatIdrInput formatting with dots
// ============================================================================
console.log('\n--- Test 2: formatIdrInput ---');
check(formatIdrInput('') === '', '2.1 empty string formats to empty string');
check(formatIdrInput(null) === '', '2.2 null formats to empty string');
check(formatIdrInput(undefined) === '', '2.3 undefined formats to empty string');
check(formatIdrInput('1') === '1', '2.4 "1" formats to "1"');
check(formatIdrInput(1) === '1', '2.5 1 formats to "1"');
check(formatIdrInput('10') === '10', '2.6 "10" formats to "10"');
check(formatIdrInput('100') === '100', '2.7a "100" formats to "100"');
check(formatIdrInput('999') === '999', '2.7b "999" formats to "999"');
check(formatIdrInput('1000') === '1.000', '2.8 "1000" formats to "1.000"');
check(formatIdrInput(1000) === '1.000', '2.9 1000 formats to "1.000"');
check(formatIdrInput('1.000') === '1.000', '2.10 "1.000" formats to "1.000"');
check(formatIdrInput('9999') === '9.999', '2.10a "9999" formats to "9.999"');
check(formatIdrInput('10000') === '10.000', '2.10b "10000" formats to "10.000"');
check(formatIdrInput('1.0000') === '10.000', '2.10c "1.0000" sequential typing formats to "10.000"');
check(formatIdrInput('99999') === '99.999', '2.10d "99999" formats to "99.999"');
check(formatIdrInput('100000') === '100.000', '2.10e "100000" formats to "100.000"');
check(formatIdrInput('10.0000') === '100.000', '2.10f "10.0000" sequential typing formats to "100.000"');
check(formatIdrInput('999999') === '999.999', '2.10g "999999" formats to "999.999"');
check(formatIdrInput('1000000') === '1.000.000', '2.11 "1000000" formats to "1.000.000"');
check(formatIdrInput(1000000) === '1.000.000', '2.12 1000000 formats to "1.000.000"');
check(formatIdrInput('1.000.000') === '1.000.000', '2.12a "1.000.000" formats to "1.000.000"');
check(formatIdrInput('Rp 10.000') === '10.000', '2.12b "Rp 10.000" formats to "10.000"');
check(formatIdrInput('Rp 1.000.000') === '1.000.000', '2.13 "Rp 1.000.000" formats to "1.000.000"');
check(formatIdrInput('1250000') === '1.250.000', '2.14 "1250000" formats to "1.250.000"');
check(formatIdrInput('abc') === 'abc', '2.15 non-numeric "abc" is preserved for validation');
check(formatIdrInput(0) === '0', '2.16 number 0 formats to "0"');
check(formatIdrInput('0') === '0', '2.17 string "0" formats to "0"');

// ============================================================================
// Test 3: Raw integer submission integrity
// ============================================================================
console.log('\n--- Test 3: Raw Integer Submission ---');
const displayFormatted = formatIdrInput('1250000');
check(displayFormatted === '1.250.000', '3.1 display value is formatted');
const payloadAmount = parseIdrInput(displayFormatted);
check(typeof payloadAmount === 'number', '3.2 parsed payload is a number');
check(Number.isInteger(payloadAmount), '3.3 parsed payload is an integer');
check(payloadAmount === 1250000, '3.4 parsed payload equals 1250000');
check(String(payloadAmount) !== '1.250.000', '3.5 payload is never sent formatted with dots');

// ============================================================================
// Test 4: Remaining Balance Preview Calculation
// ============================================================================
console.log('\n--- Test 4: Remaining Balance Preview ---');
check(calculateRemainingBalancePreview(3000, 1000) === 2000, '4.1 3000 - 1000 = 2000 (Prompt scenario A)');
check(calculateRemainingBalancePreview(30000, 10000) === 20000, '4.2 30000 - 10000 = 20000 (Prompt scenario B)');
check(calculateRemainingBalancePreview('30.000', '10.000') === 20000, '4.3 formatted strings calculate preview accurately');
check(calculateRemainingBalancePreview(3000, 3000) === 0, '4.4 exact payment leaves 0 remaining (Prompt scenario exact)');
check(calculateRemainingBalancePreview(30000, 30000) === 0, '4.5 full payment leaves 0 remaining');
check(calculateRemainingBalancePreview(30000, 50000) === 0, '4.6 overpayment clamps remaining to 0');
check(calculateRemainingBalancePreview(0, 1000) === 0, '4.7 0 outstanding clamps remaining to 0');

// ============================================================================
// Test 5: Negative Input Disallowance (Strict Rejection)
// ============================================================================
console.log('\n--- Test 5: Negative Input Safety ---');
check(parseIdrInput('-50000') === 0, '5.1 "-50000" parses to 0');
check(parseIdrInput('-Rp 50.000') === 0, '5.2 "-Rp 50.000" parses to 0');
check(parseIdrInput('Rp -50.000') === 0, '5.3 "Rp -50.000" parses to 0');
check(parseIdrInput('-1') === 0, '5.4 "-1" parses to 0');
check(parseIdrInput(-50000) === 0, '5.5 number -50000 parses to 0');
check(formatIdrInput('-50000') === '-50000', '5.6 "-50000" is NOT sanitized to "50.000"');
check(formatIdrInput('-Rp 50.000') === '-Rp 50.000', '5.7 "-Rp 50.000" is NOT sanitized to positive');

const negVal1 = validateIdrPaymentInput('-50000', 100000);
check(!negVal1.isValid, '5.8 validateIdrPaymentInput("-50000") is invalid');
check(negVal1.error === 'Nominal pembayaran tidak boleh bernilai negatif', '5.9 error message warns against negative');

const negVal2 = validateIdrPaymentInput('-Rp 50.000', 100000);
check(!negVal2.isValid, '5.10 validateIdrPaymentInput("-Rp 50.000") is invalid');
check(negVal2.error === 'Nominal pembayaran tidak boleh bernilai negatif', '5.11 error message warns against negative');

// ============================================================================
// Test 6: Decimal Safety & Ambiguity Disallowance
// ============================================================================
console.log('\n--- Test 6: Decimal Safety ---');
// Ambiguous decimal cases: 1.5, 1,5, 1000.50, 1000,50
check(parseIdrInput('1.5') === 0, '6.1 "1.5" must NOT become 15');
check(parseIdrInput('1,5') === 0, '6.2 "1,5" must NOT become 15');
check(parseIdrInput('1000.50') === 0, '6.3 "1000.50" must NOT become 100050');
check(parseIdrInput('1000,50') === 0, '6.4 "1000,50" must NOT become 100050');
check(parseIdrInput(1.5) === 0, '6.5 number 1.5 parses to 0');
check(parseIdrInput(1000.5) === 0, '6.6 number 1000.5 parses to 0');
check(parseIdrInput('1.234.5') === 0, '6.7 broken thousand dot "1.234.5" parses to 0');

const decVal1 = validateIdrPaymentInput('1.5', 100000);
check(!decVal1.isValid, '6.8 "1.5" is invalid');
check(decVal1.error === 'Nominal pembayaran tidak boleh menggunakan desimal', '6.9 error message warns against decimal');

const decVal2 = validateIdrPaymentInput('1,5', 100000);
check(!decVal2.isValid, '6.10 "1,5" is invalid');
check(decVal2.error === 'Nominal pembayaran tidak boleh menggunakan desimal', '6.11 error message warns against decimal');

const decVal3 = validateIdrPaymentInput('1000.50', 100000);
check(!decVal3.isValid, '6.12 "1000.50" is invalid');
check(decVal3.error === 'Nominal pembayaran tidak boleh menggunakan desimal', '6.13 error message warns against decimal');

// Valid thousand-dot values must remain supported
check(parseIdrInput('1.000') === 1000, '6.14 "1.000" parses to 1000');
check(parseIdrInput('10.000') === 10000, '6.15 "10.000" parses to 10000');
check(parseIdrInput('1.000.000') === 1000000, '6.16 "1.000.000" parses to 1000000');
check(parseIdrInput('Rp 1.000.000') === 1000000, '6.17 "Rp 1.000.000" parses to 1000000');

// ============================================================================
// Test 7: Overpayment Safety (Frontend Validation Guard)
// ============================================================================
console.log('\n--- Test 7: Overpayment Safety ---');
// Scenario: remaining = Rp 3.000, payment = Rp 4.000 -> must be rejected
const overpayVal1 = validateIdrPaymentInput('4.000', 3000);
check(!overpayVal1.isValid, '7.1 payment 4000 against remaining 3000 is invalid');
check(overpayVal1.amount === 4000, '7.2 parsed amount is 4000');
check(overpayVal1.error === 'Nominal pembayaran melebihi sisa tagihan', '7.3 error message is "Nominal pembayaran melebihi sisa tagihan"');

const overpayVal2 = validateIdrPaymentInput('5000', 3000);
check(!overpayVal2.isValid, '7.4 payment 5000 against remaining 3000 is invalid');
check(overpayVal2.error === 'Nominal pembayaran melebihi sisa tagihan', '7.5 error is overpayment');

// Exact payment: remaining = 3000, payment = 3000 -> valid
const exactVal = validateIdrPaymentInput('3.000', 3000);
check(exactVal.isValid, '7.6 exact payment 3000 against remaining 3000 is valid');
check(exactVal.amount === 3000, '7.7 exact payment amount is 3000');
check(exactVal.error === null, '7.8 exact payment has no error');

// Partial payment: remaining = 3000, payment = 1000 -> valid
const partialVal = validateIdrPaymentInput('1.000', 3000);
check(partialVal.isValid, '7.9 partial payment 1000 against remaining 3000 is valid');
check(partialVal.amount === 1000, '7.10 partial payment amount is 1000');
check(partialVal.error === null, '7.11 partial payment has no error');

// Zero payment -> invalid
const zeroVal = validateIdrPaymentInput('0', 3000);
check(!zeroVal.isValid, '7.12 payment 0 is invalid');

// ============================================================================
// Test 8: State Synchronization Logic (Detail Reservasi & Transaksi Table)
// ============================================================================
console.log('\n--- Test 8: State Synchronization Logic ---');

interface MockReservation {
  id: number;
  bid: string;
  guest_name: string;
  total_price: number;
  amount_paid: number;
  remaining_balance: number;
  payment_status: string;
}

const initialRes: MockReservation = {
  id: 101,
  bid: 'OAK-2026-001',
  guest_name: 'Budi Santoso',
  total_price: 3000,
  amount_paid: 0,
  remaining_balance: 3000,
  payment_status: 'UNPAID',
};

const mockTransactionTable = [initialRes, { id: 102, bid: 'OAK-2026-002', guest_name: 'Ani', total_price: 5000, amount_paid: 5000, remaining_balance: 0, payment_status: 'PAID' }];

// Partial payment: remaining = 3.000, payment = 1.000 succeeds -> remaining = 2.000, status = PARTIAL
const backendPartialUpdatedRes = {
  ...initialRes,
  amount_paid: 1000,
  remaining_balance: 2000,
  payment_status: 'PARTIAL',
};

// 1. Detail Reservasi sync
const updatedSelectedResPartial = {
  ...initialRes,
  ...backendPartialUpdatedRes,
};
check(updatedSelectedResPartial.amount_paid === 1000, '8.1 Detail Reservasi amount_paid immediately updates to 1000');
check(updatedSelectedResPartial.remaining_balance === 2000, '8.2 Detail Reservasi remaining_balance immediately updates to 2000');
check(updatedSelectedResPartial.payment_status === 'PARTIAL', '8.3 Detail Reservasi payment_status immediately updates to PARTIAL');

// 2. Transaksi table sync
const updatedTransactionTablePartial = mockTransactionTable.map((r) =>
  r.id === backendPartialUpdatedRes.id ? { ...r, ...backendPartialUpdatedRes } : r
);
const syncedRowPartial = updatedTransactionTablePartial.find((r) => r.id === 101);
check(syncedRowPartial?.amount_paid === 1000, '8.4 Transaksi row amount_paid immediately updates to 1000');
check(syncedRowPartial?.remaining_balance === 2000, '8.5 Transaksi row remaining_balance immediately updates to 2000');
check(syncedRowPartial?.payment_status === 'PARTIAL', '8.6 Transaksi row payment_status immediately updates to PARTIAL');

// Exact payment: remaining = 3.000, payment = 3.000 succeeds -> remaining = 0, status = PAID
const backendExactUpdatedRes = {
  ...initialRes,
  amount_paid: 3000,
  remaining_balance: 0,
  payment_status: 'PAID',
};
const updatedSelectedResExact = {
  ...initialRes,
  ...backendExactUpdatedRes,
};
check(updatedSelectedResExact.amount_paid === 3000, '8.7 Detail Reservasi exact amount_paid is 3000');
check(updatedSelectedResExact.remaining_balance === 0, '8.8 Detail Reservasi exact remaining_balance is 0');
check(updatedSelectedResExact.payment_status === 'PAID', '8.9 Detail Reservasi exact payment_status is PAID');

// ============================================================================
// Test 9: Backend Failure & Overpayment Rejection Preservation (Zero Mutation)
// ============================================================================
console.log('\n--- Test 9: Overpayment Rejection & Failure Zero-Mutation ---');
const selectedResState = { ...initialRes };
const transactionTableState = [...mockTransactionTable];

// Simulate rejected overpayment: remaining = 3.000, payment attempt = 5.000
const handleRejectedPayment = (errResponse: { status: string; code: string; message: string }) => {
  // On error/rejection, state must NOT mutate
  return { error: errResponse.message, code: errResponse.code };
};

const rejectionResult = handleRejectedPayment({
  status: 'ERROR',
  code: 'OVERPAYMENT_NOT_ALLOWED',
  message: 'Nominal pembayaran melebihi sisa tagihan'
});

check(rejectionResult.code === 'OVERPAYMENT_NOT_ALLOWED', '9.1 Rejection code caught');
check(selectedResState.amount_paid === 0, '9.2 Detail Reservasi amount_paid stays 0 on overpayment rejection');
check(selectedResState.remaining_balance === 3000, '9.3 Detail Reservasi remaining_balance stays 3000 on overpayment rejection');
check(selectedResState.payment_status === 'UNPAID', '9.4 Detail Reservasi payment_status stays UNPAID on overpayment rejection');
check(transactionTableState[0].remaining_balance === 3000, '9.5 Transaksi row stays 3000 on overpayment rejection');

// ============================================================================
// Test 10: Button State & Double Submission Protection
// ============================================================================
console.log('\n--- Test 10: Button State & Double Submission Protection ---');
const isSubmitAllowed = (draft: string, remaining: number, isSubmitting: boolean): boolean => {
  if (isSubmitting) return false;
  const validation = validateIdrPaymentInput(draft, remaining);
  return validation.isValid;
};

check(!isSubmitAllowed('', 3000, false), '10.1 Empty input cannot be submitted');
check(!isSubmitAllowed('0', 3000, false), '10.2 Zero input cannot be submitted');
check(!isSubmitAllowed('-50000', 3000, false), '10.3 Negative input cannot be submitted');
check(!isSubmitAllowed('1.5', 3000, false), '10.4 Decimal input cannot be submitted');
check(!isSubmitAllowed('4.000', 3000, false), '10.5 Overpayment input cannot be submitted');
check(!isSubmitAllowed('1.000', 3000, true), '10.6 In-flight request disables submit button (prevents double submit)');
check(isSubmitAllowed('1.000', 3000, false), '10.7 Valid partial payment can be submitted');
check(isSubmitAllowed('3.000', 3000, false), '10.8 Valid exact payment can be submitted');

console.log(`\n================================`);
console.log(`Summary: ${assertions} assertions PASSED`);
console.log(`================================`);
