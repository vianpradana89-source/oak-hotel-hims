import type { Pool, PoolClient } from 'pg';
import { getPropertyPricingSettings } from '../pricing/pricingService';
import type {
  CreateStayChargeRuleDto,
  PostStayChargeDto,
  StayChargeRule,
  StayChargeType,
  UpdateStayChargeRuleDto,
  VoidFolioEntryDto,
  CorrectFolioEntryDto
} from './stayChargesTypes';
import { projectFolioEntryToTransaction } from '../transactions/transactionService';

// ============================================================================
// AUDIT LOGGING HELPER
// ============================================================================

async function logAudit(
  client: PoolClient | Pool,
  params: {
    property_id: number;
    action: string;
    entity_type: string;
    entity_id: number | string;
    before?: any;
    after?: any;
    actor?: string;
  }
) {
  try {
    await client.query(
      `INSERT INTO audit_logs (
        module, action, entity, record_id, new_value, property_id
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'STAY_CHARGE',
        params.action,
        params.entity_type,
        String(params.entity_id),
        params.after ? JSON.stringify(params.after) : (params.before ? JSON.stringify(params.before) : null),
        params.property_id
      ]
    );
  } catch (err) {
    console.error('Stay charge audit logging warning:', err);
  }
}

// ============================================================================
// STAY CHARGE RULES CRUD
// ============================================================================

export async function listStayChargeRules(
  client: PoolClient | Pool,
  propertyId: number,
  chargeType?: StayChargeType,
  includeArchived: boolean = false
): Promise<StayChargeRule[]> {
  const conditions: string[] = ['property_id = $1'];
  const values: any[] = [propertyId];
  let idx = 2;

  if (chargeType) {
    conditions.push(`charge_type = $${idx++}`);
    values.push(chargeType);
  }

  if (!includeArchived) {
    conditions.push('is_archived = FALSE');
  }

  const query = `
    SELECT *
    FROM stay_charge_rules
    WHERE ${conditions.join(' AND ')}
    ORDER BY sort_order ASC, id ASC
  `;

  const res = await client.query(query, values);
  return res.rows.map(mapRowToStayChargeRule);
}

export async function getStayChargeRuleById(
  client: PoolClient | Pool,
  propertyId: number,
  id: number
): Promise<StayChargeRule | null> {
  const res = await client.query(
    'SELECT * FROM stay_charge_rules WHERE id = $1 AND property_id = $2',
    [id, propertyId]
  );
  if (res.rowCount === 0) return null;
  return mapRowToStayChargeRule(res.rows[0]);
}

export async function createStayChargeRule(
  client: PoolClient | Pool,
  propertyId: number,
  dto: CreateStayChargeRuleDto,
  actor: string = 'SYSTEM'
): Promise<StayChargeRule> {
  const code = (dto.code || '').trim().toUpperCase();
  const name = (dto.name || '').trim();

  if (!code) throw new Error('Kode aturan biaya wajib diisi');
  if (!name) throw new Error('Nama aturan biaya wajib diisi');

  // Check unique active code within property
  const dupCheck = await client.query(
    `SELECT id FROM stay_charge_rules
     WHERE property_id = $1 AND UPPER(TRIM(code)) = $2 AND is_archived = FALSE`,
    [propertyId, code]
  );
  if ((dupCheck.rowCount ?? 0) > 0) {
    throw new Error(`Kode aturan '${code}' sudah digunakan untuk properti ini`);
  }

  const res = await client.query(
    `INSERT INTO stay_charge_rules (
      property_id, charge_type, code, name, description,
      charge_method, default_amount, percentage_rate, cutoff_time,
      taxable, service_chargeable, requires_note, requires_photo,
      requires_supervisor_approval, approval_threshold,
      is_active, is_archived, sort_order, created_by, updated_by
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13,
      $14, $15,
      $16, FALSE, $17, $18, $18
    ) RETURNING *`,
    [
      propertyId,
      dto.charge_type,
      code,
      name,
      dto.description || null,
      dto.charge_method || 'FIXED_AMOUNT',
      Number(dto.default_amount || 0),
      Number(dto.percentage_rate || 0),
      dto.cutoff_time || null,
      dto.taxable !== undefined ? Boolean(dto.taxable) : true,
      dto.service_chargeable !== undefined ? Boolean(dto.service_chargeable) : true,
      Boolean(dto.requires_note),
      Boolean(dto.requires_photo),
      Boolean(dto.requires_supervisor_approval),
      Number(dto.approval_threshold || 0),
      dto.is_active !== undefined ? Boolean(dto.is_active) : true,
      Number(dto.sort_order || 0),
      actor
    ]
  );

  const created = mapRowToStayChargeRule(res.rows[0]);
  await logAudit(client, {
    property_id: propertyId,
    action: 'STAY_CHARGE_CREATED',
    entity_type: 'STAY_CHARGE_RULE',
    entity_id: created.id,
    after: created,
    actor
  });

  return created;
}

export async function updateStayChargeRule(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  dto: UpdateStayChargeRuleDto,
  actor: string = 'SYSTEM'
): Promise<StayChargeRule> {
  const existing = await getStayChargeRuleById(client, propertyId, id);
  if (!existing) {
    throw new Error(`Aturan biaya #${id} tidak ditemukan`);
  }

  if (dto.code !== undefined) {
    const newCode = dto.code.trim().toUpperCase();
    if (!newCode) throw new Error('Kode aturan tidak boleh kosong');
    if (newCode !== existing.code) {
      const dupCheck = await client.query(
        `SELECT id FROM stay_charge_rules
         WHERE property_id = $1 AND UPPER(TRIM(code)) = $2 AND id <> $3 AND is_archived = FALSE`,
        [propertyId, newCode, id]
      );
      if ((dupCheck.rowCount ?? 0) > 0) {
        throw new Error(`Kode aturan '${newCode}' sudah digunakan`);
      }
    }
  }

  const updatedCode = dto.code !== undefined ? dto.code.trim().toUpperCase() : existing.code;
  const updatedName = dto.name !== undefined ? dto.name.trim() : existing.name;
  if (!updatedName) throw new Error('Nama aturan tidak boleh kosong');

  const res = await client.query(
    `UPDATE stay_charge_rules SET
      code = $1,
      name = $2,
      description = $3,
      charge_method = $4,
      default_amount = $5,
      percentage_rate = $6,
      cutoff_time = $7,
      taxable = $8,
      service_chargeable = $9,
      requires_note = $10,
      requires_photo = $11,
      requires_supervisor_approval = $12,
      approval_threshold = $13,
      is_active = $14,
      sort_order = $15,
      updated_by = $16,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $17 AND property_id = $18
    RETURNING *`,
    [
      updatedCode,
      updatedName,
      dto.description !== undefined ? dto.description : existing.description,
      dto.charge_method !== undefined ? dto.charge_method : existing.charge_method,
      dto.default_amount !== undefined ? Number(dto.default_amount) : existing.default_amount,
      dto.percentage_rate !== undefined ? Number(dto.percentage_rate) : existing.percentage_rate,
      dto.cutoff_time !== undefined ? dto.cutoff_time : existing.cutoff_time,
      dto.taxable !== undefined ? Boolean(dto.taxable) : existing.taxable,
      dto.service_chargeable !== undefined ? Boolean(dto.service_chargeable) : existing.service_chargeable,
      dto.requires_note !== undefined ? Boolean(dto.requires_note) : existing.requires_note,
      dto.requires_photo !== undefined ? Boolean(dto.requires_photo) : existing.requires_photo,
      dto.requires_supervisor_approval !== undefined ? Boolean(dto.requires_supervisor_approval) : existing.requires_supervisor_approval,
      dto.approval_threshold !== undefined ? Number(dto.approval_threshold) : existing.approval_threshold,
      dto.is_active !== undefined ? Boolean(dto.is_active) : existing.is_active,
      dto.sort_order !== undefined ? Number(dto.sort_order) : existing.sort_order,
      actor,
      id,
      propertyId
    ]
  );

  const updated = mapRowToStayChargeRule(res.rows[0]);
  await logAudit(client, {
    property_id: propertyId,
    action: 'STAY_CHARGE_UPDATED',
    entity_type: 'STAY_CHARGE_RULE',
    entity_id: id,
    before: existing,
    after: updated,
    actor
  });

  return updated;
}

export async function deleteStayChargeRule(
  client: PoolClient | Pool,
  propertyId: number,
  id: number,
  actor: string = 'SYSTEM'
): Promise<{ deleted: boolean; archived: boolean; message: string }> {
  const existing = await getStayChargeRuleById(client, propertyId, id);
  if (!existing) {
    throw new Error(`Aturan biaya #${id} tidak ditemukan`);
  }

  // Check if referenced in folio_entries
  const refRes = await client.query(
    `SELECT COUNT(*) as count FROM folio_entries
     WHERE property_id = $1 AND source_id = $2`,
    [propertyId, String(id)]
  );
  const isReferenced = Number(refRes.rows[0]?.count || 0) > 0;

  if (isReferenced) {
    // Safe archive
    await client.query(
      `UPDATE stay_charge_rules
       SET is_archived = TRUE, is_active = FALSE, updated_by = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND property_id = $3`,
      [actor, id, propertyId]
    );

    await logAudit(client, {
      property_id: propertyId,
      action: 'STAY_CHARGE_ARCHIVED',
      entity_type: 'STAY_CHARGE_RULE',
      entity_id: id,
      before: existing,
      after: { ...existing, is_archived: true, is_active: false },
      actor
    });

    return {
      deleted: false,
      archived: true,
      message: 'Aturan biaya sudah digunakan oleh histori transaksi/folio. Data akan diarsipkan agar laporan keuangan tetap aman.'
    };
  }

  // Hard delete if never referenced
  await client.query(
    'DELETE FROM stay_charge_rules WHERE id = $1 AND property_id = $2',
    [id, propertyId]
  );

  await logAudit(client, {
    property_id: propertyId,
    action: 'STAY_CHARGE_DELETED',
    entity_type: 'STAY_CHARGE_RULE',
    entity_id: id,
    before: existing,
    actor
  });

  return {
    deleted: true,
    archived: false,
    message: 'Aturan biaya berhasil dihapus.'
  };
}

// ============================================================================
// FOLIO POSTING & VOID ENGINE
// ============================================================================

// ============================================================================
// CENTRALIZED FINANCIAL RECALCULATION ENGINE
// ============================================================================

export async function recalculateReservationFinancials(
  client: PoolClient | Pool,
  reservationId: number,
  propertyId: number,
  ordinaryFallbackOverride?: number
): Promise<{
  total_price: number;
  amount_paid: number;
  remaining_balance: number;
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
  reservation: any;
}> {
  // 1. Fetch current reservation details
  const resCheck = await client.query(
    `SELECT r.*, b.property_id AS booking_property_id
     FROM reservations r
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1
     FOR UPDATE OF r`,
    [reservationId]
  );
  if ((resCheck.rowCount ?? 0) === 0) {
    const err: any = new Error(`Reservasi #${reservationId} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }
  const resRow = resCheck.rows[0];
  const bookingPropId = Number(resRow.booking_property_id || resRow.property_id || propertyId);
  if (propertyId && bookingPropId && bookingPropId !== propertyId) {
    const err: any = new Error('Reservasi milik properti yang berbeda');
    err.statusCode = 403;
    err.code = 'CROSS_PROPERTY_ACCESS';
    throw err;
  }

  // 2. Calculate Total Charges (Debits) from folio_entries:
  // Charges = Sum of DEBIT entries that are NOT payment voids/reversals
  // Reversals = Sum of CREDIT entries that are reversals of charges (reversal_of_entry_id IS NOT NULL OR entry_type = 'REVERSAL')
  // Net Charges = Charges - Reversals
  const folioDebitsRes = await client.query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN direction = 'DEBIT' AND entry_type NOT IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT') THEN amount
         ELSE 0
       END), 0) AS gross_charges,
       COALESCE(SUM(CASE
         WHEN direction = 'CREDIT' AND (reversal_of_entry_id IS NOT NULL OR entry_type = 'REVERSAL' OR entry_type LIKE '%_REVERSAL') THEN amount
         ELSE 0
       END), 0) AS charge_reversals,
       COUNT(CASE WHEN direction = 'DEBIT' AND entry_type NOT IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL', 'REFUND_DEBIT') THEN 1 END)::int as charge_count
     FROM folio_entries
     WHERE reservation_id = $1`,
    [reservationId]
  );

  const grossCharges = Math.round(Number(folioDebitsRes.rows[0]?.gross_charges || 0));
  const chargeReversals = Math.round(Number(folioDebitsRes.rows[0]?.charge_reversals || 0));
  const chargeCount = Number(folioDebitsRes.rows[0]?.charge_count || 0);

  let netTotalCharges: number;
  if (chargeCount > 0) {
    netTotalCharges = Math.max(0, grossCharges - chargeReversals);
  } else {
    // Fallback for legacy reservations where folio charges haven't been backfilled
    const nightlySumRes = await client.query(
      `SELECT COALESCE(SUM(total_amount), 0) as nightly_sum FROM reservation_nightly_rates WHERE reservation_id = $1`,
      [reservationId]
    );
    const nightlySum = Math.round(Number(nightlySumRes.rows[0]?.nightly_sum || 0));
    netTotalCharges = nightlySum > 0 ? nightlySum : Math.round(Number(resRow.total_price || 0));
  }

  // 3. Calculate Total Payments (Credits) from payment_transactions:
  const pmtRes = await client.query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN status = 'SUCCESS' AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT') THEN amount
         ELSE 0
       END), 0) AS net_paid
     FROM payment_transactions
     WHERE reservation_id = $1`,
    [reservationId]
  );
  let ordinaryAmountPaid = Math.round(Number(pmtRes.rows[0]?.net_paid || 0));
  if (ordinaryAmountPaid < 0) ordinaryAmountPaid = 0;

  const depositApplyRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS applied_deposit
     FROM folio_entries
     WHERE reservation_id = $1
       AND property_id = $2
       AND entry_type = 'DEPOSIT_APPLY'
       AND direction = 'CREDIT'
       AND status = 'POSTED'
       AND is_voided = FALSE
       AND reversal_of_entry_id IS NULL`,
    [reservationId, propertyId]
  );
  const appliedDeposit = Math.round(Number(depositApplyRes.rows[0]?.applied_deposit || 0));

  // Deposit cash movements are liabilities, not reservation settlement. Only
  // ordinary settlement transaction types participate in this legacy fallback.
  const hasPaymentTx = await client.query(
    `SELECT 1 FROM payment_transactions
     WHERE reservation_id = $1
       AND transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
     LIMIT 1`,
    [reservationId]
  );
  if ((hasPaymentTx.rowCount ?? 0) === 0) {
    const folioPmtRes = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' AND entry_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT') AND reversal_of_entry_id IS NULL THEN amount ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN direction = 'DEBIT' AND entry_type IN ('PAYMENT_VOID', 'PAYMENT_REVERSAL') THEN amount ELSE 0 END), 0) AS folio_paid
       FROM folio_entries
       WHERE reservation_id = $1`,
      [reservationId]
    );
    const folioPaid = Math.round(Number(folioPmtRes.rows[0]?.folio_paid || 0));
    if (folioPaid > 0) {
      ordinaryAmountPaid = folioPaid;
    } else {
      ordinaryAmountPaid = ordinaryFallbackOverride === undefined
        ? Math.max(0, Math.round(Number(resRow.amount_paid || 0)) - appliedDeposit)
        : Math.max(0, Math.round(ordinaryFallbackOverride));
    }
  }

  // A deposit affects reservation settlement only when explicitly applied.
  // Do not generically sum folio credits: ordinary payments already have folio
  // projections and would otherwise be counted twice.
  const netAmountPaid = ordinaryAmountPaid + appliedDeposit;

  // 4. Calculate Remaining Balance & Payment Status
  const remainingBalance = Math.max(0, netTotalCharges - netAmountPaid);

  let newPaymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' = 'UNPAID';
  if (netAmountPaid <= 0) {
    newPaymentStatus = 'UNPAID';
  } else if (remainingBalance === 0) {
    newPaymentStatus = 'PAID';
  } else {
    newPaymentStatus = 'PARTIAL';
  }

  // 5. Update reservations row atomically
  const updatedRes = await client.query(
    `UPDATE reservations SET
       total_price = $1,
       amount_paid = $2,
       remaining_balance = $3,
       payment_status = $4
     WHERE id = $5
     RETURNING *`,
    [netTotalCharges, netAmountPaid, remainingBalance, newPaymentStatus, reservationId]
  );

  return {
    total_price: netTotalCharges,
    amount_paid: netAmountPaid,
    remaining_balance: remainingBalance,
    payment_status: newPaymentStatus,
    reservation: updatedRes.rows[0]
  };
}

// ============================================================================
// FOLIO POSTING, VOID & CORRECTION ENGINE
// ============================================================================

export async function postStayChargeToFolio(
  client: PoolClient | Pool,
  propertyId: number,
  dto: PostStayChargeDto
): Promise<{ folio_entry_id: number; reservation: any; folio_entry: any }> {
  const reservationRes = await client.query(
    `SELECT r.*, b.property_id as booking_property_id
     FROM reservations r
     LEFT JOIN bookings b ON b.id = r.booking_id
     WHERE r.id = $1`,
    [dto.reservation_id]
  );

  if ((reservationRes.rowCount ?? 0) === 0) {
    const err: any = new Error(`Reservasi #${dto.reservation_id} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }

  const reservation = reservationRes.rows[0];
  const resPropId = reservation.booking_property_id ?? reservation.property_id ?? propertyId;
  if (Number(resPropId) !== propertyId) {
    const err: any = new Error('Reservasi tidak berada pada properti yang aktif');
    err.statusCode = 403;
    err.code = 'CROSS_PROPERTY_ACCESS';
    throw err;
  }

  if (String(reservation.status).toUpperCase() === 'CANCELLED') {
    const err: any = new Error('Tidak dapat menambahkan biaya pada reservasi yang telah dibatalkan');
    err.statusCode = 400;
    throw err;
  }

  const qty = Number(dto.quantity || 1);
  if (qty <= 0) {
    const err: any = new Error('Jumlah (kuantitas) harus lebih besar dari 0');
    err.statusCode = 400;
    throw err;
  }

  // Single-occurrence guard for EARLY_CHECKIN and LATE_CHECKOUT
  if (dto.charge_type === 'EARLY_CHECKIN' || dto.charge_type === 'LATE_CHECKOUT') {
    const existingSingle = await client.query(
      `SELECT id FROM folio_entries
       WHERE reservation_id = $1
         AND entry_type = $2
         AND direction = 'DEBIT'
         AND is_voided = FALSE
         AND reversal_of_entry_id IS NULL`,
      [dto.reservation_id, dto.charge_type]
    );
    if ((existingSingle.rowCount ?? 0) > 0) {
      const label = dto.charge_type === 'EARLY_CHECKIN' ? 'Early Check-in' : 'Late Check-out';
      const err: any = new Error(`Layanan ${label} sudah ditambahkan pada reservasi ini.`);
      err.statusCode = 400;
      throw err;
    }
  }

  let baseUnitPrice = 0;
  let originalRuleAmount: number | null = null;
  let isOverride = false;
  let overrideAmount: number | null = null;
  let overrideReason: string | null = null;
  let overrideBy: string | null = null;
  let overrideAt: Date | null = null;

  let chargeDescription = dto.custom_description || '';
  let taxable = true;
  let serviceChargeable = true;
  let sourceId = dto.rule_id ? String(dto.rule_id) : '';
  let ruleCodeSnapshot: string | null = null;
  let ruleNameSnapshot: string | null = null;
  let calcMethodSnapshot: string | null = null;

  if (dto.rule_id) {
    const rule = await getStayChargeRuleById(client, propertyId, dto.rule_id);
    if (!rule) {
      const err: any = new Error(`Aturan biaya #${dto.rule_id} tidak ditemukan`);
      err.statusCode = 404;
      throw err;
    }
    if (!rule.is_active || rule.is_archived) {
      const err: any = new Error(`Aturan biaya '${rule.name}' tidak aktif atau telah diarsipkan`);
      err.statusCode = 400;
      throw err;
    }

    ruleCodeSnapshot = rule.code;
    ruleNameSnapshot = rule.name;
    calcMethodSnapshot = rule.charge_method;
    taxable = rule.taxable;
    serviceChargeable = rule.service_chargeable;
    if (!chargeDescription) chargeDescription = rule.name;

    // 1. Calculate Authoritative Default Amount from Rule
    let ruleAuthoritativeAmount = 0;
    if (rule.charge_method === 'FIXED_AMOUNT') {
      ruleAuthoritativeAmount = Number(rule.default_amount || 0);
    } else if (rule.charge_method === 'FREE') {
      ruleAuthoritativeAmount = 0;
    } else if (rule.charge_method === 'MANUAL') {
      if (dto.unit_price === undefined || dto.unit_price < 0) {
        const err: any = new Error('Nominal manual wajib diisi dan tidak boleh negatif');
        err.statusCode = 400;
        throw err;
      }
      ruleAuthoritativeAmount = Number(dto.unit_price);
    } else if (rule.charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE' || rule.charge_method === 'FULL_NIGHT') {
      const ratesRes = await client.query(
        `SELECT final_room_rate FROM reservation_nightly_rates
         WHERE reservation_id = $1 ORDER BY stay_date ASC`,
        [dto.reservation_id]
      );
      let applicableNightlyRate = 0;
      if ((ratesRes.rowCount ?? 0) > 0) {
        if (dto.charge_type === 'EARLY_CHECKIN') {
          applicableNightlyRate = Number(ratesRes.rows[0].final_room_rate);
        } else if (dto.charge_type === 'LATE_CHECKOUT') {
          applicableNightlyRate = Number(ratesRes.rows[ratesRes.rowCount! - 1].final_room_rate);
        } else {
          const sum = ratesRes.rows.reduce((acc: number, r: any) => acc + Number(r.final_room_rate), 0);
          applicableNightlyRate = sum / ratesRes.rowCount!;
        }
      } else {
        applicableNightlyRate = Number(reservation.total_price || 0);
      }

      if (rule.charge_method === 'FULL_NIGHT') {
        ruleAuthoritativeAmount = applicableNightlyRate;
      } else {
        ruleAuthoritativeAmount = Math.round((applicableNightlyRate * Number(rule.percentage_rate || 0)) / 100);
      }
    }

    // 2. Controlled Price Override Check for non-MANUAL rules
    if (rule.charge_method !== 'MANUAL') {
      const requestedPrice = dto.override_amount !== undefined
        ? Number(dto.override_amount)
        : (dto.is_override && dto.unit_price !== undefined ? Number(dto.unit_price) : undefined);

      if (dto.is_override || (requestedPrice !== undefined && requestedPrice !== ruleAuthoritativeAmount)) {
        const reasonStr = String(dto.override_reason || '').trim();
        if (!reasonStr) {
          const err: any = new Error('Alasan override harga wajib diisi');
          err.statusCode = 400;
          throw err;
        }
        if (requestedPrice === undefined || requestedPrice < 0) {
          const err: any = new Error('Nominal override harga tidak valid');
          err.statusCode = 400;
          throw err;
        }
        isOverride = true;
        originalRuleAmount = ruleAuthoritativeAmount;
        overrideAmount = requestedPrice;
        overrideReason = reasonStr;
        overrideBy = dto.actor_name || dto.actor_user_id || 'Front Desk';
        overrideAt = new Date();
        baseUnitPrice = requestedPrice;
      } else {
        // Enforce authoritative rule amount strictly
        baseUnitPrice = ruleAuthoritativeAmount;
      }
    } else {
      // MANUAL rule requires valid nominal
      baseUnitPrice = ruleAuthoritativeAmount;
    }
  } else {
    // Manual charge without configured rule
    const inputUnitPrice = dto.unit_price ?? (dto as any).unit_price_override ?? (dto as any).amount;
    if (inputUnitPrice === undefined || inputUnitPrice === null || Number(inputUnitPrice) < 0) {
      const err: any = new Error('Nominal biaya wajib diisi dan tidak boleh negatif');
      err.statusCode = 400;
      throw err;
    }
    baseUnitPrice = Number(inputUnitPrice);
    if (!chargeDescription) {
      chargeDescription = getChargeTypeNameIndonesian(dto.charge_type);
    }
  }

  const noteText = dto.note || (dto as any).notes;
  if (noteText) {
    chargeDescription = `${chargeDescription} (${String(noteText).trim()})`;
  }

  const rawSubtotal = baseUnitPrice * qty;

  // Pricing settings for Tax & Service
  const pricingSettings = await getPropertyPricingSettings(client, propertyId);
  let taxAmount = 0;
  let serviceAmount = 0;

  if (taxable && Number(pricingSettings.tax_percent || 0) > 0) {
    taxAmount = Math.round((rawSubtotal * Number(pricingSettings.tax_percent)) / 100);
  }
  if (serviceChargeable && Number(pricingSettings.service_charge_percent || 0) > 0) {
    serviceAmount = Math.round((rawSubtotal * Number(pricingSettings.service_charge_percent)) / 100);
  }

  const totalAmount = rawSubtotal + taxAmount + serviceAmount;
  const revenueCategory = dto.charge_type === 'PENALTY' ? 'OTHER_INCOME' : 'ROOM_SALES';

  // Insert folio entry with snapshot and override metadata
  const folioRes = await client.query(
    `INSERT INTO folio_entries (
      reservation_id, property_id, entry_type, source_type, source_id,
      rule_id, rule_code_snapshot, rule_name_snapshot, calculation_method_snapshot,
      description, amount, direction, base_amount, unit_price, quantity,
      tax_amount, service_amount, status, notes,
      is_override, original_rule_amount, override_amount, override_reason, override_by, override_at,
      revenue_category,
      actor_user_id, actor_name_snapshot, actor_role_snapshot
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, 'DEBIT', $12, $13, $14,
      $15, $16, 'POSTED', $17,
      $18, $19, $20, $21, $22, $23,
      $24,
      $25, $26, $27
    ) RETURNING *`,
    [
      dto.reservation_id,
      propertyId,
      dto.charge_type,
      dto.charge_type,
      sourceId,
      dto.rule_id || null,
      ruleCodeSnapshot,
      ruleNameSnapshot,
      calcMethodSnapshot,
      chargeDescription,
      totalAmount,
      rawSubtotal,
      baseUnitPrice,
      qty,
      taxAmount,
      serviceAmount,
      noteText || null,
      isOverride,
      originalRuleAmount,
      overrideAmount,
      overrideReason,
      overrideBy,
      overrideAt,
      revenueCategory,
      dto.actor_user_id || null,
      dto.actor_name || 'Front Desk',
      dto.actor_role || 'STAFF'
    ]
  );

  const insertedEntry = folioRes.rows[0];

  // Project automatically and idempotently to canonical Transaction Domain
  try {
    await projectFolioEntryToTransaction(client, insertedEntry.id, {
      propertyId,
      actorName: dto.actor_name,
      actorUserId: dto.actor_user_id
    });
  } catch (err: any) {
    console.warn(`[StayCharges] Failed to project folio entry ${insertedEntry.id} to transaction:`, err.message);
  }

  // Atomically recalculate reservation financials
  const recalc = await recalculateReservationFinancials(client, dto.reservation_id, propertyId);

  const auditAction = `${dto.charge_type}_POSTED`;
  await logAudit(client, {
    property_id: propertyId,
    action: auditAction,
    entity_type: 'RESERVATION_FOLIO',
    entity_id: dto.reservation_id,
    after: {
      folio_entry: insertedEntry,
      reservation_financials: recalc
    },
    actor: dto.actor_name || 'Front Desk'
  });

  return {
    folio_entry_id: insertedEntry.id,
    reservation: recalc.reservation,
    folio_entry: insertedEntry
  };
}

