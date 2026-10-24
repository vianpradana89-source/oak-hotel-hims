/**
 * Service & Domain Logic: Goods Receipt Note (GRN) / Penerimaan Barang POS (MP-04D)
 * OAK Hotel Integrated Management System (HIMS)
 */

import { Pool, PoolClient } from 'pg';

export interface PosGoodsReceiptItem {
  id: number;
  receipt_id: number;
  product_id: number;
  product_name?: string;
  item_code?: string | null;
  base_unit?: string | null;
  canonical_base_unit_code?: string | null;
  po_item_id: number | null;
  received_qty: string;
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
  supplier_id: number | null;
  supplier_name?: string | null;
  supplier_code?: string | null;
  location_id: number | null;
  location_name?: string | null;
  location_code?: string | null;
  receipt_date: string;
  invoice_no: string | null;
  received_by: string | null;
  status: 'COMPLETED' | 'CANCELLED';
  notes: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  items?: PosGoodsReceiptItem[];
  po_status?: string | null;
}

export interface GoodsReceiptItemInput {
  product_id: number;
  po_item_id?: number | null;
  received_qty: number | string;
  unit_cost: number | string;
  uom_id?: number | null;
  location_id?: number | null;
}

export interface CreateGoodsReceiptInput {
  property_id: number;
  grn_number?: string;
  po_id?: number | null;
  supplier_id?: number | null;
  location_id: number;
  receipt_date?: string;
  invoice_no?: string | null;
  received_by?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
  items: GoodsReceiptItemInput[];
}

export interface GetGoodsReceiptsFilter {
  po_id?: number;
  supplier_id?: number;
  location_id?: number;
  start_date?: string;
  end_date?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Generate nomor GRN unik: GRN-YYYYMMDD-XXXX
 */
async function generateGrnNumber(client: PoolClient | Pool, propertyId: number): Promise<string> {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const datePrefix = `GRN-${yyyy}${mm}${dd}-`;

  const seqRes = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM pos_goods_receipts
      WHERE property_id = $1 AND grn_number LIKE $2`,
    [propertyId, `${datePrefix}%`]
  );
  const nextSeq = (seqRes.rows[0]?.count || 0) + 1;
  const seqStr = String(nextSeq).padStart(4, '0');
  return `${datePrefix}${seqStr}`;
}

/**
 * Catat Penerimaan Barang (GRN) ke inventaris dengan validasi PO,
 * kalkulasi moving average cost, dan ledger append-only (stock_operations + stock_movements).
 */
export async function recordPosGoodsReceipt(
  pool: Pool,
  input: CreateGoodsReceiptInput
): Promise<PosGoodsReceipt> {
  const propertyId = Number(input.property_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), { statusCode: 400 });
  }

  const defaultLocationId = Number(input.location_id);
  if (!Number.isInteger(defaultLocationId) || defaultLocationId <= 0) {
    throw Object.assign(new Error('location_id gudang penerimaan wajib diisi'), { statusCode: 400 });
  }

  if (!input.items || !Array.isArray(input.items) || input.items.length === 0) {
    throw Object.assign(new Error('Item penerimaan barang (items) tidak boleh kosong'), { statusCode: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Cek Idempotency Key jika disertakan
    const idempotencyKey = input.idempotency_key ? String(input.idempotency_key).trim() : null;
    if (idempotencyKey) {
      const existingRes = await client.query(
        `SELECT id FROM pos_goods_receipts WHERE property_id = $1 AND idempotency_key = $2`,
        [propertyId, idempotencyKey]
      );
      if (existingRes.rows.length > 0) {
        await client.query('ROLLBACK');
        const existingGrnId = existingRes.rows[0].id;
        const grn = await getPosGoodsReceiptById(pool, propertyId, existingGrnId);
        if (!grn) {
          throw Object.assign(new Error('GRN tercatat namun detail tidak ditemukan'), { statusCode: 500 });
        }
        return grn;
      }
    }

    // 2. Validasi Lokasi Utama
    const locRes = await client.query(
      `SELECT id, name, code FROM stock_locations WHERE id = $1 AND property_id = $2`,
      [defaultLocationId, propertyId]
    );
    if (locRes.rows.length === 0) {
      throw Object.assign(new Error(`Lokasi gudang penerimaan #${defaultLocationId} tidak ditemukan`), { statusCode: 404 });
    }

    // 3. Validasi PO jika terkait
    const poId = input.po_id ? Number(input.po_id) : null;
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

