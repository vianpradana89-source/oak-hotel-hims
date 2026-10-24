/**
 * POS WhatsApp Digital Receipt Service (MP-05A)
 *
 * Mengelola integrasi WhatsApp untuk pengiriman struk digital POS dan notifikasi transaksi:
 * 1. Normalisasi nomor telepon standar Indonesia (08xx / +628xx -> 628xx).
 * 2. Penyusunan template struk digital ramah pelanggan dalam format WhatsApp Markdown.
 * 3. Gateway dispatcher terisolasi dengan konfigurasi environment variable aman (tanpa hardcoding).
 * 4. Audit trail dan pencatatan riwayat pengiriman (SENT / FAILED).
 */

import { Pool, PoolClient } from 'pg';
import { getPropertyBranding } from '../propertyBranding/propertyBrandingService';

// =============================================================================
// Phone Normalization & Privacy Masking
// =============================================================================

/**
 * Normalizes Indonesian phone numbers into standard format (628...).
 * Supports:
 * - 081234567890 -> 6281234567890
 * - +6281234567890 -> 6281234567890
 * - 6281234567890 -> 6281234567890
 * - 81234567890 -> 6281234567890
 * - Strips whitespace, dashes, dots, and parentheses.
 * Returns null if invalid or length not within 10-15 digits.
 */
export function normalizeIndonesianPhoneNumber(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;

  // Hapus semua karakter selain digit
  let cleaned = trimmed.replace(/\D/g, '');
  if (!cleaned) return null;

  // Normalisasi prefix
  if (cleaned.startsWith('08')) {
    cleaned = '62' + cleaned.slice(1);
  } else if (cleaned.startsWith('8')) {
    cleaned = '62' + cleaned;
  } else if (cleaned.startsWith('62')) {
    // sudah diawali 62
  } else {
    return null;
  }

  // Nomor HP Indonesia: 628... dengan panjang total 10-15 digit
  if (/^628\d{7,12}$/.test(cleaned)) {
    return cleaned;
  }

  return null;
}

/**
 * Masks phone number for privacy-safe logging and response display.
 * e.g. 6281234567890 -> 62812****7890
 */
export function maskPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return 'EMPTY';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length <= 6) return clean.replace(/./g, '*');
  const start = clean.slice(0, 5);
  const end = clean.slice(-4);
  return `${start}****${end}`;
}

// =============================================================================
// Types & Interfaces
// =============================================================================

export interface PosReceiptMessageOptions {
  intro?: string | null;
  closing?: string | null;
  outletName?: string | null;
  receiptUrl?: string | null;
  timezone?: string | null;
}

export interface PosReceiptDataPayload {
  property: {
    id: number;
    name: string;
    property_code?: string;
    address?: string | null;
    phone?: string | null;
    timezone?: string;
    currency?: string;
    branding?: any;
  };
  order: {
    id: number;
    order_number: string;
    property_id: number;
    status: string;
    guest_name?: string | null;
    guest_phone?: string | null;
    table_number?: string | null;
    notes?: string | null;
    total_amount: string;
    discount_type?: string | null;
    discount_value?: string | null;
    discount_reason?: string | null;
    discount_amount: string;
    service_amount?: string;
    tax_amount?: string;
    service_charge_percent_snapshot?: string;
    tax_percent_snapshot?: string;
    created_at?: string | null;
  };
  items: Array<{
    menu_item_id?: number;
    item_name_snapshot: string;
    item_code_snapshot?: string | null;
    quantity: number;
    unit_price: string;
    notes?: string | null;
    discount_amount?: string;
  }>;
  settlement: {
    id: number;
    amount: string;
    payment_method: string;
    status: string;
    cash_received?: string | null;
    change_due?: string | null;
    payment_reference?: string | null;
    created_by?: string | null;
    created_at?: string | null;
  };
  sale: {
    id: string;
    transaction_no: string;
    transaction_type: string;
    source_type: string;
    source_id: string;
    payment_status: string;
    payment_method: string;
    net_amount: string;
    created_at?: string | null;
  };
}

export interface SendWhatsAppResult {
  success: boolean;
  messageId?: string | null;
  gatewayResponse?: any;
  error?: string | null;
}

