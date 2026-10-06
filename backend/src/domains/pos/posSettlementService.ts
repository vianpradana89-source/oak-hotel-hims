/**
 * POS PAYMENT SETTLEMENT — Tahap 2: Service Settlement Pembayaran Langsung CASH
 *
 * Kontrak (lihat handoff):
 * - Input: propertyId, orderId, Idempotency-Key, metode CASH, identitas aktor.
 * - Nominal berasal dari order tersimpan (total_amount), BUKAN input klien.
 * - Fingerprint deterministik: property_id + pos_order_id + payment_method.
 *   TIDAK memasukkan waktu atau identitas aktor (payload retry).
 * - Lock order FOR UPDATE, validasi properti order.
 * - Settlement existing dicari SEBELUM penolakan status:
 *     key sama  + fingerprint sama  → replay settlement existing (tanpa efek)
 *     key sama  + fingerprint beda  → 409 IDEMPOTENCY_CONFLICT
 *     key beda  + order sudah settled → 409 ALREADY_PAID
 * - Order baru dibayar hanya bila status OPEN dan nominal positif.
 *   Status terminal lainnya ditolak.
 *
 * Dalam transaksi yang sama:
 *   1. UPDATE order → PAID
 *   2. projectPosOrderToTransaction(client, orderId, {...}) memakai client
 *   3. Validasi hasil SALE (helper assertPosSaleProjection):
 *      SALE benar (id, property, source POS_ORDER/order, PAID, CASH)
 *   4. INSERT pos_settlements (ID SALE, nominal order tersimpan)
 *   5. Audit logs (pola existing)
 *   6. COMMIT
 *
 * Replay (key sama + fingerprint sama):
 *   - TIDAK menulis settlement/audit/SALE baru.
 *   - Memvalidasi settlement existing (CASH, SUCCESS) & SALE yang di-merujuk
 *     (helper assertPosSaleProjection) SEBELUM mengembalikan hasil.
 *
 * TIDAK menulis payment_transactions, payment_evidences, folio_entries,
 * tidak mengubah saldo/status pembayaran reservasi, tidak membuat
 * transaksi PAYMENT atau revenue kedua.
 *
 * Lapisan ini BUKAN authorization: endpoint berikutnya wajib
 * auth/permission/property scope SEBELUM memanggil service ini.
 *
 * ── Protokol transaksi & kepemilikan client ────────────────────────────────
 * - Service ini MELAKUKAN `BEGIN` / `COMMIT` / `ROLLBACK` di dalam dirinya.
 * - Caller WAJIB menyiapkan PoolClient yang BELUM berada dalam transaksi
 *   (fresh client), dan WAJIB me-release client di `finally`.
 * - Service TIDAK me-release client.
 */

import { PoolClient } from 'pg';
import { projectPosOrderToTransaction } from '../transactions/transactionService';
import type { TransactionRow } from '../transactions/transactionTypes';
import { computeRequestHash } from '../../utils/hash';

// =============================================================================
// Error type
// =============================================================================

export class PosSettlementError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'PosSettlementError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Identifikasi error PostgreSQL unique-violation secara spesifik.
 * Hanya dianggap ALREADY_PAID bila constraint eksak uq_pos_settlements_order
 * (UNIQUE pos_order_id) yang dilanggar — bukan sembarang 23505.
 */
function isPosOrderUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code !== '23505') return false;
  // Guard: hanya tampilkan ke 409 bila constraint yang melarang satu
  // settlement per order. Constraint lain (idempotency, PK) → biarkan
  // menjadi 500 agar masalah tak disamarkan.
  return e.constraint === 'uq_pos_settlements_order';
}

// =============================================================================
// Input & output
// =============================================================================

export interface PayPosOrderCashInput {
  propertyId: number;
  orderId: number;
  /** Idempotency-Key pembayaran (VARCHAR 150). */
  idempotencyKey: string;
  /** Aktor (opsional untuk transaksi created_by & audit). */
  actorName?: string;
  actorUserId?: string;
  /** Klien (opsional, untuk audit korrelasi). */
  correlationId?: string;
}

