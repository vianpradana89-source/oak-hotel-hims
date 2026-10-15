/**
 * POS PAYMENT SETTLEMENT â€” Tahap 2: Service Settlement Pembayaran Langsung CASH
 *
 * Kontrak (lihat handoff):
 * - Input: propertyId, orderId, Idempotency-Key, metode CASH, identitas aktor.
 * - Nominal berasal dari order tersimpan (total_amount), BUKAN input klien.
 * - Fingerprint deterministik: property_id + pos_order_id + payment_method.
 *   TIDAK memasukkan waktu atau identitas aktor (payload retry).
 * - Lock order FOR UPDATE, validasi properti order.
 * - Settlement existing dicari SEBELUM penolakan status:
 *     key sama  + fingerprint sama  â†’ replay settlement existing (tanpa efek)
 *     key sama  + fingerprint beda  â†’ 409 IDEMPOTENCY_CONFLICT
 *     key beda  + order sudah settled â†’ 409 ALREADY_PAID
 * - Order baru dibayar hanya bila status OPEN dan nominal positif.
 *   Status terminal lainnya ditolak.
 *
 * Dalam transaksi yang sama:
 *   1. UPDATE order â†’ PAID
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
 * â”€â”€ Protokol transaksi & kepemilikan client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * - Service ini MELAKUKAN `BEGIN` / `COMMIT` / `ROLLBACK` di dalam dirinya.
 * - Caller WAJIB menyiapkan PoolClient yang BELUM berada dalam transaksi
 *   (fresh client), dan WAJIB me-release client di `finally`.
 * - Service TIDAK me-release client.
 */

import { PoolClient } from 'pg';
import { projectPosOrderToTransaction } from '../transactions/transactionService';
import type { TransactionRow } from '../transactions/transactionTypes';
import { computeRequestHash } from '../../utils/hash';
import { propertyQrisImageExists } from '../propertyPaymentInstructions/qrisImageStorage';

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
 * (UNIQUE pos_order_id) yang dilanggar â€” bukan sembarang 23505.
 */
function isPosOrderUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code !== '23505') return false;
  // Guard: hanya tampilkan ke 409 bila constraint yang melarang satu
  // settlement per order. Constraint lain (idempotency, PK) â†’ biarkan
  // menjadi 500 agar masalah tak disamarkan.
  return e.constraint === 'uq_pos_settlements_order';
}

// =============================================================================
// Input & output
// =============================================================================

/** Payment methods supported by POS settlement. */
export const POS_SUPPORTED_METHODS = ['CASH', 'QRIS', 'TRANSFER', 'DEBIT'] as const;
export type PosPaymentMethod = (typeof POS_SUPPORTED_METHODS)[number];

/**
 * Method-specific input for non-CASH payment verification.
 *
 * - QRIS:       payment_reference = VA/terminal reference (optional), verified_by from auth
 * - TRANSFER:   payment_reference = transfer reference number (optional), verified_by from auth
 * - DEBIT:      payment_reference = EDC slip number (optional), verified_by from auth
 *
 * `verified_by` comes from the authenticated user context, NOT from the
 * request body. This prevents a client from impersonating another actor.
 */
export interface PosMethodSpecificInput {
  /** Amount tendered (CASH only; must be >= order total). */
  cashReceived?: number | string | null;
  /** Reference code (QRIS VA / transfer ref / EDC slip). Optional. */
  paymentReference?: string | null;
}

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

/** Generalized multi-method payment input. */
export interface PayPosOrderInput extends PayPosOrderCashInput {
  /** Payment method: CASH | QRIS | TRANSFER | DEBIT. */
  paymentMethod?: string;
  /** Method-specific fields (cash_received for CASH, reference for non-CASH). */
  methodInput?: PosMethodSpecificInput;
}

