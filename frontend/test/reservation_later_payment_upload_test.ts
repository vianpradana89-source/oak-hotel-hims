import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');
const drawerSrc = fs.readFileSync(
  path.join(frontendRoot, 'src/features/calendar/ReservationDetailDrawer.tsx'),
  'utf8'
);

const fnStart = drawerSrc.indexOf('const handleAddPayment');
const fnEnd = drawerSrc.indexOf('\n  return (', fnStart);
check(fnStart >= 0 && fnEnd > fnStart, 'handleAddPayment is present in ReservationDetailDrawer');
const handleAddPayment = drawerSrc.slice(fnStart, fnEnd);

console.log('=== OAK HIMS Reservation Later Payment Upload ===\n');

check(
  handleAddPayment.includes("formData.append('file', paymentEvidenceFile)"),
  'A. later-payment FormData uses canonical field file'
);
check(
  !handleAddPayment.includes("formData.append('evidence'"),
  'B. later-payment path does not append evidence multipart field'
);
check(
  !/formData\.append\(\s*['"]evidence['"]/.test(drawerSrc),
  'B. no evidence multipart append remains in ReservationDetailDrawer'
);

check(
  handleAddPayment.includes('if (!paymentEvidenceFile)'),
  'C/E. submit is gated when no paymentEvidenceFile is selected'
);
check(
  handleAddPayment.includes('Bukti pembayaran wajib dilampirkan sebelum memproses pembayaran'),
  'C/E. missing-file message matches App.tsx later-payment copy'
);
check(
  handleAddPayment.indexOf('if (!paymentEvidenceFile)') < handleAddPayment.indexOf('authFetch'),
  'C/E. missing-file gate runs before the network request'
);

check(
  handleAddPayment.includes('`/api/reservations/${data.id}/payments`'),
  'D. later payment still posts to POST /api/reservations/:id/payments'
);
check(
  handleAddPayment.includes("method: 'POST'") && handleAddPayment.includes('body: formData'),
  'D. request is POST with FormData body'
);
check(
  !/headers\s*:\s*\{[^}]*Content-Type/i.test(handleAddPayment),
  'D. submit does not manually set multipart Content-Type'
);
check(
  handleAddPayment.includes("formData.append('amount', String(amountNum))") &&
    handleAddPayment.includes("formData.append('payment_method', paymentMethod)") &&
    handleAddPayment.includes("formData.append('property_id', String(activePropId))"),
  'D. amount, payment_method, and property_id payload fields are unchanged'
);

console.log(`\n=== ALL RESERVATION LATER PAYMENT UPLOAD TESTS PASSED (${assertions} assertions) ===`);
