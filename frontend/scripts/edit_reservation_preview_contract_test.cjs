const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../src/features/calendar/EditReservationModal.tsx'),
  'utf8'
);

for (const field of ['room_type_id: roomTypeId', 'room_id: roomId', 'rate_plan_id: ratePlanId', 'check_in: checkIn', 'check_out: stayType === \'DAY_USE\' ? checkIn : checkOut', 'stay_type: stayType', 'adults', 'children']) {
  assert.ok(source.includes(field), `edit-preview payload must include current ${field}`);
}

assert.ok(
  source.includes('[reservation, roomTypeId, roomId, ratePlanId, checkIn, checkOut, stayType, adults, children, availabilityLoading, hasAssignableRoom, isOta, hasCompatibleRatePlan, authFetch]'),
  'edit-preview callback dependencies must include current price-driving state'
);
assert.ok(source.includes('const requestId = ++previewRequestRef.current;'), 'preview requests must be sequence-protected');
assert.ok(source.includes('if (requestId !== previewRequestRef.current) return;'), 'stale preview responses must be ignored');
assert.ok(source.includes('Rp {Number(previewData.quote?.grand_total || 0).toLocaleString(\'id-ID\')}'), 'Harga Baru must render quote.grand_total');
for (const field of ['payment_required', 'new_remaining_before_payment', 'amount_paid', 'applied_deposit']) {
  assert.ok(source.includes(`previewData?.${field}`) || source.includes(`previewData.${field}`), `payment UI must consume server ${field}`);
}
assert.ok(source.includes('if (previewData && paymentRequired > 0)'), 'payment modal must use server payment_required, not raw price difference');
assert.ok(source.includes("formData.append('amount_tendered', String(cashTendered));"), 'cash flow must submit tendered amount separately');
assert.ok(source.includes("formData.append('payment_amount', String(paymentRequired));"), 'non-cash flow must submit only canonical required amount');

console.log('PASS: Edit Reservation preview request contract checks passed');
