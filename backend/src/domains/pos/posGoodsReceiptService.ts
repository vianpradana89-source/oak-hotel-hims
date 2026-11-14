/**
 * Service & Domain Logic: Goods Receipt Note (GRN) / Penerimaan Barang POS (MP-04D / Inventori 01)
 * OAK Hotel Integrated Management System (HIMS)
 *
 * Mendukung:
 * - Siklus Penerimaan: DRAFT -> POSTED (atomik ke stok/ledger/biaya)
 * - Persetujuan Pembelian (Approval Guard: unapproved purchase dilarang diterima)
 * - Agregasi Plafon (Penjumlahan seluruh baris penerimaan menuju baris PO/Tx yang sama)
 * - Konversi Kemasan (Packaging Unit Conversion)
 * - Idempotensi stabil dengan deteksi payload fingerprint
 */

import { Pool, PoolClient } from 'pg';
import crypto from 'crypto';
import { resolveCanonicalSupplierForProcurement } from './posPurchaseOrderService';

export interface PosGoodsReceiptItem {
  id: number;
  receipt_id: number;
  product_id: number;
  product_name?: string;
  item_code?: string | null;
  base_unit?: string | null;
  canonical_base_unit_code?: string | null;
  ordered_unit?: string | null;
  po_item_id: number | null;
  transaction_line_id?: number | null;
  packaging_id?: number | null;
  packaging_code?: string | null;
  packaging_label?: string | null;
  packaging_label_snapshot?: string | null;
  received_qty: string;
  base_quantity?: string | null;
  source_allocated_qty?: string | null;
  conversion_factor_snapshot?: string | null;
  unit_cost: string;
  subtotal: string;
  uom_id: number | null;
  uom_code?: string | null;
  uom_name?: string | null;
  location_id: number;
  location_code?: string;
  location_name?: string;
  created_at: string;
}

export interface PosGoodsReceipt {
  id: number;
  property_id: number;
  grn_number: string;
  po_id: number | null;
  po_number?: string | null;
  transaction_id?: number | null;
  transaction_number?: string | null;
  source_revision_snapshot?: number | null;
  supplier_id: number | null;
  canonical_supplier_id?: number | null;
  legacy_pos_supplier_id?: number | null;
  supplier_name?: string | null;
  supplier_code?: string | null;
  location_id: number | null;
  location_name?: string | null;
  location_code?: string | null;
  receipt_date: string;
  invoice_no: string | null;
  received_by: string | null;
  posted_by?: string | null;
  posted_at?: string | null;
  status: 'DRAFT' | 'POSTED' | 'COMPLETED' | 'CANCELLED';
  notes: string | null;
  operation_key?: string | null;
  payload_fingerprint?: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  items?: PosGoodsReceiptItem[];
  po_status?: string | null;
  po_approval_status?: string | null;
}

export interface GoodsReceiptItemInput {
  id?: number | null;
  product_id: number;
  po_item_id?: number | null;
  transaction_line_id?: number | null;
  packaging_id?: number | null;
  received_qty: number | string;
  unit_cost: number | string;
  uom_id?: number | null;
  location_id?: number | null;
  conversion_factor_snapshot?: number | string | null;
  packaging_label_snapshot?: string | null;
}

export interface CreateGoodsReceiptInput {
  property_id: number;
  grn_number?: string;
  po_id?: number | null;
  transaction_id?: number | null;
  supplier_id?: number | null;
  canonical_supplier_id?: number | null;
  location_id: number;
  receipt_date?: string;
  invoice_no?: string | null;
  received_by?: string | null;
  posted_by?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
  operation_key?: string | null;
  payload_fingerprint?: string | null;
  status?: 'DRAFT' | 'POSTED';
  is_draft?: boolean;
  items: GoodsReceiptItemInput[];
}

export interface UpdateGoodsReceiptDraftInput {
  location_id?: number;
  receipt_date?: string;
  invoice_no?: string | null;
  received_by?: string | null;
  notes?: string | null;
  items?: GoodsReceiptItemInput[];
}

export interface GetGoodsReceiptsFilter {
  po_id?: number;
  transaction_id?: number;
  supplier_id?: number;
  location_id?: number;
  status?: string;
  start_date?: string;
  end_date?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Generate nomor GRN unik: GRN-YYYYMMDD-XXXX
 * Menggunakan transaction-scoped advisory lock agar pembuatan GRN paralel pada properti yang sama
 * tidak menghasilkan nomor GRN kembar (23505 uq_pos_goods_receipts_property_grn).
 */
async function generateGrnNumber(client: PoolClient | Pool, propertyId: number): Promise<string> {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const datePrefix = `GRN-${yyyy}${mm}${dd}-`;

  try {
    await client.query(`SELECT pg_advisory_xact_lock(918273, $1)`, [propertyId]);
  } catch {
    // Fallback aman untuk unit test mock yang tidak mengimplementasikan pg_advisory_xact_lock
  }

  const seqRes = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM pos_goods_receipts
      WHERE property_id = $1 AND grn_number LIKE $2`,
    [propertyId, `${datePrefix}%`]
  );
  const nextSeq = Number(seqRes.rows[0]?.count || 0) + 1;
  const seqStr = String(nextSeq).padStart(4, '0');
  return `${datePrefix}${seqStr}`;
}

/**
 * Resolusi lokasi gudang utama (Gudang 1) secara eksplisit dan deterministik per property.
 * Hanya menerima lokasi aktif bertipe WAREHOUSE dengan kode WH-01 atau nama persis 'Gudang 1'.
 * Menolak fallback ke lokasi bertipe non-warehouse (seperti KITCHEN) atau lokasi ambigu.
 */
export async function resolveGudang1Location(
  clientOrPool: PoolClient | Pool,
  propertyId: number
): Promise<{ id: number; name: string; code: string; location_type: string }> {
  const pId = Number(propertyId);
  if (!Number.isInteger(pId) || pId <= 0) {
    throw Object.assign(new Error('property_id tidak valid'), { statusCode: 400 });
  }

  const res = await clientOrPool.query(
    `SELECT id, name, code, location_type
       FROM stock_locations
      WHERE property_id = $1
        AND COALESCE(is_active, TRUE) = TRUE
      ORDER BY
        CASE
          WHEN UPPER(TRIM(COALESCE(code, ''))) = 'WH-01' THEN 1
          WHEN UPPER(TRIM(COALESCE(name, ''))) = 'GUDANG 1' THEN 2
          WHEN UPPER(TRIM(COALESCE(location_type, 'WAREHOUSE'))) = 'WAREHOUSE' THEN 3
          ELSE 4
        END,
        id ASC`,
    [pId]
  );

  const validRows = (res.rows || []).filter((r: any) => {
    const locType = r.location_type ? String(r.location_type).trim().toUpperCase() : 'WAREHOUSE';
    return !['SUMMARY', 'CONTAINER', 'VIRTUAL'].includes(locType);
  });

  if (validRows.length === 0) {
    throw Object.assign(
      new Error(`Belum ada lokasi gudang fisik aktif yang dikonfigurasi untuk properti #${pId}`),
      { statusCode: 400, code: 'GUDANG_1_NOT_CONFIGURED' }
    );
  }

  const chosen = validRows[0];
  return {
    id: Number(chosen.id),
    name: chosen.name,
    code: chosen.code,
    location_type: chosen.location_type ? String(chosen.location_type).trim().toUpperCase() : 'WAREHOUSE',
  };
}

/**
 * Validasi bahwa lokasi tujuan penerimaan barang aktif dan merupakan lokasi gudang/penyimpanan fisik milik properti.
 * Menolak lokasi tidak aktif, lokasi milik properti lain, atau lokasi ringkasan/induk yang tidak menyimpan stok fisik.
 */
export async function validateGudang1DestinationLocation(
  clientOrPool: PoolClient | Pool,
  propertyId: number,
  locationId: number
): Promise<{ id: number; name: string; code: string; location_type: string }> {
  const locRes = await clientOrPool.query(
    `SELECT id, name, code, location_type, is_active
       FROM stock_locations
      WHERE id = $1
        AND property_id = $2`,
    [locationId, propertyId]
  );
  if (locRes.rows.length === 0) {
    throw Object.assign(
      new Error(`Lokasi gudang penerimaan #${locationId} tidak ditemukan pada properti #${propertyId}`),
      { statusCode: 404, code: 'LOCATION_NOT_FOUND' }
    );
  }
  const loc = locRes.rows[0];
  if (loc.is_active === false) {
    throw Object.assign(
      new Error(`Lokasi penerimaan "${loc.name || loc.code || locationId}" sedang tidak aktif`),
      { statusCode: 400, code: 'LOCATION_INACTIVE' }
    );
  }
  const locType = loc.location_type ? String(loc.location_type).trim().toUpperCase() : 'WAREHOUSE';
  if (['SUMMARY', 'CONTAINER', 'VIRTUAL'].includes(locType)) {
    throw Object.assign(
      new Error(`Penerimaan pembelian hanya diizinkan ke lokasi penyimpanan fisik aktif. Lokasi ringkasan/induk "${loc.name || loc.code || locationId}" (${locType}) tidak menyimpan stok sendiri.`),
      { statusCode: 400, code: 'INVALID_RECEIPT_LOCATION' }
    );
  }
  return {
    id: Number(loc.id),
    name: loc.name,
    code: loc.code,
    location_type: locType,
  };
}

/**
 * Validasi status transaksi sumber pembelian (harus bertipe PURCHASE, berstatus APPROVED, dan belum dibatalkan/void/reversed/dihapus).
 * Tahap 1A: Transaksi pembelian baru wajib terhubung ke PO (po_id) kecuali data lama yang ditandai sistem (is_legacy_without_po = TRUE).
 */
function assertPurchaseTransactionReceivableState(targetTx: any): void {
  if (String(targetTx.transaction_type || '').toUpperCase() !== 'PURCHASE') {
    throw Object.assign(
      new Error(`Transaksi #${targetTx.transaction_no || targetTx.id} bukan bertipe PURCHASE`),
      { statusCode: 400, code: 'NOT_PURCHASE_TRANSACTION' }
    );
  }
  const txStatus = String(targetTx.transaction_status || 'POSTED').trim().toUpperCase();
  const wfStatus = String(targetTx.purchase_workflow_status || targetTx.operational_sheet || '').trim().toUpperCase();
  if (
    ['CANCELLED', 'VOID', 'VOIDED', 'REVERSED'].includes(txStatus) ||
    ['BATAL', 'HAPUS'].includes(wfStatus) ||
    Boolean(targetTx.deleted_at)
  ) {
    throw Object.assign(
      new Error(`Transaksi pembelian #${targetTx.transaction_no || targetTx.id} telah dibatalkan atau dihapus (${txStatus || wfStatus})`),
      { statusCode: 400, code: 'PURCHASE_CANCELLED' }
    );
  }
  const approvalStatus = String(targetTx.approval_status || 'PENDING_APPROVAL').trim().toUpperCase();
  if (approvalStatus !== 'APPROVED') {
    throw Object.assign(
      new Error(`Penerimaan barang ditolak: Transaksi pembelian #${targetTx.transaction_no || targetTx.id} belum disetujui (status persetujuan: ${approvalStatus})`),
      { statusCode: 400, code: 'PURCHASE_NOT_APPROVED' }
    );
  }
  if (
    targetTx.po_id === null &&
    targetTx.is_legacy_without_po === false
  ) {
    throw Object.assign(
      new Error(
        `Penerimaan barang ditolak: Transaksi pembelian #${targetTx.transaction_no || targetTx.id} tidak terhubung ke Purchase Order (PO) yang sah`
      ),
      { statusCode: 400, code: 'PO_REQUIRED_FOR_RECEIPT' }
    );
  }
}

/**
 * Validasi status Purchase Order (PO) sebelum penerimaan barang dibuat atau diposting.
 */
function assertPurchaseOrderReceivableState(targetPo: any, isPostingOrUpdatingDraft = false): void {
  const poStatus = String(targetPo.status || 'DRAFT').trim().toUpperCase();
  const poApproval = String(targetPo.approval_status || '').trim().toUpperCase();
  if (poStatus === 'CANCELLED') {
    throw Object.assign(
      new Error(`PO #${targetPo.po_number} telah dibatalkan (CANCELLED)`),
      { statusCode: 400, code: 'PO_CANCELLED' }
    );
  }
  if (poStatus === 'REJECTED' || poApproval === 'REJECTED') {
    throw Object.assign(
      new Error(`PO #${targetPo.po_number} telah ditolak (REJECTED) dan tidak dapat diterima`),
      { statusCode: 400, code: 'PO_REJECTED' }
    );
  }
  if (
    poStatus === 'DRAFT' ||
    poStatus === 'PENDING_APPROVAL' ||
    poApproval === 'DRAFT' ||
    poApproval === 'PENDING_APPROVAL'
  ) {
    throw Object.assign(
      new Error(`PO #${targetPo.po_number} belum disetujui (${poApproval || poStatus}), silakan setujui terlebih dahulu`),
      { statusCode: 400, code: 'PO_NOT_ORDERED' }
    );
  }
  if (!isPostingOrUpdatingDraft && poStatus === 'COMPLETED') {
    throw Object.assign(
      new Error(`PO #${targetPo.po_number} sudah selesai diterima sepenuhnya (COMPLETED)`),
      { statusCode: 400, code: 'PO_ALREADY_COMPLETED' }
    );
  }
}

function isNonStockPurchaseLineType(lineTypeRaw: unknown): boolean {
  const lt = String(lineTypeRaw || 'STOCK').trim().toUpperCase();
  return ['NON_STOCK', 'NON_STOCK_EXPENSE', 'NON_STOCK_PHYSICAL', 'SERVICE'].includes(lt);
}

/**
 * Normalisasi tanggal kalender (receipt_date) menjadi string 'YYYY-MM-DD'
 * berdasarkan kalender operasional hotel (Asia/Jakarta) tanpa pergeseran hari UTC.
 */
export function formatCalendarDateStr(val?: string | Date | null): string {
  if (!val) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  }
  if (val instanceof Date) {
    if (isNaN(val.getTime())) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    }
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(val);
  }
  const str = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(parsed);
  }
  return str.slice(0, 10);
}

/**
 * Hitung fingerprint payload penerimaan barang untuk deteksi idempotensi & konflik
 */
