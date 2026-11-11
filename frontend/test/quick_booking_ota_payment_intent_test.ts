/** Payment/OTA regression against production helpers; no duplicated payment calculator. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import {
  buildQuickBookingPaymentPayload, nextQuickBookingOrdinaryAmount, quickBookingPaymentIssues,
  type QuickBookingPaymentMode,
} from '../src/features/booking/quickBookingPayment.ts';
import { normalizeBookingPaymentIntent } from '../../backend/src/domains/reservations/bookingPaymentIntentService.ts';

const here = dirname(fileURLToPath(import.meta.url));
const gatesPath = join(here, '../../backend/src/domains/reservations/bookingCreatePaymentService.ts');
const gatesSource = readFileSync(gatesPath, 'utf8');
const ast = ts.createSourceFile(gatesPath, gatesSource, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'evaluateBookingPaymentGates');
assert.ok(declaration && ts.isFunctionDeclaration(declaration));
const moduleObject: { exports: Record<string, any> } = { exports: {} };
const js = ts.transpileModule(declaration.getText(ast), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
new Function('exports', js)(moduleObject.exports);
const evaluateBookingPaymentGates = moduleObject.exports.evaluateBookingPaymentGates;
let assertions = 0;
function check(value: unknown, message: string) { assert.ok(value, message); assertions++; }

const modes: QuickBookingPaymentMode[] = ['PAY_BILL', 'ADVANCE_PAYMENT', 'UNPAID'];
for (const mode of modes) for (const methodRule of ['OPTIONAL', 'REQUIRED']) {
  for (const amountRule of ['OPTIONAL', 'REQUIRED']) for (const evidenceRule of ['OPTIONAL', 'REQUIRED']) {
    for (const hasFile of [false, true]) {
      const input = { mode, amountPaid: 250000, advanceAmount: 100000, paymentMethod: 'CASH', otaCollect: false };
      const rules = { payment_method: methodRule, payment_amount: amountRule, payment_evidence: evidenceRule };
      const payload = buildQuickBookingPaymentPayload({ reservations: [{}] }, input);
      const intent = normalizeBookingPaymentIntent(payload);
      const result = evaluateBookingPaymentGates({ intent, rules, channelType: 'WALK_IN',
        paymentResponsibility: 'HOTEL_COLLECT', paymentMethod: intent.paymentMethod,
        evidencePath: null, childOrdinaryTotal: 0, filePresent: hasFile });
      const frontendAllowed = quickBookingPaymentIssues({ ...input, rules, hasFile }).length === 0;
      const backendAllowed = result.missing.length === 0 && !result.hardReject;
      check(frontendAllowed === backendAllowed, `${mode} ${JSON.stringify(rules)} file=${hasFile}: accepted backend gate matches UI`);
    }
  }
}
for (const method of ['CASH', 'TRANSFER', 'QRIS', 'DEBIT_CARD', 'CREDIT_CARD']) {
  for (const amount of [0, 250000]) for (const hasFile of [false, true]) {
    const input = { mode: 'PAY_BILL' as const, amountPaid: amount, advanceAmount: 0, paymentMethod: method, otaCollect: false };
    const rules = { payment_evidence: 'REQUIRED' };
    const intent = normalizeBookingPaymentIntent(buildQuickBookingPaymentPayload({ reservations: [{}] }, input));
    const result = evaluateBookingPaymentGates({ intent, rules, channelType: 'OTA',
      paymentResponsibility: 'HOTEL_COLLECT', paymentMethod: intent.paymentMethod,
      evidencePath: null, childOrdinaryTotal: 0, filePresent: hasFile });
    check((quickBookingPaymentIssues({ ...input, rules, hasFile }).length === 0) === (result.missing.length === 0),
      `OTA hotel collect ${method} amount=${amount} file=${hasFile}; positive CASH follows current REQUIRED evidence rule`);
  }
}
for (const mode of modes) {
  const input = { mode, amountPaid: 500000, advanceAmount: 200000, paymentMethod: 'CASH', otaCollect: true };
  const payload = buildQuickBookingPaymentPayload({ booking_channel: 'OTA', payment_responsibility: 'OTA_COLLECT', reservations: [{}] }, input);
  const intent = normalizeBookingPaymentIntent(payload);
  check(intent.mode === 'UNPAID' && intent.ordinaryAmount === 0 && intent.advanceAmount === 0 && intent.paymentMethod === null,
    `${mode} stale hotel fields cannot leak into OTA collect`);
  check(quickBookingPaymentIssues({ ...input, rules: {}, hasFile: false }).length === 1, 'OTA voucher still required');
  check(quickBookingPaymentIssues({ ...input, rules: { payment_method: 'REQUIRED', payment_amount: 'REQUIRED' }, hasFile: true }).length === 0,
    'OTA voucher does not become hotel payment');
}
for (const [isOta, touched, amountPaid, grandTotal, expected] of [
  [false, false, 0, 500000, 500000], [true, false, 500000, 500000, 0],
  [true, false, 0, 600000, 0], [true, true, 200000, 500000, 200000],
  [true, true, 600000, 500000, 500000], [true, true, 0, 500000, 0],
  [true, true, 300000, 500000, 300000], [false, true, 300000, 500000, 300000],
  [false, true, 600000, 500000, 500000], [false, false, 0, 750000, 750000],
] as const) {
  check(nextQuickBookingOrdinaryAmount({ mode: 'PAY_BILL', otaCollect: false, isOta, touched, amountPaid, grandTotal }) === expected,
    `ordinary sync OTA=${isOta} touched=${touched} paid=${amountPaid} total=${grandTotal}`);
}
console.log(`PASS ${assertions} assertions; production normalizer/gates + frontend helper, DB-free`);