export interface PayPosOrderCashResult {
  /** settlement terdeterminasi dari DB. */
  settlement: {
    id: number;
    property_id: number;
    pos_order_id: number;
    transaction_id: string; // BIGINT â†’ string (pg)
    amount: string;
    payment_method: string;
    status: string;
    idempotency_key: string;
    request_fingerprint: string;
    created_by: string | null;
    /** Method-specific metadata. */
    cash_received: string | null;
    change_due: string | null;
    payment_reference: string | null;
    verified_by: string | null;
    verified_at: string | null;
    created_at: string | null;
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
  id: string; // BIGINT â†’ string; TIDAK dikonversi ke Number
  property_id: number | string;
  transaction_no: string;
  transaction_type: string;
  source_type: string;
  source_id: string | null;
  payment_status: string;
  payment_method: string | null;
}

// =============================================================================
// Fingerprint deterministik â€” TANPA waktu & identitas aktor
// =============================================================================

/** Normalize persisted settlement timestamps consistently for new and replay responses. */
function normalizeSettlementVerifiedAt(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * CASH fingerprint (backward compatible): path `/api/pos/orders/pay/cash`.
 * Old idempotency keys using this exact format remain valid.
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
  return computeRequestHash('POST', '/api/pos/orders/pay/cash', payload);
}

/**
 * Non-CASH fingerprint: path `/api/pos/orders/pay` with method-specific fields.
 * The fingerprint includes the payment method AND normalized method input
 * (e.g. cash_received for CASH, payment_reference for non-CASH) so that
 * a retry with the same key but a different input is detected as a 409 conflict.
 */
function computeMethodFingerprint(
  propertyId: number,
  orderId: number,
  paymentMethod: string,
  methodInput: PosMethodSpecificInput
): string {
  const payload: Record<string, unknown> = {
    property_id: propertyId,
    pos_order_id: orderId,
    payment_method: paymentMethod,
  };
  if (paymentMethod === 'CASH') {
    const cashReceived = methodInput.cashReceived != null ? Number(methodInput.cashReceived) : null;
    if (cashReceived != null) {
      payload.cash_received = cashReceived;
    }
  } else {
    const ref = (methodInput.paymentReference ?? '').trim();
    if (ref) {
      payload.payment_reference = ref;
    }
  }
  return computeRequestHash('POST', '/api/pos/orders/pay', payload);
}

/**
 * Chooses the correct fingerprint based on payment method.
 * CASH â†’ backward-compatible namespace; non-CASH â†’ new namespace.
 */
function resolveFingerprint(
  propertyId: number,
  orderId: number,
  paymentMethod: string,
  methodInput: PosMethodSpecificInput | null
): string {
  // CASH without cash_received â†’ old namespace (backward compatible with legacy CASH keys)
  // CASH with cash_received â†’ new namespace (fingerprint includes cash_received so
  //   a retry with a different amount is detected as 409 IDEMPOTENCY_CONFLICT)
  // non-CASH â†’ new namespace (fingerprint includes payment_reference)
  if (paymentMethod === 'CASH' && (!methodInput || methodInput.cashReceived == null)) {
    return computeCashSettlementFingerprint(propertyId, orderId, paymentMethod);
  }
  return computeMethodFingerprint(propertyId, orderId, paymentMethod, methodInput ?? {});
}

/**
 * Method-specific config validation.
 * Checks that the property has the required config enabled before processing.
 * For CASH, no config check is needed.
 */
async function validateMethodConfig(
  client: PoolClient,
  propertyId: number,
  paymentMethod: string
): Promise<void> {
  if (paymentMethod === 'CASH') return;

  const cfgRes = await client.query(
    `SELECT qris_enabled, qris_merchant_id, qris_image_path,
            transfer_enabled, transfer_ref_note,
            debit_enabled, debit_edc_terminal,
            bank_name, bank_account_number
     FROM property_payment_instructions WHERE property_id = $1`,
    [propertyId]
  );
  const cfg = cfgRes.rows[0];

  switch (paymentMethod) {
    case 'QRIS': {
      if (!cfg?.qris_enabled) {
        throw new PosSettlementError(
          422,
          'QRIS_NOT_CONFIGURED',
          'QRIS belum diaktifkan untuk properti ini. Aktifkan di Pengaturan Pembayaran.'
        );
      }
      // An enabled QRIS method must have an official QR image configured.
      // A merchant ID alone cannot supply the QR displayed by the payment UI.
      const hasImage = (cfg?.qris_image_path ?? '').trim().length > 0;
      if (!hasImage || !await propertyQrisImageExists(cfg?.qris_image_path, propertyId)) {
        throw new PosSettlementError(
          422,
          'QRIS_NOT_CONFIGURED',
          'Gambar QRIS resmi belum tersedia untuk properti ini. Unggah ulang gambar QRIS di Pengaturan Pembayaran.'
        );
      }
      break;
    }
    case 'TRANSFER': {
      if (!cfg?.transfer_enabled) {
        throw new PosSettlementError(
          422,
          'TRANSFER_NOT_CONFIGURED',
          'Pembayaran Transfer belum diaktifkan untuk properti ini. Aktifkan di Pengaturan Pembayaran.'
        );
      }
      const hasAccount = (cfg?.bank_account_number ?? '').trim().length > 0;
      if (!hasAccount) {
        throw new PosSettlementError(
          422,
          'TRANSFER_NOT_CONFIGURED',
          'Transfer aktif tapi rekening belum diisi. Lengkapi nomor rekening di Pengaturan.'
        );
      }
      break;
    }
    case 'DEBIT': {
      if (!cfg?.debit_enabled) {
        throw new PosSettlementError(
          422,
          'DEBIT_NOT_CONFIGURED',
          'Pembayaran Debit/EDC belum diaktifkan untuk properti ini. Aktifkan di Pengaturan Pembayaran.'
        );
      }
      if (!(cfg?.debit_edc_terminal ?? '').trim()) {
        throw new PosSettlementError(
          422,
          'DEBIT_NOT_CONFIGURED',
          'Debit aktif tapi EDC terminal belum diisi. Lengkapi di Pengaturan.'
        );
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Normalize payment method string: upper + trim, validate against supported set.
 */
function normalizePaymentMethod(raw: unknown): string {
  const m = String(raw ?? '').trim().toUpperCase();
  const valid = POS_SUPPORTED_METHODS as readonly string[];
  if (!valid.includes(m)) {
    throw new PosSettlementError(
      400,
      'SALE_PAYMENT_METHOD_INVALID',
      `Metode pembayaran '${raw}' tidak valid. Pilihan: ${POS_SUPPORTED_METHODS.join(', ')}`
    );
  }
  return m;
}

// =============================================================================
// Helper validasi SALE (dipakai jalur pembayaran baru DAN replay)
// =============================================================================

/**
 * Baca satu baris SALE dari tabel `transactions` dan validasi seluruh
 * invariant:
 *   - id SALE valid (non-kosong; BIGINT sebagai string, TIDAK ke Number)
 *   - property_id === propertyId input
 *   - transaction_type tepat 'SALE'
 *   - source_type tepat 'POS_ORDER'
 *   - source_id tepat String(orderId)
 *   - payment_status tepat 'PAID'
 *   - payment_method tepat `expectedMethod`
 *
 * @param expectedSaleId bila di-set (jalur replay), id baris harus sama
 *                       dengan `existing.transaction_id`.
 * @param expectedMethod metode pembayaran yang diharapkan (default 'CASH').
 * @throws {PosSettlementError} 5xx bila ada invariant yang dilanggar.
 */
export async function assertPosSaleProjection(
  poolClient: PoolClient,
  saleId: string,
  propertyId: number,
  orderId: number,
  expectedSaleId?: string,
  expectedMethod?: string
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
  const expectedM = (expectedMethod ?? 'CASH').toUpperCase();
  if (String(row.payment_method || '').toUpperCase() !== expectedM) {
    throw new PosSettlementError(
      500,
      'SALE_PAYMENT_METHOD_INVALID',
      `payment_method SALE=${row.payment_method} (ekspektasi ${expectedM})`
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
 * Wrapper kompatibel: delegasikan ke `payPosOrder` dengan `paymentMethod: 'CASH'`.
 * Pertahankan export, signature, default export, fingerprint CASH lama,
 * serta kontrak hasil/error existing.
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
  return payPosOrder(poolClient, {
    ...input,
    paymentMethod: 'CASH',
  });
}

// =============================================================================
// Generalized multi-method payment service
// =============================================================================

/**
 * Bayarkan order POS dengan metode pembayaran apapun (CASH, QRIS, TRANSFER, DEBIT).
 *
 * Protokol: service melakukan BEGIN/COMMIT/ROLLBACK. Caller menyediakan
 * PoolClient yang BELUM dalam transaksi dan WAJIB me-release di finally.
 *
 * Kontrak:
 * - `paymentMethod` divalidasi terhadap `POS_SUPPORTED_METHODS`.
 * - `verified_by` berasal dari `actorName`/`actorUserId` (pengguna terautentikasi),
 *   BUKAN dari body request â€” klien tidak dapat mengidentifikasikan actor lain.
 * - `cash_received` hanya untuk CASH; `change_due` dihitung backend
 *   (= cash_received - order total). Nilai kembalian dari request DIABAIKAN.
 * - Konfigurasi QRIS/Transfer/EDC diverifikasi sesuai properti sebelum diproses.
 * - Fingerprint mencakup input pembayaran yang dinormalisasi;
 *   retry dengan key sama + payload sama â†’ replay, payload beda â†’ 409.
 * - Pembayaran CASH dan idempotency key lama tetap kompatibel (backward compat).
 * - Order lock, transaksi atomik, replay, dan perlindungan pembayaran ganda
 *   tetap dipertahankan.
 *
 * @throws {PosSettlementError} 4xx/5xx dengan code terstruktur.
 */
export async function payPosOrder(
  poolClient: PoolClient,
  input: PayPosOrderInput
): Promise<PayPosOrderCashResult> {
  // â”€â”€ Validasi input dasar (sama dengan CASH path) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const propertyId = Number(input.propertyId);
  const orderId = Number(input.orderId);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw new PosSettlementError(400, 'VALIDATION_ERROR', 'property_id wajib integer positif');
  }
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new PosSettlementError(400, 'VALIDATION_ERROR', 'order_id wajib integer positif');
  }
  const key = (input.idempotencyKey ?? '').trim();
  if (key.length === 0 || key.length > 150) {
    throw new PosSettlementError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key wajib tidak kosong dan maks 150 karakter'
    );
  }

  // â”€â”€ Validasi & normalisasi payment method â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  const methodInput = input.methodInput ?? {};

  // â”€â”€ CASH: validasi cash_received; hitung change_due backend â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let cashReceived: number | null = null;
  let changeDue: number | null = null;
  if (paymentMethod === 'CASH') {
    // cash_received is OPTIONAL for CASH (backward compat: old CASH flow
    // may not supply it). If provided, validate and compute change_due.
    if (methodInput.cashReceived != null) {
      const cr = Number(methodInput.cashReceived);
      if (!Number.isFinite(cr) || cr < 0) {
        throw new PosSettlementError(
          422,
          'INVALID_CASH_RECEIVED',
          'cash_received harus angka non-negatif'
        );
      }
      cashReceived = cr;
    }
  }

  // â”€â”€ Non-CASH: extract verified_by from actor context (NOT from body) â”€
  const verifiedBy =
    paymentMethod === 'CASH'
      ? null
      : (input.actorName ?? input.actorUserId ?? null);

  // â”€â”€ Fingerprint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // CASH uses the backward-compatible namespace; non-CASH uses the new one.
  const fingerprint = resolveFingerprint(propertyId, orderId, paymentMethod, methodInput);

  // ï¿½ï¿½â”€ Satu transaksi eksplisit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await poolClient.query('BEGIN');
  try {
    // Lock order FOR UPDATE
    const lockRes = await poolClient.query(
      `SELECT id, property_id, status, total_amount, discount_amount
       FROM pos_orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    );
    const orderRow = lockRes.rows[0];
    if ((lockRes.rowCount ?? 0) === 0 || !orderRow) {
      throw new PosSettlementError(404, 'ORDER_NOT_FOUND', `POS order #${orderId} tidak ditemukan`);
    }

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
    const orderDiscount = Number(orderRow.discount_amount || 0);

    // â”€â”€ Replay check: key sama + fingerprint sama â†’ REPLAY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const replayQ = await poolClient.query(
      `SELECT id, property_id, pos_order_id, transaction_id,
              amount, payment_method, status,
              idempotency_key, request_fingerprint, created_by,
              cash_received, change_due, payment_reference,
              verified_by, verified_at, created_at
       FROM pos_settlements
       WHERE property_id = $1 AND pos_order_id = $2 AND idempotency_key = $3
       LIMIT 1`,
      [propertyId, orderId, key]
    );
    if ((replayQ.rowCount ?? 0) > 0 && replayQ.rows[0]) {
      const existing = replayQ.rows[0];
      const fpMatch = String(existing.request_fingerprint || '') === fingerprint;
      if (fpMatch) {
        // Replay: validasi settlement existing + SALE
        const existingMethod = String(existing.payment_method || '').toUpperCase();
        if (existingMethod !== paymentMethod) {
          throw new PosSettlementError(
            500,
            'SETTLEMENT_METHOD_INVALID',
            `Settlement #${existing.id} payment_method=${existing.payment_method} (ekspektasi ${paymentMethod})`
          );
        }
        if (String(existing.status || '') !== 'SUCCESS') {
          throw new PosSettlementError(
            500,
            'SETTLEMENT_STATUS_INVALID',
            `Settlement #${existing.id} status=${existing.status} (ekspektasi SUCCESS)`
          );
        }
        const expectedSaleId = String(existing.transaction_id);
        const saleRow = await assertPosSaleProjection(
          poolClient,
          expectedSaleId,
          propertyId,
          orderId,
          expectedSaleId,
          paymentMethod
        );
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
            cash_received: existing.cash_received == null ? null : String(existing.cash_received),
            change_due: existing.change_due == null ? null : String(existing.change_due),
            payment_reference: existing.payment_reference == null ? null : String(existing.payment_reference),
            verified_by: existing.verified_by == null ? null : String(existing.verified_by),
            verified_at: normalizeSettlementVerifiedAt(existing.verified_at),
            created_at: normalizeSettlementVerifiedAt(existing.created_at),
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
      // key sama + fingerprint berbeda â†’ 409 IDEMPOTENCY_CONFLICT
      throw new PosSettlementError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Idempotency-Key sudah digunakan untuk payload pembayaran yang berbeda'
      );
    }

    // â”€â”€ ALREADY_PAID guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const settledQ = await poolClient.query(
      `SELECT 1 FROM pos_settlements WHERE property_id = $1 AND pos_order_id = $2 LIMIT 1`,
      [propertyId, orderId]
    );
    if ((settledQ.rowCount ?? 0) > 0) {
      throw new PosSettlementError(
        409,
        'ALREADY_PAID',
        `POS order #${orderId} sudah memiliki settlement pembayaran`
      );
    }

    // â”€â”€ Legacy payment guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const legacyPayQ = await poolClient.query(
      `SELECT EXISTS(
         SELECT 1 FROM payment_transactions pt
         JOIN transactions t ON t.id = pt.transaction_id
         WHERE t.property_id = $1
           AND t.source_type IN ('POS_ORDER', 'POS')
           AND t.source_id = $2
           AND t.reversal_of_transaction_id IS NULL
           AND t.transaction_type = 'SALE'
           AND pt.status = 'SUCCESS'
           AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
           AND pt.amount > 0
       ) AS has_legacy_payment`,
      [propertyId, String(orderId)]
    );
    if (legacyPayQ.rows[0]?.has_legacy_payment === true) {
      throw new PosSettlementError(
        409,
        'POS_EXISTING_PAYMENT_NOT_SUPPORTED',
        'Order POS sudah memiliki pembayaran sebelumnya. Pembayaran penuh tidak dapat dilanjutkan.'
      );
    }

    // â”€â”€ Validasi order payable â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Validasi cash_received >= order total (CASH only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (paymentMethod === 'CASH' && cashReceived != null) {
      if (cashReceived < orderAmount) {
        throw new PosSettlementError(
          422,
          'CASH_RECEIVED_INSUFFICIENT',
          `cash_received (${cashReceived}) kurang dari tagihan ${orderAmount}`
        );
      }
      changeDue = Math.max(0, cashReceived - orderAmount);
    }

    // â”€â”€ Validasi konfigurasi metode non-CASH per properti â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await validateMethodConfig(poolClient, propertyId, paymentMethod);

    // 1) UPDATE order â†’ PAID
    await poolClient.query(
      `UPDATE pos_orders SET status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [orderId]
    );

    // 2) Proyeksi SALE
    const sale: TransactionRow | null = await projectPosOrderToTransaction(
      poolClient,
      orderId,
      {
        propertyId,
        actorName: input.actorName,
        actorUserId: input.actorUserId,
        paymentMethod,
        discountAmount: orderDiscount,
      }
    );
    if (!sale) {
      throw new PosSettlementError(
        500,
        'SALE_PROJECTION_FAILED',
        'Proyeksi SALE dari order POS gagal (null) â€” kondisi internal'
      );
    }

    // 3) Validasi hasil SALE
    const saleRow = await assertPosSaleProjection(
      poolClient,
      String(sale.id),
      propertyId,
      orderId,
      undefined,
      paymentMethod
    );

    // 4) INSERT settlement dengan field metode spesifik
    const amountForSettlement = String(orderAmount);
    const paymentReference =
      paymentMethod === 'CASH'
        ? null
        : (methodInput.paymentReference ?? '').trim() || null;

    let insRow: {
      id: string; property_id: string | number; pos_order_id: string | number;
      transaction_id: string | number; amount: string; payment_method: string;
      status: string; idempotency_key: string; request_fingerprint: string;
      created_by: string | null;
      cash_received: string | null;
      change_due: string | null;
      payment_reference: string | null;
      verified_by: string | null;
      verified_at: Date | string | null;
      created_at: Date | string | null;
    };
    try {
      const insQ = await poolClient.query(
        `INSERT INTO pos_settlements (
           property_id, pos_order_id, transaction_id, amount,
           payment_method, status, idempotency_key, request_fingerprint,
           created_by,
           cash_received, change_due,
           payment_reference, verified_by, verified_at
         ) VALUES (
            $1, $2, $3, $4,
            $5, 'SUCCESS', $6, $7,
            $8,
            $9, $10,
            $11, $12, $13
          )
          RETURNING id, property_id, pos_order_id, transaction_id,
                    amount, payment_method, status,
                    idempotency_key, request_fingerprint, created_by,
                    cash_received, change_due, payment_reference,
                    verified_by, verified_at, created_at`,
        [
          propertyId,
          orderId,
          saleRow.id,
          amountForSettlement,
          paymentMethod,
          key,
          fingerprint,
          input.actorName || input.actorUserId || null,
          cashReceived,
          changeDue,
          paymentReference,
          verifiedBy,
          verifiedBy != null ? new Date().toISOString() : null,
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

    // 5) Audit log
    const auditAction =
      paymentMethod === 'CASH' ? 'SETTLEMENT_CASH' : `SETTLEMENT_${paymentMethod}`;
    await poolClient.query(
      `INSERT INTO audit_logs (
         module, action, entity, record_id, new_value,
         property_id, actor_user_id, correlation_id
       ) VALUES ('POS', $1, 'pos_settlements', $2, $3, $4, $5, $6)`,
      [
        auditAction,
        String(insRow.id),
        JSON.stringify({
          property_id: propertyId,
          pos_order_id: orderId,
          transaction_id: saleRow.id,
          amount: amountForSettlement,
          payment_method: paymentMethod,
          status: 'SUCCESS',
          idempotency_key: key,
          request_fingerprint: fingerprint,
          created_by: input.actorName || input.actorUserId || null,
          cash_received: cashReceived,
          change_due: changeDue,
          payment_reference: paymentReference,
          verified_by: verifiedBy,
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
        cash_received: insRow.cash_received == null ? null : String(insRow.cash_received),
        change_due: insRow.change_due == null ? null : String(insRow.change_due),
        payment_reference: insRow.payment_reference == null ? null : String(insRow.payment_reference),
        verified_by: insRow.verified_by == null ? null : String(insRow.verified_by),
        verified_at: normalizeSettlementVerifiedAt(insRow.verified_at),
        created_at: normalizeSettlementVerifiedAt(insRow.created_at),
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
    try {
      await poolClient.query('ROLLBACK');
    } catch (rollbackErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[posSettlement] payPosOrder ROLLBACK gagal setelah error utama: ' +
          String((rollbackErr as Error)?.message ?? rollbackErr)
      );
    }
    throw err;
  }
}

export default payPosOrderCash;
