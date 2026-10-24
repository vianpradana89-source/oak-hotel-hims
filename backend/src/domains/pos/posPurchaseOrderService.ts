/**
 * Service & Domain Logic: Purchase Order (PO) & Supplier POS (MP-04D)
 * OAK Hotel Integrated Management System (HIMS)
 */

import { Pool, PoolClient } from 'pg';

export interface PosSupplier {
  id: number;
  property_id: number;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateSupplierInput {
  property_id: number;
  code: string;
  name: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  is_active?: boolean;
}

export interface UpdateSupplierInput {
  code?: string;
  name?: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  is_active?: boolean;
}

export interface PosPurchaseOrderItem {
  id: number;
  po_id: number;
  product_id: number;
  product_name?: string;
  item_code?: string | null;
  base_unit?: string | null;
  canonical_base_unit_code?: string | null;
  ordered_qty: string;
  received_qty: string;
  unit_cost: string;
  uom_id: number | null;
  uom_code?: string | null;
  uom_name?: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PosPurchaseOrder {
  id: number;
  property_id: number;
  po_number: string;
  supplier_id: number;
  supplier_name?: string;
  supplier_code?: string;
  order_date: string;
  expected_date: string | null;
  status: 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'COMPLETED' | 'CANCELLED';
  notes: string | null;
  total_estimated_amount: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  items?: PosPurchaseOrderItem[];
}

export interface CreatePurchaseOrderItemInput {
  product_id: number;
  ordered_qty: number | string;
  unit_cost: number | string;
  uom_id?: number | null;
  notes?: string | null;
}

export interface CreatePurchaseOrderInput {
  property_id: number;
  po_number?: string;
  supplier_id: number;
  order_date?: string;
  expected_date?: string | null;
  notes?: string | null;
  created_by?: string | null;
  items: CreatePurchaseOrderItemInput[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Supplier CRUD Operations
// ─────────────────────────────────────────────────────────────────────────────

export interface GetSuppliersFilter {
  search?: string;
  is_active?: boolean;
}

export async function getPosSuppliers(
  clientOrPool: Pool | PoolClient,
  propertyId: number,
  filter?: string | GetSuppliersFilter
): Promise<PosSupplier[]> {
  const search = typeof filter === 'string' ? filter : filter?.search;
  const isActive = typeof filter === 'object' ? filter?.is_active : undefined;

  const params: any[] = [propertyId];
  let query = `
    SELECT id, property_id, code, name, contact_person, phone, email, address, is_active, created_at, updated_at
      FROM pos_suppliers
     WHERE property_id = $1
  `;
  let pIdx = 2;
  if (search && search.trim()) {
    query += ` AND (name ILIKE $${pIdx} OR code ILIKE $${pIdx} OR contact_person ILIKE $${pIdx})`;
    params.push(`%${search.trim()}%`);
    pIdx++;
  }
  if (isActive !== undefined) {
    query += ` AND is_active = $${pIdx}`;
    params.push(Boolean(isActive));
    pIdx++;
  }
  query += ` ORDER BY name ASC`;
  const res = await clientOrPool.query(query, params);
  return res.rows;
}

export async function getPosSupplierById(
  clientOrPool: Pool | PoolClient,
  propertyId: number,
  supplierId: number
): Promise<PosSupplier | null> {
  const res = await clientOrPool.query(
    `SELECT id, property_id, code, name, contact_person, phone, email, address, is_active, created_at, updated_at
       FROM pos_suppliers
      WHERE id = $1 AND property_id = $2`,
    [supplierId, propertyId]
  );
  return res.rows[0] || null;
}

export async function createPosSupplier(
  clientOrPool: Pool | PoolClient,
  input: CreateSupplierInput
): Promise<PosSupplier> {
  const propertyId = Number(input.property_id);
  const code = String(input.code || '').trim().toUpperCase();
  const name = String(input.name || '').trim();

  if (!code) {
    throw Object.assign(new Error('Kode supplier wajib diisi'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (!name) {
    throw Object.assign(new Error('Nama supplier wajib diisi'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  // Cek duplikasi kode dalam properti
  const existing = await clientOrPool.query(
    `SELECT id FROM pos_suppliers WHERE property_id = $1 AND UPPER(code) = UPPER($2)`,
    [propertyId, code]
  );
  if (existing.rows.length > 0) {
    throw Object.assign(new Error(`Supplier dengan kode "${code}" sudah terdaftar pada properti ini`), {
      statusCode: 409,
      code: 'DUPLICATE_SUPPLIER_CODE',
    });
  }

  const res = await clientOrPool.query(
    `INSERT INTO pos_suppliers (
       property_id, code, name, contact_person, phone, email, address, is_active, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     RETURNING *`,
    [
      propertyId,
      code,
      name,
      input.contact_person ? input.contact_person.trim() : null,
      input.phone ? input.phone.trim() : null,
      input.email ? input.email.trim() : null,
      input.address ? input.address.trim() : null,
      input.is_active !== undefined ? Boolean(input.is_active) : true,
    ]
  );

  return res.rows[0];
}

export async function updatePosSupplier(
  clientOrPool: Pool | PoolClient,
  propertyId: number,
  supplierId: number,
  input: UpdateSupplierInput
): Promise<PosSupplier> {
  const current = await getPosSupplierById(clientOrPool, propertyId, supplierId);
  if (!current) {
    throw Object.assign(new Error('Supplier tidak ditemukan'), { statusCode: 404, code: 'SUPPLIER_NOT_FOUND' });
  }

  const code = input.code !== undefined ? String(input.code).trim().toUpperCase() : current.code;
  const name = input.name !== undefined ? String(input.name).trim() : current.name;

  if (!code) {
    throw Object.assign(new Error('Kode supplier tidak boleh kosong'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (!name) {
    throw Object.assign(new Error('Nama supplier tidak boleh kosong'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  if (code !== current.code) {
    const existing = await clientOrPool.query(
      `SELECT id FROM pos_suppliers WHERE property_id = $1 AND UPPER(code) = UPPER($2) AND id <> $3`,
      [propertyId, code, supplierId]
    );
    if (existing.rows.length > 0) {
      throw Object.assign(new Error(`Supplier dengan kode "${code}" sudah digunakan`), {
        statusCode: 409,
        code: 'DUPLICATE_SUPPLIER_CODE',
      });
    }
  }

  const res = await clientOrPool.query(
    `UPDATE pos_suppliers
        SET code = $1,
            name = $2,
            contact_person = $3,
            phone = $4,
            email = $5,
            address = $6,
            is_active = $7,
            updated_at = NOW()
      WHERE id = $8 AND property_id = $9
      RETURNING *`,
    [
      code,
      name,
      input.contact_person !== undefined ? (input.contact_person ? input.contact_person.trim() : null) : current.contact_person,
      input.phone !== undefined ? (input.phone ? input.phone.trim() : null) : current.phone,
      input.email !== undefined ? (input.email ? input.email.trim() : null) : current.email,
      input.address !== undefined ? (input.address ? input.address.trim() : null) : current.address,
      input.is_active !== undefined ? Boolean(input.is_active) : current.is_active,
      supplierId,
      propertyId,
    ]
  );

  return res.rows[0];
}

export async function deletePosSupplier(
  clientOrPool: Pool | PoolClient,
  propertyId: number,
  supplierId: number
): Promise<{ deleted: boolean; deactivated?: boolean }> {
  // Cek apakah supplier memiliki referensi PO atau Goods Receipt
  const refPo = await clientOrPool.query(
    `SELECT 1 FROM pos_purchase_orders WHERE supplier_id = $1 LIMIT 1`,
    [supplierId]
  );
  const refGrn = await clientOrPool.query(
    `SELECT 1 FROM pos_goods_receipts WHERE supplier_id = $1 LIMIT 1`,
    [supplierId]
  );

  if (refPo.rows.length > 0 || refGrn.rows.length > 0) {
    // Soft-deactivate to preserve audit trail
    await clientOrPool.query(
      `UPDATE pos_suppliers SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND property_id = $2`,
      [supplierId, propertyId]
    );
    return { deleted: false, deactivated: true };
  }

  await clientOrPool.query(
    `DELETE FROM pos_suppliers WHERE id = $1 AND property_id = $2`,
    [supplierId, propertyId]
  );
  return { deleted: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Purchase Order Operations
// ─────────────────────────────────────────────────────────────────────────────

export async function getPosPurchaseOrders(
  clientOrPool: Pool | PoolClient,
  propertyId: number,
  filters?: { status?: string; supplier_id?: number; search?: string }
): Promise<PosPurchaseOrder[]> {
  const params: any[] = [propertyId];
  let query = `
    SELECT po.id, po.property_id, po.po_number, po.supplier_id, s.name AS supplier_name, s.code AS supplier_code,
           po.order_date, po.expected_date, po.status, po.notes, po.total_estimated_amount,
           po.created_by, po.created_at, po.updated_at,
           COUNT(poi.id)::int AS item_count
      FROM pos_purchase_orders po
      JOIN pos_suppliers s ON s.id = po.supplier_id
      LEFT JOIN pos_purchase_order_items poi ON poi.po_id = po.id
     WHERE po.property_id = $1
  `;

  if (filters?.status) {
    params.push(filters.status);
    query += ` AND po.status = $${params.length}`;
  }
  if (filters?.supplier_id) {
    params.push(filters.supplier_id);
    query += ` AND po.supplier_id = $${params.length}`;
  }
  if (filters?.search && filters.search.trim()) {
    params.push(`%${filters.search.trim()}%`);
    query += ` AND (po.po_number ILIKE $${params.length} OR s.name ILIKE $${params.length})`;
  }

  query += ` GROUP BY po.id, s.name, s.code ORDER BY po.id DESC`;

  const res = await clientOrPool.query(query, params);
  return res.rows;
}

export async function getPosPurchaseOrderById(
  clientOrPool: Pool | PoolClient,
  propertyId: number,
  poId: number
): Promise<PosPurchaseOrder | null> {
  const poRes = await clientOrPool.query(
    `SELECT po.id, po.property_id, po.po_number, po.supplier_id, s.name AS supplier_name, s.code AS supplier_code,
            po.order_date, po.expected_date, po.status, po.notes, po.total_estimated_amount,
            po.created_by, po.created_at, po.updated_at
       FROM pos_purchase_orders po
       JOIN pos_suppliers s ON s.id = po.supplier_id
      WHERE po.id = $1 AND po.property_id = $2`,
    [poId, propertyId]
  );
  if (poRes.rows.length === 0) return null;

  const po = poRes.rows[0];

  const itemsRes = await clientOrPool.query(
    `SELECT poi.id, poi.po_id, poi.product_id, pmi.name AS product_name, pmi.item_code,
            pmi.base_unit, pmi.canonical_base_unit_code,
            poi.ordered_qty, poi.received_qty, poi.unit_cost,
            poi.uom_id, u.code AS uom_code, u.name AS uom_name,
            poi.notes, poi.created_at, poi.updated_at
       FROM pos_purchase_order_items poi
       JOIN pos_menu_items pmi ON pmi.id = poi.product_id
       LEFT JOIN pos_product_uoms u ON u.id = poi.uom_id
      WHERE poi.po_id = $1
      ORDER BY poi.id ASC`,
    [poId]
  );

  po.items = itemsRes.rows;
  return po;
}

export async function createPosPurchaseOrder(
  clientOrPool: Pool | PoolClient,
  input: CreatePurchaseOrderInput
): Promise<PosPurchaseOrder> {
  const propertyId = Number(input.property_id);
  const supplierId = Number(input.supplier_id);

  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    throw Object.assign(new Error('property_id wajib berupa bilangan bulat positif'), { statusCode: 400 });
  }
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    throw Object.assign(new Error('supplier_id wajib berupa bilangan bulat positif'), { statusCode: 400 });
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw Object.assign(new Error('Purchase Order wajib memiliki minimal 1 item pesanan'), { statusCode: 400 });
  }

  const isPool = typeof (clientOrPool as any).connect === 'function';
  const client: PoolClient = isPool ? await (clientOrPool as Pool).connect() : (clientOrPool as PoolClient);

  try {
    if (isPool) await client.query('BEGIN');

    // 1. Validasi Supplier
    const supRes = await client.query(
      `SELECT id, name, is_active FROM pos_suppliers WHERE id = $1 AND property_id = $2`,
      [supplierId, propertyId]
    );
    if (supRes.rows.length === 0) {
      throw Object.assign(new Error(`Supplier #${supplierId} tidak ditemukan`), { statusCode: 404 });
    }
    if (!supRes.rows[0].is_active) {
      throw Object.assign(new Error(`Supplier "${supRes.rows[0].name}" sedang tidak aktif`), { statusCode: 400 });
    }

    // 2. Generate nomor PO jika tidak disertakan
    let poNumber = input.po_number ? String(input.po_number).trim().toUpperCase() : '';
    if (!poNumber) {
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM pos_purchase_orders WHERE property_id = $1 AND po_number LIKE $2`,
        [propertyId, `PO-${todayStr}-%`]
      );
      const nextSeq = (countRes.rows[0].cnt + 1).toString().padStart(4, '0');
      poNumber = `PO-${todayStr}-${nextSeq}`;
    }

    // Cek duplikasi nomor PO
    const dupCheck = await client.query(
      `SELECT id FROM pos_purchase_orders WHERE property_id = $1 AND po_number = $2`,
      [propertyId, poNumber]
    );
    if (dupCheck.rows.length > 0) {
      throw Object.assign(new Error(`Nomor PO "${poNumber}" sudah ada`), { statusCode: 409 });
    }

    // 3. Validasi & Hitung Total Estimasi Item
    let totalEstimated = 0;
    const validatedItems: Array<{
      product_id: number;
      ordered_qty: number;
      unit_cost: number;
      uom_id: number | null;
      notes: string | null;
    }> = [];

    const seenProductIds = new Set<number>();
    for (const item of input.items) {
      const prodId = Number(item.product_id);
      const qty = parseFloat(String(item.ordered_qty));
      const cost = parseFloat(String(item.unit_cost || 0));

      if (!Number.isInteger(prodId) || prodId <= 0) {
        throw Object.assign(new Error('product_id item PO tidak valid'), { statusCode: 400 });
      }
      if (seenProductIds.has(prodId)) {
        throw Object.assign(new Error(`Produk #${prodId} tercantum lebih dari sekali dalam satu PO`), { statusCode: 400 });
      }
      seenProductIds.add(prodId);

      if (isNaN(qty) || qty <= 0) {
        throw Object.assign(new Error('Kuantitas pesanan PO (ordered_qty) harus lebih besar dari 0'), { statusCode: 400 });
      }
      if (isNaN(cost) || cost < 0) {
        throw Object.assign(new Error('Estimasi harga satuan (unit_cost) tidak boleh negatif'), { statusCode: 400 });
      }

      // Pastikan produk terdaftar di properti
      const pRes = await client.query(
        `SELECT id, name FROM pos_menu_items WHERE id = $1 AND property_id = $2`,
        [prodId, propertyId]
      );
      if (pRes.rows.length === 0) {
        throw Object.assign(new Error(`Produk #${prodId} tidak ditemukan pada properti`), { statusCode: 404 });
      }

      totalEstimated += qty * cost;
      validatedItems.push({
        product_id: prodId,
        ordered_qty: qty,
        unit_cost: cost,
        uom_id: item.uom_id ? Number(item.uom_id) : null,
        notes: item.notes ? String(item.notes).trim() : null,
      });
    }

    // 4. Insert Header PO
    const orderDate = input.order_date || new Date().toISOString().slice(0, 10);
    const expectedDate = input.expected_date || null;
    const notes = input.notes ? String(input.notes).trim() : null;
    const createdBy = input.created_by ? String(input.created_by).trim() : null;

    const poRes = await client.query(
      `INSERT INTO pos_purchase_orders (
         property_id, po_number, supplier_id, order_date, expected_date,
         status, notes, total_estimated_amount, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, NOW(), NOW())
       RETURNING *`,
      [propertyId, poNumber, supplierId, orderDate, expectedDate, notes, totalEstimated.toFixed(2), createdBy]
    );
    const createdPo = poRes.rows[0];

    // 5. Insert Item Baris PO
    const insertedItems: PosPurchaseOrderItem[] = [];
    for (const item of validatedItems) {
      const itRes = await client.query(
        `INSERT INTO pos_purchase_order_items (
           po_id, product_id, ordered_qty, received_qty, unit_cost, uom_id, notes, created_at, updated_at
         ) VALUES ($1, $2, $3, 0, $4, $5, $6, NOW(), NOW())
         RETURNING *`,
        [createdPo.id, item.product_id, item.ordered_qty, item.unit_cost, item.uom_id, item.notes]
      );
      insertedItems.push(itRes.rows[0]);
    }

    if (isPool) await client.query('COMMIT');

    createdPo.items = insertedItems;
    createdPo.supplier_name = supRes.rows[0].name;
    return createdPo;
  } catch (err) {
    if (isPool) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (isPool) client.release();
  }
}

export async function updatePosPurchaseOrderStatus(
  clientOrPool: Pool | PoolClient,
  propertyId: number,
  poId: number,
  newStatus: 'ORDERED' | 'CANCELLED',
  updatedBy?: string
): Promise<PosPurchaseOrder> {
  const poRes = await clientOrPool.query(
    `SELECT * FROM pos_purchase_orders WHERE id = $1 AND property_id = $2 FOR UPDATE`,
    [poId, propertyId]
  );
  if (poRes.rows.length === 0) {
    throw Object.assign(new Error('Purchase Order tidak ditemukan'), { statusCode: 404 });
  }

  const po = poRes.rows[0];

  if (newStatus === 'ORDERED') {
    if (po.status !== 'DRAFT') {
      throw Object.assign(
        new Error(`PO #${po.po_number} hanya dapat disetujui (ORDERED) jika berstatus DRAFT (saat ini: ${po.status})`),
        { statusCode: 400, code: 'INVALID_STATUS_TRANSITION' }
      );
    }
  } else if (newStatus === 'CANCELLED') {
    if (po.status === 'COMPLETED' || po.status === 'PARTIALLY_RECEIVED') {
      throw Object.assign(
        new Error(`PO #${po.po_number} sudah memiliki penerimaan barang dan tidak dapat dibatalkan`),
        { statusCode: 400, code: 'CANNOT_CANCEL_RECEIVED_PO' }
      );
    }
    if (po.status === 'CANCELLED') {
      return po; // Idempotent
    }
  } else {
    throw Object.assign(new Error(`Status ${newStatus} tidak valid untuk pembaruan manual status PO`), { statusCode: 400 });
  }

  const updated = await clientOrPool.query(
    `UPDATE pos_purchase_orders
        SET status = $1,
            updated_at = NOW()
      WHERE id = $2 AND property_id = $3
      RETURNING *`,
    [newStatus, poId, propertyId]
  );

  return updated.rows[0];
}