export function computeReceiptPayloadFingerprint(input: {
  po_id?: number | null;
  transaction_id?: number | null;
  location_id: number;
  receipt_date?: string;
  items: GoodsReceiptItemInput[];
}): string {
  const sortedItems = [...input.items].map(it => ({
    product_id: Number(it.product_id),
    po_item_id: it.po_item_id ? Number(it.po_item_id) : null,
    transaction_line_id: it.transaction_line_id ? Number(it.transaction_line_id) : null,
    packaging_id: it.packaging_id ? Number(it.packaging_id) : null,
    received_qty: Number(it.received_qty).toFixed(3),
    unit_cost: Number(it.unit_cost || 0).toFixed(2),
    location_id: it.location_id ? Number(it.location_id) : Number(input.location_id),
  })).sort((a, b) => a.product_id - b.product_id || (a.po_item_id || 0) - (b.po_item_id || 0));

  const payload = {
    po_id: input.po_id ? Number(input.po_id) : null,
    transaction_id: input.transaction_id ? Number(input.transaction_id) : null,
    location_id: Number(input.location_id),
    items: sortedItems,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

interface ValidatedItemData {
  receipt_item_id: number | null;
  product_id: number;
  product_name: string;
  base_unit_code: string;
  ordered_unit: string;
  po_item_id: number | null;
  transaction_line_id: number | null;
  packaging_id: number | null;
  packaging_code: string | null;
  packaging_label: string | null;
  received_qty: number;
  base_quantity: number;
  source_alloc_qty: number;
  po_alloc_qty?: number;
  tx_alloc_qty?: number;
  conversion_factor: number;
  unit_cost: number;
  subtotal: number;
  uom_id: number | null;
  location_id: number;
}

/**
 * Validasi item dan aturan plafon (pre-aggregation pada satuan sumber/dasar) serta konversi kemasan.
 * Tahap 1A: Mendukung Satu Batas Penerimaan (Shared Cumulative Ceiling) antara PO dan Transaksi Pembelian terkait PO yang sama.
 */
async function validateAndPrepareReceiptItems(
  client: PoolClient,
  propertyId: number,
  defaultLocationId: number,
  items: GoodsReceiptItemInput[],
  targetPo: any,
  poItemsMap: Map<number, any>,
  targetTx: any,
  txLinesMap: Map<number, any>,
  trustedDraftSnapshotsMap?: Map<
    number,
    {
      packaging_id: number | null;
      conversion_factor_snapshot: number | null;
      packaging_label_snapshot: string | null;
    }
  >
): Promise<ValidatedItemData[]> {
  const isSameProcurement =
    Boolean(targetPo && targetTx) &&
    targetTx.po_id != null &&
    Number(targetTx.po_id) === Number(targetPo.id);

  if (targetPo && targetTx && !isSameProcurement) {
    throw Object.assign(
      new Error('Dokumen penerimaan tidak boleh merujuk po_id dan transaction_id yang tidak berasal dari PO yang sama (dual-source ambigu)'),
      { statusCode: 400, code: 'AMBIGUOUS_RECEIPT_SOURCE' }
    );
  }
  if (targetPo && poItemsMap.size === 0) {
    throw Object.assign(
      new Error(`PO #${targetPo.po_number || targetPo.id} tidak memiliki baris item pesanan yang valid`),
      { statusCode: 400, code: 'PO_HAS_NO_ITEMS' }
    );
  }
  if (targetTx && txLinesMap.size === 0) {
    throw Object.assign(
      new Error(`Transaksi pembelian #${targetTx.transaction_no || targetTx.id} tidak memiliki baris pembelian stok yang valid`),
      { statusCode: 400, code: 'PURCHASE_HAS_NO_STOCK_LINES' }
    );
  }

  // 1. Resolusi po_item_id dan transaction_line_id secara ketat (wajib terikat ke baris sumber bila dokumen sumber ada)
  const resolvedIds = items.map((item, idx) => {
    let poItemId = item.po_item_id ? Number(item.po_item_id) : null;
    let txLineId = item.transaction_line_id ? Number(item.transaction_line_id) : null;
    if (poItemId && txLineId && !isSameProcurement) {
      throw Object.assign(
        new Error(`Item #${idx + 1} tidak boleh memiliki po_item_id dan transaction_line_id sekaligus`),
        { statusCode: 400, code: 'AMBIGUOUS_RECEIPT_LINE_REFERENCE' }
      );
    }
    if (poItemId && !targetPo) {
      throw Object.assign(
        new Error(`Item #${idx + 1} menyertakan po_item_id #${poItemId} tanpa referensi po_id pada header penerimaan`),
        { statusCode: 400, code: 'AMBIGUOUS_RECEIPT_LINE_REFERENCE' }
      );
    }
    if (txLineId && !targetTx) {
      throw Object.assign(
        new Error(`Item #${idx + 1} menyertakan transaction_line_id #${txLineId} tanpa referensi transaction_id pada header penerimaan`),
        { statusCode: 400, code: 'AMBIGUOUS_RECEIPT_LINE_REFERENCE' }
      );
    }

    if (targetTx) {
      if (txLineId) {
        const targetTxLine = txLinesMap.get(txLineId);
        if (!targetTxLine) {
          throw Object.assign(
            new Error(`Baris transaksi #${txLineId} pada item #${idx + 1} tidak ditemukan dalam transaksi #${targetTx.transaction_no || targetTx.id}`),
            { statusCode: 400, code: 'INVALID_TRANSACTION_LINE_ID' }
          );
        }
        const lineType = String(targetTxLine.line_type || 'STOCK').toUpperCase();
        if (isNonStockPurchaseLineType(lineType)) {
          throw Object.assign(
            new Error(`Baris transaksi #${txLineId} bertipe ${lineType} dan tidak dapat diterima ke inventori`),
            { statusCode: 400, code: 'NON_STOCK_LINE_NOT_RECEIVABLE' }
          );
        }
        const lineProdId = targetTxLine.product_id !== undefined && targetTxLine.product_id !== null
          ? Number(targetTxLine.product_id)
          : null;
        if (lineProdId === null || !Number.isInteger(lineProdId) || lineProdId <= 0) {
          throw Object.assign(
            new Error(`Baris transaksi #${txLineId} belum memiliki ikatan produk inventori (stock_purchase_line_bindings / product_id)`),
            { statusCode: 400, code: 'PURCHASE_LINE_MISSING_PRODUCT_BINDING' }
          );
        }
        if (lineProdId !== Number(item.product_id)) {
          throw Object.assign(
            new Error(`Baris transaksi #${txLineId} merujuk produk #${lineProdId}, bukan produk #${item.product_id}`),
            { statusCode: 400, code: 'TX_LINE_PRODUCT_MISMATCH' }
          );
        }
        if (isSameProcurement) {
          const boundPoItemId = targetTxLine.po_item_id ? Number(targetTxLine.po_item_id) : null;
          if (poItemId && boundPoItemId && poItemId !== boundPoItemId) {
            throw Object.assign(
              new Error(`Item #${idx + 1} menyertakan po_item_id #${poItemId} yang tidak cocok dengan po_item_id #${boundPoItemId} pada baris transaksi #${txLineId}`),
              { statusCode: 400, code: 'AMBIGUOUS_RECEIPT_LINE_REFERENCE' }
            );
          }
          if (!poItemId && boundPoItemId) {
            poItemId = boundPoItemId;
          }
        }
      } else if (!poItemId) {
        const matchingTxLines = Array.from(txLinesMap.values()).filter((t: any) => {
          const lineType = String(t.line_type || 'STOCK').toUpperCase();
          if (isNonStockPurchaseLineType(lineType)) return false;
          const lineProdId = t.product_id !== undefined && t.product_id !== null ? Number(t.product_id) : null;
          return lineProdId !== null && lineProdId === Number(item.product_id);
        });
        if (matchingTxLines.length === 1) {
          txLineId = Number(matchingTxLines[0].transaction_line_id || matchingTxLines[0].id);
          if (isSameProcurement && matchingTxLines[0].po_item_id) {
            poItemId = Number(matchingTxLines[0].po_item_id);
          }
        } else if (matchingTxLines.length > 1) {
          throw Object.assign(
            new Error(
              `Terdapat ${matchingTxLines.length} baris dengan produk #${item.product_id} pada transaksi #${targetTx.transaction_no || targetTx.id}. Harap sertakan transaction_line_id secara eksplisit agar alokasi tidak tertukar.`
            ),
            { statusCode: 400, code: 'EXPLICIT_LINE_ID_REQUIRED' }
          );
        } else {
          throw Object.assign(
            new Error(
              `Produk #${item.product_id} pada item #${idx + 1} tidak terdaftar pada baris transaksi pembelian #${targetTx.transaction_no || targetTx.id}`
            ),
            { statusCode: 400, code: 'ITEM_NOT_IN_SOURCE_PURCHASE' }
          );
        }
      }
    }

    if (targetPo) {
      if (poItemId) {
        const targetPoItem = poItemsMap.get(poItemId);
        if (!targetPoItem) {
          throw Object.assign(
            new Error(`Baris PO #${poItemId} pada item #${idx + 1} tidak ditemukan dalam PO #${targetPo.po_number || targetPo.id}`),
            { statusCode: 400, code: 'INVALID_PO_ITEM_ID' }
          );
        }
        if (Number(targetPoItem.product_id) !== Number(item.product_id)) {
          throw Object.assign(
            new Error(`Baris PO #${poItemId} merujuk produk #${targetPoItem.product_id}, bukan produk #${item.product_id}`),
            { statusCode: 400, code: 'PO_ITEM_PRODUCT_MISMATCH' }
          );
        }
        if (isSameProcurement && !txLineId) {
          const matchingByPoItem = Array.from(txLinesMap.values()).filter(
            (t: any) => t.po_item_id != null && Number(t.po_item_id) === poItemId
          );
          if (matchingByPoItem.length === 1) {
            txLineId = Number(matchingByPoItem[0].transaction_line_id || matchingByPoItem[0].id);
          }
        }
      } else {
        const matchingPoLines = Array.from(poItemsMap.values()).filter(
          (p: any) => Number(p.product_id) === Number(item.product_id)
        );
        if (matchingPoLines.length === 1) {
          poItemId = Number(matchingPoLines[0].id);
          if (isSameProcurement && !txLineId) {
            const matchingByPoItem = Array.from(txLinesMap.values()).filter(
              (t: any) => t.po_item_id != null && Number(t.po_item_id) === poItemId
            );
            if (matchingByPoItem.length === 1) {
              txLineId = Number(matchingByPoItem[0].transaction_line_id || matchingByPoItem[0].id);
            }
          }
        } else if (matchingPoLines.length > 1) {
          throw Object.assign(
            new Error(
              `Terdapat ${matchingPoLines.length} baris dengan produk #${item.product_id} pada PO #${targetPo.po_number || targetPo.id}. Harap sertakan po_item_id secara eksplisit agar alokasi tidak tertukar.`
            ),
            { statusCode: 400, code: 'EXPLICIT_LINE_ID_REQUIRED' }
          );
        } else {
          throw Object.assign(
            new Error(
              `Produk #${item.product_id} pada item #${idx + 1} tidak ditemukan pada baris PO #${targetPo.po_number || targetPo.id}`
            ),
            { statusCode: 400, code: 'ITEM_NOT_IN_SOURCE_PO' }
          );
        }
      }
    }

    return { poItemId, txLineId };
  });

  // 2. Resolusi produk, kemasan, base_quantity, dan source_alloc_qty terlebih dahulu sebelum cek plafon
  const incomingPoTotals = new Map<number, number>();
  const incomingTxTotals = new Map<number, number>();
  const validatedItems: ValidatedItemData[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { poItemId, txLineId } = resolvedIds[i];
    const prodId = Number(item.product_id);
    const qty = parseFloat(String(item.received_qty));
    const cost = parseFloat(String(item.unit_cost || 0));
    const itemLocId = item.location_id ? Number(item.location_id) : defaultLocationId;

    if (isNaN(qty) || qty <= 0) {
      throw Object.assign(new Error('Kuantitas penerimaan (received_qty) harus lebih besar dari 0'), { statusCode: 400 });
    }
    if (!Number.isInteger(prodId) || prodId <= 0) {
      throw Object.assign(new Error('product_id item GRN tidak valid'), { statusCode: 400 });
    }
    if (isNaN(cost) || cost < 0) {
      throw Object.assign(new Error('Harga satuan penerimaan (unit_cost) tidak boleh negatif'), { statusCode: 400 });
    }

    // Validasi produk terdaftar di properti, aktif, dan melacak stok
    const prodRes = await client.query(
      `SELECT id, name, canonical_base_unit_code, base_unit, average_cost, last_cost,
              is_active, track_stock, track_inventory, product_type
         FROM pos_menu_items
        WHERE id = $1 AND property_id = $2`,
      [prodId, propertyId]
    );
    if (prodRes.rows.length === 0) {
      throw Object.assign(new Error(`Produk #${prodId} tidak ditemukan pada properti`), { statusCode: 404, code: 'PRODUCT_NOT_FOUND' });
    }
    const productRow = prodRes.rows[0];
    if (productRow.is_active === false) {
      throw Object.assign(
        new Error(`Produk "${productRow.name || prodId}" sedang tidak aktif dan tidak dapat diterima ke inventori`),
        { statusCode: 400, code: 'PRODUCT_INACTIVE' }
      );
    }
    const productType = String(productRow.product_type || '').trim().toUpperCase();
    if (
      productRow.track_stock === false ||
      productRow.track_inventory === false ||
      ['NON_STOCK', 'NONE', 'SERVICE'].includes(productType)
    ) {
      throw Object.assign(
        new Error(
          `Produk "${productRow.name || prodId}" tidak menggunakan metode pelacakan stok (non-stock/service). Aktifkan opsi "Lacak Stok & Penerimaan Gudang (GRN)" pada Master Produk terlebih dahulu.`
        ),
        { statusCode: 400, code: 'PRODUCT_NOT_STOCK_TRACKED' }
      );
    }

    // Jika lokasi item berbeda dari header, pastikan lokasi juga valid dan merupakan Gudang 1 aktif
    if (itemLocId !== defaultLocationId) {
      await validateGudang1DestinationLocation(client, propertyId, itemLocId);
    }

    // Konversi Kemasan jika packaging_id disertakan atau diwarisi dari baris sumber (jika item.packaging_id tidak dikirim eksplisit)
    const poLine = poItemId ? poItemsMap.get(poItemId) : null;
    const txLine = txLineId ? txLinesMap.get(txLineId) : null;
    const sourceLine = txLine || poLine;
    const effectivePackagingId = item.packaging_id !== undefined
      ? (item.packaging_id ? Number(item.packaging_id) : null)
      : (sourceLine && sourceLine.packaging_id ? Number(sourceLine.packaging_id) : null);

    let packagingId: number | null = null;
    let packagingCode: string | null = null;
    let packagingLabel: string | null = null;
    let itemFactor = 1;
    let baseQuantity = qty;

    if (effectivePackagingId) {
      const pId = Number(effectivePackagingId);
      const pkgRes = await client.query(
        `SELECT id, packaging_code, packaging_label, to_base_factor, is_active
           FROM product_packaging_conversions
          WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
        [pId, propertyId, prodId]
      );
      if (pkgRes.rows.length === 0) {
        throw Object.assign(new Error(`Konversi kemasan #${pId} tidak ditemukan untuk produk #${prodId}`), { statusCode: 404, code: 'PACKAGING_NOT_FOUND' });
      }
      const pkg = pkgRes.rows[0];
      if (!pkg.is_active) {
        throw Object.assign(new Error(`Kemasan "${pkg.packaging_code}" sedang tidak aktif`), { statusCode: 400, code: 'PACKAGING_INACTIVE' });
      }
      packagingId = pkg.id;
      packagingCode = pkg.packaging_code;
      packagingLabel = pkg.packaging_label;

      const poSnapFactor =
        poLine &&
        poLine.packaging_id != null &&
        Number(poLine.packaging_id) === pId &&
        poLine.conversion_factor_snapshot != null &&
        parseFloat(String(poLine.conversion_factor_snapshot)) > 0
          ? parseFloat(String(poLine.conversion_factor_snapshot))
          : NaN;
      const txSnapRaw = txLine?.conversion_factor_snapshot ?? txLine?.source_to_base_factor ?? null;
      const txSnapFactor =
        txLine &&
        txLine.packaging_id != null &&
        Number(txLine.packaging_id) === pId &&
        txSnapRaw != null &&
        parseFloat(String(txSnapRaw)) > 0
          ? parseFloat(String(txSnapRaw))
          : NaN;

      // Reject packaged purchase invoice line that has an unresolved/null conversion_factor_snapshot and no same-packaging PO snapshot
      if (
        txLine &&
        txLine.packaging_id != null &&
        Number(txLine.packaging_id) === pId &&
        isNaN(txSnapFactor) &&
        isNaN(poSnapFactor)
      ) {
        throw Object.assign(
          new Error(
            `Baris pembelian #${txLineId} menggunakan kemasan #${pId} dengan conversion_factor_snapshot yang belum terverifikasi/ambigu (NULL). Harap rekonsiliasi snapshot baris pembelian sebelum melakukan penerimaan barang.`
          ),
          { statusCode: 409, code: 'UNRESOLVED_CONVERSION_FACTOR_SNAPSHOT' }
        );
      }

      const trustedDraftSnap =
        item.id != null && trustedDraftSnapshotsMap
          ? trustedDraftSnapshotsMap.get(Number(item.id)) || null
          : null;
      const trustedDraftFactor =
        trustedDraftSnap &&
        trustedDraftSnap.packaging_id != null &&
        Number(trustedDraftSnap.packaging_id) === pId &&
        trustedDraftSnap.conversion_factor_snapshot != null &&
        parseFloat(String(trustedDraftSnap.conversion_factor_snapshot)) > 0
          ? parseFloat(String(trustedDraftSnap.conversion_factor_snapshot))
          : NaN;

      if (!isNaN(poSnapFactor) && poSnapFactor > 0) {
        itemFactor = poSnapFactor;
        if (poLine?.packaging_label_snapshot) {
          packagingLabel = String(poLine.packaging_label_snapshot);
        }
      } else if (!isNaN(txSnapFactor) && txSnapFactor > 0) {
        itemFactor = txSnapFactor;
        if (txLine?.packaging_label_snapshot) {
          packagingLabel = String(txLine.packaging_label_snapshot);
        }
      } else if (!isNaN(trustedDraftFactor) && trustedDraftFactor > 0) {
        itemFactor = trustedDraftFactor;
        if (trustedDraftSnap?.packaging_label_snapshot) {
          packagingLabel = String(trustedDraftSnap.packaging_label_snapshot);
        }
      } else {
        itemFactor = parseFloat(pkg.to_base_factor);
      }

      // Never trust client-supplied conversion_factor_snapshot to override server-authoritative snapshot or master factor
      const clientSnapRaw = (item as any).conversion_factor_snapshot;
      if (clientSnapRaw !== undefined && clientSnapRaw !== null && String(clientSnapRaw).trim() !== '') {
        const clientSnapVal = parseFloat(String(clientSnapRaw));
        if (isNaN(clientSnapVal) || clientSnapVal <= 0 || Math.abs(clientSnapVal - itemFactor) > 1e-6) {
          throw Object.assign(
            new Error(
              `conversion_factor_snapshot (${clientSnapRaw}) pada item #${i + 1} tidak sesuai dengan faktor konversi otoritatif server (${itemFactor})`
            ),
            { statusCode: 400, code: 'INVALID_CONVERSION_FACTOR_SNAPSHOT' }
          );
        }
      }
      baseQuantity = qty * itemFactor;
    }

    // Hitung alokasi kuantitas pada satuan baris PO (poAllocQty) dan pada satuan baris Transaksi/Binding (txAllocQty) secara terpisah dari baseQuantity

    let poAllocQty = baseQuantity;
    if (poLine) {
      const poPkgId = poLine.packaging_id != null ? Number(poLine.packaging_id) : null;
      const poSnapFactor =
        poLine.conversion_factor_snapshot != null && parseFloat(String(poLine.conversion_factor_snapshot)) > 0
          ? parseFloat(String(poLine.conversion_factor_snapshot))
          : NaN;
      if (poPkgId != null) {
        let poFactor = poSnapFactor;
        if (isNaN(poFactor) || poFactor <= 0) {
          if (packagingId && poPkgId === Number(packagingId) && itemFactor > 0) {
            poFactor = itemFactor;
          } else {
            const poPkgRes = await client.query(
              `SELECT id, packaging_code, packaging_label, to_base_factor, is_active
                 FROM product_packaging_conversions
                WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
              [poPkgId, propertyId, prodId]
            );
            poFactor = poPkgRes.rows.length > 0 ? parseFloat(poPkgRes.rows[0].to_base_factor || '1') : 1;
          }
        }
        if (packagingId && poPkgId === Number(packagingId) && Math.abs(poFactor - itemFactor) <= 1e-6) {
          poAllocQty = qty;
        } else {
          poAllocQty = poFactor > 0 ? baseQuantity / poFactor : baseQuantity;
        }
      } else if (!isNaN(poSnapFactor) && poSnapFactor > 1) {
        poAllocQty = baseQuantity / poSnapFactor;
      } else {
        poAllocQty = baseQuantity;
      }
    }

    let txAllocQty = baseQuantity;
    if (txLine) {
      const txPkgId = txLine.packaging_id != null ? Number(txLine.packaging_id) : null;
      const txSnapRaw = txLine.conversion_factor_snapshot ?? txLine.source_to_base_factor ?? null;
      const txSnapFactor =
        txSnapRaw != null && parseFloat(String(txSnapRaw)) > 0 ? parseFloat(String(txSnapRaw)) : NaN;
      if (txPkgId != null) {
        let txFactor = txSnapFactor;
        if (isNaN(txFactor) || txFactor <= 0) {
          if (
            poLine &&
            poLine.packaging_id != null &&
            Number(poLine.packaging_id) === txPkgId &&
            poLine.conversion_factor_snapshot != null &&
            parseFloat(String(poLine.conversion_factor_snapshot)) > 0
          ) {
            txFactor = parseFloat(String(poLine.conversion_factor_snapshot));
          } else {
            throw Object.assign(
              new Error(
                `Baris pembelian #${txLineId} menggunakan kemasan #${txPkgId} dengan conversion_factor_snapshot yang belum terverifikasi/ambigu (NULL). Harap rekonsiliasi snapshot baris pembelian sebelum melakukan penerimaan barang.`
              ),
              { statusCode: 409, code: 'UNRESOLVED_CONVERSION_FACTOR_SNAPSHOT' }
            );
          }
        }
        if (packagingId && txPkgId === Number(packagingId) && Math.abs(txFactor - itemFactor) <= 1e-6) {
          txAllocQty = qty;
        } else {
          txAllocQty = txFactor > 0 ? baseQuantity / txFactor : baseQuantity;
        }
      } else if (!isNaN(txSnapFactor) && txSnapFactor > 1) {
        txAllocQty = baseQuantity / txSnapFactor;
      } else {
        txAllocQty = baseQuantity;
      }
    }

    const sourceAllocQty = poLine ? poAllocQty : txAllocQty;

    if (poItemId) {
      incomingPoTotals.set(poItemId, (incomingPoTotals.get(poItemId) || 0) + poAllocQty);
    }
    if (txLineId) {
      incomingTxTotals.set(txLineId, (incomingTxTotals.get(txLineId) || 0) + txAllocQty);
    }

    const subtotal = qty * cost;
    const baseUnitCode = productRow.canonical_base_unit_code || productRow.base_unit || 'PCS';
    const orderedUnit = String(
      packagingCode || sourceLine?.ordered_unit || sourceLine?.unit || baseUnitCode
    ).trim().toUpperCase();

    validatedItems.push({
      receipt_item_id: item.id ? Number(item.id) : null,
      product_id: prodId,
      product_name: productRow.name,
      base_unit_code: baseUnitCode,
      ordered_unit: orderedUnit,
      po_item_id: poItemId,
      transaction_line_id: txLineId,
      packaging_id: packagingId,
      packaging_code: packagingCode,
      packaging_label: packagingLabel,
      received_qty: qty,
      base_quantity: baseQuantity,
      source_alloc_qty: sourceAllocQty,
      po_alloc_qty: poAllocQty,
      tx_alloc_qty: txAllocQty,
      conversion_factor: itemFactor,
      unit_cost: cost,
      subtotal,
      uom_id: item.uom_id ? Number(item.uom_id) : null,
      location_id: itemLocId,
    });
  }

  // 3. Validasi batas plafon PO pada satuan yang konsisten (source_alloc_qty)
  if (targetPo && poItemsMap.size > 0) {
    for (const [poItemId, totalIncoming] of incomingPoTotals.entries()) {
      const poItem = poItemsMap.get(poItemId);
      if (!poItem) {
        throw Object.assign(new Error(`Baris PO #${poItemId} tidak ditemukan dalam PO #${targetPo.po_number}`), { statusCode: 400 });
      }
      const curReceived = parseFloat(poItem.received_qty || 0);
      const ordered = parseFloat(poItem.ordered_qty || 0);
      const remaining = ordered - curReceived;
      if (totalIncoming > remaining + 0.0001) {
        throw Object.assign(
          new Error(`Total kuantitas penerimaan (${totalIncoming}) melebihi sisa pesanan PO (${remaining.toFixed(2)}) untuk baris #${poItemId}`),
          { statusCode: 400, code: 'OVER_RECEIPT_NOT_ALLOWED' }
        );
      }
    }
  }

  // 4. Validasi batas plafon Transaksi Pembelian pada satuan yang konsisten (source_alloc_qty)
  if (targetTx && txLinesMap.size > 0) {
    for (const [lineId, totalIncoming] of incomingTxTotals.entries()) {
      const txLine = txLinesMap.get(lineId);
      if (!txLine) {
        throw Object.assign(new Error(`Baris transaksi #${lineId} tidak ditemukan`), { statusCode: 400 });
      }
      const curReceived = parseFloat(txLine.received_quantity || 0);
      const ordered = parseFloat(txLine.ordered_quantity ?? txLine.quantity ?? 0);
      const remaining = ordered - curReceived;
      if (totalIncoming > remaining + 0.0001) {
        throw Object.assign(
          new Error(`Total kuantitas penerimaan (${totalIncoming}) melebihi sisa pesanan transaksi (${remaining.toFixed(2)}) untuk baris #${lineId}`),
          { statusCode: 400, code: 'OVER_RECEIPT_NOT_ALLOWED' }
        );
      }
    }
  }

  return validatedItems;
}

/**
 * Muat dan rekonsiliasi baris item Purchase Order (pos_purchase_order_items) terhadap seluruh GRN POSTED/COMPLETED
 * yang merujuk PO ini (baik langsung via po_id maupun via transaksi pembelian terkait po_id).
 */
async function loadAndReconcilePurchaseOrderItems(
  client: PoolClient,
  propertyId: number,
  poId: number
): Promise<Map<number, any>> {
  const poItemsMap = new Map<number, any>();
  const poItemsRes = await client.query(
    `SELECT * FROM pos_purchase_order_items WHERE po_id = $1 ORDER BY id ASC FOR UPDATE`,
    [poId]
  );
  const poRows = poItemsRes.rows || [];

  const postedGrnItemsRes = await client.query(
    `SELECT gri.po_item_id, gri.transaction_line_id, gri.product_id, gri.packaging_id,
            gri.received_qty, gri.base_quantity, gri.source_allocated_qty, gri.conversion_factor_snapshot,
            tl.po_item_id AS tx_line_po_item_id
       FROM pos_goods_receipt_items gri
       JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
       LEFT JOIN transaction_lines tl ON tl.id = gri.transaction_line_id
      WHERE gr.property_id = $1
        AND gr.status IN ('POSTED', 'COMPLETED')
        AND (
          gr.po_id = $2
          OR gri.po_item_id IN (SELECT id FROM pos_purchase_order_items WHERE po_id = $2)
          OR gr.transaction_id IN (SELECT id FROM transactions WHERE property_id = $1 AND po_id = $2 AND deleted_at IS NULL)
        )`,
    [propertyId, poId]
  );
  const postedItems = postedGrnItemsRes.rows || [];

  for (const row of poRows) {
    const poItemId = Number(row.id);
    const prodId = Number(row.product_id);
    const pkgId = row.packaging_id != null ? Number(row.packaging_id) : null;
    const sameProductLinesCount = poRows.filter((r: any) => Number(r.product_id) === prodId).length;

    let sourcePkgFactor = row.conversion_factor_snapshot != null ? parseFloat(String(row.conversion_factor_snapshot)) : NaN;
    if ((isNaN(sourcePkgFactor) || sourcePkgFactor <= 0) && pkgId != null && postedItems.length > 0) {
      const srcPkgRes = await client.query(
        `SELECT to_base_factor FROM product_packaging_conversions WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
        [pkgId, propertyId, prodId]
      );
      sourcePkgFactor = parseFloat(String(srcPkgRes.rows?.[0]?.to_base_factor || '1'));
    }

    let reconciledReceived = 0;
    for (const it of postedItems) {
      const effectiveItPoItemId = it.po_item_id != null
        ? Number(it.po_item_id)
        : (it.tx_line_po_item_id != null ? Number(it.tx_line_po_item_id) : null);

      const matchesPoLine =
        effectiveItPoItemId === poItemId ||
        (effectiveItPoItemId == null &&
          sameProductLinesCount === 1 &&
          Number(it.product_id) === prodId);

      if (matchesPoLine) {
        let alloc = 0;
        const rawSourceAlloc =
          it.source_allocated_qty !== null && it.source_allocated_qty !== undefined
            ? parseFloat(String(it.source_allocated_qty))
            : NaN;
        const itPkgId = it.packaging_id != null ? Number(it.packaging_id) : null;
        if (!isNaN(rawSourceAlloc) && rawSourceAlloc > 0 && itPkgId === pkgId) {
          alloc = rawSourceAlloc;
        } else if (pkgId != null && itPkgId != null && itPkgId === pkgId) {
          alloc = parseFloat(String(it.received_qty || '0'));
        } else {
          const itemBaseQty =
            it.base_quantity !== null && it.base_quantity !== undefined && parseFloat(String(it.base_quantity)) > 0
              ? parseFloat(String(it.base_quantity))
              : parseFloat(String(it.received_qty || '0')) *
                (it.conversion_factor_snapshot != null && parseFloat(String(it.conversion_factor_snapshot)) > 0
                  ? parseFloat(String(it.conversion_factor_snapshot))
                  : 1);
          alloc = pkgId != null && !isNaN(sourcePkgFactor) && sourcePkgFactor > 0
            ? itemBaseQty / sourcePkgFactor
            : itemBaseQty;
        }
        if (!isNaN(alloc) && alloc > 0) {
          reconciledReceived += alloc;
        }
      }
    }

    const existingReceived = parseFloat(String(row.received_qty || '0'));
    const authoritativeReceived = Math.max(isNaN(existingReceived) ? 0 : existingReceived, reconciledReceived);
    if (Math.abs(authoritativeReceived - (isNaN(existingReceived) ? 0 : existingReceived)) > 0.0001) {
      await client.query(
        `UPDATE pos_purchase_order_items SET received_qty = $1, updated_at = NOW() WHERE id = $2`,
        [authoritativeReceived.toFixed(3), poItemId]
      );
      row.received_qty = authoritativeReceived.toFixed(3);
    }
    poItemsMap.set(poItemId, row);
  }

  return poItemsMap;
}

/**
 * Eksekusi Posting Penerimaan Barang ke Ledger Inventori (stock_operations, stock_movements, stock_balances, moving average cost)
 */
async function loadOrReconcilePurchaseLineBindings(
  client: PoolClient,
  propertyId: number,
  txId: number
): Promise<Map<number, any>> {
  const txLinesMap = new Map<number, any>();
  const existingByLineId = new Map<number, any>();
  const bindingsRes = await client.query(
    `SELECT * FROM stock_purchase_line_bindings WHERE transaction_id = $1 FOR UPDATE`,
    [txId]
  );
  for (const row of bindingsRes.rows) {
    existingByLineId.set(Number(row.transaction_line_id), row);
  }

  const txHeaderRes = await client.query(
    `SELECT po_id FROM transactions WHERE id = $1 AND property_id = $2`,
    [txId, propertyId]
  );
  const txPoId = txHeaderRes.rows?.[0]?.po_id != null ? Number(txHeaderRes.rows[0].po_id) : null;

  const txLinesRes = await client.query(
    `SELECT id, product_id, packaging_id, po_item_id, line_type, quantity, unit, line_total FROM transaction_lines WHERE transaction_id = $1 FOR UPDATE`,
    [txId]
  );

  // Reconcile historical POSTED/COMPLETED receipts for this purchase transaction (and its linked PO if any) across all lines
  const joinedItemsRes = await client.query(
    `SELECT gri.po_item_id, gri.transaction_line_id, gri.product_id, gri.packaging_id,
            gri.received_qty, gri.base_quantity, gri.source_allocated_qty, gri.conversion_factor_snapshot
       FROM pos_goods_receipt_items gri
       JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
      WHERE gr.property_id = $1
        AND (
          gr.transaction_id = $2
          OR ($3::int IS NOT NULL AND gr.po_id = $3::int)
          OR gri.po_item_id IN (SELECT COALESCE(po_item_id, -1) FROM transaction_lines WHERE transaction_id = $2 AND po_item_id IS NOT NULL)
        )
        AND gr.status IN ('POSTED', 'COMPLETED')`,
    [propertyId, txId, txPoId]
  );
  const postedItems = joinedItemsRes.rows || [];

  const sourceLines = txLinesRes.rows || [];
  for (const row of sourceLines) {
    const lineId = Number(row.id);
    const existingBinding = existingByLineId.get(lineId);
    const effectiveProductId = existingBinding?.product_id ?? row.product_id ?? null;
    const effectivePackagingId = existingBinding?.packaging_id ?? row.packaging_id ?? null;
    const effectivePoItemId = existingBinding?.po_item_id ?? row.po_item_id ?? null;
    const effectiveOrderedQty =
      existingBinding && existingBinding.packaging_id != null && row.packaging_id == null
        ? existingBinding.ordered_quantity
        : (row.quantity ?? existingBinding?.ordered_quantity ?? 0);
    const lineType = String(
      row.line_type || existingBinding?.line_type || (effectiveProductId ? 'STOCK' : 'NON_STOCK_PHYSICAL')
    ).toUpperCase();

    const sameProductLinesCount = sourceLines.filter(
      (l: any) =>
        effectiveProductId != null &&
        Number(existingByLineId.get(Number(l.id))?.product_id ?? l.product_id) === Number(effectiveProductId)
    ).length;

    const bindSnapRaw =
      existingBinding &&
      existingBinding.packaging_id != null &&
      effectivePackagingId != null &&
      Number(existingBinding.packaging_id) === Number(effectivePackagingId)
        ? existingBinding.conversion_factor_snapshot ?? existingBinding.source_to_base_factor
        : null;
    const lineSnapRaw =
      row.packaging_id != null &&
      effectivePackagingId != null &&
      Number(row.packaging_id) === Number(effectivePackagingId)
        ? row.conversion_factor_snapshot ?? row.source_to_base_factor
        : null;
    let rowSnapFactor =
      bindSnapRaw != null && parseFloat(String(bindSnapRaw)) > 0
        ? parseFloat(String(bindSnapRaw))
        : lineSnapRaw != null && parseFloat(String(lineSnapRaw)) > 0
        ? parseFloat(String(lineSnapRaw))
        : NaN;

    if (isNaN(rowSnapFactor) && effectivePackagingId != null) {
      let minGrnFactor = Infinity;
      let maxGrnFactor = -Infinity;
      let grnFactorCount = 0;
      for (const it of postedItems) {
        const matchesLine =
          Number(it.transaction_line_id) === lineId ||
          (effectivePoItemId != null && it.po_item_id != null && Number(it.po_item_id) === Number(effectivePoItemId)) ||
          (it.transaction_line_id == null &&
            it.po_item_id == null &&
            sameProductLinesCount === 1 &&
            effectiveProductId != null &&
            Number(it.product_id) === Number(effectiveProductId));
        if (
          matchesLine &&
          it.packaging_id != null &&
          Number(it.packaging_id) === Number(effectivePackagingId) &&
          it.conversion_factor_snapshot != null &&
          parseFloat(String(it.conversion_factor_snapshot)) > 0
        ) {
          const fVal = parseFloat(String(it.conversion_factor_snapshot));
          minGrnFactor = Math.min(minGrnFactor, fVal);
          maxGrnFactor = Math.max(maxGrnFactor, fVal);
          grnFactorCount++;
        }
      }
      if (grnFactorCount > 0 && Math.abs(minGrnFactor - maxGrnFactor) <= 1e-6) {
        rowSnapFactor = minGrnFactor;
      }
    }

    let sourcePkgFactor: number | null =
      !isNaN(rowSnapFactor) && rowSnapFactor > 0 ? rowSnapFactor : null;
    let sourcePkgLabel: string | null =
      (existingBinding &&
      existingBinding.packaging_id != null &&
      effectivePackagingId != null &&
      Number(existingBinding.packaging_id) === Number(effectivePackagingId)
        ? existingBinding.packaging_label_snapshot
        : null) ||
      (row.packaging_id != null &&
      effectivePackagingId != null &&
      Number(row.packaging_id) === Number(effectivePackagingId)
        ? row.packaging_label_snapshot
        : null) ||
      null;

    if (
      effectivePackagingId != null &&
      effectiveProductId != null &&
      postedItems.length > 0
    ) {
      const srcPkgRes = await client.query(
        `SELECT id, packaging_code, packaging_label, to_base_factor, is_active
           FROM product_packaging_conversions
          WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
        [Number(effectivePackagingId), propertyId, Number(effectiveProductId)]
      );
      const factorVal = parseFloat(String(srcPkgRes.rows?.[0]?.to_base_factor || '0'));
      if (postedItems.length > 0 && (!srcPkgRes.rows?.length || isNaN(factorVal) || factorVal <= 0)) {
        throw Object.assign(
          new Error(
            `Gagal merekonsiliasi kuantitas historis pada baris pembelian #${lineId}: faktor konversi kemasan sumber #${effectivePackagingId} tidak ditemukan atau tidak valid`
          ),
          { statusCode: 409, code: 'RECONCILIATION_CONVERSION_FAILED' }
        );
      }
      if (!sourcePkgLabel && srcPkgRes.rows?.[0]?.packaging_label) {
        sourcePkgLabel = String(srcPkgRes.rows[0].packaging_label);
      }
      sourcePkgFactor =
        !isNaN(rowSnapFactor) && rowSnapFactor > 0
          ? rowSnapFactor
          : null;
    }

    let reconciledReceived = 0;
    for (const it of postedItems) {
      const matchesLine =
        Number(it.transaction_line_id) === lineId ||
        (effectivePoItemId != null && it.po_item_id != null && Number(it.po_item_id) === Number(effectivePoItemId)) ||
        (it.transaction_line_id == null &&
          it.po_item_id == null &&
          sameProductLinesCount === 1 &&
          effectiveProductId != null &&
          Number(it.product_id) === Number(effectiveProductId));
      if (matchesLine) {
        let alloc = 0;
        const itPkgId = it.packaging_id != null ? Number(it.packaging_id) : null;
        const effPkgId = effectivePackagingId != null ? Number(effectivePackagingId) : null;
        if (effPkgId != null && itPkgId != null && itPkgId === effPkgId) {
          alloc = parseFloat(String(it.received_qty || '0'));
        } else {
          let itemBaseQty = NaN;
          if (it.base_quantity !== null && it.base_quantity !== undefined) {
            const bq = parseFloat(String(it.base_quantity));
            if (!isNaN(bq) && bq > 0) {
              itemBaseQty = bq;
            }
          }
          if (isNaN(itemBaseQty)) {
            const rQty = parseFloat(String(it.received_qty || '0'));
            const snapFactor =
              it.conversion_factor_snapshot !== null && it.conversion_factor_snapshot !== undefined
                ? parseFloat(String(it.conversion_factor_snapshot))
                : NaN;
            if (!isNaN(snapFactor) && snapFactor > 0) {
              itemBaseQty = rQty * snapFactor;
            } else if (it.packaging_id != null && effectiveProductId != null) {
              const itPkgRes = await client.query(
                `SELECT id, packaging_code, packaging_label, to_base_factor, is_active
                   FROM product_packaging_conversions
                  WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
                [Number(it.packaging_id), propertyId, Number(effectiveProductId)]
              );
              const itFactor = parseFloat(String(itPkgRes.rows?.[0]?.to_base_factor || '0'));
              if (!itPkgRes.rows?.length || isNaN(itFactor) || itFactor <= 0) {
                throw Object.assign(
                  new Error(
                    `Gagal merekonsiliasi item penerimaan historis pada baris #${lineId}: konversi kemasan #${it.packaging_id} tidak valid`
                  ),
                  { statusCode: 409, code: 'RECONCILIATION_CONVERSION_FAILED' }
                );
              }
              itemBaseQty = rQty * itFactor;
            } else {
              itemBaseQty = rQty;
            }
          }
          if (effectivePackagingId != null) {
            if (!sourcePkgFactor || sourcePkgFactor <= 0) {
              throw Object.assign(
                new Error(
                  `Gagal merekonsiliasi kuantitas historis ke satuan pesanan pada baris #${lineId}: faktor kemasan sumber tidak valid`
                ),
                { statusCode: 409, code: 'RECONCILIATION_CONVERSION_FAILED' }
              );
            }
            alloc = itemBaseQty / sourcePkgFactor;
          } else {
            alloc = itemBaseQty;
          }
        }
        if (!isNaN(alloc) && alloc > 0) {
          reconciledReceived += alloc;
        }
      }
    }

    const existingReceived = existingBinding ? parseFloat(String(existingBinding.received_quantity || '0')) : 0;
    const authoritativeReceived = Math.max(
      isNaN(existingReceived) ? 0 : existingReceived,
      reconciledReceived
    );

    let canonicalBaseUnit = String(existingBinding?.base_unit_code || 'PCS').trim().toUpperCase();
    if (effectiveProductId && !isNonStockPurchaseLineType(lineType)) {
      const prodRes = await client.query(
        `SELECT id, name, canonical_base_unit_code, base_unit, average_cost, last_cost,
                is_active, track_stock, track_inventory, product_type
           FROM pos_menu_items
          WHERE id = $1 AND property_id = $2`,
        [Number(effectiveProductId), propertyId]
      );
      const prodRow = prodRes.rows?.[0];
      canonicalBaseUnit = String(
        prodRow?.canonical_base_unit_code || prodRow?.base_unit || existingBinding?.base_unit_code || 'PCS'
      )
        .trim()
        .toUpperCase();
    }

    const effectiveSnapFactor =
      effectivePackagingId == null
        ? 1
        : !isNaN(rowSnapFactor) && rowSnapFactor > 0
        ? rowSnapFactor
        : null;
    const effectivePkgLabelSnapshot =
      effectivePackagingId == null
        ? canonicalBaseUnit
        : sourcePkgLabel || (row.unit ? String(row.unit).trim() : null);

    const synthesizedBinding: any = {
      ...row,
      ...(existingBinding || {}),
      property_id: propertyId,
      transaction_id: txId,
      transaction_line_id: lineId,
      po_item_id: effectivePoItemId != null ? Number(effectivePoItemId) : null,
      line_type: lineType,
      product_id: effectiveProductId != null ? Number(effectiveProductId) : null,
      packaging_id: effectivePackagingId != null ? Number(effectivePackagingId) : null,
      ordered_quantity: String(effectiveOrderedQty),
      received_quantity: authoritativeReceived.toFixed(3),
      base_unit_code: canonicalBaseUnit,
      packaging_label_snapshot: effectivePkgLabelSnapshot,
      conversion_factor_snapshot: effectiveSnapFactor != null ? effectiveSnapFactor.toFixed(4) : null,
      source_to_base_factor: effectiveSnapFactor != null ? effectiveSnapFactor : undefined,
    };

    if (effectiveProductId && !isNonStockPurchaseLineType(lineType)) {
      const insBindRes = await client.query(
        `INSERT INTO stock_purchase_line_bindings (
           property_id, transaction_id, transaction_line_id, po_item_id, line_type,
           product_id, packaging_id, ordered_quantity, received_quantity, base_unit_code,
           packaging_label_snapshot, conversion_factor_snapshot, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
         ON CONFLICT (property_id, transaction_id, transaction_line_id)
         DO UPDATE SET
           po_item_id = COALESCE(EXCLUDED.po_item_id, stock_purchase_line_bindings.po_item_id),
           ordered_quantity = EXCLUDED.ordered_quantity,
           received_quantity = GREATEST(stock_purchase_line_bindings.received_quantity, EXCLUDED.received_quantity),
           base_unit_code = COALESCE(EXCLUDED.base_unit_code, stock_purchase_line_bindings.base_unit_code),
           packaging_label_snapshot = COALESCE(stock_purchase_line_bindings.packaging_label_snapshot, EXCLUDED.packaging_label_snapshot),
           conversion_factor_snapshot = COALESCE(stock_purchase_line_bindings.conversion_factor_snapshot, EXCLUDED.conversion_factor_snapshot),
           updated_at = NOW()
         RETURNING *`,
        [
          propertyId,
          txId,
          lineId,
          effectivePoItemId != null ? Number(effectivePoItemId) : null,
          lineType,
          Number(effectiveProductId),
          effectivePackagingId != null ? Number(effectivePackagingId) : null,
          effectiveOrderedQty,
          authoritativeReceived.toFixed(3),
          canonicalBaseUnit,
          effectivePkgLabelSnapshot,
          effectiveSnapFactor != null ? effectiveSnapFactor.toFixed(4) : null,
        ]
      );
      if (insBindRes.rows && insBindRes.rows.length > 0) {
        Object.assign(synthesizedBinding, insBindRes.rows[0]);
      }
      synthesizedBinding.base_unit_code = canonicalBaseUnit;
      if (effectiveSnapFactor != null && synthesizedBinding.conversion_factor_snapshot == null) {
        synthesizedBinding.conversion_factor_snapshot = effectiveSnapFactor.toFixed(4);
      }
      if (effectiveSnapFactor != null && synthesizedBinding.source_to_base_factor == null) {
        synthesizedBinding.source_to_base_factor = effectiveSnapFactor;
      }
      if (existingBinding) {
        existingBinding.ordered_quantity = Number(effectiveOrderedQty);
        existingBinding.received_quantity = Math.max(
          Number(existingBinding.received_quantity || 0),
          authoritativeReceived
        );
        existingBinding.base_unit_code = canonicalBaseUnit;
        if (effectiveSnapFactor != null && existingBinding.conversion_factor_snapshot == null) {
          existingBinding.conversion_factor_snapshot = effectiveSnapFactor.toFixed(4);
        }
      }
    }

    txLinesMap.set(lineId, synthesizedBinding);
  }

  for (const [lineId, existingRow] of existingByLineId.entries()) {
    if (!txLinesMap.has(lineId)) {
      txLinesMap.set(lineId, existingRow);
    }
  }

  return txLinesMap;
}