export interface PosWhatsAppReceiptLogRecord {
  id: number;
  property_id: number;
  order_id: number;
  recipient_phone: string;
  recipient_phone_masked: string;
  message_content: string;
  status: 'SENT' | 'FAILED';
  gateway_response?: any;
  error_message?: string | null;
  sent_by_user_id?: number | null;
  created_at: string;
}

// =============================================================================
// Formatting Helpers
// =============================================================================

function parseRupiahNumber(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const cleaned = String(raw).trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num);
}

function formatRupiah(amount: unknown): string {
  const val = parseRupiahNumber(amount);
  return `Rp ${val.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
}

/**
 * Format datetime to Asia/Jakarta (WIB).
 */
export function formatReceiptDateTime(dateStr: string | null | undefined, timeZone = 'Asia/Jakarta'): string {
  try {
    const d = dateStr ? new Date(dateStr) : new Date();
    const formatter = new Intl.DateTimeFormat('id-ID', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${formatter.format(d)} WIB`;
  } catch {
    return `${new Date().toLocaleDateString('id-ID')} WIB`;
  }
}

// =============================================================================
// Message Builder for WhatsApp
// =============================================================================

/**
 * Menyusun pesan teks struk digital WhatsApp dengan format Markdown bersih.
 */
export function buildPosDigitalReceiptWhatsAppMessage(
  receipt: PosReceiptDataPayload,
  options?: PosReceiptMessageOptions
): string {
  const { property, order, items, settlement, sale } = receipt;

  const hotelName = property.branding?.display_name || property.name || 'OAK Hotel';
  const outletName = options?.outletName || 'POS Outlet';
  const lines: string[] = [];

  // 1. Intro opsional dari konfigurasi komunikasi
  const intro = options?.intro?.trim();
  if (intro) {
    lines.push(intro);
    lines.push('');
  }

  // 2. Header Properti & Outlet
  lines.push(`*${hotelName.toUpperCase()}*`);
  lines.push(`*${outletName}*`);
  lines.push('────────────────────────');

  // 3. Info Transaksi
  lines.push(`*No. Struk:* ${order.order_number}`);
  lines.push(`*No. Transaksi:* ${sale.transaction_no}`);
  const txDate = settlement.created_at || sale.created_at || order.created_at;
  lines.push(`*Waktu:* ${formatReceiptDateTime(txDate, options?.timezone || property.timezone)}`);

  const cashier = settlement.created_by || 'Kasir';
  lines.push(`*Kasir:* ${cashier}`);

  if (order.guest_name && order.guest_name.trim()) {
    lines.push(`*Pelanggan:* ${order.guest_name.trim()}`);
  }
  if (order.table_number && order.table_number.trim()) {
    lines.push(`*Meja:* ${order.table_number.trim()}`);
  }
  lines.push('────────────────────────');

  // 4. Rincian Pesanan
  lines.push('*DETAIL PESANAN:*');
  let rawItemsSubtotal = 0;
  for (const item of items) {
    const qty = Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;
    const unitPrice = parseRupiahNumber(item.unit_price);
    const itemDisc = parseRupiahNumber(item.discount_amount);
    const lineTotal = Math.max(0, qty * unitPrice - itemDisc);
    rawItemsSubtotal += qty * unitPrice;

    const discNote = itemDisc > 0 ? ` (disc ${formatRupiah(itemDisc)})` : '';
    lines.push(`• ${qty}x ${item.item_name_snapshot}`);
    lines.push(`  @ ${formatRupiah(unitPrice)} = *${formatRupiah(lineTotal)}*${discNote}`);
  }
  lines.push('────────────────────────');

  // 5. Ringkasan Finansial
  const orderDisc = parseRupiahNumber(order.discount_amount);
  const svcAmt = parseRupiahNumber(order.service_amount);
  const taxAmt = parseRupiahNumber(order.tax_amount);
  const totalAmt = parseRupiahNumber(order.total_amount);

  lines.push(`Subtotal: ${formatRupiah(rawItemsSubtotal)}`);

  if (orderDisc > 0) {
    const reason = order.discount_reason ? ` (${order.discount_reason})` : '';
    lines.push(`Diskon Order${reason}: -${formatRupiah(orderDisc)}`);
  }

  if (svcAmt > 0) {
    const svcPct = order.service_charge_percent_snapshot ? ` (${order.service_charge_percent_snapshot}%)` : '';
    lines.push(`Service Charge${svcPct}: ${formatRupiah(svcAmt)}`);
  }

  if (taxAmt > 0) {
    const taxPct = order.tax_percent_snapshot ? ` (${order.tax_percent_snapshot}%)` : '';
    lines.push(`PBJT / Pajak${taxPct}: ${formatRupiah(taxAmt)}`);
  }

  lines.push(`*TOTAL: ${formatRupiah(totalAmt)}*`);
  lines.push('────────────────────────');

  // 6. Pembayaran
  lines.push('*PEMBAYARAN:*');
  lines.push(`Metode: *${settlement.payment_method}*`);

  if (settlement.payment_method === 'CASH') {
    const cashRec = parseRupiahNumber(settlement.cash_received);
    const chgDue = parseRupiahNumber(settlement.change_due);
    if (cashRec > 0) {
      lines.push(`Tunai Diterima: ${formatRupiah(cashRec)}`);
    }
    if (chgDue > 0) {
      lines.push(`Kembalian: ${formatRupiah(chgDue)}`);
    }
  } else {
    if (settlement.payment_reference) {
      lines.push(`No. Ref: ${settlement.payment_reference}`);
    }
  }

  lines.push('────────────────────────');

  // 7. Closing & Footer
  const closing = options?.closing?.trim();
  if (closing) {
    lines.push(closing);
    lines.push('');
  }

  if (options?.receiptUrl && options.receiptUrl.trim()) {
    lines.push(`Tautan Struk Digital:`);
    lines.push(`${options.receiptUrl.trim()}`);
    lines.push('');
  }

  lines.push(`Terima kasih telah berkunjung ke *${hotelName}*!`);
  lines.push('Semoga hari Anda menyenangkan.');

  return lines.join('\n');
}