export interface PayPosOrderCashResult {
  /** settlement terdeterminasi dari DB. */
  settlement: {
    id: number;
    property_id: number;
    pos_order_id: number;
    transaction_id: string; // BIGINT → string (pg)
    amount: string;
    payment_method: string;
    status: string;
    idempotency_key: string;
    request_fingerprint: string;
    created_by: string | null;
  };
  /** true bila jalur ini yang membuat settlement (bukan replay). */
  created: boolean;
  /** true bila jalur replay (key & fingerprint sama, settlement sudah ada). */
  replayed: boolean;
  /** SALE transaction terproyeksi (id, transaction_no, payment_status, method). */
  sale: {
    id: string;
    transaction_no: string;
    payment_status: string;
    payment_method: string;
    source_type: string;
    source_id: string | null;
  };
}

// Baris SALE minimal yang diambil dari DB (bukan dari projection objek)
// agar helper validasi bekerja pada field yang benar-benar dibaca.
interface SaleRecordRow {
  id: string; // BIGINT → string; TIDAK dikonversi ke Number
  property_id: number | string;
  transaction_no: string;
  transaction_type: string;
  source_type: string;
  source_id: string | null;
  payment_status: string;
  payment_method: string | null;
}

// =============================================================================
// Fingerprint deterministik — TANPA waktu & identitas aktor
// =============================================================================

/**
 * Fingerprint untuk dedup pembayaran: identik untuk properti+order+metode
 * yang sama (sehingga retry key-sama menghasilkan fingerprint-sama → replay),
 * berbeda bila metode berbeda. Tidak mengandung waktu / identitas aktor.
 */
export function computeCashSettlementFingerprint(
  propertyId: number,
  orderId: number,
  paymentMethod: string
): string {
  const payload = {
    property_id: propertyId,
    pos_order_id: orderId,
    payment_method: paymentMethod,
  };
  // computeRequestHash(method, path, body) → SHA-256. Body deterministik.
  return computeRequestHash('POST', '/api/pos/orders/pay/cash', payload);
}

// =============================================================================
// Helper validasi SALE (dipakai jalur pembayaran baru DAN replay)
// =============================================================================

/**
 * Baca satu baris SALE dari tabel `transactions` dan validasi seluruh
 * invariant payment CASH:
 *   - id SALE valid (non-kosong; BIGINT sebagai string, TIDAK ke Number)
 *   - property_id === propertyId input
 *   - transaction_type tepat 'SALE'
 *   - source_type tepat 'POS_ORDER'
 *   - source_id tepat String(orderId)
 *   - payment_status tepat 'PAID'
 *   - payment_method tepat 'CASH'
 *
 * @param expectedSaleId bila di-set (jalur replay), id baris harus sama
 *                       dengan `existing.transaction_id`.
 * @throws {PosSettlementError} 5xx bila ada invariant yang dilanggar.
 */
export async function assertPosSaleProjection(
  poolClient: PoolClient,
  saleId: string,
  propertyId: number,
  orderId: number,
  expectedSaleId?: string
): Promise<SaleRecordRow> {
  const q = await poolClient.query(
    `SELECT id, property_id, transaction_no, transaction_type,
            source_type, source_id, payment_status, payment_method
     FROM transactions
     WHERE id = $1
     LIMIT 1`,
    [saleId]
  );
  if ((q.rowCount ?? 0) === 0 || !q.rows[0]) {
    throw new PosSettlementError(
      500,
      'SALE_NOT_FOUND',
      `SALE #${saleId} tidak ditemukan di transactions`
    );
  }
  const row = q.rows[0] as SaleRecordRow;

  // id SALE valid: non-kosong & tetap string (BIGINT), tanpa konversi Number
  if (typeof row.id !== 'string' || row.id.trim() === '') {
    throw new PosSettlementError(
      500,
      'SALE_ID_INVALID',
      'id SALE kosong/tak valid'
    );
  }
  // Replay: id SALE harus cocok existing.transaction_id
  if (expectedSaleId !== undefined && row.id !== expectedSaleId) {
    throw new PosSettlementError(
      500,
      'SALE_ID_MISMATCH',
      `id SALE ${row.id} tidak cocok dengan settlement.transaction_id ${expectedSaleId}`
    );
  }
  if (Number(row.property_id) !== propertyId) {
    throw new PosSettlementError(
      500,
      'SALE_PROPERTY_MISMATCH',
      `property_id SALE ${row.property_id} != ${propertyId}`
    );
  }
  if (String(row.transaction_type || '') !== 'SALE') {
    throw new PosSettlementError(
      500,
      'SALE_TYPE_INVALID',
      `transaction_type SALE=${row.transaction_type} (ekspektasi SALE)`
    );
  }
  if (String(row.source_type || '') !== 'POS_ORDER') {
    throw new PosSettlementError(
      500,
      'SALE_SOURCE_TYPE_INVALID',
      `source_type SALE=${row.source_type} (ekspektasi POS_ORDER)`
    );
  }
  if (String(row.source_id ?? '') !== String(orderId)) {
    throw new PosSettlementError(
      500,
      'SALE_SOURCE_MISMATCH',
      `source_id SALE=${row.source_id} != order #${orderId}`
    );
  }
  if (String(row.payment_status || '') !== 'PAID') {
    throw new PosSettlementError(
      500,
      'SALE_PAYMENT_STATUS_INVALID',
      `payment_status SALE=${row.payment_status} (ekspektasi PAID)`
    );
  }
  if (String(row.payment_method || '') !== 'CASH') {
    throw new PosSettlementError(
      500,
      'SALE_PAYMENT_METHOD_INVALID',
      `payment_method SALE=${row.payment_method} (ekspektasi CASH)`
    );
  }
  return row;
}