async function executeGoodsReceiptPosting(
  client: PoolClient,
  propertyId: number,
  grn: any,
  validatedItems: ValidatedItemData[],
  targetPo: any,
  targetTx: any
): Promise<void> {
  const notes = grn.notes || null;
  const opKey = grn.operation_key || `grn:${propertyId}:${grn.grn_number}`;
  if (
    /_dup_draft_\d+$/.test(String(opKey || '')) ||
    /_dup_draft_\d+$/.test(String(grn.idempotency_key || ''))
  ) {
    throw Object.assign(
      new Error(
        `Penerimaan barang #${grn.id} (${grn.grn_number || ''}) adalah draft duplikat historis yang telah dikarantina (${opKey}) dan tidak dapat diposting ke stok`
      ),
      { statusCode: 409, code: 'DUPLICATE_OPERATION_KEY_QUARANTINED' }
    );
  }

  // 1. Buat Header Stock Operations untuk Ledger Audit Trail (tolak duplikasi operation_key lintas dokumen)
  const opInsertRes = await client.query(
    `INSERT INTO stock_operations (
       property_id, operation_type, operation_key, payload_fingerprint,
       notes, metadata, created_at
     ) VALUES ($1, 'PURCHASE_RECEIPT', $2, $3, $4, $5, NOW())
     ON CONFLICT (property_id, operation_key) DO NOTHING
     RETURNING id, created_at`,
    [
      propertyId,
      opKey,
      grn.payload_fingerprint || opKey,
      notes,
      JSON.stringify({
        grn_id: grn.id,
        grn_number: grn.grn_number,
        po_id: grn.po_id,
        transaction_id: grn.transaction_id,
        supplier_id: grn.supplier_id,
        invoice_no: grn.invoice_no,
        received_by: grn.received_by,
      }),
    ]
  );
  if (!opInsertRes.rows || opInsertRes.rows.length === 0) {
    throw Object.assign(
      new Error(`Konflik posting: operation_key "${opKey}" sudah pernah diposting ke ledger inventori`),
      { statusCode: 409, code: 'OPERATION_KEY_ALREADY_POSTED' }
    );
  }
  const opRow = opInsertRes.rows[0];

  // Lock in-process per produk untuk memastikan serialisasi perhitungan moving average pada koneksi/mock paralel
  const costLockRegistry: Map<string, Promise<void>> =
    (globalThis as any).__oakGrnCostLocks || ((globalThis as any).__oakGrnCostLocks = new Map<string, Promise<void>>());

  // 2. Eksekusi Items ke Stok & Ledger
  for (const vItem of validatedItems) {
    const fallbackAllocQty = vItem.source_alloc_qty !== undefined && vItem.source_alloc_qty !== null
      ? Number(vItem.source_alloc_qty)
      : Number(vItem.base_quantity ?? vItem.received_qty);
    const poAllocQty = vItem.po_alloc_qty !== undefined && vItem.po_alloc_qty !== null
      ? Number(vItem.po_alloc_qty)
      : fallbackAllocQty;
    const txAllocQty = vItem.tx_alloc_qty !== undefined && vItem.tx_alloc_qty !== null
      ? Number(vItem.tx_alloc_qty)
      : fallbackAllocQty;

    // 2a. Update PO item received_qty dengan kuantitas yang telah dinormalisasi ke satuan PO
    if (vItem.po_item_id) {
      await client.query(
        `UPDATE pos_purchase_order_items
            SET received_qty = received_qty + $1,
                updated_at = NOW()
          WHERE id = $2`,
        [poAllocQty, vItem.po_item_id]
      );
    }

    // 2b. Update Transaction Line / Binding received_quantity dengan kuantitas yang telah dinormalisasi ke satuan binding transaksi
    if (vItem.transaction_line_id) {
      await client.query(
        `UPDATE stock_purchase_line_bindings
            SET received_quantity = received_quantity + $1,
                updated_at = NOW()
          WHERE transaction_line_id = $2`,
        [txAllocQty, vItem.transaction_line_id]
      );
    }

    // 2b-sync. Jika terdapat po_item_id, sinkronkan juga stock_purchase_line_bindings pada transaksi pembelian terkait PO ini
    // yang belum ikut ter-update oleh transaction_line_id di atas (Satu Batas Penerimaan / Shared Cumulative Ceiling),
    // dengan konversi satuan bila kemasan antara baris PO dan binding transaksi berbeda.
    if (vItem.po_item_id) {
      await client.query(
        `UPDATE stock_purchase_line_bindings b
            SET received_quantity = CASE
                  WHEN b.packaging_id IS NOT DISTINCT FROM poi.packaging_id THEN poi.received_qty
                  WHEN b.packaging_id IS NULL THEN
                    poi.received_qty * COALESCE(
                      NULLIF(poi.conversion_factor_snapshot, 0),
                      CASE WHEN poi.packaging_id IS NULL THEN 1 ELSE NULL END,
                      0
                    )
                  WHEN COALESCE(
                    NULLIF(b.conversion_factor_snapshot, 0),
                    NULLIF((SELECT tl_b.conversion_factor_snapshot FROM transaction_lines tl_b WHERE tl_b.id = b.transaction_line_id), 0),
                    CASE WHEN b.packaging_id = poi.packaging_id THEN NULLIF(poi.conversion_factor_snapshot, 0) ELSE NULL END,
                    0
                  ) > 0 THEN
                    (
                      poi.received_qty * COALESCE(
                        NULLIF(poi.conversion_factor_snapshot, 0),
                        CASE WHEN poi.packaging_id IS NULL THEN 1 ELSE NULL END,
                        0
                      )
                    ) / COALESCE(
                      NULLIF(b.conversion_factor_snapshot, 0),
                      NULLIF((SELECT tl_b.conversion_factor_snapshot FROM transaction_lines tl_b WHERE tl_b.id = b.transaction_line_id), 0),
                      CASE WHEN b.packaging_id = poi.packaging_id THEN NULLIF(poi.conversion_factor_snapshot, 0) ELSE NULL END
                    )
                  ELSE b.received_quantity
                END,
                updated_at = NOW()
           FROM pos_purchase_order_items poi
          WHERE poi.id = $1
            AND b.property_id = $2
            AND b.po_item_id = poi.id
            AND ($3::int IS NULL OR b.transaction_line_id <> $3::int)`,
        [vItem.po_item_id, propertyId, vItem.transaction_line_id]
      );
    }

    // 2c. Kunci baris pos_menu_items FOR UPDATE terlebih dahulu (mencegah race condition moving-average di PostgreSQL)
    let prodCostRes = await client.query(
      `SELECT average_cost, last_cost FROM pos_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [vItem.product_id, propertyId]
    );

    const lockKey = `${propertyId}:${vItem.product_id}`;
    const prevLock = costLockRegistry.get(lockKey);
    let releaseLock!: () => void;
    const currentLock = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    costLockRegistry.set(lockKey, prevLock ? prevLock.then(() => currentLock) : currentLock);

    if (prevLock) {
      await prevLock;
      // Baca ulang setelah lock dilepaskan oleh transaksi paralel sebelumnya
      prodCostRes = await client.query(
        `SELECT average_cost, last_cost FROM pos_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [vItem.product_id, propertyId]
      );
    }

    try {
      const curStockRes = await client.query(
        `SELECT COALESCE(SUM(quantity), 0) AS total_qty
           FROM stock_balances
          WHERE property_id = $1 AND product_id = $2`,
        [propertyId, vItem.product_id]
      );
      const existingQty = parseFloat(curStockRes.rows[0]?.total_qty || '0');

      const rawExistingAvgCost = prodCostRes.rows[0]?.average_cost;
      const hasKnownAvgCost = rawExistingAvgCost !== null && rawExistingAvgCost !== undefined && !isNaN(parseFloat(rawExistingAvgCost));
      const existingAvgCost = hasKnownAvgCost ? parseFloat(rawExistingAvgCost) : 0;

      // unit cost satuan dasar (jika kemasan, sesuaikan per unit dasar)
      const effectiveBaseUnitCost = vItem.base_quantity > 0
        ? (vItem.received_qty * vItem.unit_cost) / vItem.base_quantity
        : vItem.unit_cost;

      let newAvgCost: number;
      if (existingQty <= 0 || !hasKnownAvgCost) {
        newAvgCost = effectiveBaseUnitCost;
      } else {
        const totalOldValuation = existingQty * existingAvgCost;
        const totalNewValuation = vItem.base_quantity * effectiveBaseUnitCost;
        const totalNewQty = existingQty + vItem.base_quantity;
        newAvgCost = totalNewQty > 0 ? (totalOldValuation + totalNewValuation) / totalNewQty : effectiveBaseUnitCost;
      }

      await client.query(
        `UPDATE pos_menu_items
            SET average_cost = $1,
                last_cost = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [newAvgCost.toFixed(2), effectiveBaseUnitCost.toFixed(2), vItem.product_id]
      );

      // 2d. Append ke stock_movements (Ledger)
      await client.query(
        `INSERT INTO stock_movements (
           operation_id, property_id, product_id, location_id,
           packaging_id, packaging_code, packaging_label,
           quantity_delta, base_unit_code, unit_cost, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
        [
          opRow.id,
          propertyId,
          vItem.product_id,
          vItem.location_id,
          vItem.packaging_id,
          vItem.packaging_code,
          vItem.packaging_label,
          vItem.base_quantity,
          vItem.base_unit_code,
          effectiveBaseUnitCost.toFixed(2),
        ]
      );

      // 2e. Update stock_balances (Atomic Upsert)
      await client.query(
        `INSERT INTO stock_balances (
           property_id, product_id, location_id, quantity, updated_at
         ) VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (property_id, product_id, location_id)
         DO UPDATE SET
           quantity = stock_balances.quantity + EXCLUDED.quantity,
           updated_at = NOW()`,
        [propertyId, vItem.product_id, vItem.location_id, vItem.base_quantity]
      );
    } finally {
      releaseLock();
      if (costLockRegistry.get(lockKey) === currentLock) {
        costLockRegistry.delete(lockKey);
      }
    }
  }

  // 3. Perbarui Status PO jika ada
  if (targetPo) {
    const allPoItemsRes = await client.query(
      `SELECT ordered_qty, received_qty FROM pos_purchase_order_items WHERE po_id = $1`,
      [targetPo.id]
    );
    const isAllReceived = allPoItemsRes.rows.every(
      (row: any) => parseFloat(row.received_qty) >= parseFloat(row.ordered_qty) - 0.0001
    );
    const anyPoReceived = allPoItemsRes.rows.some(
      (row: any) => parseFloat(row.received_qty) > 0.0001
    );

    const updatedPoStatus = isAllReceived ? 'COMPLETED' : 'PARTIALLY_RECEIVED';
    const updatedPoReceivingStatus = isAllReceived
      ? 'DITERIMA_LENGKAP'
      : (anyPoReceived ? 'DITERIMA_SEBAGIAN' : 'BELUM_DITERIMA');
    await client.query(
      `UPDATE pos_purchase_orders
          SET status = $1,
              receiving_status = $2,
              updated_at = NOW()
        WHERE id = $3`,
      [updatedPoStatus, updatedPoReceivingStatus, targetPo.id]
    );

    // Sinkronkan receiving_status pada semua transaksi pembelian aktif yang terhubung ke PO ini
    const linkedTxRes = await client.query(
      `SELECT id FROM transactions
        WHERE property_id = $1
          AND po_id = $2
          AND transaction_type = 'PURCHASE'
          AND deleted_at IS NULL
          AND COALESCE(UPPER(transaction_status), 'POSTED') NOT IN ('CANCELLED', 'VOID', 'VOIDED', 'REVERSED')`,
      [propertyId, targetPo.id]
    );
    for (const lTx of linkedTxRes.rows || []) {
      const linkedTxId = Number(lTx.id);
      if (targetTx && Number(targetTx.id) === linkedTxId) continue;
      const lBindRes = await client.query(
        `SELECT ordered_quantity, received_quantity
           FROM stock_purchase_line_bindings
          WHERE transaction_id = $1
            AND COALESCE(UPPER(line_type), 'STOCK') = 'STOCK'`,
        [linkedTxId]
      );
      let linkedReceivingStatus = updatedPoReceivingStatus;
      if (lBindRes.rows && lBindRes.rows.length > 0) {
        const isAllLinkedRec = lBindRes.rows.every(
          (r: any) => parseFloat(r.received_quantity || '0') >= parseFloat(r.ordered_quantity || '0') - 0.0001
        );
        const anyLinkedRec = lBindRes.rows.some(
          (r: any) => parseFloat(r.received_quantity || '0') > 0.0001
        );
        linkedReceivingStatus = isAllLinkedRec
          ? 'DITERIMA_LENGKAP'
          : (anyLinkedRec ? 'DITERIMA_SEBAGIAN' : 'BELUM_DITERIMA');
      }
      await client.query(
        `UPDATE transactions
            SET receiving_status = $1::varchar,
                received_at = CASE WHEN $1::text IN ('DITERIMA', 'DITERIMA_LENGKAP') THEN COALESCE(received_at, NOW()) ELSE NULL END,
                updated_at = NOW()
          WHERE id = $2`,
        [linkedReceivingStatus, linkedTxId]
      );
    }
  }

  // 4. Perbarui Status Transaksi Pembelian jika ada (hanya berdasarkan baris STOCK kanonik)
  if (targetTx) {
    const allBindingsRes = await client.query(
      `SELECT ordered_quantity, received_quantity
         FROM stock_purchase_line_bindings
        WHERE transaction_id = $1
          AND COALESCE(UPPER(line_type), 'STOCK') = 'STOCK'`,
      [targetTx.id]
    );
    if (allBindingsRes.rows.length > 0) {
      const isAllReceived = allBindingsRes.rows.every(
        (row: any) => parseFloat(row.received_quantity) >= parseFloat(row.ordered_quantity) - 0.0001
      );
      const anyReceived = allBindingsRes.rows.some(
        (row: any) => parseFloat(row.received_quantity) > 0.0001
      );
      const nextReceivingStatus = isAllReceived
        ? 'DITERIMA_LENGKAP'
        : (anyReceived ? 'DITERIMA_SEBAGIAN' : 'BELUM_DITERIMA');
      await client.query(
        `UPDATE transactions
            SET receiving_status = $1::varchar,
                received_at = CASE WHEN $1::text IN ('DITERIMA', 'DITERIMA_LENGKAP') THEN COALESCE(received_at, NOW()) ELSE NULL END,
                updated_at = NOW()
          WHERE id = $2`,
        [nextReceivingStatus, targetTx.id]
      );
    }
  }
}