export async function voidFolioEntry(
  client: PoolClient | Pool,
  propertyId: number,
  reservationId: number,
  folioEntryId: number,
  dto: VoidFolioEntryDto
): Promise<{ voided: boolean; reservation: any; folio_entry: any; reversal_entry: any }> {
  const reason = (dto.reason || '').trim();
  if (!reason) {
    const err: any = new Error('Alasan pembatalan biaya (void reason) wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  // 1. Lock target entry
  const entryRes = await client.query(
    'SELECT * FROM folio_entries WHERE id = $1 FOR UPDATE',
    [folioEntryId]
  );

  if ((entryRes.rowCount ?? 0) === 0) {
    const err: any = new Error(`Item folio #${folioEntryId} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }

  const entry = entryRes.rows[0];
  const targetReservationId = Number(entry.reservation_id);

  // 2. Property isolation and reservation validation
  if (entry.property_id && Number(entry.property_id) !== propertyId) {
    const err: any = new Error('Item folio tidak berada pada properti yang aktif');
    err.statusCode = 403;
    err.code = 'CROSS_PROPERTY_ACCESS';
    throw err;
  }
  if (reservationId && targetReservationId !== Number(reservationId)) {
    const err: any = new Error('ID reservasi tidak cocok dengan item folio');
    err.statusCode = 400;
    throw err;
  }

  // 3. Prevent duplicate void / reversal
  if (entry.is_voided || entry.status === 'VOIDED' || entry.status === 'REVERSED' || entry.status === 'CORRECTED') {
    const err: any = new Error(`Item folio #${folioEntryId} sudah dibatalkan atau dibalikkan sebelumnya`);
    err.statusCode = 409;
    err.code = 'ALREADY_VOIDED';
    throw err;
  }

  const existingRev = await client.query(
    'SELECT id FROM folio_entries WHERE reversal_of_entry_id = $1',
    [folioEntryId]
  );
  if ((existingRev.rowCount ?? 0) > 0) {
    const err: any = new Error(`Item folio #${folioEntryId} sudah memiliki entri pembalik (reversal)`);
    err.statusCode = 409;
    err.code = 'ALREADY_REVERSED';
    throw err;
  }

  // 4. Validate entry kind (cannot void payment or reversal rows directly through this endpoint)
  if (entry.entry_type === 'DEPOSIT_APPLY' || entry.source_type === 'DEPOSIT') {
    const err: any = new Error('Aplikasi deposit hanya dapat dibalik melalui lifecycle deposit canonical');
    err.statusCode = 400;
    err.code = 'DEPOSIT_APPLY_CANONICAL_OPERATION_REQUIRED';
    throw err;
  }
  if (entry.direction === 'CREDIT' && entry.entry_type === 'PAYMENT') {
    const err: any = new Error('Pembayaran harus dibatalkan melalui fitur pembatalan pembayaran');
    err.statusCode = 400;
    throw err;
  }
  if (entry.entry_type === 'REVERSAL' || entry.reversal_of_entry_id !== null) {
    const err: any = new Error('Transaksi pembalik (reversal) tidak dapat dibatalkan kembali');
    err.statusCode = 400;
    throw err;
  }

  const correlationId = `corr_rev_${entry.id}_${Date.now()}`;
  const reversalDirection = entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';

  // 5. Create Compensating Reversal Entry (exact tax & service snapshot)
  const reversalRes = await client.query(
    `INSERT INTO folio_entries (
      reservation_id, property_id, entry_type, source_type, source_id,
      description, amount, direction, base_amount, unit_price, quantity,
      tax_amount, service_amount, reversal_of_entry_id, correction_group_id,
      status, notes, actor_user_id, actor_name_snapshot, actor_role_snapshot
    ) VALUES (
      $1, $2, 'REVERSAL', $3, $4,
      $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14,
      'REVERSED', $15, $16, $17, $18
    ) RETURNING *`,
    [
      targetReservationId,
      propertyId,
      entry.source_type || entry.entry_type,
      entry.source_id,
      `Pembatalan: ${entry.description}`,
      entry.amount,
      reversalDirection,
      entry.base_amount || (Number(entry.unit_price || 0) * Number(entry.quantity || 1)),
      entry.unit_price || 0,
      entry.quantity || 1,
      entry.tax_amount || 0,
      entry.service_amount || 0,
      entry.id,
      correlationId,
      reason,
      dto.actor_user_id || null,
      dto.actor_name || 'Supervisor',
      dto.actor_role || 'SUPERVISOR'
    ]
  );

  const reversalEntry = reversalRes.rows[0];

  // Project reversal entry to canonical Transaction Domain
  try {
    await projectFolioEntryToTransaction(client, reversalEntry.id, {
      propertyId,
      actorName: dto.actor_name,
      actorUserId: dto.actor_user_id
    });
  } catch (err: any) {
    console.warn(`[StayCharges] Failed to project reversal folio entry ${reversalEntry.id} to transaction:`, err.message);
  }

  // 6. Update Original Target Entry metadata
  const voidedRes = await client.query(
    `UPDATE folio_entries SET
      is_voided = TRUE,
      status = 'VOIDED',
      void_reason = $1,
      voided_at = CURRENT_TIMESTAMP,
      voided_by = $2
     WHERE id = $3
     RETURNING *`,
    [reason, dto.actor_name || 'Supervisor', folioEntryId]
  );

  // 7. Centralized recalculation
  const recalc = await recalculateReservationFinancials(client, targetReservationId, propertyId);

  // 8. Audit trail
  await logAudit(client, {
    property_id: propertyId,
    action: 'FOLIO_ENTRY_VOIDED',
    entity_type: 'RESERVATION_FOLIO',
    entity_id: targetReservationId,
    before: entry,
    after: {
      original_entry: voidedRes.rows[0],
      reversal_entry: reversalEntry,
      reservation_financials: recalc
    },
    actor: dto.actor_name || 'Supervisor'
  });

  return {
    voided: true,
    reservation: recalc.reservation,
    folio_entry: voidedRes.rows[0],
    reversal_entry: reversalEntry
  };
}

export async function correctFolioEntry(
  client: PoolClient | Pool,
  propertyId: number,
  reservationId: number,
  folioEntryId: number,
  dto: CorrectFolioEntryDto
): Promise<{
  corrected: boolean;
  reservation: any;
  original_entry: any;
  reversal_entry: any;
  replacement_entry: any;
}> {
  const reason = (dto.reason || '').trim();
  if (!reason) {
    const err: any = new Error('Alasan koreksi (correction reason) wajib diisi');
    err.statusCode = 400;
    throw err;
  }

  // 1. Lock target entry
  const entryRes = await client.query(
    'SELECT * FROM folio_entries WHERE id = $1 FOR UPDATE',
    [folioEntryId]
  );

  if ((entryRes.rowCount ?? 0) === 0) {
    const err: any = new Error(`Item folio #${folioEntryId} tidak ditemukan`);
    err.statusCode = 404;
    throw err;
  }

  const entry = entryRes.rows[0];
  const targetReservationId = Number(entry.reservation_id);

  // 2. Validation
  if (entry.property_id && Number(entry.property_id) !== propertyId) {
    const err: any = new Error('Item folio tidak berada pada properti yang aktif');
    err.statusCode = 403;
    err.code = 'CROSS_PROPERTY_ACCESS';
    throw err;
  }
  if (reservationId && targetReservationId !== Number(reservationId)) {
    const err: any = new Error('ID reservasi tidak cocok dengan item folio');
    err.statusCode = 400;
    throw err;
  }
  if (entry.is_voided || entry.status === 'VOIDED' || entry.status === 'REVERSED' || entry.status === 'CORRECTED') {
    const err: any = new Error(`Item folio #${folioEntryId} sudah dibatalkan atau dikoreksi sebelumnya`);
    err.statusCode = 409;
    err.code = 'ALREADY_MODIFIED';
    throw err;
  }
  if (entry.entry_type === 'DEPOSIT_APPLY' || entry.source_type === 'DEPOSIT') {
    const err: any = new Error('Aplikasi deposit hanya dapat dikoreksi melalui lifecycle deposit canonical');
    err.statusCode = 400;
    err.code = 'DEPOSIT_APPLY_CANONICAL_OPERATION_REQUIRED';
    throw err;
  }
  if (entry.direction === 'CREDIT' && entry.entry_type === 'PAYMENT') {
    const err: any = new Error('Pembayaran harus dikoreksi melalui fitur koreksi pembayaran');
    err.statusCode = 400;
    throw err;
  }
  if (entry.entry_type === 'REVERSAL' || entry.reversal_of_entry_id !== null) {
    const err: any = new Error('Transaksi pembalik (reversal) tidak dapat dikoreksi');
    err.statusCode = 400;
    throw err;
  }

  const correctionGroupId = `corr_grp_${entry.id}_${Date.now()}`;

  // 3. Step 1: Reversal Entry (Credit offset)
  const reversalRes = await client.query(
    `INSERT INTO folio_entries (
      reservation_id, property_id, entry_type, source_type, source_id,
      description, amount, direction, base_amount, unit_price, quantity,
      tax_amount, service_amount, reversal_of_entry_id, correction_group_id,
      status, notes, actor_user_id, actor_name_snapshot, actor_role_snapshot
    ) VALUES (
      $1, $2, 'REVERSAL', $3, $4,
      $5, $6, 'CREDIT', $7, $8, $9,
      $10, $11, $12, $13,
      'REVERSED', $14, $15, $16, $17
    ) RETURNING *`,
    [
      targetReservationId,
      propertyId,
      entry.source_type || entry.entry_type,
      entry.source_id,
      `Pembalik Koreksi: ${entry.description}`,
      entry.amount,
      entry.base_amount || (Number(entry.unit_price || 0) * Number(entry.quantity || 1)),
      entry.unit_price || 0,
      entry.quantity || 1,
      entry.tax_amount || 0,
      entry.service_amount || 0,
      entry.id,
      correctionGroupId,
      reason,
      dto.actor_user_id || null,
      dto.actor_name || 'Supervisor',
      dto.actor_role || 'SUPERVISOR'
    ]
  );

  // 4. Step 2: Compute Replacement values
  const newChargeType = (dto.charge_type || entry.source_type || entry.entry_type) as StayChargeType;
  const newUnitPrice = dto.unit_price !== undefined ? Number(dto.unit_price) : Number(entry.unit_price || 0);
  const newQty = Number(dto.quantity || entry.quantity || 1);

  if (newUnitPrice < 0) {
    const err: any = new Error('Nominal unit price baru tidak boleh negatif');
    err.statusCode = 400;
    throw err;
  }
  if (newQty <= 0) {
    const err: any = new Error('Kuantitas baru harus lebih besar dari 0');
    err.statusCode = 400;
    throw err;
  }

  const newSubtotal = newUnitPrice * newQty;
  const pricingSettings = await getPropertyPricingSettings(client, propertyId);

  const isTaxable = dto.taxable !== undefined ? dto.taxable : Number(entry.tax_amount || 0) > 0;
  const isServiceChargeable = dto.service_chargeable !== undefined ? dto.service_chargeable : Number(entry.service_amount || 0) > 0;

  let newTaxAmount = 0;
  let newServiceAmount = 0;
  if (isTaxable && Number(pricingSettings.tax_percent || 0) > 0) {
    newTaxAmount = Math.round((newSubtotal * Number(pricingSettings.tax_percent)) / 100);
  }
  if (isServiceChargeable && Number(pricingSettings.service_charge_percent || 0) > 0) {
    newServiceAmount = Math.round((newSubtotal * Number(pricingSettings.service_charge_percent)) / 100);
  }

  const newTotalAmount = newSubtotal + newTaxAmount + newServiceAmount;
  const newDescription = dto.custom_description || `Koreksi: ${entry.description}`;

  // 5. Step 3: Insert Replacement Entry (Debit)
  const replacementRes = await client.query(
    `INSERT INTO folio_entries (
      reservation_id, property_id, entry_type, source_type, source_id,
      description, amount, direction, base_amount, unit_price, quantity,
      tax_amount, service_amount, reversal_of_entry_id, correction_group_id,
      status, notes, actor_user_id, actor_name_snapshot, actor_role_snapshot
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, 'DEBIT', $8, $9, $10,
      $11, $12, $13, $14,
      'POSTED', $15, $16, $17, $18
    ) RETURNING *`,
    [
      targetReservationId,
      propertyId,
      newChargeType,
      newChargeType,
      dto.rule_id ? String(dto.rule_id) : entry.source_id,
      newDescription,
      newTotalAmount,
      newSubtotal,
      newUnitPrice,
      newQty,
      newTaxAmount,
      newServiceAmount,
      entry.id,
      correctionGroupId,
      dto.note || reason,
      dto.actor_user_id || null,
      dto.actor_name || 'Supervisor',
      dto.actor_role || 'SUPERVISOR'
    ]
  );

  // 6. Step 4: Mark Original Target Entry as CORRECTED
  const originalUpdatedRes = await client.query(
    `UPDATE folio_entries SET
      is_voided = TRUE,
      status = 'CORRECTED',
      void_reason = $1,
      voided_at = CURRENT_TIMESTAMP,
      voided_by = $2
     WHERE id = $3
     RETURNING *`,
    [reason, dto.actor_name || 'Supervisor', folioEntryId]
  );

  // 7. Step 5: Atomically recalculate reservation financials
  const recalc = await recalculateReservationFinancials(client, targetReservationId, propertyId);

  // 8. Step 6: Log audit
  await logAudit(client, {
    property_id: propertyId,
    action: 'FOLIO_ENTRY_CORRECTED',
    entity_type: 'RESERVATION_FOLIO',
    entity_id: targetReservationId,
    before: entry,
    after: {
      original_entry: originalUpdatedRes.rows[0],
      reversal_entry: reversalRes.rows[0],
      replacement_entry: replacementRes.rows[0],
      reservation_financials: recalc
    },
    actor: dto.actor_name || 'Supervisor'
  });

  return {
    corrected: true,
    reservation: recalc.reservation,
    original_entry: originalUpdatedRes.rows[0],
    reversal_entry: reversalRes.rows[0],
    replacement_entry: replacementRes.rows[0]
  };
}

// ============================================================================
// HELPER MAPPERS
// ============================================================================

function mapRowToStayChargeRule(row: any): StayChargeRule {
  return {
    id: Number(row.id),
    property_id: Number(row.property_id),
    charge_type: row.charge_type as StayChargeType,
    code: String(row.code),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    charge_method: row.charge_method,
    default_amount: Number(row.default_amount || 0),
    percentage_rate: Number(row.percentage_rate || 0),
    cutoff_time: row.cutoff_time ? String(row.cutoff_time) : null,
    taxable: Boolean(row.taxable),
    service_chargeable: Boolean(row.service_chargeable),
    requires_note: Boolean(row.requires_note),
    requires_photo: Boolean(row.requires_photo),
    requires_supervisor_approval: Boolean(row.requires_supervisor_approval),
    approval_threshold: Number(row.approval_threshold || 0),
    is_active: Boolean(row.is_active),
    is_archived: Boolean(row.is_archived),
    sort_order: Number(row.sort_order || 0),
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: new Date(row.created_at).toISOString(),
    updated_by: row.updated_by ? String(row.updated_by) : null,
    updated_at: new Date(row.updated_at).toISOString()
  };
}

function getChargeTypeNameIndonesian(type: StayChargeType): string {
  switch (type) {
    case 'EXTRA_BED': return 'Extra Bed';
    case 'EXTRA_PERSON': return 'Extra Person';
    case 'EARLY_CHECKIN': return 'Early Check-in';
    case 'LATE_CHECKOUT': return 'Late Check-out';
    case 'PENALTY': return 'Denda / Penalty';
    default: return type;
  }
}
