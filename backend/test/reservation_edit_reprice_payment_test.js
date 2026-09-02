const assert = require('assert');
const { Pool } = require('pg');
const { initializeDatabase } = require('../dist/db/schema_v3');
const {
  previewReservationEdit,
  executeReservationEditWithPayment
} = require('../dist/domains/reservations/reservationEditService');
const { deleteEvidenceFile } = require('../dist/domains/payments/evidenceStorageService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db'
});

const runId = `ERP${String(Date.now()).slice(-8)}`;
const tracked = { propertyId: null, reservationIds: [], bookingIds: [], evidenceKeys: [] };

async function createReservation(client, propertyId, roomId, roomTypeId, total, suffix, otaSourceId = null) {
  const booking = await client.query(
    `INSERT INTO bookings (property_id, bid, guest_name_snapshot, booking_status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [propertyId, `${runId}-${suffix}`, `${runId}-${suffix}`]
  );
  const bookingId = booking.rows[0].id;
  tracked.bookingIds.push(bookingId);
  const reservation = await client.query(
    `INSERT INTO reservations (
       booking_id, room_id, booked_room_type_id_snapshot, ota_source_id,
       guest_name, check_in, check_out, subtotal_amount, service_amount,
       tax_amount, total_price, amount_paid, applied_deposit,
       remaining_balance, status, payment_status, stay_sequence
     ) VALUES ($1, $2, $3, $4, $5, '2035-01-01', '2035-01-02',
       $6, 0, 0, $6, 0, 0, $6, 'BOOKED', 'UNPAID', 1)
     RETURNING id`,
    [bookingId, roomId, roomTypeId, otaSourceId, `${runId}-${suffix}`, total]
  );
  const reservationId = reservation.rows[0].id;
  tracked.reservationIds.push(reservationId);
  await client.query(
    `INSERT INTO folio_entries (
       reservation_id, property_id, entry_type, description, amount, direction
     ) VALUES ($1, $2, 'ROOM_CHARGE', 'Initial room charge', $3, 'DEBIT')`,
    [reservationId, propertyId, total]
  );
  return reservationId;
}

async function cleanup() {
  const client = await pool.connect();
  try {
    if (tracked.reservationIds.length) {
      const evidence = await client.query(
        'SELECT storage_key FROM payment_evidences WHERE reservation_id = ANY($1::int[])',
        [tracked.reservationIds]
      );
      tracked.evidenceKeys.push(...evidence.rows.map((row) => row.storage_key));
      await client.query('DELETE FROM payment_evidences WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM payment_transactions WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM folio_entries WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservation_nightly_rates WHERE reservation_id = ANY($1::int[])', [tracked.reservationIds]);
      await client.query('DELETE FROM reservations WHERE id = ANY($1::int[])', [tracked.reservationIds]);
    }
    if (tracked.bookingIds.length) {
      await client.query('DELETE FROM bookings WHERE id = ANY($1::int[])', [tracked.bookingIds]);
    }
    if (tracked.propertyId) {
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [tracked.propertyId]);
      await client.query(
        `DELETE FROM availability_dates
         WHERE room_type_id IN (SELECT id FROM room_types WHERE property_id = $1)`,
        [tracked.propertyId]
      );
      await client.query('DELETE FROM ota_sources WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rate_overrides WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rate_plans WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [tracked.propertyId]);
      await client.query('DELETE FROM properties WHERE id = $1', [tracked.propertyId]);
    }
  } finally {
    client.release();
    await Promise.all(tracked.evidenceKeys.map((key) => deleteEvidenceFile(key).catch(() => {})));
  }
}

async function run() {
  await initializeDatabase(pool);
  const client = await pool.connect();
  let oldTypeId;
  let targetTypeId;
  let oldRoomId;
  let targetRoomId;
  let targetRoomId2;
  let targetRoomId3;
  let targetRoomId4;
  let targetRoomId5;
  let targetRoomId6;
  let targetRoomId7;
  let targetRoomId8;
  let targetRoomId9;
  let staleRatePlanId;
  let targetRatePlanId;
  let alternateTargetRatePlanId;
  let settlementRatePlanId;
  let otaSourceId;
  try {
    await client.query('BEGIN');
    const property = await client.query(
      `INSERT INTO properties (name, property_code, timezone, currency, address, is_active)
       VALUES ($1, $2, 'Asia/Jakarta', 'IDR', 'Test', TRUE) RETURNING id`,
      [runId, `E${String(Date.now()).slice(-5)}`]
    );
    tracked.propertyId = property.rows[0].id;
    await client.query(
      `INSERT INTO property_pricing_settings (
         property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service
       ) VALUES ($1, 0, 0, FALSE, FALSE)
       ON CONFLICT (property_id) DO UPDATE
       SET tax_percent = EXCLUDED.tax_percent,
           service_charge_percent = EXCLUDED.service_charge_percent,
           prices_include_tax = EXCLUDED.prices_include_tax,
           prices_include_service = EXCLUDED.prices_include_service`,
      [tracked.propertyId]
    );
    const category = await client.query(
      `INSERT INTO room_categories (property_id, code, name, is_active)
       VALUES ($1, 'ERP-CAT', 'Edit Reprice', TRUE) RETURNING id`,
      [tracked.propertyId]
    );
    const oldType = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, 'ERP-OLD', 'Old Type', 550000, 2) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    const targetType = await client.query(
      `INSERT INTO room_types (property_id, room_category_id, code, name, base_rate, capacity)
       VALUES ($1, $2, 'ERP-NEW', 'New Type', 460000, 2) RETURNING id`,
      [tracked.propertyId, category.rows[0].id]
    );
    oldTypeId = oldType.rows[0].id;
    targetTypeId = targetType.rows[0].id;
    const oldRoom = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, 'ERP-OLD', 'Old Room', 'Ready', TRUE) RETURNING id`,
      [tracked.propertyId, oldTypeId]
    );
    const targetRoom = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES ($1, $2, 'ERP-NEW', 'New Room', 'Ready', TRUE) RETURNING id`,
      [tracked.propertyId, targetTypeId]
    );
    oldRoomId = oldRoom.rows[0].id;
    targetRoomId = targetRoom.rows[0].id;
    const extraTargetRooms = await client.query(
      `INSERT INTO rooms (property_id, room_type_id, room_number, name, status, is_active)
       VALUES
         ($1, $2, 'ERP-NEW-2', 'New Room 2', 'Ready', TRUE),
         ($1, $2, 'ERP-NEW-3', 'New Room 3', 'Ready', TRUE),
         ($1, $2, 'ERP-NEW-4', 'New Room 4', 'Ready', TRUE),
         ($1, $2, 'ERP-NEW-5', 'New Room 5', 'Ready', TRUE),
         ($1, $2, 'ERP-NEW-6', 'New Room 6', 'Ready', TRUE),
         ($1, $2, 'ERP-NEW-7', 'New Room 7', 'Ready', TRUE),
         ($1, $2, 'ERP-NEW-8', 'New Room 8', 'Ready', TRUE),
         ($1, $2, 'ERP-NEW-9', 'New Room 9', 'Ready', TRUE)
       RETURNING id`,
      [tracked.propertyId, targetTypeId]
    );
    targetRoomId2 = extraTargetRooms.rows[0].id;
    targetRoomId3 = extraTargetRooms.rows[1].id;
    targetRoomId4 = extraTargetRooms.rows[2].id;
    targetRoomId5 = extraTargetRooms.rows[3].id;
    targetRoomId6 = extraTargetRooms.rows[4].id;
    targetRoomId7 = extraTargetRooms.rows[5].id;
    targetRoomId8 = extraTargetRooms.rows[6].id;
    targetRoomId9 = extraTargetRooms.rows[7].id;
    const stalePlan = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate)
       VALUES ($1, $2, 'ERP-STALE', 'Stale Old Plan', 550000) RETURNING id`,
      [tracked.propertyId, oldTypeId]
    );
    staleRatePlanId = stalePlan.rows[0].id;
    const targetPlan = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate)
       VALUES ($1, $2, 'ERP-TARGET', 'Target Plan', 460000) RETURNING id`,
      [tracked.propertyId, targetTypeId]
    );
    targetRatePlanId = targetPlan.rows[0].id;
    const alternateTargetPlan = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate)
       VALUES ($1, $2, 'ERP-TARGET-ALT', 'Target Alternate Plan', 650000) RETURNING id`,
      [tracked.propertyId, targetTypeId]
    );
    alternateTargetRatePlanId = alternateTargetPlan.rows[0].id;
    const settlementPlan = await client.query(
      `INSERT INTO rate_plans (property_id, room_type_id, code, name, base_rate)
       VALUES ($1, $2, 'ERP-SETTLEMENT', 'Settlement Plan', 610000) RETURNING id`,
      [tracked.propertyId, targetTypeId]
    );
    settlementRatePlanId = settlementPlan.rows[0].id;
    const ota = await client.query(
      `INSERT INTO ota_sources (property_id, code, name)
       VALUES ($1, 'ERP-OTA', 'Edit Reprice OTA') RETURNING id`,
      [tracked.propertyId]
    );
    otaSourceId = ota.rows[0].id;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  try {
    const previewPriceId = await createReservation(pool, tracked.propertyId, null, oldTypeId, 435000, 'PREVIEW-PRICE');
    const selectedTargetPlanPreview = await previewReservationEdit(pool, previewPriceId, {
      property_id: tracked.propertyId,
      room_type_id: targetTypeId,
      room_id: targetRoomId,
      rate_plan_id: targetRatePlanId,
      check_in: '2035-01-01',
      check_out: '2035-01-02',
      stay_type: 'OVERNIGHT'
    });
    assert.strictEqual(Number(selectedTargetPlanPreview.quote.grand_total), 460000, 'selected target Rate Plan returns its canonical total');
    assert.strictEqual(Number(selectedTargetPlanPreview.price_difference), 25000, 'target Rate Plan difference is calculated from old total');
    assert.strictEqual(Number(selectedTargetPlanPreview.quote.room_type_id), Number(targetTypeId), 'preview honors the selected Room Type ID');
    assert.strictEqual(Number(selectedTargetPlanPreview.quote.rate_plan_id), Number(targetRatePlanId), 'preview honors the selected Rate Plan ID');

    const alternateTargetPlanPreview = await previewReservationEdit(pool, previewPriceId, {
      property_id: tracked.propertyId,
      room_type_id: targetTypeId,
      room_id: targetRoomId,
      rate_plan_id: alternateTargetRatePlanId,
      check_in: '2035-01-01',
      check_out: '2035-01-02',
      stay_type: 'OVERNIGHT'
    });
    assert.strictEqual(Number(alternateTargetPlanPreview.quote.grand_total), 650000, 'alternate Rate Plan returns its own canonical total');
    assert.strictEqual(Number(alternateTargetPlanPreview.price_difference), 215000, 'alternate Rate Plan recalculates difference');
    assert.notStrictEqual(
      Number(alternateTargetPlanPreview.quote.grand_total),
      Number(selectedTargetPlanPreview.quote.grand_total),
      'different Rate Plan IDs cannot reuse the prior quote total'
    );

    const financialAId = await createReservation(pool, tracked.propertyId, null, oldTypeId, 435000, 'FIN-A');
    await pool.query(
      `INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status)
       VALUES ($1, 'PAYMENT', 385000, 'TRANSFER', 'SUCCESS')`,
      [financialAId]
    );
    await pool.query(
      `UPDATE reservations SET amount_paid = 385000, remaining_balance = 50000, payment_status = 'PARTIAL' WHERE id = $1`,
      [financialAId]
    );
    const financialAPreview = await previewReservationEdit(pool, financialAId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId7,
      rate_plan_id: settlementRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    assert.strictEqual(Number(financialAPreview.old_total), 435000, 'A old_total is canonical reservation total');
    assert.strictEqual(Number(financialAPreview.new_total), 610000, 'A new_total is canonical selected plan quote');
    assert.strictEqual(Number(financialAPreview.price_difference), 175000, 'A price difference is correct');
    assert.strictEqual(Number(financialAPreview.effective_settlement), 385000, 'A effective settlement is correct');
    assert.strictEqual(Number(financialAPreview.new_remaining_before_payment), 225000, 'A remaining before payment is correct');
    assert.strictEqual(Number(financialAPreview.payment_required), 175000, 'A payment required is capped at price difference');
    const paymentEvidence = { buffer: Buffer.from([137, 80, 78, 71]), mimetype: 'image/png', originalname: 'difference.png', size: 4 };
    const financialAResult = await executeReservationEditWithPayment(pool, financialAId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId7,
      rate_plan_id: settlementRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
      expected_new_total: 610000, payment_method: 'TRANSFER', payment_amount: 175000,
      idempotency_key: `${runId}-FIN-A`
    }, paymentEvidence, 'TEST');
    assert.strictEqual(Number(financialAResult.payment.amount), 175000, 'A posts only payment_required');
    assert.strictEqual(Number(financialAResult.reservation.remaining_balance), 50000, 'A preserves prior outstanding balance');

    const financialBId = await createReservation(pool, tracked.propertyId, null, oldTypeId, 534000, 'FIN-B');
    await pool.query(
      `INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status)
       VALUES ($1, 'PAYMENT', 560000, 'TRANSFER', 'SUCCESS')`,
      [financialBId]
    );
    await pool.query(
      `UPDATE reservations SET amount_paid = 560000, remaining_balance = 0, payment_status = 'PAID' WHERE id = $1`,
      [financialBId]
    );
    const financialBPreview = await previewReservationEdit(pool, financialBId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId8,
      rate_plan_id: settlementRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    assert.strictEqual(Number(financialBPreview.price_difference), 76000, 'B price difference is correct');
    assert.strictEqual(Number(financialBPreview.new_remaining_before_payment), 50000, 'B remaining before payment is correct');
    assert.strictEqual(Number(financialBPreview.payment_required), 50000, 'B payment required is capped by new remaining');
    const financialBPayload = {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId8,
      rate_plan_id: settlementRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
      expected_new_total: 610000, payment_method: 'CASH', idempotency_key: `${runId}-FIN-B`
    };
    await assert.rejects(
      executeReservationEditWithPayment(pool, financialBId, { ...financialBPayload, amount_tendered: 40000 }, paymentEvidence, 'TEST'),
      (error) => error.code === 'INSUFFICIENT_CASH_TENDER'
    );
    const financialBResult = await executeReservationEditWithPayment(pool, financialBId, { ...financialBPayload, amount_tendered: 100000 }, paymentEvidence, 'TEST');
    assert.strictEqual(Number(financialBResult.payment.amount), 50000, 'B cash tender posts required amount, not tendered amount');
    assert.strictEqual(Number(financialBResult.reservation.remaining_balance), 0, 'B remaining balance is zero after capped payment');
    assert.strictEqual(String(financialBResult.reservation.payment_status), 'PAID', 'B payment status is PAID');

    const nonCashMismatchId = await createReservation(pool, tracked.propertyId, null, oldTypeId, 534000, 'NONCASH-MISMATCH');
    const nonCashMismatchPreview = await previewReservationEdit(pool, nonCashMismatchId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId9,
      rate_plan_id: settlementRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    await assert.rejects(
      executeReservationEditWithPayment(pool, nonCashMismatchId, {
        property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId9,
        rate_plan_id: settlementRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
        expected_new_total: Number(nonCashMismatchPreview.new_total), payment_method: 'TRANSFER', payment_amount: 100000,
        idempotency_key: `${runId}-NONCASH-MISMATCH`
      }, paymentEvidence, 'TEST'),
      (error) => error.code === 'PAYMENT_AMOUNT_MISMATCH'
    );

    const depositPreviewId = await createReservation(pool, tracked.propertyId, null, oldTypeId, 534000, 'DEPOSIT-PREVIEW');
    await pool.query(
      `INSERT INTO folio_entries (reservation_id, property_id, entry_type, description, amount, direction, status, is_voided)
       VALUES ($1, $2, 'DEPOSIT_APPLY', 'Applied deposit', 560000, 'CREDIT', 'POSTED', FALSE)`,
      [depositPreviewId, tracked.propertyId]
    );
    await pool.query('UPDATE reservations SET applied_deposit = 560000, remaining_balance = 0, payment_status = $2 WHERE id = $1', [depositPreviewId, 'PAID']);
    const depositPreview = await previewReservationEdit(pool, depositPreviewId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId9,
      rate_plan_id: settlementRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    assert.strictEqual(Number(depositPreview.effective_settlement), 560000, 'applied deposit participates in effective settlement');
    assert.strictEqual(Number(depositPreview.payment_required), 50000, 'applied deposit reduces payment_required');

    const quoteSeedId = await createReservation(pool, tracked.propertyId, null, oldTypeId, 1, 'QUOTE');
    const targetPreview = await previewReservationEdit(pool, quoteSeedId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId2,
      rate_plan_id: null, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    const targetTotal = Number(targetPreview.quote.grand_total);

    const keepId = await createReservation(pool, tracked.propertyId, oldRoomId, oldTypeId, targetTotal + 90000, 'KEEP');
    await pool.query(
      `INSERT INTO reservation_nightly_rates (
         reservation_id, property_id, stay_date, room_type_id,
         room_type_code_snapshot, room_type_name_snapshot, rate_plan_id,
         rate_plan_code_snapshot, rate_plan_name_snapshot, base_rate,
         final_room_rate, service_amount, tax_amount, total_amount
       ) VALUES ($1, $2, '2035-01-01', $3, 'ERP-OLD', 'Old Type', $4,
         'ERP-STALE', 'Stale Old Plan', $5, $5, 0, 0, $5)`,
      [keepId, tracked.propertyId, oldTypeId, staleRatePlanId, targetTotal + 90000]
    );
    const keepPreview = await previewReservationEdit(pool, keepId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId,
      rate_plan_id: targetRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    const kept = await executeReservationEditWithPayment(pool, keepId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId,
      rate_plan_id: targetRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
      keep_current_price: true, expected_new_total: keepPreview.quote.grand_total,
      idempotency_key: `${runId}-KEEP`
    }, null, 'TEST');
    assert.strictEqual(Number(kept.reservation.total_price), targetTotal + 90000, 'keep old price preserves total');
    assert.strictEqual(Number(kept.reservation.room_id), Number(targetRoomId), 'keep old price still applies room change');
    const keptSnapshot = await pool.query(
      `SELECT room_type_id, rate_plan_id, total_amount, is_manual_override, manual_override_reason
       FROM reservation_nightly_rates WHERE reservation_id = $1`,
      [keepId]
    );
    assert.strictEqual(Number(keptSnapshot.rows[0].room_type_id), Number(targetTypeId), 'keep old price updates snapshot room type');
    assert.strictEqual(Number(keptSnapshot.rows[0].rate_plan_id), Number(targetRatePlanId), 'keep old price updates snapshot rate plan');
    assert.strictEqual(Number(keptSnapshot.rows[0].total_amount), targetTotal + 90000, 'keep old price preserves snapshot selling amount');
    assert.strictEqual(keptSnapshot.rows[0].is_manual_override, true, 'keep old price marks snapshot manual override');

    const lowerId = await createReservation(pool, tracked.propertyId, null, oldTypeId, targetTotal + 90000, 'LOWER');
    await pool.query(
      `INSERT INTO payment_transactions (reservation_id, transaction_type, amount, payment_method, status)
       VALUES ($1, 'PAYMENT', $2, 'CASH', 'SUCCESS')`,
      [lowerId, targetTotal + 90000]
    );
    await pool.query('UPDATE reservations SET amount_paid = $2, remaining_balance = 0, payment_status = $3 WHERE id = $1', [lowerId, targetTotal + 90000, 'PAID']);
    const lowerPreview = await previewReservationEdit(pool, lowerId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId2,
      rate_plan_id: null, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    const lowered = await executeReservationEditWithPayment(pool, lowerId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId3,
      rate_plan_id: null, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
      keep_current_price: false, expected_new_total: lowerPreview.quote.grand_total,
      idempotency_key: `${runId}-LOWER`
    }, null, 'TEST');
    assert.strictEqual(Number(lowered.reservation.total_price), targetTotal, 'apply lower quote updates total');
    assert.strictEqual(Number(lowered.reservation.amount_paid), targetTotal + 90000, 'lower quote does not refund overpayment');
    assert.strictEqual(Number(lowered.reservation.remaining_balance), 0, 'overpayment remains zero-balance credit state');
    const lowerSnapshot = await pool.query(
      'SELECT room_type_id, total_amount, is_manual_override FROM reservation_nightly_rates WHERE reservation_id = $1',
      [lowerId]
    );
    assert.strictEqual(Number(lowerSnapshot.rows[0].room_type_id), Number(targetTypeId), 'apply new price updates snapshot room type');
    assert.strictEqual(Number(lowerSnapshot.rows[0].total_amount), targetTotal, 'apply new price updates snapshot amount');
    assert.strictEqual(lowerSnapshot.rows[0].is_manual_override, false, 'apply new price is not a manual override');

    const samePriceId = await createReservation(pool, tracked.propertyId, null, targetTypeId, targetTotal, 'SAME');
    const samePreview = await previewReservationEdit(pool, samePriceId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId3,
      rate_plan_id: null, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    await executeReservationEditWithPayment(pool, samePriceId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId4,
      rate_plan_id: null, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
      keep_current_price: false, expected_new_total: samePreview.quote.grand_total,
      idempotency_key: `${runId}-SAME`
    }, null, 'TEST');
    const samePaymentRows = await pool.query('SELECT COUNT(*)::int AS count FROM payment_transactions WHERE reservation_id = $1', [samePriceId]);
    const sameEvidenceRows = await pool.query('SELECT COUNT(*)::int AS count FROM payment_evidences WHERE reservation_id = $1', [samePriceId]);
    assert.strictEqual(samePaymentRows.rows[0].count, 0, 'same-price edit creates no payment');
    assert.strictEqual(sameEvidenceRows.rows[0].count, 0, 'same-price edit creates no evidence');

    const increaseId = await createReservation(pool, tracked.propertyId, null, oldTypeId, targetTotal - 51379, 'INCREASE');
    const increasePreview = await previewReservationEdit(pool, increaseId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId4,
      rate_plan_id: null, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    const increasePayload = {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId5,
      rate_plan_id: null, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
      keep_current_price: false, expected_new_total: increasePreview.quote.grand_total,
      payment_method: 'QRIS', payment_amount: Number(increasePreview.payment_required), idempotency_key: `${runId}-INCREASE`
    };
    await assert.rejects(
      executeReservationEditWithPayment(pool, increaseId, increasePayload, null, 'TEST'),
      (error) => error.code === 'PAYMENT_EVIDENCE_REQUIRED'
    );
    const afterRejected = await pool.query('SELECT room_id, total_price FROM reservations WHERE id = $1', [increaseId]);
    assert.strictEqual(Number(afterRejected.rows[0].total_price), targetTotal - 51379, 'missing evidence rolls back reprice');
    const file = { buffer: Buffer.from([137, 80, 78, 71]), mimetype: 'image/png', originalname: 'difference.png', size: 4 };
    const paid = await executeReservationEditWithPayment(pool, increaseId, increasePayload, file, 'TEST');
    assert.strictEqual(Number(paid.payment.amount), 51379, 'server posts exact positive difference');
    assert.strictEqual(Number(paid.evidence.payment_transaction_id), Number(paid.payment.id), 'evidence links to exact payment');
    await executeReservationEditWithPayment(pool, increaseId, increasePayload, file, 'TEST');
    const duplicateCount = await pool.query(
      `SELECT COUNT(*)::int AS count FROM payment_transactions
       WHERE reservation_id = $1 AND correction_group_id = $2`,
      [increaseId, `edit-payment:${tracked.propertyId}:${increaseId}:${runId}-INCREASE`]
    );
    assert.strictEqual(duplicateCount.rows[0].count, 1, 'duplicate idempotency key creates one payment');

    const otaId = await createReservation(pool, tracked.propertyId, oldRoomId, oldTypeId, 777777, 'OTA', otaSourceId);
    await pool.query('UPDATE reservations SET rate_plan_id = $2 WHERE id = $1', [otaId, staleRatePlanId]);
    const otaPreview = await previewReservationEdit(pool, otaId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId6,
      rate_plan_id: staleRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT'
    });
    const otaEdited = await executeReservationEditWithPayment(pool, otaId, {
      property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId6,
      rate_plan_id: staleRatePlanId, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
      keep_current_price: false, expected_new_total: otaPreview.quote.grand_total,
      idempotency_key: `${runId}-OTA`
    }, null, 'TEST');
    assert.strictEqual(Number(otaEdited.reservation.total_price), 777777, 'OTA manual total remains authoritative');
    assert.strictEqual(otaEdited.reservation.rate_plan_id, null, 'OTA incompatible stale rate plan is cleared');

    const checkedInId = await createReservation(pool, tracked.propertyId, oldRoomId, oldTypeId, targetTotal, 'CHECKED-IN');
    await pool.query("UPDATE reservations SET status = 'CHECKED_IN' WHERE id = $1", [checkedInId]);
    await assert.rejects(
      executeReservationEditWithPayment(pool, checkedInId, {
        property_id: tracked.propertyId, room_type_id: targetTypeId, room_id: targetRoomId6,
        rate_plan_id: null, check_in: '2035-01-01', check_out: '2035-01-02', stay_type: 'OVERNIGHT',
        keep_current_price: false, expected_new_total: targetTotal,
        idempotency_key: `${runId}-CHECKED-IN`
      }, null, 'TEST'),
      (error) => error.code === 'BOOKED_RESERVATION_REQUIRED'
    );

    console.log('PASS: reservation edit reprice/payment integration checks passed');
  } finally {
    await cleanup();
    await pool.end();
  }
}

run().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