// =============================================================================
// WhatsApp Gateway Dispatcher
// =============================================================================

export interface GatewayConfig {
  url?: string;
  apiToken?: string;
  senderNumber?: string;
  provider?: string;
  timeoutMs?: number;
}

/**
 * Mengambil konfigurasi WhatsApp gateway dari environment variables dengan aman.
 */
export function getWhatsAppGatewayConfig(): GatewayConfig {
  return {
    url: process.env.WHATSAPP_GATEWAY_URL?.trim() || undefined,
    apiToken: (process.env.WHATSAPP_API_TOKEN || process.env.WHATSAPP_API_KEY)?.trim() || undefined,
    senderNumber: process.env.WHATSAPP_SENDER_NUMBER?.trim() || undefined,
    provider: (process.env.WHATSAPP_PROVIDER || 'FONNTE').trim().toUpperCase(),
    timeoutMs: parseInt(process.env.WHATSAPP_TIMEOUT_MS || '10000', 10),
  };
}

/**
 * Dispatcher pesan WhatsApp ke gateway penyedia (Fonnte, Generic HTTP, atau Mock).
 */
export async function sendWhatsAppGatewayMessage(
  recipientPhone: string,
  messageText: string,
  customConfig?: Partial<GatewayConfig>
): Promise<SendWhatsAppResult> {
  const config = { ...getWhatsAppGatewayConfig(), ...customConfig };

  // Mode Mock / Sandbox jika URL tidak dikonfigurasi, bernilai 'mock', atau test environment tanpa URL eksplisit
  const isMock =
    !config.url ||
    config.url.toLowerCase() === 'mock' ||
    (process.env.NODE_ENV === 'test' && !customConfig?.url);

  if (isMock) {
    const mockMessageId = `wa_mock_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    return {
      success: true,
      messageId: mockMessageId,
      gatewayResponse: {
        status: 'mock_delivered',
        provider: 'MOCK',
        recipient: recipientPhone,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Mode Gateway Live HTTP POST
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs || 10000);

  try {
    let headers: Record<string, string> = {};
    let body: any;

    if (config.provider === 'FONNTE') {
      // Fonnte standard API format
      headers = {
        Authorization: config.apiToken || '',
        'Content-Type': 'application/json',
      };
      body = JSON.stringify({
        target: recipientPhone,
        message: messageText,
        countryCode: '62',
      });
    } else {
      // Generic HTTP API format
      headers = {
        'Content-Type': 'application/json',
      };
      if (config.apiToken) {
        headers['Authorization'] = `Bearer ${config.apiToken}`;
      }
      body = JSON.stringify({
        to: recipientPhone,
        message: messageText,
        sender: config.senderNumber,
      });
    }

    const res = await (globalThis as any).fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const textResponse = await res.text();
    let jsonResponse: any;
    try {
      jsonResponse = JSON.parse(textResponse);
    } catch {
      jsonResponse = { raw: textResponse };
    }

    if (!res.ok) {
      const errMsg = jsonResponse?.message || jsonResponse?.error || `HTTP ${res.status}: ${res.statusText}`;
      return {
        success: false,
        error: errMsg,
        gatewayResponse: jsonResponse,
      };
    }

    // Ekstrak message ID dari response jika ada
    const messageId =
      jsonResponse?.id ||
      jsonResponse?.message_id ||
      jsonResponse?.data?.id ||
      `msg_${Date.now()}`;

    return {
      success: true,
      messageId: String(messageId),
      gatewayResponse: jsonResponse,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError';
    const errMsg = isTimeout
      ? `Gateway timeout setelah ${config.timeoutMs}ms`
      : err?.message || 'Gagal menghubungi gateway WhatsApp';

    return {
      success: false,
      error: errMsg,
      gatewayResponse: { errorName: err?.name, message: err?.message },
    };
  }
}

// =============================================================================
// Database Audit & Logging
// =============================================================================

export interface LogWhatsAppReceiptParams {
  propertyId: number;
  orderId: number;
  recipientPhone: string;
  recipientPhoneMasked: string;
  messageContent: string;
  status: 'SENT' | 'FAILED';
  gatewayResponse?: any;
  errorMessage?: string | null;
  sentByUserId?: number | null;
}

/**
 * Menyimpan log pengiriman struk WA ke tabel pos_whatsapp_receipt_logs dan audit_logs.
 */
export async function logWhatsAppReceiptDispatch(
  poolOrClient: Pool | PoolClient,
  params: LogWhatsAppReceiptParams
): Promise<number> {
  const {
    propertyId,
    orderId,
    recipientPhone,
    recipientPhoneMasked,
    messageContent,
    status,
    gatewayResponse,
    errorMessage,
    sentByUserId,
  } = params;

  const insertSql = `
    INSERT INTO pos_whatsapp_receipt_logs (
      property_id,
      order_id,
      recipient_phone,
      recipient_phone_masked,
      message_content,
      status,
      gateway_response,
      error_message,
      sent_by_user_id,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    RETURNING id
  `;

  const res = await poolOrClient.query(insertSql, [
    propertyId,
    orderId,
    recipientPhone,
    recipientPhoneMasked,
    messageContent,
    status,
    gatewayResponse ? JSON.stringify(gatewayResponse) : null,
    errorMessage || null,
    sentByUserId || null,
  ]);

  const logId = Number(res.rows[0]?.id || 0);

  // Catat juga ke audit_logs umum jika tabel audit_logs tersedia
  try {
    await poolOrClient.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        'POS',
        status === 'SENT' ? 'WHATSAPP_RECEIPT_SENT' : 'WHATSAPP_RECEIPT_FAILED',
        'POS_ORDER',
        String(orderId),
        JSON.stringify({
          order_id: orderId,
          recipient_masked: recipientPhoneMasked,
          status,
          log_id: logId,
          error: errorMessage || null,
        }),
        `wa_receipt_${orderId}`,
        propertyId,
      ]
    );
  } catch (auditErr) {
    // Non-fatal: jangan gagalkan operasi utama jika audit_logs opsional
    console.warn('[logWhatsAppReceiptDispatch] audit_logs write warning:', auditErr);
  }

  return logId;
}

/**
 * Mengambil riwayat pengiriman struk WhatsApp untuk order tertentu.
 */
export async function getWhatsAppReceiptLogs(
  poolOrClient: Pool | PoolClient,
  orderId: number,
  propertyId: number
): Promise<PosWhatsAppReceiptLogRecord[]> {
  const querySql = `
    SELECT id, property_id, order_id, recipient_phone, recipient_phone_masked,
           message_content, status, gateway_response, error_message,
           sent_by_user_id, created_at
    FROM pos_whatsapp_receipt_logs
    WHERE order_id = $1 AND property_id = $2
    ORDER BY id DESC
  `;

  const res = await poolOrClient.query(querySql, [orderId, propertyId]);
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    property_id: Number(r.property_id),
    order_id: Number(r.order_id),
    recipient_phone: String(r.recipient_phone),
    recipient_phone_masked: String(r.recipient_phone_masked),
    message_content: String(r.message_content),
    status: r.status as 'SENT' | 'FAILED',
    gateway_response: r.gateway_response,
    error_message: r.error_message || null,
    sent_by_user_id: r.sent_by_user_id ? Number(r.sent_by_user_id) : null,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

// =============================================================================
// Main Service Orchestrator
// =============================================================================

export interface SendPosReceiptWhatsAppDTO {
  orderId: number;
  propertyId: number;
  phoneNumber?: string | null;
  sentByUserId?: number | null;
  customGatewayConfig?: Partial<GatewayConfig>;
  webReceiptBaseUrl?: string | null;
}

export interface SendPosReceiptWhatsAppResponse {
  order_id: number;
  phone_number: string;
  phone_number_masked: string;
  status: 'SENT' | 'FAILED';
  message_id?: string | null;
  sent_at: string;
  error?: string | null;
}

/**
 * Mengambil data receipt authoritative dari database.
 */
export async function fetchAuthoritativeReceiptData(
  client: PoolClient | Pool,
  orderId: number,
  propertyId: number
): Promise<PosReceiptDataPayload> {
  // 1. Order
  const orderRes = await client.query(
    `SELECT id, property_id, reservation_id, order_number,
            table_number, guest_name, guest_phone,
            status, total_amount,
            service_amount, tax_amount,
            service_charge_percent_snapshot, tax_percent_snapshot,
            notes,
            discount_type, discount_value, discount_reason, discount_amount,
            created_at, updated_at
     FROM pos_orders
     WHERE id = $1 AND property_id = $2`,
    [orderId, propertyId]
  );

  if (orderRes.rows.length === 0) {
    throw { statusCode: 404, code: 'ORDER_NOT_FOUND', message: 'Order tidak ditemukan' };
  }
  const order = orderRes.rows[0];

  // 2. Items
  const itemsRes = await client.query(
    `SELECT menu_item_id, item_name_snapshot, item_code_snapshot,
            quantity, unit_price, notes,
            discount_type, discount_value, discount_amount
     FROM pos_order_items
     WHERE order_id = $1
     ORDER BY id ASC`,
    [orderId]
  );

  // 3. Settlement
  const settlementRes = await client.query(
    `SELECT id, property_id, pos_order_id, transaction_id, amount,
            payment_method, status, cash_received, change_due, payment_reference,
            created_by, created_at, verified_by, verified_at
     FROM pos_settlements
     WHERE property_id = $1 AND pos_order_id = $2 AND status = 'SUCCESS'
     LIMIT 1`,
    [propertyId, orderId]
  );

  if (settlementRes.rows.length === 0) {
    throw { statusCode: 409, code: 'RECEIPT_NOT_AVAILABLE', message: 'Settlement belum diselesaikan untuk order ini' };
  }
  const settlement = settlementRes.rows[0];

  // 4. SALE Transaction
  const saleRes = await client.query(
    `SELECT id, property_id, transaction_no, transaction_type, source_type,
            source_id, payment_status, payment_method, net_amount, created_at
     FROM transactions
     WHERE id = $1 AND property_id = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [settlement.transaction_id, propertyId]
  );

  if (saleRes.rows.length === 0) {
    throw { statusCode: 409, code: 'RECEIPT_NOT_AVAILABLE', message: 'Transaksi SALE tidak ditemukan' };
  }
  const sale = saleRes.rows[0];

  // 5. Property & Branding
  const propRes = await client.query(
    `SELECT id, name, property_code, address, phone, timezone, currency
     FROM properties WHERE id = $1`,
    [propertyId]
  );
  const propRow = propRes.rows[0] || { id: propertyId, name: 'OAK Hotel' };

  let branding: any = null;
  try {
    branding = await getPropertyBranding(client as any, propertyId);
  } catch {
    branding = null;
  }

  return {
    property: {
      id: Number(propRow.id),
      name: String(propRow.name || ''),
      property_code: propRow.property_code,
      address: propRow.address,
      phone: propRow.phone,
      timezone: propRow.timezone || 'Asia/Jakarta',
      currency: propRow.currency || 'IDR',
      branding,
    },
    order: {
      id: Number(order.id),
      order_number: String(order.order_number || ''),
      property_id: Number(order.property_id),
      status: String(order.status || ''),
      guest_name: order.guest_name,
      guest_phone: order.guest_phone,
      table_number: order.table_number,
      notes: order.notes,
      total_amount: String(order.total_amount || '0'),
      discount_type: order.discount_type,
      discount_value: order.discount_value,
      discount_reason: order.discount_reason,
      discount_amount: String(order.discount_amount || '0'),
      service_amount: String(order.service_amount || '0'),
      tax_amount: String(order.tax_amount || '0'),
      service_charge_percent_snapshot: String(order.service_charge_percent_snapshot || '0'),
      tax_percent_snapshot: String(order.tax_percent_snapshot || '0'),
      created_at: order.created_at,
    },
    items: itemsRes.rows.map((it: any) => ({
      menu_item_id: it.menu_item_id ? Number(it.menu_item_id) : undefined,
      item_name_snapshot: String(it.item_name_snapshot || 'Item'),
      item_code_snapshot: it.item_code_snapshot,
      quantity: Number(it.quantity || 1),
      unit_price: String(it.unit_price || '0'),
      notes: it.notes,
      discount_amount: String(it.discount_amount || '0'),
    })),
    settlement: {
      id: Number(settlement.id),
      amount: String(settlement.amount || '0'),
      payment_method: String(settlement.payment_method || 'CASH'),
      status: String(settlement.status || 'SUCCESS'),
      cash_received: settlement.cash_received != null ? String(settlement.cash_received) : null,
      change_due: settlement.change_due != null ? String(settlement.change_due) : null,
      payment_reference: settlement.payment_reference,
      created_by: settlement.created_by,
      created_at: settlement.created_at,
    },
    sale: {
      id: String(sale.id),
      transaction_no: String(sale.transaction_no || ''),
      transaction_type: String(sale.transaction_type || 'SALE'),
      source_type: String(sale.source_type || 'POS_ORDER'),
      source_id: String(sale.source_id || ''),
      payment_status: String(sale.payment_status || 'PAID'),
      payment_method: String(sale.payment_method || ''),
      net_amount: String(sale.net_amount || '0'),
      created_at: sale.created_at,
    },
  };
}

/**
 * Menjalankan alur lengkap pengiriman struk digital WhatsApp:
 * 1. Validasi input & normalisasi nomor telepon.
 * 2. Pengecekan status order harus PAID / SETTLED.
 * 3. Pengecekan whatsapp_enabled pada property_pos_communication_settings.
 * 4. Kompilasi pesan WhatsApp Markdown.
 * 5. Pengiriman via gateway.
 * 6. Audit & logging ke database.
 */
export async function sendPosReceiptWhatsApp(
  pool: Pool,
  dto: SendPosReceiptWhatsAppDTO
): Promise<SendPosReceiptWhatsAppResponse> {
  const { orderId, propertyId, phoneNumber, sentByUserId, customGatewayConfig, webReceiptBaseUrl } = dto;

  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'orderId wajib berupa integer positif' };
  }
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'propertyId wajib berupa integer positif' };
  }

  const client = await pool.connect();
  try {
    // 1. Ambil data receipt authoritative
    const receiptData = await fetchAuthoritativeReceiptData(client, orderId, propertyId);

    // 2. Status pesanan harus PAID / SETTLED
    const orderStatus = String(receiptData.order.status).toUpperCase();
    if (orderStatus !== 'PAID' && orderStatus !== 'SETTLED') {
      throw {
        statusCode: 409,
        code: 'RECEIPT_NOT_AVAILABLE',
        message: `Struk WhatsApp hanya dapat dikirim untuk order yang sudah lunas/PAID (status saat ini: ${orderStatus})`,
      };
    }

    // 3. Periksa setting komunikasi WhatsApp properti
    let whatsappEnabled = true;
    let customIntro: string | null = null;
    let customClosing: string | null = null;
    try {
      const commRes = await client.query(
        `SELECT whatsapp_enabled, whatsapp_intro_message, whatsapp_closing_message
         FROM property_pos_communication_settings
         WHERE property_id = $1`,
        [propertyId]
      );
      if (commRes.rows.length > 0) {
        whatsappEnabled = Boolean(commRes.rows[0].whatsapp_enabled ?? true);
        customIntro = commRes.rows[0].whatsapp_intro_message || null;
        customClosing = commRes.rows[0].whatsapp_closing_message || null;
      }
    } catch {
      // Fail-open: jika tabel settings belum ada, default whatsappEnabled = true
      whatsappEnabled = true;
    }

    if (!whatsappEnabled) {
      throw {
        statusCode: 403,
        code: 'WHATSAPP_DISABLED',
        message: 'Pengiriman struk WhatsApp dinonaktifkan untuk properti ini di Pengaturan POS',
      };
    }

    // 4. Resolve & Normalisasi Nomor HP
    const targetRaw = phoneNumber || receiptData.order.guest_phone;
    const normalizedPhone = normalizeIndonesianPhoneNumber(targetRaw);
    if (!normalizedPhone) {
      throw {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Nomor WhatsApp tujuan tidak valid. Masukkan nomor HP Indonesia standar (contoh: 081234567890 atau 6281234567890)',
      };
    }

    const maskedPhone = maskPhoneNumber(normalizedPhone);

    // 5. Susun URL struk web (jika tersedia base URL)
    let receiptUrl: string | null = null;
    if (webReceiptBaseUrl) {
      const cleanBase = webReceiptBaseUrl.replace(/\/+$/, '');
      receiptUrl = `${cleanBase}/pos/receipt/${orderId}?property_id=${propertyId}`;
    }

    // 6. Susun Pesan WhatsApp Markdown
    const messageContent = buildPosDigitalReceiptWhatsAppMessage(receiptData, {
      intro: customIntro,
      closing: customClosing,
      outletName: 'OAK POS Kasir',
      receiptUrl,
      timezone: receiptData.property.timezone,
    });

    // 7. Kirim Pesan via Gateway Dispatcher
    const sendResult = await sendWhatsAppGatewayMessage(normalizedPhone, messageContent, customGatewayConfig);

    const status: 'SENT' | 'FAILED' = sendResult.success ? 'SENT' : 'FAILED';
    const sentAt = new Date().toISOString();

    // 8. Catat Audit & Riwayat Pengiriman
    await logWhatsAppReceiptDispatch(client, {
      propertyId,
      orderId,
      recipientPhone: normalizedPhone,
      recipientPhoneMasked: maskedPhone,
      messageContent,
      status,
      gatewayResponse: sendResult.gatewayResponse,
      errorMessage: sendResult.error,
      sentByUserId,
    });

    if (!sendResult.success) {
      throw {
        statusCode: 502,
        code: 'WHATSAPP_GATEWAY_ERROR',
        message: `Gagal mengirim struk via gateway WhatsApp: ${sendResult.error || 'Gateway offline'}`,
        data: {
          order_id: orderId,
          phone_number: normalizedPhone,
          phone_number_masked: maskedPhone,
          status: 'FAILED',
          sent_at: sentAt,
          error: sendResult.error,
        },
      };
    }

    return {
      order_id: orderId,
      phone_number: normalizedPhone,
      phone_number_masked: maskedPhone,
      status: 'SENT',
      message_id: sendResult.messageId,
      sent_at: sentAt,
    };
  } finally {
    client.release();
  }
}