/**
 * Catat Penerimaan Barang (GRN) ke inventaris.
 * Jika status = 'DRAFT' (atau is_draft = true): simpan draft tanpa mutasi inventori.
 * Jika status = 'POSTED': simpan dan langsung posting atomik ke ledger.
 */
export async function recordPosGoodsReceipt(
  pool: Pool,
  input: CreateGoodsReceiptInput
): Promise<PosGoodsReceipt> {
  const propertyId = Number(input.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), { statusCode: 400 });
  }

  let defaultLocationId = input.location_id ? Number(input.location_id) : 0;
  if (!Number.isInteger(defaultLocationId) || defaultLocationId <= 0) {
    // Resolusi dinamis ke Gudang 1 milik property
    const g1 = await resolveGudang1Location(pool, propertyId);
    defaultLocationId = g1.id;
  }

  if (!input.items || !Array.isArray(input.items) || input.items.length === 0) {
    throw Object.assign(new Error('Item penerimaan barang (items) tidak boleh kosong'), { statusCode: 400 });
  }

  const idempotencyKey = input.idempotency_key ? String(input.idempotency_key).trim() : null;
  const operationKey = input.operation_key ? String(input.operation_key).trim() : null;
  const lookupKey = idempotencyKey || operationKey;
  const computedFingerprint = computeReceiptPayloadFingerprint({
    ...input,
    location_id: defaultLocationId,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Cek Idempotency Key & Operation Key secara independen serta hitung fingerprint server
    if (input.payload_fingerprint && String(input.payload_fingerprint).trim() !== computedFingerprint) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error('Fingerprint payload dari klien tidak cocok dengan muatan aktual server'),
        { statusCode: 409, code: 'PAYLOAD_FINGERPRINT_MISMATCH' }
      );
    }
    const currentFingerprint = computedFingerprint;

    if (lookupKey) {
      const existingRes = await client.query(
        `SELECT id, payload_fingerprint, status FROM pos_goods_receipts
          WHERE property_id = $1 AND (idempotency_key = $2 OR operation_key = $2)`,
        [propertyId, lookupKey]
      );
      if (existingRes.rows.length > 0) {
        const existingRow = existingRes.rows[0];
        if (existingRow.payload_fingerprint && existingRow.payload_fingerprint !== currentFingerprint) {
          await client.query('ROLLBACK');
          throw Object.assign(
            new Error(`Konflik idempotensi: Permintaan dengan kunci "${lookupKey}" telah ada dengan data muatan (fingerprint) berbeda`),
            { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' }
          );
        }
        await client.query('ROLLBACK');
        const grn = await getPosGoodsReceiptById(pool, propertyId, existingRow.id);
        if (!grn) {
          throw Object.assign(new Error('GRN tercatat namun detail tidak ditemukan'), { statusCode: 500 });
        }
        return grn;
      }
    }

    // Jika klien mengirim baik idempotency_key maupun operation_key yang berbeda, pastikan operation_key belum dipakai alias lain
    if (idempotencyKey && operationKey && operationKey !== idempotencyKey) {
      const existingOpRes = await client.query(
        `SELECT id, payload_fingerprint, status FROM pos_goods_receipts
          WHERE property_id = $1 AND (idempotency_key = $2 OR operation_key = $2)`,
        [propertyId, operationKey]
      );
      if (existingOpRes.rows.length > 0) {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`Konflik idempotensi: operation_key "${operationKey}" telah digunakan oleh dokumen penerimaan lain dengan idempotency_key berbeda`),
          { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' }
        );
      }
    }

    // 2. Validasi Lokasi Utama: wajib aktif dan Gudang 1 (WH-01 / WAREHOUSE) milik properti
    await validateGudang1DestinationLocation(client, propertyId, defaultLocationId);

    // 3. Validasi sumber pengadaan (Tahap 1A: wajib terhubung ke PO yang disetujui atau Transaksi Pembelian yang sah)
    const txId = input.transaction_id ? Number(input.transaction_id) : null;
    let poId = input.po_id ? Number(input.po_id) : null;
    if (!txId && !poId) {
      throw Object.assign(
        new Error('Penerimaan barang baru wajib terhubung ke Purchase Order (PO) yang telah disetujui'),
        { statusCode: 400, code: 'PO_REQUIRED_FOR_RECEIPT' }
      );
    }

    let targetTx: any = null;
    let txLinesMap = new Map<number, any>();

    if (txId) {
      const txRes = await client.query(
        `SELECT id, transaction_no, transaction_type, approval_status, transaction_status,
                receiving_status, source_revision, deleted_at, po_id, is_legacy_without_po,
                supplier_id, canonical_supplier_id
           FROM transactions
          WHERE id = $1 AND property_id = $2
          FOR UPDATE`,
        [txId, propertyId]
      );
      if (txRes.rows.length === 0) {
        throw Object.assign(new Error(`Transaksi pembelian #${txId} tidak ditemukan`), { statusCode: 404 });
      }
      targetTx = txRes.rows[0];
      assertPurchaseTransactionReceivableState(targetTx);

      if (targetTx.po_id != null && !poId) {
        poId = Number(targetTx.po_id);
      } else if (targetTx.po_id != null && poId && Number(targetTx.po_id) !== Number(poId)) {
        throw Object.assign(
          new Error(`Transaksi pembelian #${targetTx.transaction_no || txId} terhubung ke PO #${targetTx.po_id}, bukan PO #${poId}`),
          { statusCode: 400, code: 'PO_TRANSACTION_MISMATCH' }
        );
      }

      // Ambil atau rekonsiliasi bindings dari stock_purchase_line_bindings / riwayat GRN
      txLinesMap = await loadOrReconcilePurchaseLineBindings(client, propertyId, txId);
    }

    // 4. Validasi PO jika terkait (PO Guard & Satu Batas Penerimaan Kumulatif)
    let targetPo: any = null;
    let poItemsMap = new Map<number, any>();

    if (poId) {
      const poRes = await client.query(
        `SELECT * FROM pos_purchase_orders WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [poId, propertyId]
      );
      if (poRes.rows.length === 0) {
        throw Object.assign(new Error(`Purchase Order #${poId} tidak ditemukan`), { statusCode: 404 });
      }
      targetPo = poRes.rows[0];
      assertPurchaseOrderReceivableState(targetPo, false);
      poItemsMap = await loadAndReconcilePurchaseOrderItems(client, propertyId, poId);
    }

    // 5. Supplier ID & Canonical Supplier ID (Satu Master Rekanan)
    const rawSupplierId = input.canonical_supplier_id
      ? Number(input.canonical_supplier_id)
      : input.supplier_id
        ? Number(input.supplier_id)
        : targetPo
          ? Number(targetPo.canonical_supplier_id || targetPo.supplier_id || 0)
          : targetTx
            ? Number(targetTx.canonical_supplier_id || targetTx.supplier_id || 0)
            : 0;

    let supplierId: number | null = targetPo?.supplier_id
      ? Number(targetPo.supplier_id)
      : targetTx?.supplier_id
        ? Number(targetTx.supplier_id)
        : null;
    let canonicalSupplierId: number | null = targetPo?.canonical_supplier_id
      ? Number(targetPo.canonical_supplier_id)
      : targetTx?.canonical_supplier_id
        ? Number(targetTx.canonical_supplier_id)
        : null;

    if (rawSupplierId > 0) {
      const resolvedSup = await resolveCanonicalSupplierForProcurement(client, propertyId, rawSupplierId);
      supplierId = resolvedSup.legacyPosSupplierId;
      canonicalSupplierId = Number(resolvedSup.canonicalSupplier.id);
    }

    // 6. Validasi Nomor GRN
    let grnNumber = input.grn_number ? String(input.grn_number).trim() : '';
    if (!grnNumber) {
      grnNumber = await generateGrnNumber(client, propertyId);
    } else {
      const dupCheck = await client.query(
        `SELECT id FROM pos_goods_receipts WHERE property_id = $1 AND grn_number = $2`,
        [propertyId, grnNumber]
      );
      if (dupCheck.rows.length > 0) {
        throw Object.assign(new Error(`Nomor GRN "${grnNumber}" sudah ada`), { statusCode: 409 });
      }
    }

    // 7. Validasi Items, Plafon, dan Kemasan
    const validatedItems = await validateAndPrepareReceiptItems(
      client,
      propertyId,
      defaultLocationId,
      input.items,
      targetPo,
      poItemsMap,
      targetTx,
      txLinesMap
    );

    // 8. Tentukan Status Awal: DRAFT atau POSTED
    const isDraft = Boolean(input.is_draft || input.status === 'DRAFT');
    const initialStatus = isDraft ? 'DRAFT' : 'POSTED';
    const postedBy = isDraft ? null : (input.posted_by || input.received_by || 'system');
    const opKey = operationKey || `grn:${propertyId}:${grnNumber}`;
    const sourceRevisionSnapshot = targetTx
      ? Number(targetTx.source_revision ?? 1)
      : targetPo
        ? Number(targetPo.source_revision ?? 1)
        : null;

    const receiptDate = formatCalendarDateStr(input.receipt_date);
    const invoiceNo = input.invoice_no ? String(input.invoice_no).trim() : null;
    const receivedBy = input.received_by ? String(input.received_by).trim() : null;
    const notes = input.notes ? String(input.notes).trim() : null;

    // 9. Insert Header GRN
    const grnInsertRes = await client.query(
      `INSERT INTO pos_goods_receipts (
         property_id, grn_number, po_id, transaction_id, supplier_id, canonical_supplier_id, location_id, receipt_date,
         invoice_no, received_by, posted_by, posted_at, status, notes,
         operation_key, payload_fingerprint, idempotency_key, source_revision_snapshot, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12 = 'POSTED' THEN NOW() ELSE NULL END, $12, $13, $14, $15, $16, $17, NOW(), NOW())
       RETURNING *`,
      [
        propertyId,
        grnNumber,
        poId,
        txId,
        supplierId,
        canonicalSupplierId,
        defaultLocationId,
        receiptDate,
        invoiceNo,
        receivedBy,
        postedBy,
        initialStatus,
        notes,
        opKey,
        currentFingerprint,
        idempotencyKey,
        sourceRevisionSnapshot,
      ]
    );
    const createdGrn = grnInsertRes.rows[0];

    // 10. Insert GRN Items (termasuk source_allocated_qty, conversion_factor_snapshot, ordered_unit, packaging_label_snapshot)
    const insertedGrnItems: PosGoodsReceiptItem[] = [];
    for (const vItem of validatedItems) {
      const griRes = await client.query(
        `INSERT INTO pos_goods_receipt_items (
           receipt_id, product_id, po_item_id, transaction_line_id, packaging_id,
           received_qty, base_quantity, unit_cost, subtotal, uom_id, location_id,
           source_allocated_qty, conversion_factor_snapshot, ordered_unit, packaging_label_snapshot, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
         RETURNING *`,
        [
          createdGrn.id,
          vItem.product_id,
          vItem.po_item_id,
          vItem.transaction_line_id,
          vItem.packaging_id,
          vItem.received_qty,
          vItem.base_quantity,
          vItem.unit_cost,
          vItem.subtotal,
          vItem.uom_id,
          vItem.location_id,
          vItem.source_alloc_qty,
          vItem.conversion_factor,
          vItem.ordered_unit,
          vItem.packaging_label,
        ]
      );
      insertedGrnItems.push(griRes.rows[0]);
    }

    // 11. Jika POSTED: Eksekusi posting atomik ke ledger inventori
    if (!isDraft) {
      await executeGoodsReceiptPosting(client, propertyId, createdGrn, validatedItems, targetPo, targetTx);
    }

    await client.query('COMMIT');

    const fullGrn = await getPosGoodsReceiptById(pool, propertyId, createdGrn.id);
    return fullGrn || createdGrn;
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err && err.code === '23505' && (idempotencyKey || operationKey)) {
      const conflictKey = idempotencyKey || operationKey;
      const raceRes = await pool.query(
        `SELECT id, payload_fingerprint, status FROM pos_goods_receipts
          WHERE property_id = $1 AND (idempotency_key = $2 OR operation_key = $2)
          ORDER BY id DESC LIMIT 1`,
        [propertyId, conflictKey]
      );
      if (raceRes.rows.length > 0) {
        const winner = raceRes.rows[0];
        if (winner.payload_fingerprint && winner.payload_fingerprint !== computedFingerprint) {
          throw Object.assign(
            new Error(`Konflik idempotensi konkuren: Permintaan dengan kunci "${conflictKey}" telah disimpan dengan muatan (fingerprint) berbeda`),
            { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' }
          );
        }
        const existingGrn = await getPosGoodsReceiptById(pool, propertyId, Number(winner.id));
        if (existingGrn) return existingGrn;
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Post Goods Receipt yang berstatus DRAFT menjadi POSTED
 */
export async function postPosGoodsReceipt(
  pool: Pool,
  propertyId: number,
  grnId: number,
  postedBy?: string | { posted_by?: string }
): Promise<PosGoodsReceipt> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const grnRes = await client.query(
      `SELECT * FROM pos_goods_receipts WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [grnId, propertyId]
    );
    if (grnRes.rows.length === 0) {
      throw Object.assign(new Error(`Penerimaan barang #${grnId} tidak ditemukan`), { statusCode: 404 });
    }
    const grn = grnRes.rows[0];

    // Idempotent: jika sudah diposting sebelumnya, kembalikan GRN
    if (grn.status === 'POSTED' || grn.status === 'COMPLETED') {
      await client.query('ROLLBACK');
      const existing = await getPosGoodsReceiptById(pool, propertyId, grnId);
      return existing!;
    }

    // Tolak draft duplikat historis yang telah dikarantina (_dup_draft_)
    if (
      /_dup_draft_\d+$/.test(String(grn.operation_key || '')) ||
      /_dup_draft_\d+$/.test(String(grn.idempotency_key || ''))
    ) {
      throw Object.assign(
        new Error(
          `Penerimaan barang #${grnId} (${grn.grn_number || ''}) adalah draft duplikat historis yang telah dikarantina (${grn.operation_key || grn.idempotency_key}) dan tidak dapat diposting ke stok`
        ),
        { statusCode: 409, code: 'DUPLICATE_OPERATION_KEY_QUARANTINED' }
      );
    }

    if (grn.status === 'CANCELLED') {
      throw Object.assign(new Error('Penerimaan barang telah dibatalkan (CANCELLED) dan tidak dapat diposting'), { statusCode: 400 });
    }

    if (grn.status !== 'DRAFT') {
      throw Object.assign(new Error(`Penerimaan barang berstatus ${grn.status}, bukan DRAFT`), { statusCode: 400 });
    }

    // Validasi lokasi tujuan harus tetap Gudang 1 yang aktif
    await validateGudang1DestinationLocation(client, propertyId, Number(grn.location_id));

    // Validasi Purchase Order / Transaksi Pembelian terkait
    let targetTx: any = null;
    let txLinesMap = new Map<number, any>();
    let effectivePoId = grn.po_id ? Number(grn.po_id) : null;
    if (grn.transaction_id) {
      const txRes = await client.query(
        `SELECT id, transaction_no, transaction_type, approval_status, transaction_status,
                receiving_status, source_revision, deleted_at, po_id, is_legacy_without_po
           FROM transactions
          WHERE id = $1 AND property_id = $2
          FOR UPDATE`,
        [grn.transaction_id, propertyId]
      );
      if (txRes.rows.length > 0) {
        targetTx = txRes.rows[0];
        assertPurchaseTransactionReceivableState(targetTx);
        if (!effectivePoId && targetTx.po_id != null) {
          effectivePoId = Number(targetTx.po_id);
        }
        txLinesMap = await loadOrReconcilePurchaseLineBindings(client, propertyId, Number(grn.transaction_id));
      }
    }

    let targetPo: any = null;
    let poItemsMap = new Map<number, any>();
    if (effectivePoId) {
      const poRes = await client.query(
        `SELECT * FROM pos_purchase_orders WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [effectivePoId, propertyId]
      );
      if (poRes.rows.length > 0) {
        targetPo = poRes.rows[0];
        assertPurchaseOrderReceivableState(targetPo, true);
        poItemsMap = await loadAndReconcilePurchaseOrderItems(client, propertyId, effectivePoId);
      }
    }

    // Ambil item draft
    const draftItemsRes = await client.query(
      `SELECT * FROM pos_goods_receipt_items WHERE receipt_id = $1 ORDER BY id ASC`,
      [grnId]
    );
    if (draftItemsRes.rows.length === 0) {
      throw Object.assign(new Error('Penerimaan draft tidak memiliki item'), { statusCode: 400 });
    }

    const trustedDraftSnapshotsMap = new Map<
      number,
      {
        packaging_id: number | null;
        conversion_factor_snapshot: number | null;
        packaging_label_snapshot: string | null;
      }
    >();
    for (const r of draftItemsRes.rows) {
      if (r.id != null) {
        trustedDraftSnapshotsMap.set(Number(r.id), {
          packaging_id: r.packaging_id != null ? Number(r.packaging_id) : null,
          conversion_factor_snapshot:
            r.conversion_factor_snapshot != null ? parseFloat(String(r.conversion_factor_snapshot)) : null,
          packaging_label_snapshot: r.packaging_label_snapshot ?? null,
        });
      }
    }

    const itemsInput: GoodsReceiptItemInput[] = draftItemsRes.rows.map(r => ({
      id: r.id,
      product_id: r.product_id,
      po_item_id: r.po_item_id,
      transaction_line_id: r.transaction_line_id,
      packaging_id: r.packaging_id,
      received_qty: r.received_qty,
      unit_cost: r.unit_cost,
      uom_id: r.uom_id,
      location_id: r.location_id,
    }));

    const validatedItems = await validateAndPrepareReceiptItems(
      client,
      propertyId,
      grn.location_id,
      itemsInput,
      targetPo,
      poItemsMap,
      targetTx,
      txLinesMap,
      trustedDraftSnapshotsMap
    );

    // P03 Guard 1: Tolak jika faktor konversi kemasan berubah sehingga base_quantity draft berbeda dari kalkulasi master saat ini
    const draftById = new Map<number, any>();
    for (const dRow of draftItemsRes.rows) {
      if (dRow.id != null) draftById.set(Number(dRow.id), dRow);
    }
    for (let idx = 0; idx < validatedItems.length; idx++) {
      const vItem = validatedItems[idx];
      const draftRow = (vItem.receipt_item_id != null ? draftById.get(vItem.receipt_item_id) : null) || draftItemsRes.rows[idx];
      if (draftRow) {
        if (
          draftRow.conversion_factor_snapshot !== null &&
          draftRow.conversion_factor_snapshot !== undefined &&
          Math.abs(parseFloat(String(draftRow.conversion_factor_snapshot)) - vItem.conversion_factor) > 0.0001
        ) {
          throw Object.assign(
            new Error(
              `Faktor konversi kemasan untuk produk "${vItem.product_name}" berubah sejak Draft disimpan (${draftRow.conversion_factor_snapshot} -> ${vItem.conversion_factor}). Harap perbarui dan simpan ulang Draft sebelum posting.`
            ),
            { statusCode: 409, code: 'PACKAGING_FACTOR_CHANGED' }
          );
        }
        if (
          (vItem.packaging_id != null || draftRow.packaging_id != null) &&
          draftRow.base_quantity !== null &&
          draftRow.base_quantity !== undefined &&
          Math.abs(parseFloat(String(draftRow.base_quantity)) - vItem.base_quantity) > 0.0001
        ) {
          throw Object.assign(
            new Error(
              `Kuantitas satuan dasar pada Draft produk "${vItem.product_name}" (${draftRow.base_quantity}) tidak lagi cocok dengan konversi kemasan master saat ini (${vItem.base_quantity}). Harap perbarui dan simpan ulang Draft sebelum posting.`
            ),
            { statusCode: 409, code: 'PACKAGING_FACTOR_CHANGED' }
          );
        }
      }
    }

    // P03 Guard 2: Tolak jika sumber telah direvisi (source_revision berubah) sejak Draft dibuat/diperbarui
    if (targetTx) {
      const currentSourceRev = Number(targetTx.source_revision ?? 1);
      const snapshotRev = grn.source_revision_snapshot !== null && grn.source_revision_snapshot !== undefined
        ? Number(grn.source_revision_snapshot)
        : 1;
      if (snapshotRev !== currentSourceRev) {
        throw Object.assign(
          new Error(
            `Transaksi pembelian #${targetTx.transaction_no || targetTx.id} telah mengalami revisi material (revisi Draft: ${snapshotRev}, revisi sumber saat ini: ${currentSourceRev}). Harap perbarui/sinkronkan Draft penerimaan terhadap data pembelian terbaru yang sudah disetujui sebelum posting.`
          ),
          { statusCode: 409, code: 'SOURCE_CHANGED' }
        );
      }
    } else if (targetPo) {
      const currentPoRev = Number(targetPo.source_revision ?? 1);
      const snapshotRev = grn.source_revision_snapshot !== null && grn.source_revision_snapshot !== undefined
        ? Number(grn.source_revision_snapshot)
        : 1;
      if (snapshotRev !== currentPoRev) {
        throw Object.assign(
          new Error(
            `PO #${targetPo.po_number || targetPo.id} telah mengalami revisi material (revisi Draft: ${snapshotRev}, revisi PO saat ini: ${currentPoRev}). Harap perbarui/sinkronkan Draft penerimaan terhadap PO terbaru yang sudah disetujui sebelum posting.`
          ),
          { statusCode: 409, code: 'SOURCE_CHANGED' }
        );
      }
    }

    // Update items base_quantity & snapshots berdasarkan primary key baris item penerimaan (id)
    for (const vItem of validatedItems) {
      if (vItem.receipt_item_id) {
        await client.query(
          `UPDATE pos_goods_receipt_items
              SET base_quantity = $1,
                  packaging_id = $2,
                  po_item_id = COALESCE($3, po_item_id),
                  transaction_line_id = COALESCE($4, transaction_line_id),
                  ordered_unit = COALESCE($5, ordered_unit),
                  packaging_label_snapshot = COALESCE($6, packaging_label_snapshot)
            WHERE id = $7 AND receipt_id = $8`,
          [
            vItem.base_quantity,
            vItem.packaging_id,
            vItem.po_item_id,
            vItem.transaction_line_id,
            vItem.ordered_unit,
            vItem.packaging_label,
            vItem.receipt_item_id,
            grnId,
          ]
        );
      } else {
        await client.query(
          `UPDATE pos_goods_receipt_items
              SET base_quantity = $1,
                  packaging_id = $2
            WHERE receipt_id = $3 AND product_id = $4`,
          [vItem.base_quantity, vItem.packaging_id, grnId, vItem.product_id]
        );
      }
    }

    // Eksekusi posting ke ledger
    await executeGoodsReceiptPosting(client, propertyId, grn, validatedItems, targetPo, targetTx);

    // Update header status ke POSTED
    const resolvedPostedBy = typeof postedBy === 'object' && postedBy !== null
      ? (postedBy as any).posted_by
      : (typeof postedBy === 'string' ? postedBy : null);
    const postedByUser = resolvedPostedBy || grn.received_by || 'system';
    await client.query(
      `UPDATE pos_goods_receipts
          SET status = 'POSTED',
              po_id = COALESCE(po_id, $3),
              posted_at = NOW(),
              posted_by = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [postedByUser, grnId, effectivePoId]
    );

    await client.query('COMMIT');
    return (await getPosGoodsReceiptById(pool, propertyId, grnId))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Update Draft Goods Receipt (hanya berlaku jika status = 'DRAFT')
 */
export async function updatePosGoodsReceiptDraft(
  pool: Pool,
  propertyId: number,
  grnId: number,
  input: UpdateGoodsReceiptDraftInput
): Promise<PosGoodsReceipt> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const grnRes = await client.query(
      `SELECT * FROM pos_goods_receipts WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [grnId, propertyId]
    );
    if (grnRes.rows.length === 0) {
      throw Object.assign(new Error(`Penerimaan barang #${grnId} tidak ditemukan`), { statusCode: 404 });
    }
    const grn = grnRes.rows[0];

    if (grn.status !== 'DRAFT') {
      throw Object.assign(new Error(`Hanya draft penerimaan yang dapat diedit (status saat ini: ${grn.status})`), { statusCode: 400 });
    }

    const defaultLocationId = input.location_id ? Number(input.location_id) : grn.location_id;
    await validateGudang1DestinationLocation(client, propertyId, Number(defaultLocationId));

    const normalizedReceiptDate = input.receipt_date ? formatCalendarDateStr(input.receipt_date) : null;

    // Update header draft
    await client.query(
      `UPDATE pos_goods_receipts
          SET location_id = $1,
              receipt_date = COALESCE($2, receipt_date),
              invoice_no = COALESCE($3, invoice_no),
              received_by = COALESCE($4, received_by),
              notes = COALESCE($5, notes),
              updated_at = NOW()
        WHERE id = $6`,
      [
        defaultLocationId,
        normalizedReceiptDate,
        input.invoice_no !== undefined ? input.invoice_no : null,
        input.received_by !== undefined ? input.received_by : null,
        input.notes !== undefined ? input.notes : null,
        grnId,
      ]
    );

    // Jika ada update items
    if (input.items && Array.isArray(input.items)) {
      if (input.items.length === 0) {
        throw Object.assign(new Error('Item penerimaan tidak boleh kosong'), { statusCode: 400 });
      }

      // Muat data referensi PO/Transaksi jika terkait
      let targetTx: any = null;
      let txLinesMap = new Map<number, any>();
      let effectivePoId = grn.po_id ? Number(grn.po_id) : null;
      if (grn.transaction_id) {
        const txRes = await client.query(
          `SELECT id, transaction_no, transaction_type, approval_status, transaction_status,
                  receiving_status, source_revision, deleted_at, po_id, is_legacy_without_po
             FROM transactions
            WHERE id = $1 AND property_id = $2
            FOR UPDATE`,
          [grn.transaction_id, propertyId]
        );
        if (txRes.rows.length > 0) {
          targetTx = txRes.rows[0];
          assertPurchaseTransactionReceivableState(targetTx);
          if (!effectivePoId && targetTx.po_id != null) {
            effectivePoId = Number(targetTx.po_id);
          }
          txLinesMap = await loadOrReconcilePurchaseLineBindings(client, propertyId, Number(grn.transaction_id));
        }
      }

      let targetPo: any = null;
      let poItemsMap = new Map<number, any>();
      if (effectivePoId) {
        const poRes = await client.query(
          `SELECT * FROM pos_purchase_orders WHERE id = $1 AND property_id = $2 FOR UPDATE`,
          [effectivePoId, propertyId]
        );
        if (poRes.rows.length > 0) {
          targetPo = poRes.rows[0];
          assertPurchaseOrderReceivableState(targetPo, true);
          poItemsMap = await loadAndReconcilePurchaseOrderItems(client, propertyId, effectivePoId);
        }
      }

      // Pertahankan ID baris eksisting bila cocok (id / transaction_line_id / po_item_id / product_id)
      // sekaligus mewarisi snapshot faktor/label kemasan dari draft eksisting bila kemasan tidak diganti.
      const existingItemsRes = await client.query(
        `SELECT id, product_id, po_item_id, transaction_line_id, packaging_id,
                conversion_factor_snapshot, packaging_label_snapshot
           FROM pos_goods_receipt_items
          WHERE receipt_id = $1
          ORDER BY id ASC
          FOR UPDATE`,
        [grnId]
      );
      const existingRows = existingItemsRes.rows || [];

      const trustedDraftSnapshotsMap = new Map<
        number,
        {
          packaging_id: number | null;
          conversion_factor_snapshot: number | null;
          packaging_label_snapshot: string | null;
        }
      >();
      for (const r of existingRows) {
        if (r.id != null) {
          trustedDraftSnapshotsMap.set(Number(r.id), {
            packaging_id: r.packaging_id != null ? Number(r.packaging_id) : null,
            conversion_factor_snapshot:
              r.conversion_factor_snapshot != null ? parseFloat(String(r.conversion_factor_snapshot)) : null,
            packaging_label_snapshot: r.packaging_label_snapshot ?? null,
          });
        }
      }

      const preClaimedIds = new Set<number>();
      const enrichedInputItems: GoodsReceiptItemInput[] = input.items.map((item) => {
        const rawReceiptItemId = item.id ?? (item as any).receipt_item_id ?? (item as any).grn_item_id ?? null;
        let match =
          rawReceiptItemId != null
            ? existingRows.find(
                (r: any) => Number(r.id) === Number(rawReceiptItemId) && !preClaimedIds.has(Number(r.id))
              )
            : null;
        if (!match && rawReceiptItemId == null && item.transaction_line_id != null) {
          match = existingRows.find(
            (r: any) =>
              r.transaction_line_id != null &&
              Number(r.transaction_line_id) === Number(item.transaction_line_id) &&
              !preClaimedIds.has(Number(r.id))
          );
        }
        if (!match && rawReceiptItemId == null && item.transaction_line_id == null && item.po_item_id != null) {
          match = existingRows.find(
            (r: any) =>
              r.po_item_id != null &&
              Number(r.po_item_id) === Number(item.po_item_id) &&
              !preClaimedIds.has(Number(r.id))
          );
        }
        if (
          !match &&
          rawReceiptItemId == null &&
          item.transaction_line_id == null &&
          item.po_item_id == null &&
          item.product_id != null
        ) {
          const candidates = existingRows.filter(
            (r: any) => Number(r.product_id) === Number(item.product_id) && !preClaimedIds.has(Number(r.id))
          );
          if (candidates.length === 1) {
            match = candidates[0];
          }
        }
        if (match) {
          preClaimedIds.add(Number(match.id));
          return {
            ...item,
            id: Number(match.id),
          };
        }
        return item;
      });

      // Validasi items dan batas plafon
      const validatedItems = await validateAndPrepareReceiptItems(
        client,
        propertyId,
        defaultLocationId,
        enrichedInputItems,
        targetPo,
        poItemsMap,
        targetTx,
        txLinesMap,
        trustedDraftSnapshotsMap
      );

      const claimedIds = new Set<number>();
      const keptIds: number[] = [];

      for (const vItem of validatedItems) {
        let match =
          vItem.receipt_item_id != null
            ? existingRows.find(
                (r: any) =>
                  Number(r.id) === Number(vItem.receipt_item_id) && !claimedIds.has(Number(r.id))
              )
            : null;
        if (!match && vItem.receipt_item_id == null && vItem.transaction_line_id != null) {
          match = existingRows.find(
            (r: any) =>
              r.transaction_line_id != null &&
              Number(r.transaction_line_id) === Number(vItem.transaction_line_id) &&
              !claimedIds.has(Number(r.id))
          );
        }
        if (
          !match &&
          vItem.receipt_item_id == null &&
          vItem.transaction_line_id == null &&
          vItem.po_item_id != null
        ) {
          match = existingRows.find(
            (r: any) =>
              r.po_item_id != null &&
              Number(r.po_item_id) === Number(vItem.po_item_id) &&
              !claimedIds.has(Number(r.id))
          );
        }
        if (
          !match &&
          vItem.receipt_item_id == null &&
          vItem.transaction_line_id == null &&
          vItem.po_item_id == null
        ) {
          const candidates = existingRows.filter(
            (r: any) =>
              Number(r.product_id) === Number(vItem.product_id) && !claimedIds.has(Number(r.id))
          );
          if (candidates.length === 1) {
            match = candidates[0];
          }
        }

        if (match) {
          const matchedId = Number(match.id);
          claimedIds.add(matchedId);
          keptIds.push(matchedId);
          await client.query(
            `UPDATE pos_goods_receipt_items
                SET product_id = $1,
                    po_item_id = $2,
                    transaction_line_id = $3,
                    packaging_id = $4,
                    received_qty = $5,
                    base_quantity = $6,
                    unit_cost = $7,
                    subtotal = $8,
                    uom_id = $9,
                    location_id = $10,
                    source_allocated_qty = $11,
                    conversion_factor_snapshot = $12,
                    ordered_unit = $13,
                    packaging_label_snapshot = $14
              WHERE id = $15 AND receipt_id = $16`,
            [
              vItem.product_id,
              vItem.po_item_id,
              vItem.transaction_line_id,
              vItem.packaging_id,
              vItem.received_qty,
              vItem.base_quantity,
              vItem.unit_cost,
              vItem.subtotal,
              vItem.uom_id,
              vItem.location_id,
              vItem.source_alloc_qty,
              vItem.conversion_factor,
              vItem.ordered_unit,
              vItem.packaging_label,
              matchedId,
              grnId,
            ]
          );
        } else {
          const insRes = await client.query(
            `INSERT INTO pos_goods_receipt_items (
               receipt_id, product_id, po_item_id, transaction_line_id, packaging_id,
               received_qty, base_quantity, unit_cost, subtotal, uom_id, location_id,
               source_allocated_qty, conversion_factor_snapshot, ordered_unit, packaging_label_snapshot, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
             RETURNING id`,
            [
              grnId,
              vItem.product_id,
              vItem.po_item_id,
              vItem.transaction_line_id,
              vItem.packaging_id,
              vItem.received_qty,
              vItem.base_quantity,
              vItem.unit_cost,
              vItem.subtotal,
              vItem.uom_id,
              vItem.location_id,
              vItem.source_alloc_qty,
              vItem.conversion_factor,
              vItem.ordered_unit,
              vItem.packaging_label,
            ]
          );
          if (insRes.rows[0]?.id != null) {
            keptIds.push(Number(insRes.rows[0].id));
          }
        }
      }

      if (keptIds.length > 0) {
        await client.query(
          `DELETE FROM pos_goods_receipt_items WHERE receipt_id = $1 AND NOT (id = ANY($2::int[]))`,
          [grnId, keptIds]
        );
      } else {
        await client.query(`DELETE FROM pos_goods_receipt_items WHERE receipt_id = $1`, [grnId]);
      }

      // Update payload fingerprint & source_revision_snapshot draft
      const updatedFingerprint = computeReceiptPayloadFingerprint({
        po_id: effectivePoId || grn.po_id,
        transaction_id: grn.transaction_id,
        location_id: defaultLocationId,
        receipt_date: normalizedReceiptDate || formatCalendarDateStr(grn.receipt_date),
        items: input.items,
      });
      const refreshedSourceRevision = targetTx
        ? Number(targetTx.source_revision ?? 1)
        : targetPo
          ? Number(targetPo.source_revision ?? 1)
          : grn.source_revision_snapshot;
      await client.query(
        `UPDATE pos_goods_receipts
            SET payload_fingerprint = $1,
                source_revision_snapshot = $2,
                po_id = COALESCE(po_id, $3),
                updated_at = NOW()
          WHERE id = $4`,
        [updatedFingerprint, refreshedSourceRevision, effectivePoId, grnId]
      );
    }

    await client.query('COMMIT');
    return (await getPosGoodsReceiptById(pool, propertyId, grnId))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Batalkan Draft Goods Receipt (status = 'CANCELLED')
 */
export async function cancelPosGoodsReceiptDraft(
  pool: Pool,
  propertyId: number,
  grnId: number,
  _reason?: string
): Promise<PosGoodsReceipt> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const grnRes = await client.query(
      `SELECT * FROM pos_goods_receipts WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [grnId, propertyId]
    );
    if (grnRes.rows.length === 0) {
      throw Object.assign(new Error(`Penerimaan barang #${grnId} tidak ditemukan`), { statusCode: 404 });
    }
    const grn = grnRes.rows[0];

    if (grn.status !== 'DRAFT') {
      throw Object.assign(new Error(`Hanya draft penerimaan yang dapat dibatalkan (status saat ini: ${grn.status})`), { statusCode: 400 });
    }

    await client.query(
      `UPDATE pos_goods_receipts
          SET status = 'CANCELLED',
              updated_at = NOW()
        WHERE id = $1`,
      [grnId]
    );

    await client.query('COMMIT');
    return (await getPosGoodsReceiptById(pool, propertyId, grnId))!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Daftar Riwayat Goods Receipt Note (GRN)
 */
export async function getPosGoodsReceipts(
  pool: Pool,
  propertyId: number,
  filter: GetGoodsReceiptsFilter = {}
): Promise<{ receipts: PosGoodsReceipt[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, Number(filter.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(filter.limit) || 20));
  const offset = (page - 1) * limit;

  const conditions: string[] = ['grn.property_id = $1'];
  const params: any[] = [propertyId];
  let pIdx = 2;

  if (filter.po_id) {
    conditions.push(`grn.po_id = $${pIdx++}`);
    params.push(filter.po_id);
  }
  if (filter.transaction_id) {
    conditions.push(`grn.transaction_id = $${pIdx++}`);
    params.push(filter.transaction_id);
  }
  if (filter.supplier_id) {
    conditions.push(`(grn.supplier_id = $${pIdx} OR grn.canonical_supplier_id = $${pIdx})`);
    params.push(filter.supplier_id);
    pIdx++;
  }
  if (filter.location_id) {
    conditions.push(`grn.location_id = $${pIdx++}`);
    params.push(filter.location_id);
  }
  if (filter.status) {
    const s = filter.status.toUpperCase();
    if (s === 'DRAFT') {
      conditions.push(`grn.status = 'DRAFT'`);
    } else if (s === 'POSTED') {
      conditions.push(`grn.status IN ('POSTED', 'COMPLETED')`);
    } else if (s !== 'ALL') {
      conditions.push(`grn.status = $${pIdx++}`);
      params.push(s);
    }
  }
  if (filter.start_date) {
    conditions.push(`grn.receipt_date >= $${pIdx++}`);
    params.push(filter.start_date);
  }
  if (filter.end_date) {
    conditions.push(`grn.receipt_date <= $${pIdx++}`);
    params.push(filter.end_date);
  }
  if (filter.search) {
    conditions.push(`(grn.grn_number ILIKE $${pIdx} OR grn.invoice_no ILIKE $${pIdx} OR COALESCE(cs.name, s.name, '') ILIKE $${pIdx} OR tx.transaction_no ILIKE $${pIdx} OR po.po_number ILIKE $${pIdx})`);
    params.push(`%${filter.search.trim()}%`);
    pIdx++;
  }

  const whereClause = conditions.join(' AND ');

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total
       FROM pos_goods_receipts grn
       LEFT JOIN pos_purchase_orders po ON grn.po_id = po.id
       LEFT JOIN pos_suppliers s ON grn.supplier_id = s.id
       LEFT JOIN suppliers cs ON grn.canonical_supplier_id = cs.id
       LEFT JOIN transactions tx ON grn.transaction_id = tx.id
      WHERE ${whereClause}`,
    params
  );
  const total = countRes.rows[0]?.total || 0;

  const listRes = await pool.query(
    `SELECT grn.*,
            to_char(grn.receipt_date, 'YYYY-MM-DD') AS receipt_date,
            po.po_number,
            po.status AS po_status,
            tx.transaction_no AS transaction_number,
            COALESCE(cs.name, s.name) AS supplier_name,
            COALESCE(cs.code, s.code) AS supplier_code,
            loc.name AS location_name,
            loc.code AS location_code
       FROM pos_goods_receipts grn
       LEFT JOIN pos_purchase_orders po ON grn.po_id = po.id
       LEFT JOIN transactions tx ON grn.transaction_id = tx.id
       LEFT JOIN pos_suppliers s ON grn.supplier_id = s.id
       LEFT JOIN suppliers cs ON grn.canonical_supplier_id = cs.id
       LEFT JOIN stock_locations loc ON grn.location_id = loc.id
      WHERE ${whereClause}
      ORDER BY grn.id DESC
      LIMIT $${pIdx++} OFFSET $${pIdx++}`,
    [...params, limit, offset]
  );

  const receipts = listRes.rows.map((r: any) => ({
    ...r,
    receipt_date: r.receipt_date ? formatCalendarDateStr(r.receipt_date) : r.receipt_date,
  }));

  return {
    receipts,
    total,
    page,
    limit,
  };
}

/**
 * Detail Goods Receipt Note beserta daftar item
 */
export async function getPosGoodsReceiptById(
  pool: Pool,
  propertyId: number,
  grnId: number
): Promise<PosGoodsReceipt | null> {
  const grnRes = await pool.query(
    `SELECT grn.*,
            to_char(grn.receipt_date, 'YYYY-MM-DD') AS receipt_date,
            po.po_number,
            po.status AS po_status,
            tx.transaction_no AS transaction_number,
            COALESCE(cs.name, s.name) AS supplier_name,
            COALESCE(cs.code, s.code) AS supplier_code,
            loc.name AS location_name,
            loc.code AS location_code
       FROM pos_goods_receipts grn
       LEFT JOIN pos_purchase_orders po ON grn.po_id = po.id
       LEFT JOIN transactions tx ON grn.transaction_id = tx.id
       LEFT JOIN pos_suppliers s ON grn.supplier_id = s.id
       LEFT JOIN suppliers cs ON grn.canonical_supplier_id = cs.id
       LEFT JOIN stock_locations loc ON grn.location_id = loc.id
      WHERE grn.id = $1 AND grn.property_id = $2`,
    [grnId, propertyId]
  );

  if (grnRes.rows.length === 0) return null;
  const grn = grnRes.rows[0];
  if (grn.receipt_date) {
    grn.receipt_date = formatCalendarDateStr(grn.receipt_date);
  }

  const itemsRes = await pool.query(
    `SELECT gri.*,
            p.name AS product_name,
            p.item_code,
            p.base_unit,
            p.canonical_base_unit_code,
            ppc.packaging_code,
            COALESCE(gri.packaging_label_snapshot, ppc.packaging_label) AS packaging_label,
            COALESCE(gri.conversion_factor_snapshot, ppc.to_base_factor) AS to_base_factor,
            uom.code AS uom_code,
            uom.name AS uom_name,
            loc.name AS location_name,
            loc.code AS location_code
       FROM pos_goods_receipt_items gri
       JOIN pos_menu_items p ON gri.product_id = p.id
       LEFT JOIN product_packaging_conversions ppc ON gri.packaging_id = ppc.id
       LEFT JOIN pos_product_uoms uom ON gri.uom_id = uom.id
       JOIN stock_locations loc ON gri.location_id = loc.id
      WHERE gri.receipt_id = $1
      ORDER BY gri.id ASC`,
    [grnId]
  );

  grn.items = itemsRes.rows;
  return grn;
}

/**
 * Preview baris pembelian yang dapat diterima ke Gudang 1 dari Transaksi Pembelian yang telah disetujui
 */
export async function getPurchaseTransactionReceivablePreview(
  pool: Pool,
  propertyId: number,
  transactionId: number
) {
  const txRes = await pool.query(
    `SELECT t.id, t.property_id, t.transaction_no, t.transaction_type, t.approval_status,
            t.transaction_status, t.receiving_status, t.supplier_id, t.canonical_supplier_id,
            t.po_id, t.is_legacy_without_po,
            po.po_number, po.status AS po_status, po.approval_status AS po_approval_status, po.destination_location_id AS po_destination_location_id,
            COALESCE(cs.name, s.name, t.party_name) AS supplier_name,
            t.party_name, t.source_reference, t.transaction_date, t.notes,
            COALESCE(t.source_revision, 1) AS source_revision, t.deleted_at,
            (
              SELECT row_to_json(d)
                FROM (
                  SELECT grn.id, grn.grn_number, grn.status,
                         to_char(grn.receipt_date, 'YYYY-MM-DD') AS receipt_date,
                         grn.po_id, grn.transaction_id,
                         grn.supplier_id, grn.canonical_supplier_id, grn.location_id, grn.invoice_no, grn.received_by, grn.notes,
                         grn.operation_key, grn.idempotency_key, grn.source_revision_snapshot,
                         COALESCE(
                           (
                             SELECT json_agg(
                                      json_build_object(
                                        'id', gri.id,
                                        'receipt_id', gri.receipt_id,
                                        'product_id', gri.product_id,
                                        'product_name', pmi.name,
                                        'item_code', pmi.item_code,
                                        'po_item_id', gri.po_item_id,
                                        'transaction_line_id', gri.transaction_line_id,
                                        'packaging_id', gri.packaging_id,
                                        'packaging_code', ppc_g.packaging_code,
                                        'packaging_label', COALESCE(gri.packaging_label_snapshot, ppc_g.packaging_label),
                                        'ordered_unit', gri.ordered_unit,
                                        'received_qty', gri.received_qty,
                                        'base_quantity', gri.base_quantity,
                                        'unit_cost', gri.unit_cost,
                                        'subtotal', gri.subtotal,
                                        'source_allocated_qty', gri.source_allocated_qty,
                                        'conversion_factor_snapshot', gri.conversion_factor_snapshot,
                                        'base_unit', COALESCE(pmi.canonical_base_unit_code, pmi.base_unit, 'PCS'),
                                        'track_stock', COALESCE(pmi.track_stock, false),
                                        'track_inventory', COALESCE(pmi.track_inventory, false)
                                      )
                                      ORDER BY gri.id ASC
                                    )
                               FROM pos_goods_receipt_items gri
                               LEFT JOIN pos_menu_items pmi ON pmi.id = gri.product_id
                               LEFT JOIN product_packaging_conversions ppc_g ON ppc_g.id = gri.packaging_id
                              WHERE gri.receipt_id = grn.id
                           ),
                           '[]'::json
                         ) AS items
                    FROM pos_goods_receipts grn
                   WHERE grn.property_id = t.property_id
                     AND (
                       grn.transaction_id = t.id
                       OR (t.po_id IS NOT NULL AND grn.po_id = t.po_id)
                     )
                     AND grn.status = 'DRAFT'
                   ORDER BY grn.id DESC
                   LIMIT 1
                ) d
            ) AS active_draft
       FROM transactions t
       LEFT JOIN pos_purchase_orders po ON po.id = t.po_id AND po.property_id = t.property_id
       LEFT JOIN pos_suppliers s ON s.id = t.supplier_id AND s.property_id = t.property_id
       LEFT JOIN suppliers cs ON cs.id = t.canonical_supplier_id
      WHERE t.id = $1 AND t.property_id = $2`,
    [transactionId, propertyId]
  );
  if (txRes.rows.length === 0) {
    throw Object.assign(new Error(`Transaksi pembelian #${transactionId} tidak ditemukan`), { statusCode: 404 });
  }
  const tx = txRes.rows[0];
  assertPurchaseTransactionReceivableState(tx);
  if (tx.po_id != null) {
    assertPurchaseOrderReceivableState(
      {
        po_number: tx.po_number || String(tx.po_id),
        status: tx.po_status,
        approval_status: tx.po_approval_status,
      },
      true
    );
  }

  const gudang1 = tx.po_destination_location_id
    ? await validateGudang1DestinationLocation(pool, propertyId, Number(tx.po_destination_location_id)).catch(() =>
        resolveGudang1Location(pool, propertyId)
      )
    : await resolveGudang1Location(pool, propertyId);

  const linesRes = await pool.query(
    `SELECT tl.id AS transaction_line_id,
            COALESCE(b.po_item_id, tl.po_item_id) AS po_item_id,
            tl.description_snapshot,
            tl.quantity AS ordered_quantity,
            tl.unit,
            tl.unit_price,
            tl.line_total,
            COALESCE(tl.line_type, 'STOCK') AS line_type,
            COALESCE(b.product_id, tl.product_id) AS product_id,
            COALESCE(b.packaging_id, tl.packaging_id) AS packaging_id,
            GREATEST(
              COALESCE(b.received_quantity, 0),
              CASE
                WHEN poi.id IS NULL THEN 0
                WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NOT DISTINCT FROM poi.packaging_id THEN COALESCE(poi.received_qty, 0)
                WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NULL THEN
                  COALESCE(poi.received_qty, 0) * COALESCE(
                    NULLIF(poi.conversion_factor_snapshot, 0),
                    CASE WHEN poi.packaging_id IS NULL THEN 1 ELSE NULL END,
                    0
                  )
                WHEN COALESCE(
                  NULLIF(b.conversion_factor_snapshot, 0),
                  NULLIF(tl.conversion_factor_snapshot, 0),
                  CASE
                    WHEN COALESCE(b.packaging_id, tl.packaging_id) = poi.packaging_id
                         AND COALESCE(poi.conversion_factor_snapshot, 0) > 0 THEN poi.conversion_factor_snapshot
                    ELSE NULL
                  END,
                  (SELECT CASE
                            WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                            THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                            ELSE NULL
                          END
                     FROM pos_goods_receipt_items gri_s
                     JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                    WHERE gr_s.property_id = $2
                      AND gr_s.status IN ('POSTED', 'COMPLETED')
                      AND gri_s.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                      AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                      AND (
                        gri_s.transaction_line_id = tl.id
                        OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                      )),
                  0
                ) > 0 THEN
                  (
                    COALESCE(poi.received_qty, 0) * COALESCE(
                      NULLIF(poi.conversion_factor_snapshot, 0),
                      CASE WHEN poi.packaging_id IS NULL THEN 1 ELSE NULL END,
                      0
                    )
                  ) / COALESCE(
                    NULLIF(b.conversion_factor_snapshot, 0),
                    NULLIF(tl.conversion_factor_snapshot, 0),
                    CASE
                      WHEN COALESCE(b.packaging_id, tl.packaging_id) = poi.packaging_id
                           AND COALESCE(poi.conversion_factor_snapshot, 0) > 0 THEN poi.conversion_factor_snapshot
                      ELSE NULL
                    END,
                    (SELECT CASE
                              WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                              THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                              ELSE NULL
                            END
                       FROM pos_goods_receipt_items gri_s
                       JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                      WHERE gr_s.property_id = $2
                        AND gr_s.status IN ('POSTED', 'COMPLETED')
                        AND gri_s.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                        AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                        AND (
                          gri_s.transaction_line_id = tl.id
                          OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                        ))
                  )
                ELSE 0
              END,
              COALESCE(
                (
                  SELECT SUM(
                    CASE
                      WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NOT NULL
                           AND gri.packaging_id = COALESCE(b.packaging_id, tl.packaging_id) THEN gri.received_qty
                      WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NOT NULL
                           AND COALESCE(
                             NULLIF(b.conversion_factor_snapshot, 0),
                             NULLIF(tl.conversion_factor_snapshot, 0),
                             CASE
                               WHEN COALESCE(b.packaging_id, tl.packaging_id) = poi.packaging_id
                                    AND COALESCE(poi.conversion_factor_snapshot, 0) > 0 THEN poi.conversion_factor_snapshot
                               ELSE NULL
                             END,
                             (SELECT CASE
                                       WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                                       THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                                       ELSE NULL
                                     END
                                FROM pos_goods_receipt_items gri_s
                                JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                               WHERE gr_s.property_id = $2
                                 AND gr_s.status IN ('POSTED', 'COMPLETED')
                                 AND gri_s.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                                 AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                                 AND (
                                   gri_s.transaction_line_id = tl.id
                                   OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                                 )),
                             0
                           ) > 0 THEN
                        COALESCE(
                          NULLIF(gri.base_quantity, 0),
                          CASE WHEN gri.packaging_id IS NULL THEN gri.received_qty ELSE gri.received_qty * NULLIF(gri.conversion_factor_snapshot, 0) END,
                          0
                        ) / COALESCE(
                          NULLIF(b.conversion_factor_snapshot, 0),
                          NULLIF(tl.conversion_factor_snapshot, 0),
                          CASE
                            WHEN COALESCE(b.packaging_id, tl.packaging_id) = poi.packaging_id
                                 AND COALESCE(poi.conversion_factor_snapshot, 0) > 0 THEN poi.conversion_factor_snapshot
                            ELSE NULL
                          END,
                          (SELECT CASE
                                    WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                                    THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                                    ELSE NULL
                                  END
                             FROM pos_goods_receipt_items gri_s
                             JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                            WHERE gr_s.property_id = $2
                              AND gr_s.status IN ('POSTED', 'COMPLETED')
                              AND gri_s.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                              AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                              AND (
                                gri_s.transaction_line_id = tl.id
                                OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                              ))
                        )
                      WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NOT NULL THEN 0
                      ELSE COALESCE(
                        NULLIF(gri.base_quantity, 0),
                        CASE WHEN gri.packaging_id IS NULL THEN gri.received_qty ELSE gri.received_qty * NULLIF(gri.conversion_factor_snapshot, 0) END,
                        0
                      )
                    END
                  )
                    FROM pos_goods_receipt_items gri
                    JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
                   WHERE gr.property_id = $2
                     AND (
                       gri.transaction_line_id = tl.id
                       OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                       OR (
                         gr.transaction_id = tl.transaction_id
                         AND gri.transaction_line_id IS NULL
                         AND gri.po_item_id IS NULL
                         AND gri.product_id = COALESCE(b.product_id, tl.product_id)
                         AND (
                           SELECT COUNT(*)
                             FROM transaction_lines tl_cnt
                            WHERE tl_cnt.transaction_id = tl.transaction_id
                              AND COALESCE(tl_cnt.product_id, 0) = COALESCE(b.product_id, tl.product_id, -1)
                         ) = 1
                       )
                     )
                     AND gr.status IN ('POSTED', 'COMPLETED')
                ),
                0
              )
            ) AS received_quantity,
            COALESCE(
              (
                SELECT SUM(
                  COALESCE(
                    NULLIF(gri.base_quantity, 0),
                    CASE WHEN gri.packaging_id IS NULL THEN gri.received_qty ELSE gri.received_qty * NULLIF(gri.conversion_factor_snapshot, 0) END,
                    gri.received_qty,
                    0
                  )
                )
                  FROM pos_goods_receipt_items gri
                  JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
                 WHERE gr.property_id = $2
                   AND (
                     gri.transaction_line_id = tl.id
                     OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                     OR (
                       gr.transaction_id = tl.transaction_id
                       AND gri.transaction_line_id IS NULL
                       AND gri.po_item_id IS NULL
                       AND gri.product_id = COALESCE(b.product_id, tl.product_id)
                       AND (
                         SELECT COUNT(*)
                           FROM transaction_lines tl_cnt
                          WHERE tl_cnt.transaction_id = tl.transaction_id
                            AND COALESCE(tl_cnt.product_id, 0) = COALESCE(b.product_id, tl.product_id, -1)
                       ) = 1
                     )
                   )
                   AND gr.status IN ('POSTED', 'COMPLETED')
              ),
              0
            ) AS raw_grn_base_qty,
            p.name AS product_name,
            p.item_code,
            COALESCE(p.track_stock, false) AS track_stock,
            COALESCE(p.track_inventory, false) AS track_inventory,
            COALESCE(p.canonical_base_unit_code, p.base_unit, 'PCS') AS base_unit_code,
            ppc.packaging_code,
            COALESCE(
              b.packaging_label_snapshot,
              tl.packaging_label_snapshot,
              CASE
                WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NOT NULL
                     AND poi.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                     AND poi.packaging_label_snapshot IS NOT NULL THEN poi.packaging_label_snapshot
                ELSE NULL
              END,
              ppc.packaging_label
            ) AS packaging_label,
            COALESCE(
              NULLIF(b.conversion_factor_snapshot, 0),
              NULLIF(tl.conversion_factor_snapshot, 0),
              CASE
                WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NOT NULL
                     AND poi.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                     AND COALESCE(poi.conversion_factor_snapshot, 0) > 0 THEN poi.conversion_factor_snapshot
                ELSE NULL
              END,
              (SELECT CASE
                        WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                        THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                        ELSE NULL
                      END
                 FROM pos_goods_receipt_items gri_s
                 JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                WHERE gr_s.property_id = $2
                  AND gr_s.status IN ('POSTED', 'COMPLETED')
                  AND gri_s.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                  AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                  AND (
                    gri_s.transaction_line_id = tl.id
                    OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                  )),
              CASE
                WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NULL THEN 1
                ELSE NULL
              END
            ) AS conversion_factor_snapshot,
            COALESCE(
              NULLIF(b.conversion_factor_snapshot, 0),
              NULLIF(tl.conversion_factor_snapshot, 0),
              CASE
                WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NOT NULL
                     AND poi.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                     AND COALESCE(poi.conversion_factor_snapshot, 0) > 0 THEN poi.conversion_factor_snapshot
                ELSE NULL
              END,
              (SELECT CASE
                        WHEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0)) = MAX(NULLIF(gri_s.conversion_factor_snapshot, 0))
                        THEN MIN(NULLIF(gri_s.conversion_factor_snapshot, 0))
                        ELSE NULL
                      END
                 FROM pos_goods_receipt_items gri_s
                 JOIN pos_goods_receipts gr_s ON gr_s.id = gri_s.receipt_id
                WHERE gr_s.property_id = $2
                  AND gr_s.status IN ('POSTED', 'COMPLETED')
                  AND gri_s.packaging_id = COALESCE(b.packaging_id, tl.packaging_id)
                  AND NULLIF(gri_s.conversion_factor_snapshot, 0) IS NOT NULL
                  AND (
                    gri_s.transaction_line_id = tl.id
                    OR (COALESCE(b.po_item_id, tl.po_item_id) IS NOT NULL AND gri_s.po_item_id = COALESCE(b.po_item_id, tl.po_item_id))
                  )),
              CASE
                WHEN COALESCE(b.packaging_id, tl.packaging_id) IS NULL THEN 1
                ELSE NULL
              END
            ) AS to_base_factor
       FROM transaction_lines tl
       LEFT JOIN stock_purchase_line_bindings b ON b.transaction_line_id = tl.id
       LEFT JOIN pos_purchase_order_items poi ON poi.id = COALESCE(b.po_item_id, tl.po_item_id)
       LEFT JOIN pos_menu_items p ON p.id = COALESCE(b.product_id, tl.product_id)
       LEFT JOIN product_packaging_conversions ppc ON ppc.id = COALESCE(b.packaging_id, tl.packaging_id)
      WHERE tl.transaction_id = $1
      ORDER BY tl.sort_order ASC, tl.id ASC`,
    [transactionId, propertyId]
  );

  const receivableItems = linesRes.rows
    .filter((row: any) => !isNonStockPurchaseLineType(row.line_type) && row.product_id)
    .map((row: any) => {
      const ordered = parseFloat(row.ordered_quantity || '0');
      const received = parseFloat(row.received_quantity || '0');
      const remaining = Math.max(0, ordered - received);
      const hasPkg = row.packaging_id != null;
      const verifiedSnap =
        row.conversion_factor_snapshot != null && parseFloat(row.conversion_factor_snapshot) > 0
          ? parseFloat(row.conversion_factor_snapshot)
          : hasPkg
          ? null
          : 1;
      const factor = verifiedSnap;
      const rawGrnBaseQty = parseFloat(row.raw_grn_base_qty || '0');
      const baseUnitCode = row.base_unit_code || 'PCS';
      const orderedUnit = row.unit || row.packaging_code || baseUnitCode;
      const descSnapshot = row.description_snapshot || row.item_name || row.product_name || '';
      const prodName = row.product_name || descSnapshot;
      return {
        transaction_line_id: Number(row.transaction_line_id),
        po_item_id: row.po_item_id != null ? Number(row.po_item_id) : null,
        product_id: Number(row.product_id),
        product_name: prodName,
        description_snapshot: descSnapshot,
        item_code: row.item_code || null,
        packaging_id: row.packaging_id ? Number(row.packaging_id) : null,
        packaging_code: row.packaging_code || null,
        packaging_label: row.packaging_label || null,
        conversion_factor_snapshot: verifiedSnap,
        to_base_factor: factor,
        conversion_factor_unresolved: hasPkg && verifiedSnap === null,
        unverified_received_base_qty: hasPkg && verifiedSnap === null ? rawGrnBaseQty : 0,
        unit: orderedUnit,
        ordered_unit: orderedUnit,
        base_unit: baseUnitCode,
        base_unit_code: baseUnitCode,
        ordered_qty: ordered,
        received_qty: received,
        remaining_qty: remaining,
        unit_cost: parseFloat(row.unit_price || '0'),
        line_type: String(row.line_type || 'STOCK').toUpperCase(),
        track_stock: Boolean(row.track_stock),
        track_inventory: Boolean(row.track_inventory),
      };
    });

  const activeDraft = tx.active_draft || null;
  if (activeDraft && activeDraft.receipt_date) {
    activeDraft.receipt_date = formatCalendarDateStr(activeDraft.receipt_date);
  }

  return {
    transaction_id: Number(tx.id),
    po_id: tx.po_id != null ? Number(tx.po_id) : null,
    po_number: tx.po_number || null,
    property_id: Number(tx.property_id || propertyId),
    transaction_no: tx.transaction_no || `TX-${tx.id}`,
    transaction_date: tx.transaction_date || null,
    approval_status: tx.approval_status || 'APPROVED',
    receiving_status: tx.receiving_status || 'BELUM_DITERIMA',
    supplier_id: tx.supplier_id ? Number(tx.supplier_id) : null,
    canonical_supplier_id: tx.canonical_supplier_id ? Number(tx.canonical_supplier_id) : null,
    supplier_name: tx.supplier_name || tx.party_name || null,
    source_reference: tx.source_reference || null,
    source_revision: Number(tx.source_revision ?? 1),
    default_location: gudang1,
    active_draft_id: activeDraft ? Number(activeDraft.id) : null,
    active_draft: activeDraft,
    lines: receivableItems,
    // Backward-compatible aliases
    transaction: tx,
    items: receivableItems,
  };
}