      if (targetPo.status === 'DRAFT') {
        throw Object.assign(
          new Error(`PO #${targetPo.po_number} masih berstatus DRAFT, silakan setujui (ORDERED) terlebih dahulu`),
          { statusCode: 400, code: 'PO_NOT_ORDERED' }
        );
      }
      if (targetPo.status === 'COMPLETED') {
        throw Object.assign(
          new Error(`PO #${targetPo.po_number} sudah selesai diterima sepenuhnya (COMPLETED)`),
          { statusCode: 400, code: 'PO_ALREADY_COMPLETED' }
        );
      }
      if (targetPo.status === 'CANCELLED') {
        throw Object.assign(
          new Error(`PO #${targetPo.po_number} telah dibatalkan (CANCELLED)`),
          { statusCode: 400, code: 'PO_CANCELLED' }
        );
      }

      // Ambil seluruh item PO dengan lock
      const poItemsRes = await client.query(
        `SELECT * FROM pos_purchase_order_items WHERE po_id = $1 FOR UPDATE`,
        [poId]
      );
      for (const row of poItemsRes.rows) {
        poItemsMap.set(row.id, row);
      }
    }

    // 4. Supplier ID
    let supplierId = input.supplier_id ? Number(input.supplier_id) : (targetPo ? targetPo.supplier_id : null);
    if (supplierId) {
      const supRes = await client.query(
        `SELECT id, name FROM pos_suppliers WHERE id = $1 AND property_id = $2`,
        [supplierId, propertyId]
      );
      if (supRes.rows.length === 0) {
        throw Object.assign(new Error(`Supplier #${supplierId} tidak ditemukan`), { statusCode: 404 });
      }
    }

    // 5. Validasi Nomor GRN
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

    // 6. Validasi Items
    const validatedItems: Array<{
      product_id: number;
      product_name: string;
      base_unit_code: string;
      po_item_id: number | null;
      received_qty: number;
      unit_cost: number;
      subtotal: number;
      uom_id: number | null;
      location_id: number;
    }> = [];

    for (const item of input.items) {
      const prodId = Number(item.product_id);
      const qty = parseFloat(String(item.received_qty));
      const cost = parseFloat(String(item.unit_cost || 0));
      const itemLocId = item.location_id ? Number(item.location_id) : defaultLocationId;

      if (!Number.isInteger(prodId) || prodId <= 0) {
        throw Object.assign(new Error('product_id item GRN tidak valid'), { statusCode: 400 });
      }
      if (isNaN(qty) || qty <= 0) {
        throw Object.assign(new Error('Kuantitas penerimaan (received_qty) harus lebih besar dari 0'), { statusCode: 400 });
      }
      if (isNaN(cost) || cost < 0) {
        throw Object.assign(new Error('Harga satuan penerimaan (unit_cost) tidak boleh negatif'), { statusCode: 400 });
      }

      // Validasi produk terdaftar di properti
      const prodRes = await client.query(
        `SELECT id, name, canonical_base_unit_code, base_unit, average_cost, last_cost
           FROM pos_menu_items
          WHERE id = $1 AND property_id = $2`,
        [prodId, propertyId]
      );
      if (prodRes.rows.length === 0) {
        throw Object.assign(new Error(`Produk #${prodId} tidak ditemukan pada properti`), { statusCode: 404 });
      }
      const productRow = prodRes.rows[0];

      // Jika lokasi item berbeda dari header, pastikan lokasi ada
      if (itemLocId !== defaultLocationId) {
        const itemLocRes = await client.query(
          `SELECT id FROM stock_locations WHERE id = $1 AND property_id = $2`,
          [itemLocId, propertyId]
        );
        if (itemLocRes.rows.length === 0) {
          throw Object.assign(new Error(`Lokasi item #${itemLocId} tidak ditemukan`), { statusCode: 404 });
        }
      }

      // Validasi PO Item jika ada
      let poItemId = item.po_item_id ? Number(item.po_item_id) : null;
      if (targetPo) {
        // Jika po_item_id tidak dispesifikasi, cari baris PO dengan product_id cocok
        if (!poItemId) {
          for (const [id, pi] of poItemsMap.entries()) {
            if (pi.product_id === prodId) {
              poItemId = id;
              break;
            }
          }
        }

        if (poItemId) {
          const poItem = poItemsMap.get(poItemId);
          if (!poItem) {
            throw Object.assign(new Error(`Baris PO #${poItemId} tidak ditemukan dalam PO #${targetPo.po_number}`), { statusCode: 400 });
          }
          if (poItem.product_id !== prodId) {
            throw Object.assign(new Error(`Produk baris PO #${poItemId} (${poItem.product_id}) tidak cocok dengan item penerimaan (${prodId})`), { statusCode: 400 });
          }

          const curReceived = parseFloat(poItem.received_qty);
          const ordered = parseFloat(poItem.ordered_qty);
          const remaining = ordered - curReceived;

          if (qty > remaining + 0.0001) {
            throw Object.assign(
              new Error(`Kuantitas penerimaan (${qty}) melebihi sisa pesanan PO (${remaining.toFixed(2)}) untuk produk "${productRow.name}"`),
              { statusCode: 400, code: 'OVER_RECEIPT_NOT_ALLOWED' }
            );
          }
        }
      }

      const subtotal = qty * cost;
      const baseUnitCode = productRow.canonical_base_unit_code || productRow.base_unit || 'PCS';

      validatedItems.push({
        product_id: prodId,
        product_name: productRow.name,
        base_unit_code: baseUnitCode,
        po_item_id: poItemId,
        received_qty: qty,
        unit_cost: cost,
        subtotal,
        uom_id: item.uom_id ? Number(item.uom_id) : null,
        location_id: itemLocId,
      });
    }

    // 7. Insert Header GRN
    const receiptDate = input.receipt_date || new Date().toISOString().slice(0, 10);
    const invoiceNo = input.invoice_no ? String(input.invoice_no).trim() : null;
    const receivedBy = input.received_by ? String(input.received_by).trim() : null;
    const notes = input.notes ? String(input.notes).trim() : null;

    const grnInsertRes = await client.query(
      `INSERT INTO pos_goods_receipts (
         property_id, grn_number, po_id, supplier_id, location_id, receipt_date,
         invoice_no, received_by, status, notes, idempotency_key, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED', $9, $10, NOW(), NOW())
       RETURNING *`,
      [propertyId, grnNumber, poId, supplierId, defaultLocationId, receiptDate, invoiceNo, receivedBy, notes, idempotencyKey]
    );
    const createdGrn = grnInsertRes.rows[0];

    // 8. Buat Header Stock Operations untuk Ledger Audit Trail
    const opKey = `grn:${propertyId}:${grnNumber}`;
    const opInsertRes = await client.query(
      `INSERT INTO stock_operations (
         property_id, operation_type, operation_key, payload_fingerprint,
         notes, metadata, created_at
       ) VALUES ($1, 'PURCHASE_RECEIPT', $2, $3, $4, $5, NOW())
       RETURNING id, created_at`,
      [
        propertyId,
        opKey,
        opKey,
        notes,
        JSON.stringify({
          grn_id: createdGrn.id,
          grn_number: grnNumber,
          po_id: poId,
          supplier_id: supplierId,
          invoice_no: invoiceNo,
          received_by: receivedBy,
        }),
      ]
    );
    const opRow = opInsertRes.rows[0];

    // 9. Eksekusi Items: Insert GRN Items, Update Moving Average Cost, Update PO Item, Insert Stock Movements & Balances
    const insertedGrnItems: PosGoodsReceiptItem[] = [];

    for (const vItem of validatedItems) {
      // 9a. Insert GRN item
      const griRes = await client.query(
        `INSERT INTO pos_goods_receipt_items (
           receipt_id, product_id, po_item_id, received_qty, unit_cost, subtotal, uom_id, location_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING *`,
        [
          createdGrn.id,
          vItem.product_id,
          vItem.po_item_id,
          vItem.received_qty,
          vItem.unit_cost,
          vItem.subtotal,
          vItem.uom_id,
          vItem.location_id,
        ]
      );
      insertedGrnItems.push(griRes.rows[0]);

      // 9b. Update PO item received_qty jika ada
      if (vItem.po_item_id) {
        await client.query(
          `UPDATE pos_purchase_order_items
              SET received_qty = received_qty + $1,
                  updated_at = NOW()
            WHERE id = $2`,
          [vItem.received_qty, vItem.po_item_id]
        );
      }

      // 9c. Kalkulasi Moving Average Unit Cost
      // Ambil total saldo eksisting produk di seluruh lokasi properti
      const curStockRes = await client.query(
        `SELECT COALESCE(SUM(quantity), 0) AS total_qty
           FROM stock_balances
          WHERE property_id = $1 AND product_id = $2`,
        [propertyId, vItem.product_id]
      );
      const existingQty = parseFloat(curStockRes.rows[0]?.total_qty || '0');

      const prodCostRes = await client.query(
        `SELECT average_cost, last_cost FROM pos_menu_items WHERE id = $1`,
        [vItem.product_id]
      );
      const existingAvgCost = parseFloat(prodCostRes.rows[0]?.average_cost || '0');

      let newAvgCost: number;
      if (existingQty <= 0 || existingAvgCost <= 0) {
        newAvgCost = vItem.unit_cost;
      } else {
        const totalOldValuation = existingQty * existingAvgCost;
        const totalNewValuation = vItem.received_qty * vItem.unit_cost;
        const totalNewQty = existingQty + vItem.received_qty;
        newAvgCost = totalNewQty > 0 ? (totalOldValuation + totalNewValuation) / totalNewQty : vItem.unit_cost;
      }

      await client.query(
        `UPDATE pos_menu_items
            SET average_cost = $1,
                last_cost = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [newAvgCost.toFixed(2), vItem.unit_cost.toFixed(2), vItem.product_id]
      );

      // 9d. Append ke stock_movements (Ledger)
      await client.query(
        `INSERT INTO stock_movements (
           operation_id, property_id, product_id, location_id,
           quantity_delta, base_unit_code, unit_cost, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          opRow.id,
          propertyId,
          vItem.product_id,
          vItem.location_id,
          vItem.received_qty,
          vItem.base_unit_code,
          vItem.unit_cost,
        ]
      );

      // 9e. Update stock_balances (Atomic Upsert)
      await client.query(
        `INSERT INTO stock_balances (
           property_id, product_id, location_id, quantity, updated_at
         ) VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (property_id, product_id, location_id)
         DO UPDATE SET
           quantity = stock_balances.quantity + EXCLUDED.quantity,
           updated_at = NOW()`,
        [propertyId, vItem.product_id, vItem.location_id, vItem.received_qty]
      );
    }

    // 10. Perbarui Status PO jika ada
    let updatedPoStatus: string | null = null;
    if (targetPo) {
      const allPoItemsRes = await client.query(
        `SELECT ordered_qty, received_qty FROM pos_purchase_order_items WHERE po_id = $1`,
        [poId]
      );
      const isAllReceived = allPoItemsRes.rows.every(
        (row: any) => parseFloat(row.received_qty) >= parseFloat(row.ordered_qty) - 0.0001
      );

      updatedPoStatus = isAllReceived ? 'COMPLETED' : 'PARTIALLY_RECEIVED';
      await client.query(
        `UPDATE pos_purchase_orders
            SET status = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [updatedPoStatus, poId]
      );
    }

    await client.query('COMMIT');

    createdGrn.items = insertedGrnItems;
    createdGrn.po_status = updatedPoStatus;
    return createdGrn;
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
  if (filter.supplier_id) {
    conditions.push(`grn.supplier_id = $${pIdx++}`);
    params.push(filter.supplier_id);
  }
  if (filter.location_id) {
    conditions.push(`grn.location_id = $${pIdx++}`);
    params.push(filter.location_id);
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
    conditions.push(`(grn.grn_number ILIKE $${pIdx} OR grn.invoice_no ILIKE $${pIdx} OR s.name ILIKE $${pIdx})`);
    params.push(`%${filter.search.trim()}%`);
    pIdx++;
  }

  const whereClause = conditions.join(' AND ');

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total
       FROM pos_goods_receipts grn
       LEFT JOIN pos_suppliers s ON grn.supplier_id = s.id
      WHERE ${whereClause}`,
    params
  );
  const total = countRes.rows[0]?.total || 0;

  const listRes = await pool.query(
    `SELECT grn.*,
            po.po_number,
            s.name AS supplier_name,
            s.code AS supplier_code,
            loc.name AS location_name,
            loc.code AS location_code
       FROM pos_goods_receipts grn
       LEFT JOIN pos_purchase_orders po ON grn.po_id = po.id
       LEFT JOIN pos_suppliers s ON grn.supplier_id = s.id
       LEFT JOIN stock_locations loc ON grn.location_id = loc.id
      WHERE ${whereClause}
      ORDER BY grn.id DESC
      LIMIT $${pIdx++} OFFSET $${pIdx++}`,
    [...params, limit, offset]
  );

  return {
    receipts: listRes.rows,
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
            po.po_number,
            s.name AS supplier_name,
            s.code AS supplier_code,
            loc.name AS location_name,
            loc.code AS location_code
       FROM pos_goods_receipts grn
       LEFT JOIN pos_purchase_orders po ON grn.po_id = po.id
       LEFT JOIN pos_suppliers s ON grn.supplier_id = s.id
       LEFT JOIN stock_locations loc ON grn.location_id = loc.id
      WHERE grn.id = $1 AND grn.property_id = $2`,
    [grnId, propertyId]
  );

  if (grnRes.rows.length === 0) return null;
  const grn = grnRes.rows[0];

  const itemsRes = await pool.query(
    `SELECT gri.*,
            p.name AS product_name,
            p.item_code,
            p.base_unit,
            p.canonical_base_unit_code,
            uom.code AS uom_code,
            uom.name AS uom_name,
            loc.name AS location_name,
            loc.code AS location_code
       FROM pos_goods_receipt_items gri
       JOIN pos_menu_items p ON gri.product_id = p.id
       LEFT JOIN pos_product_uoms uom ON gri.uom_id = uom.id
       JOIN stock_locations loc ON gri.location_id = loc.id
      WHERE gri.receipt_id = $1
      ORDER BY gri.id ASC`,
    [grnId]
  );

  grn.items = itemsRes.rows;
  return grn;
}