// =============================================================================
// Service utama
// =============================================================================

/**
 * Bayarkan order POS dengan metode CASH (settlement).
 *
 * Protokol: service melakukan BEGIN/COMMIT/ROLLBACK. Caller menyediakan
 * PoolClient yang BELUM dalam transaksi dan WAJIB me-release di finally.
 * Service tidak me-release client.
 *
 * @throws {PosSettlementError} 4xx/5xx dengan code terstruktur.
 */
export async function payPosOrderCash(
  poolClient: PoolClient,
  input: PayPosOrderCashInput
): Promise<PayPosOrderCashResult> {
  // ── Validasi input ─────────────────────────��──────────────────────────
  const propertyId = Number(input.propertyId);
  const orderId = Number(input.orderId);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PosSettlementError(
      400,
      'VALIDATION_ERROR',
      'property_id wajib integer positif'
    );
  }
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new PosSettlementError(
      400,
      'VALIDATION_ERROR',
      'order_id wajib integer positif'
    );
  }
  const key = (input.idempotencyKey ?? '').trim();
  // Skema: idempotency_key VARCHAR(150) NOT NULL
  if (key.length === 0 || key.length > 150) {
    throw new PosSettlementError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key wajib tidak kosong dan maks 150 karakter'
    );
  }
  const paymentMethod = 'CASH'; // metode tunggal untuk tahap ini

  const fingerprint = computeCashSettlementFingerprint(
    propertyId,
    orderId,
    paymentMethod
  );
  // request_fingerprint VARCHAR(128); SHA-256 hex = 64 char → aman.

  // ── Satu transaksi eksplisit ─────────────────────────────────────────
  await poolClient.query('BEGIN');
  try {
    // Lock order FOR UPDATE untuk serialisasi concurrency.
    const lockRes = await poolClient.query(
      `SELECT id, property_id, status, total_amount
       FROM pos_orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    );
    const orderRow = lockRes.rows[0];
    if ((lockRes.rowCount ?? 0) === 0 || !orderRow) {
      throw new PosSettlementError(
        404,
        'ORDER_NOT_FOUND',
        `POS order #${orderId} tidak ditemukan`
      );
    }

    // Validasi properti order (scope)
    const orderPropertyId = Number(orderRow.property_id);
    if (orderPropertyId !== propertyId) {
      throw new PosSettlementError(
        403,
        'CROSS_PROPERTY_ORDER',
        `POS order #${orderId} bukan milik properti #${propertyId}`
      );
    }

    const orderStatus = String(orderRow.status || '').toUpperCase();
    const orderAmount = Number(orderRow.total_amount || 0);

    // ── Cari settlement EXISTING SEBELUM penolakan status ─────────────
    // (a) key sama + fingerprint sama → REPLAY
    const replayQ = await poolClient.query(
      `SELECT id, property_id, pos_order_id, transaction_id,
              amount, payment_method, status,
              idempotency_key, request_fingerprint, created_by
       FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2 AND idempotency_key = $3
       LIMIT 1`,
      [propertyId, orderId, key]
    );
    if ((replayQ.rowCount ?? 0) > 0 && replayQ.rows[0]) {
      const existing = replayQ.rows[0];
      const fpMatch =
        String(existing.request_fingerprint || '') === fingerprint;
      if (fpMatch) {
        // Replay: validasi settlement existing tetap CASH & SUCCESS.
        if (String(existing.payment_method || '') !== 'CASH') {
          throw new PosSettlementError(
            500,
            'SETTLEMENT_METHOD_INVALID',
            `Settlement #${existing.id} payment_method=${existing.payment_method} (ekspektasi CASH)`
          );
        }
        if (String(existing.status || '') !== 'SUCCESS') {
          throw new PosSettlementError(
            500,
            'SETTLEMENT_STATUS_INVALID',
            `Settlement #${existing.id} status=${existing.status} (ekspektasi SUCCESS)`
          );
        }

        // Validasi SALE yang di-merujuk; id SALE harus cocok transaction_id.
        const expectedSaleId = String(existing.transaction_id);
        const saleRow = await assertPosSaleProjection(
          poolClient,
          expectedSaleId,
          propertyId,
          orderId,
          expectedSaleId
        );

        // Tidak menulis settlement/audit/SALE baru.
        await poolClient.query('COMMIT');
        return {
          settlement: {
            id: Number(existing.id),
            property_id: Number(existing.property_id),
            pos_order_id: Number(existing.pos_order_id),
            transaction_id: expectedSaleId,
            amount: String(existing.amount),
            payment_method: String(existing.payment_method),
            status: String(existing.status),
            idempotency_key: String(existing.idempotency_key),
            request_fingerprint: String(existing.request_fingerprint),
            created_by: existing.created_by == null ? null : String(existing.created_by),
          },
          created: false,
          replayed: true,
          sale: {
            id: saleRow.id,
            transaction_no: saleRow.transaction_no,
            payment_status: saleRow.payment_status,
            payment_method: saleRow.payment_method == null ? '' : saleRow.payment_method,
            source_type: saleRow.source_type,
            source_id: saleRow.source_id,
          },
        };
      }
      // (b) key sama + fingerprint berbeda → 409 IDEMPOTENCY_CONFLICT
      throw new PosSettlementError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Idempotency-Key sudah digunakan untuk payload pembayaran yang berbeda'
      );
    }

    // (c) Cek order sudah settled dengan KEY BERBEDA (uq_pos_settlements_order
    // hanya mengizinkan satu settlement per order) → 409 ALREADY_PAID.
    const settledQ = await poolClient.query(
      `SELECT 1 FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2
       LIMIT 1`,
      [propertyId, orderId]
    );
    if ((settledQ.rowCount ?? 0) > 0) {
      throw new PosSettlementError(
        409,
        'ALREADY_PAID',
        `POS order #${orderId} sudah memiliki settlement pembayaran`
      );
    }

    // ── Order harus dapat dibayar: status OPEN & nominal positif ────────
    if (orderStatus !== 'OPEN') {
      throw new PosSettlementError(
        409,
        'ORDER_NOT_PAYABLE',
        `POS order #${orderId} berstatus ${orderStatus || 'UNKNOWN'}; hanya status OPEN yang dapat dibayar`
      );
    }
    if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
      throw new PosSettlementError(
        422,
        'INVALID_ORDER_AMOUNT',
        `POS order #${orderId} memiliki nominal tidak valid (${orderAmount})`
      );
    }

    // 1) UPDATE order → PAID
    await poolClient.query(
      `UPDATE pos_orders
       SET status = 'PAID', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [orderId]
    );

    // 2) Proyeksi SALE memakai client transaksi yang sama
    const sale: TransactionRow | null = await projectPosOrderToTransaction(
      poolClient,
      orderId,
      { propertyId, actorName: input.actorName, actorUserId: input.actorUserId }
    );

    if (!sale) {
      // Seharusnya tidak terjadi (status kini PAID & nominal positif),
      // tetapi tetap defensif.
      throw new PosSettlementError(
        500,
        'SALE_PROJECTION_FAILED',
        'Proyeksi SALE dari order POS gagal (null) — kondisi internal'
      );
    }

    // 3) Validasi hasil SALE dari DB (field benar-benar terbaca)
    const saleRow = await assertPosSaleProjection(
      poolClient,
      String(sale.id),
      propertyId,
      orderId
    );

    // 4) INSERT settlement (tanpa ON CONFLICT; constraint DB menangkis race)
    const amountForSettlement = String(orderAmount);
    let insRow: {
      id: string; property_id: string | number; pos_order_id: string | number;
      transaction_id: string | number; amount: string; payment_method: string;
      status: string; idempotency_key: string; request_fingerprint: string;
      created_by: string | null;
    };
    try {
      const insQ = await poolClient.query(
        `INSERT INTO pos_settlements (
           property_id, pos_order_id, transaction_id, amount,
           payment_method, status, idempotency_key, request_fingerprint,
           created_by
         ) VALUES (
           $1, $2, $3, $4,
           'CASH', 'SUCCESS', $5, $6,
           $7
         )
         RETURNING id, property_id, pos_order_id, transaction_id,
                   amount, payment_method, status,
                   idempotency_key, request_fingerprint, created_by`,
        [
          propertyId,
          orderId,
          saleRow.id,
          amountForSettlement,
          key,
          fingerprint,
          input.actorName || input.actorUserId || null,
        ]
      );
      insRow = insQ.rows[0];
      if (!insRow) {
        throw new PosSettlementError(
          500,
          'SETTLEMENT_INSERT_FAILED',
          'INSERT pos_settlements tidak mengembalikan baris'
        );
      }
    } catch (insErr) {
      // Hanya unique-violation pada uq_pos_settlements_order (satu
      // settlement per order) yang dipetakan ke 409 ALREADY_PAID.
      // 23505 lain (idempotency, PK) → biarkan 5xx, jangan disamarkan.
      if (isPosOrderUniqueViolation(insErr)) {
        const already: PosSettlementError = new PosSettlementError(
          409,
          'ALREADY_PAID',
          `POS order #${orderId} sudah memiliki settlement pembayaran`
        );
        already.cause = insErr;
        throw already;
      }
      throw insErr;
    }

    // 5) Audit (pola existing: INSERT audit_logs)
    await poolClient.query(
      `INSERT INTO audit_logs (
         module, action, entity, record_id, new_value,
         property_id, actor_user_id, correlation_id
       ) VALUES (
         'POS', 'SETTLEMENT_CASH', 'pos_settlements', $1, $2,
         $3, $4, $5
       )`,
      [
        String(insRow.id),
        JSON.stringify({
          property_id: propertyId,
          pos_order_id: orderId,
          transaction_id: saleRow.id,
          amount: amountForSettlement,
          payment_method: 'CASH',
          status: 'SUCCESS',
          idempotency_key: key,
          request_fingerprint: fingerprint,
          created_by: input.actorName || input.actorUserId || null,
        }),
        propertyId,
        input.actorUserId || null,
        input.correlationId || null,
      ]
    );

    // 6) COMMIT
    await poolClient.query('COMMIT');

    return {
      settlement: {
        id: Number(insRow.id),
        property_id: Number(insRow.property_id),
        pos_order_id: Number(insRow.pos_order_id),
        transaction_id: String(insRow.transaction_id),
        amount: String(insRow.amount),
        payment_method: String(insRow.payment_method),
        status: String(insRow.status),
        idempotency_key: String(insRow.idempotency_key),
        request_fingerprint: String(insRow.request_fingerprint),
        created_by: insRow.created_by == null ? null : String(insRow.created_by),
      },
      created: true,
      replayed: false,
      sale: {
        id: saleRow.id,
        transaction_no: saleRow.transaction_no,
        payment_status: saleRow.payment_status,
        payment_method: saleRow.payment_method == null ? '' : saleRow.payment_method,
        source_type: saleRow.source_type,
        source_id: saleRow.source_id,
      },
    };
  } catch (err) {
    // ROLLBACK transaksi. Kegagalan ROLLBACK TIDAK BOLEH menutupi error awal:
    // tampilkan error rollback ke log, lalu re-throw error pertama.
    try {
      await poolClient.query('ROLLBACK');
    } catch (rollbackErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[posSettlement] ROLLBACK gagal setelah error utama: ' +
        String((rollbackErr as Error)?.message ?? rollbackErr)
      );
    }
    throw err;
  }
}

export default payPosOrderCash;