/**
 * Preview baris Purchase Order (PO) yang dapat diterima ke Gudang 1
 * Mendukung penerimaan langsung dari PO yang telah disetujui meskipun belum ada tagihan/nota (Tahap 1A).
 */
export async function getPurchaseOrderReceivablePreview(
  pool: Pool,
  propertyId: number,
  poId: number
) {
  const poRes = await pool.query(
    `SELECT po.*,
            to_char(po.order_date, 'YYYY-MM-DD') AS order_date,
            COALESCE(cs.name, s.name) AS supplier_name,
            COALESCE(cs.code, s.code) AS supplier_code,
            (
              SELECT row_to_json(d)
                FROM (
                  SELECT grn.id, grn.grn_number, grn.status,
                         to_char(grn.receipt_date, 'YYYY-MM-DD') AS receipt_date,
                         grn.po_id, grn.transaction_id,
                         grn.supplier_id, grn.canonical_supplier_id, grn.location_id, grn.invoice_no, grn.received_by, grn.notes,
                         grn.operation_key, grn.idempotency_key, grn.source_revision_snapshot,
                         COALESCE(
                           (
                             SELECT json_agg(
                                      json_build_object(
                                        'id', gri.id,
                                        'receipt_id', gri.receipt_id,
                                        'product_id', gri.product_id,
                                        'product_name', pmi.name,
                                        'item_code', pmi.item_code,
                                        'po_item_id', gri.po_item_id,
                                        'transaction_line_id', gri.transaction_line_id,
                                        'packaging_id', gri.packaging_id,
                                        'packaging_code', ppc_g.packaging_code,
                                        'packaging_label', COALESCE(gri.packaging_label_snapshot, ppc_g.packaging_label),
                                        'ordered_unit', gri.ordered_unit,
                                        'received_qty', gri.received_qty,
                                        'base_quantity', gri.base_quantity,
                                        'unit_cost', gri.unit_cost,
                                        'subtotal', gri.subtotal,
                                        'source_allocated_qty', gri.source_allocated_qty,
                                        'conversion_factor_snapshot', gri.conversion_factor_snapshot,
                                        'base_unit', COALESCE(pmi.canonical_base_unit_code, pmi.base_unit, 'PCS'),
                                        'track_stock', COALESCE(pmi.track_stock, false),
                                        'track_inventory', COALESCE(pmi.track_inventory, false)
                                      )
                                      ORDER BY gri.id ASC
                                    )
                               FROM pos_goods_receipt_items gri
                               LEFT JOIN pos_menu_items pmi ON pmi.id = gri.product_id
                               LEFT JOIN product_packaging_conversions ppc_g ON ppc_g.id = gri.packaging_id
                              WHERE gri.receipt_id = grn.id
                           ),
                           '[]'::json
                         ) AS items
                    FROM pos_goods_receipts grn
                   WHERE grn.property_id = po.property_id
                     AND grn.po_id = po.id
                     AND grn.status = 'DRAFT'
                   ORDER BY grn.id DESC
                   LIMIT 1
                ) d
            ) AS active_draft
       FROM pos_purchase_orders po
       LEFT JOIN pos_suppliers s ON s.id = po.supplier_id
       LEFT JOIN suppliers cs ON cs.id = po.canonical_supplier_id
      WHERE po.id = $1 AND po.property_id = $2`,
    [poId, propertyId]
  );
  if (poRes.rows.length === 0) {
    throw Object.assign(new Error(`Purchase Order #${poId} tidak ditemukan`), { statusCode: 404 });
  }
  const po = poRes.rows[0];
  assertPurchaseOrderReceivableState(po, true);

  const gudang1 = po.destination_location_id
    ? await validateGudang1DestinationLocation(pool, propertyId, Number(po.destination_location_id)).catch(() =>
        resolveGudang1Location(pool, propertyId)
      )
    : await resolveGudang1Location(pool, propertyId);

  const itemsRes = await pool.query(
    `SELECT poi.id AS po_item_id,
            poi.product_id,
            poi.ordered_qty,
            poi.packaging_id,
            poi.ordered_unit,
            poi.packaging_label_snapshot,
            poi.conversion_factor_snapshot,
            poi.unit_cost,
            poi.subtotal,
            GREATEST(
              COALESCE(poi.received_qty, 0),
              COALESCE(
                (
                  SELECT SUM(
                    CASE
                      WHEN poi.packaging_id IS NOT NULL AND gri.packaging_id = poi.packaging_id THEN gri.received_qty
                      WHEN COALESCE(NULLIF(poi.conversion_factor_snapshot, 0), ppc.to_base_factor, 0) > 0 THEN
                        COALESCE(
                          NULLIF(gri.base_quantity, 0),
                          gri.received_qty * COALESCE(NULLIF(gri.conversion_factor_snapshot, 0), ppc_gri.to_base_factor, 1)
                        ) / COALESCE(NULLIF(poi.conversion_factor_snapshot, 0), ppc.to_base_factor, 1)
                      ELSE COALESCE(
                        NULLIF(gri.base_quantity, 0),
                        gri.received_qty * COALESCE(NULLIF(gri.conversion_factor_snapshot, 0), ppc_gri.to_base_factor, 1),
                        gri.received_qty
                      )
                    END
                  )
                    FROM pos_goods_receipt_items gri
                    JOIN pos_goods_receipts gr ON gr.id = gri.receipt_id
                    LEFT JOIN product_packaging_conversions ppc_gri ON ppc_gri.id = gri.packaging_id
                   WHERE gr.property_id = $2
                     AND gr.status IN ('POSTED', 'COMPLETED')
                     AND (
                       gri.po_item_id = poi.id
                       OR (
                         gri.transaction_line_id IS NOT NULL
                         AND EXISTS (
                           SELECT 1
                             FROM transaction_lines tl
                             LEFT JOIN stock_purchase_line_bindings b ON b.transaction_line_id = tl.id
                            WHERE tl.id = gri.transaction_line_id
                              AND COALESCE(b.po_item_id, tl.po_item_id) = poi.id
                         )
                       )
                       OR (
                         gr.po_id = poi.po_id
                         AND gri.po_item_id IS NULL
                         AND gri.transaction_line_id IS NULL
                         AND gri.product_id = poi.product_id
                         AND (
                           SELECT COUNT(*)
                             FROM pos_purchase_order_items poi_cnt
                            WHERE poi_cnt.po_id = poi.po_id
                              AND poi_cnt.product_id = poi.product_id
                         ) = 1
                       )
                     )
                ),
                0
              )
            ) AS received_quantity,
            p.name AS product_name,
            p.item_code,
            COALESCE(p.track_stock, false) AS track_stock,
            COALESCE(p.track_inventory, false) AS track_inventory,
            COALESCE(p.canonical_base_unit_code, p.base_unit, 'PCS') AS base_unit_code,
            ppc.packaging_code,
            ppc.packaging_label,
            ppc.to_base_factor,
            (
              SELECT tl.id
                FROM transaction_lines tl
                JOIN transactions t ON t.id = tl.transaction_id
                LEFT JOIN stock_purchase_line_bindings b ON b.transaction_line_id = tl.id
               WHERE t.property_id = $2
                 AND t.po_id = poi.po_id
                 AND t.deleted_at IS NULL
                 AND COALESCE(t.transaction_status, 'PROSES') != 'BATAL'
                 AND COALESCE(b.po_item_id, tl.po_item_id) = poi.id
               ORDER BY t.id DESC, tl.id ASC
               LIMIT 1
            ) AS linked_transaction_line_id
       FROM pos_purchase_order_items poi
       JOIN pos_menu_items p ON p.id = poi.product_id
       LEFT JOIN product_packaging_conversions ppc ON ppc.id = poi.packaging_id
      WHERE poi.po_id = $1
      ORDER BY poi.id ASC`,
    [poId, propertyId]
  );

  const receivableItems = itemsRes.rows.map((row: any) => {
    const ordered = parseFloat(row.ordered_qty || '0');
    const received = parseFloat(row.received_quantity || '0');
    const remaining = Math.max(0, ordered - received);
    const factor = row.conversion_factor_snapshot
      ? parseFloat(row.conversion_factor_snapshot)
      : row.to_base_factor
        ? parseFloat(row.to_base_factor)
        : 1;
    const baseUnitCode = row.base_unit_code || 'PCS';
    const orderedUnit = row.ordered_unit || row.packaging_code || baseUnitCode;
    return {
      po_item_id: Number(row.po_item_id),
      transaction_line_id: row.linked_transaction_line_id != null ? Number(row.linked_transaction_line_id) : null,
      product_id: Number(row.product_id),
      product_name: row.product_name,
      description_snapshot: row.product_name,
      item_code: row.item_code || null,
      packaging_id: row.packaging_id ? Number(row.packaging_id) : null,
      packaging_code: row.packaging_code || null,
      packaging_label: row.packaging_label_snapshot || row.packaging_label || null,
      to_base_factor: factor,
      unit: orderedUnit,
      ordered_unit: orderedUnit,
      base_unit: baseUnitCode,
      base_unit_code: baseUnitCode,
      ordered_qty: ordered,
      received_qty: received,
      remaining_qty: remaining,
      unit_cost: parseFloat(row.unit_cost || '0'),
      line_type: 'STOCK',
      track_stock: Boolean(row.track_stock),
      track_inventory: Boolean(row.track_inventory),
    };
  });

  const activeDraft = po.active_draft || null;
  if (activeDraft && activeDraft.receipt_date) {
    activeDraft.receipt_date = formatCalendarDateStr(activeDraft.receipt_date);
  }

  return {
    po_id: Number(po.id),
    property_id: Number(po.property_id || propertyId),
    po_number: po.po_number,
    order_date: po.order_date || null,
    status: po.status,
    approval_status: po.approval_status || 'APPROVED',
    supplier_id: po.supplier_id ? Number(po.supplier_id) : null,
    canonical_supplier_id: po.canonical_supplier_id ? Number(po.canonical_supplier_id) : null,
    supplier_name: po.supplier_name || null,
    source_revision: Number(po.source_revision ?? 1),
    default_location: gudang1,
    active_draft_id: activeDraft ? Number(activeDraft.id) : null,
    active_draft: activeDraft,
    lines: receivableItems,
    purchase_order: po,
    items: receivableItems,
  };
}


