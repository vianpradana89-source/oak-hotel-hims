import type { Pool, PoolClient } from 'pg';

export type PosPurchaseOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'ORDERED'
  | 'PARTIALLY_RECEIVED'
  | 'COMPLETED'
  | 'CANCELLED';

export type PosPurchaseOrderApprovalStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED';

export type PosPurchaseOrderReceivingStatus =
  | 'BELUM_DITERIMA'
  | 'DITERIMA_SEBAGIAN'
  | 'DITERIMA_LENGKAP';

export interface PosSupplierRow {
  id: number;
  property_id: number;
  code: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  payment_terms: string | null;
  notes: string | null;
  is_active: boolean;
  partner_type?: string;
  canonical_supplier_id?: number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PosPurchaseOrderItemRow {
  id: number;
  property_id: number;
  po_id: number;
  product_id: number;
  product_name?: string;
  product_code?: string | null;
  track_stock?: boolean;
  track_inventory?: boolean;
  base_unit: string;
  ordered_unit?: string;
  packaging_id?: number | null;
  packaging_code?: string | null;
  packaging_label?: string | null;
  conversion_factor?: number;
  destination_location_id?: number | null;
  destination_location_name?: string | null;
  ordered_qty: number;
  received_qty: number;
  remaining_qty: number;
  invoiced_qty?: number;
  unit_cost: number;
  line_total: number;
  notes: string | null;
}

export interface PosPurchaseOrderLinkedInvoiceSummary {
  id: number;
  transaction_no: string;
  transaction_date: string;
  source_reference?: string | null;
  external_reference: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  net_amount?: number;
  total_amount: number;
  paid_amount: number;
  outstanding_amount: number;
  payment_status: string;
  approval_status: string | null;
  verification_status: string | null;
  verified_by_user_id: number | null;
  verified_by_name_snapshot: string | null;
  verified_at: string | Date | null;
  verification_notes: string | null;
  receiving_status: string | null;
  transaction_status: string;
  has_po_variance: boolean;
  po_variance_summary: any | null;
  archived_at: string | Date | null;
  created_at: string | Date;
}

export interface PosPurchaseOrderLinkedGrnSummary {
  id: number;
  grn_number: string;
  po_id: number | null;
  transaction_id: number | null;
  transaction_no: string | null;
  location_id: number;
  location_name: string | null;
  location_code: string | null;
  receipt_date: string;
  status: string;
  total_amount: number;
  notes: string | null;
  posted_at: string | Date | null;
  created_at: string | Date;
}

export interface PosPurchaseOrderRow {
  id: number;
  property_id: number;
  po_number: string;
  supplier_id: number;
  canonical_supplier_id?: number;
  legacy_pos_supplier_id?: number | null;
  supplier_name?: string;
  supplier_code?: string;
  order_date: string;
  expected_date: string | null;
  destination_location_id: number | null;
  destination_location_name?: string | null;
  destination_location_code?: string | null;
  status: PosPurchaseOrderStatus;
  approval_status: PosPurchaseOrderApprovalStatus;
  receiving_status: PosPurchaseOrderReceivingStatus;
  subtotal_amount: number;
  tax_amount: number;
  total_amount: number;
  notes: string | null;
  created_by: number | null;
  submitted_by_user_id?: number | null;
  submitted_by_name_snapshot?: string | null;
  submitted_at?: string | Date | null;
  approved_by: number | null;
  approved_by_user_id?: number | null;
  approved_by_name_snapshot?: string | null;
  approved_at: string | Date | null;
  rejection_reason?: string | null;
  source_revision?: number;
  archived_at?: string | Date | null;
  archived_by_user_id?: number | null;
  archived_by_name_snapshot?: string | null;
  archive_reason?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  item_count?: number;
  invoice_count?: number;
  invoiced_total_amount?: number;
  paid_total_amount?: number;
  outstanding_amount?: number;
  payment_settlement_status?: 'BELUM_ADA_TAGIHAN' | 'BELUM_DIBAYAR' | 'DIBAYAR_SEBAGIAN' | 'LUNAS';
  invoice_verification_status?: 'BELUM_ADA_TAGIHAN' | 'UNVERIFIED' | 'VERIFIED' | 'REJECTED';
  has_po_variance?: boolean;
  grn_posted_count?: number;
  grn_draft_count?: number;
  receiving_progress_text?: string;
  items?: PosPurchaseOrderItemRow[];
  linked_invoices?: PosPurchaseOrderLinkedInvoiceSummary[];
  linked_goods_receipts?: PosPurchaseOrderLinkedGrnSummary[];
}

function normalizeDateOnly(input?: string | null): string {
  if (!input) {
    const now = new Date();
    const jakartaMs = now.getTime() + 7 * 60 * 60 * 1000;
    return new Date(jakartaMs).toISOString().slice(0, 10);
  }
  const trimmed = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) {
    throw Object.assign(new Error(`Format tanggal tidak valid: ${input}`), {
      statusCode: 400,
      code: 'INVALID_DATE',
    });
  }
  const jakartaMs = parsed.getTime() + 7 * 60 * 60 * 1000;
  return new Date(jakartaMs).toISOString().slice(0, 10);
}

function mapCanonicalSupplierToPosSupplierRow(row: any): PosSupplierRow {
  const id = Number(row.id);
  return {
    id,
    property_id: Number(row.property_id),
    code: String(row.code || `SUP-${String(id).padStart(4, '0')}`),
    name: String(row.name || ''),
    contact_name: row.contact_person ?? row.contact_name ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    payment_terms: row.payment_terms ?? null,
    notes: row.notes ?? null,
    is_active: Boolean(row.is_active),
    partner_type: row.partner_type ? String(row.partner_type) : 'SUPPLIER',
    canonical_supplier_id: id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ResolvedCanonicalSupplier {
  canonicalSupplier: PosSupplierRow;
  legacyPosSupplierId: number | null;
}

/**
 * Resolves a supplier reference to the single canonical `suppliers` master for the property.
 * - Never equates numeric IDs across tables without explicit mapping.
 * - Rejects quarantined ambiguous legacy suppliers (`QUARANTINED_AMBIGUOUS`) with 409.
 */
export async function resolveCanonicalSupplierForProcurement(
  clientOrPool: Pool | PoolClient | any,
  propertyId: number,
  supplierIdInput: number,
  options?: { legacyPosSupplierId?: number | null; requireActive?: boolean }
): Promise<ResolvedCanonicalSupplier> {
  const requireActive = options?.requireActive !== false;
  const explicitLegacyId =
    options?.legacyPosSupplierId != null && Number(options.legacyPosSupplierId) > 0
      ? Number(options.legacyPosSupplierId)
      : null;

  if (explicitLegacyId != null) {
    const mapRes = await clientOrPool.query(
      `SELECT pos_supplier_id, canonical_supplier_id, mapping_status, notes
         FROM pos_supplier_canonical_mappings
        WHERE property_id = $1 AND pos_supplier_id = $2`,
      [propertyId, explicitLegacyId]
    );
    if ((mapRes.rowCount ?? 0) > 0) {
      const m = mapRes.rows[0];
      if (m.mapping_status === 'QUARANTINED_AMBIGUOUS' || !m.canonical_supplier_id) {
        throw Object.assign(
          new Error(
            `Relasi pemasok lama #${explicitLegacyId} bersifat ambigu dan dikarantina (${m.notes || 'QUARANTINED_AMBIGUOUS'}). Silakan pilih pemasok kanonik dari Master Vendor & Supplier.`
          ),
          { statusCode: 409, code: 'SUPPLIER_MAPPING_AMBIGUOUS' }
        );
      }
      const canonRes = await clientOrPool.query(
        `SELECT * FROM suppliers WHERE id = $1 AND property_id = $2`,
        [Number(m.canonical_supplier_id), propertyId]
      );
      if ((canonRes.rowCount ?? 0) === 0) {
        throw Object.assign(new Error('Pemasok kanonik hasil pemetaan tidak ditemukan'), {
          statusCode: 404,
          code: 'SUPPLIER_NOT_FOUND',
        });
      }
      const sup = mapCanonicalSupplierToPosSupplierRow(canonRes.rows[0]);
      if (requireActive && !sup.is_active) {
        throw Object.assign(new Error(`Pemasok "${sup.name}" sedang nonaktif`), {
          statusCode: 400,
          code: 'SUPPLIER_INACTIVE',
        });
      }
      return { canonicalSupplier: sup, legacyPosSupplierId: explicitLegacyId };
    }
    throw Object.assign(
      new Error(
        `Relasi pemasok lama #${explicitLegacyId} belum memiliki pemetaan kanonik terverifikasi di pos_supplier_canonical_mappings dan tidak boleh digabung otomatis tanpa rekonsiliasi.`
      ),
      { statusCode: 409, code: 'SUPPLIER_MAPPING_REQUIRED' }
    );
  }

  // 1. Check canonical `suppliers` table first
  const canonDirectRes = await clientOrPool.query(
    `SELECT * FROM suppliers WHERE id = $1 AND property_id = $2`,
    [supplierIdInput, propertyId]
  );
  if ((canonDirectRes.rowCount ?? 0) > 0) {
    const sup = mapCanonicalSupplierToPosSupplierRow(canonDirectRes.rows[0]);
    if (requireActive && !sup.is_active) {
      throw Object.assign(new Error(`Pemasok "${sup.name}" sedang nonaktif`), {
        statusCode: 400,
        code: 'SUPPLIER_INACTIVE',
      });
    }
    // Check if there is an explicit mapping pointing to this canonical supplier
    const reverseMapRes = await clientOrPool.query(
      `SELECT pos_supplier_id FROM pos_supplier_canonical_mappings
        WHERE property_id = $1 AND canonical_supplier_id = $2 AND mapping_status = 'MAPPED'
        ORDER BY pos_supplier_id ASC LIMIT 1`,
      [propertyId, sup.id]
    );
    const mappedLegacyId =
      (reverseMapRes.rowCount ?? 0) > 0 ? Number(reverseMapRes.rows[0].pos_supplier_id) : null;
    return { canonicalSupplier: sup, legacyPosSupplierId: mappedLegacyId };
  }

  // 2. If not found in canonical `suppliers`, check explicit `pos_supplier_canonical_mappings`
  const mappingRes = await clientOrPool.query(
    `SELECT pos_supplier_id, canonical_supplier_id, mapping_status, notes
       FROM pos_supplier_canonical_mappings
      WHERE property_id = $1 AND pos_supplier_id = $2`,
    [propertyId, supplierIdInput]
  );

  if ((mappingRes.rowCount ?? 0) > 0) {
    const m = mappingRes.rows[0];
    if (m.mapping_status === 'QUARANTINED_AMBIGUOUS' || !m.canonical_supplier_id) {
      throw Object.assign(
        new Error(
          `Relasi pemasok lama #${supplierIdInput} bersifat ambigu dan dikarantina (${m.notes || 'QUARANTINED_AMBIGUOUS'}). Jangan menyamakan ID lintas tabel; silakan rekonsiliasi atau pilih pemasok kanonik.`
        ),
        { statusCode: 409, code: 'SUPPLIER_MAPPING_AMBIGUOUS' }
      );
    }
    const mappedCanonRes = await clientOrPool.query(
      `SELECT * FROM suppliers WHERE id = $1 AND property_id = $2`,
      [Number(m.canonical_supplier_id), propertyId]
    );
    if ((mappedCanonRes.rowCount ?? 0) > 0) {
      const sup = mapCanonicalSupplierToPosSupplierRow(mappedCanonRes.rows[0]);
      if (requireActive && !sup.is_active) {
        throw Object.assign(new Error(`Pemasok "${sup.name}" sedang nonaktif`), {
          statusCode: 400,
          code: 'SUPPLIER_INACTIVE',
        });
      }
      return { canonicalSupplier: sup, legacyPosSupplierId: Number(m.pos_supplier_id) };
    }
  }

  // 3. Reject/quarantine any unmapped `pos_suppliers` row rather than auto-merging by name at runtime
  const legacyPosRes = await clientOrPool.query(
    `SELECT * FROM pos_suppliers WHERE id = $1 AND property_id = $2`,
    [supplierIdInput, propertyId]
  );
  if ((legacyPosRes.rowCount ?? 0) > 0) {
    const ps = legacyPosRes.rows[0];
    await clientOrPool.query(
      `INSERT INTO pos_supplier_canonical_mappings (
         property_id, pos_supplier_id, canonical_supplier_id, mapping_status, mapping_method, notes
       ) VALUES ($1, $2, NULL, 'QUARANTINED_AMBIGUOUS', 'UNVERIFIED_LEGACY_SUPPLIER_QUARANTINE', $3)
       ON CONFLICT (property_id, pos_supplier_id) DO NOTHING`,
      [propertyId, Number(ps.id), `Unmapped legacy pos_suppliers #${ps.id} ("${ps.name || ''}") requires explicit verified mapping`]
    );
    throw Object.assign(
      new Error(
        `Relasi pemasok lama "${ps.name || ps.id}" (#${ps.id}) belum memiliki pemetaan kanonik terverifikasi di pos_supplier_canonical_mappings dan tidak boleh digabung otomatis berdasarkan nama saja.`
      ),
      { statusCode: 409, code: 'SUPPLIER_MAPPING_REQUIRED' }
    );
  }

  throw Object.assign(new Error('Pemasok (supplier) tidak ditemukan pada properti ini'), {
    statusCode: 404,
    code: 'SUPPLIER_NOT_FOUND',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SUPPLIER SERVICE (Unified Canonical `suppliers` Master)
// ─────────────────────────────────────────────────────────────────────────────

export async function listSuppliers(
  pool: Pool | PoolClient,
  propertyId: number,
  options?: { includeInactive?: boolean; search?: string }
): Promise<PosSupplierRow[]> {
  const params: any[] = [propertyId];
  let where = `WHERE s.property_id = $1 AND COALESCE(s.partner_type, 'BOTH') IN ('SUPPLIER', 'BOTH')`;

  if (!options?.includeInactive) {
    where += ` AND s.is_active = TRUE`;
  }

  if (options?.search && options.search.trim() !== '') {
    params.push(`%${options.search.trim()}%`);
    where += ` AND (s.name ILIKE $${params.length} OR COALESCE(s.code, '') ILIKE $${params.length} OR COALESCE(s.contact_person, '') ILIKE $${params.length})`;
  }

  const res = await pool.query(
    `SELECT s.*
       FROM suppliers s
       ${where}
      ORDER BY s.is_active DESC, s.name ASC, s.id ASC`,
    params
  );

  return res.rows.map(mapCanonicalSupplierToPosSupplierRow);
}

export async function getSupplierById(
  pool: Pool | PoolClient,
  propertyId: number,
  supplierId: number
): Promise<PosSupplierRow> {
  const resolved = await resolveCanonicalSupplierForProcurement(pool, propertyId, supplierId, {
    requireActive: false,
  });
  return resolved.canonicalSupplier;
}

export async function createSupplier(
  pool: Pool | PoolClient,
  params: {
    property_id: number;
    code: string;
    name: string;
    contact_name?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    payment_terms?: string | null;
    notes?: string | null;
    partner_type?: 'VENDOR' | 'SUPPLIER' | 'BOTH';
    is_active?: boolean;
  }
): Promise<PosSupplierRow> {
  const propertyId = Number(params.property_id);
  const code = String(params.code || '').trim().toUpperCase();
  const name = String(params.name || '').trim();

  if (!code) {
    throw Object.assign(new Error('Kode pemasok (code) wajib diisi'), {
      statusCode: 400,
      code: 'SUPPLIER_CODE_REQUIRED',
    });
  }
  if (!name) {
    throw Object.assign(new Error('Nama pemasok (name) wajib diisi'), {
      statusCode: 400,
      code: 'SUPPLIER_NAME_REQUIRED',
    });
  }

  const dupCodeCheck = await pool.query(
    `SELECT id FROM suppliers WHERE property_id = $1 AND UPPER(COALESCE(code, '')) = $2`,
    [propertyId, code]
  );
  if ((dupCodeCheck.rowCount ?? 0) > 0) {
    throw Object.assign(new Error(`Kode pemasok "${code}" sudah terdaftar pada properti ini`), {
      statusCode: 409,
      code: 'DUPLICATE_SUPPLIER_CODE',
    });
  }

  const dupNameCheck = await pool.query(
    `SELECT id FROM suppliers WHERE property_id = $1 AND LOWER(BTRIM(name)) = LOWER(BTRIM($2))`,
    [propertyId, name]
  );
  if ((dupNameCheck.rowCount ?? 0) > 0) {
    throw Object.assign(new Error(`Nama rekanan "${name}" sudah terdaftar pada properti ini`), {
      statusCode: 409,
      code: 'DUPLICATE_SUPPLIER_NAME',
    });
  }

  const partnerType = params.partner_type || 'SUPPLIER';
  const isActive = params.is_active !== undefined ? Boolean(params.is_active) : true;

  const res = await pool.query(
    `INSERT INTO suppliers (
       property_id, code, name, partner_type, contact_person, phone, email, address, payment_terms, notes, is_active, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
     RETURNING *`,
    [
      propertyId,
      code,
      name,
      partnerType,
      params.contact_name ? String(params.contact_name).trim() : null,
      params.phone ? String(params.phone).trim() : null,
      params.email ? String(params.email).trim() : null,
      params.address ? String(params.address).trim() : null,
      params.payment_terms ? String(params.payment_terms).trim() : null,
      params.notes ? String(params.notes).trim() : null,
      isActive,
    ]
  );

  const canonRow = res.rows[0];

  // Maintain compatibility mirror in pos_suppliers + explicit mapping
  try {
    const legacyMirror = await pool.query(
      `INSERT INTO pos_suppliers (
         property_id, code, name, contact_name, phone, email, address, payment_terms, notes, is_active, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       ON CONFLICT (property_id, code) DO UPDATE SET
         name = EXCLUDED.name,
         contact_name = EXCLUDED.contact_name,
         phone = EXCLUDED.phone,
         email = EXCLUDED.email,
         address = EXCLUDED.address,
         payment_terms = EXCLUDED.payment_terms,
         notes = EXCLUDED.notes,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()
       RETURNING id`,
      [
        propertyId,
        code,
        name,
        params.contact_name ? String(params.contact_name).trim() : null,
        params.phone ? String(params.phone).trim() : null,
        params.email ? String(params.email).trim() : null,
        params.address ? String(params.address).trim() : null,
        params.payment_terms ? String(params.payment_terms).trim() : null,
        params.notes ? String(params.notes).trim() : null,
        isActive,
      ]
    );
    if ((legacyMirror.rowCount ?? 0) > 0) {
      await pool.query(
        `INSERT INTO pos_supplier_canonical_mappings (
           property_id, pos_supplier_id, canonical_supplier_id, mapping_status, mapping_method, notes
         ) VALUES ($1, $2, $3, 'MAPPED', 'EXPLICIT_CANONICAL_CREATE', 'Created via canonical supplier service')
         ON CONFLICT (property_id, pos_supplier_id) DO UPDATE SET
           canonical_supplier_id = EXCLUDED.canonical_supplier_id,
           mapping_status = 'MAPPED',
           updated_at = NOW()`,
        [propertyId, Number(legacyMirror.rows[0].id), Number(canonRow.id)]
      );
    }
  } catch {
    // Non-fatal if legacy mirror code collides
  }

  return mapCanonicalSupplierToPosSupplierRow(canonRow);
}

export async function updateSupplier(
  pool: Pool | PoolClient,
  propertyId: number,
  supplierId: number,
  params: {
    code?: string;
    name?: string;
    contact_name?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    payment_terms?: string | null;
    notes?: string | null;
    partner_type?: 'VENDOR' | 'SUPPLIER' | 'BOTH';
    is_active?: boolean;
  }
): Promise<PosSupplierRow> {
  const resolved = await resolveCanonicalSupplierForProcurement(pool, propertyId, supplierId, {
    requireActive: false,
  });
  const current = resolved.canonicalSupplier;
  const targetId = current.id;

  const nextCode = params.code !== undefined ? String(params.code).trim().toUpperCase() : current.code;
  const nextName = params.name !== undefined ? String(params.name).trim() : current.name;

  if (!nextCode) {
    throw Object.assign(new Error('Kode pemasok (code) tidak boleh kosong'), {
      statusCode: 400,
      code: 'SUPPLIER_CODE_REQUIRED',
    });
  }
  if (!nextName) {
    throw Object.assign(new Error('Nama pemasok (name) tidak boleh kosong'), {
      statusCode: 400,
      code: 'SUPPLIER_NAME_REQUIRED',
    });
  }

  if (nextCode !== current.code) {
    const dupCheck = await pool.query(
      `SELECT id FROM suppliers WHERE property_id = $1 AND UPPER(COALESCE(code, '')) = $2 AND id <> $3`,
      [propertyId, nextCode, targetId]
    );
    if ((dupCheck.rowCount ?? 0) > 0) {
      throw Object.assign(new Error(`Kode pemasok "${nextCode}" sudah digunakan pemasok lain`), {
        statusCode: 409,
        code: 'DUPLICATE_SUPPLIER_CODE',
      });
    }
  }

  const contactPerson =
    params.contact_name !== undefined
      ? params.contact_name
        ? String(params.contact_name).trim()
        : null
      : current.contact_name;
  const phone =
    params.phone !== undefined ? (params.phone ? String(params.phone).trim() : null) : current.phone;
  const email =
    params.email !== undefined ? (params.email ? String(params.email).trim() : null) : current.email;
  const address =
    params.address !== undefined
      ? params.address
        ? String(params.address).trim()
        : null
      : current.address;
  const paymentTerms =
    params.payment_terms !== undefined
      ? params.payment_terms
        ? String(params.payment_terms).trim()
        : null
      : current.payment_terms;
  const notes =
    params.notes !== undefined ? (params.notes ? String(params.notes).trim() : null) : current.notes;
  const isActive = params.is_active !== undefined ? Boolean(params.is_active) : current.is_active;
  const partnerType = params.partner_type || current.partner_type || 'SUPPLIER';

  const res = await pool.query(
    `UPDATE suppliers
        SET code = $1,
            name = $2,
            contact_person = $3,
            phone = $4,
            email = $5,
            address = $6,
            payment_terms = $7,
            notes = $8,
            is_active = $9,
            partner_type = $10,
            updated_at = NOW()
      WHERE id = $11 AND property_id = $12
      RETURNING *`,
    [
      nextCode,
      nextName,
      contactPerson,
      phone,
      email,
      address,
      paymentTerms,
      notes,
      isActive,
      partnerType,
      targetId,
      propertyId,
    ]
  );

  if (resolved.legacyPosSupplierId) {
    await pool.query(
      `UPDATE pos_suppliers
          SET code = $1, name = $2, contact_name = $3, phone = $4, email = $5,
              address = $6, payment_terms = $7, notes = $8, is_active = $9, updated_at = NOW()
        WHERE id = $10 AND property_id = $11`,
      [
        nextCode,
        nextName,
        contactPerson,
        phone,
        email,
        address,
        paymentTerms,
        notes,
        isActive,
        resolved.legacyPosSupplierId,
        propertyId,
      ]
    ).catch(() => {});
  }

  return mapCanonicalSupplierToPosSupplierRow(res.rows[0]);
}

export async function deactivateSupplier(
  pool: Pool | PoolClient,
  propertyId: number,
  supplierId: number
): Promise<PosSupplierRow> {
  return updateSupplier(pool, propertyId, supplierId, { is_active: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PURCHASE ORDER (PO) SERVICE
// ─────────────────────────────────────────────────────────────────────────────

async function generatePoNumber(client: PoolClient, propertyId: number, orderDate: string): Promise<string> {
  const dateCompact = orderDate.replace(/-/g, '');
  const prefix = `PO-${dateCompact}-`;
  const res = await client.query(
    `SELECT po_number
       FROM pos_purchase_orders
      WHERE property_id = $1 AND po_number LIKE $2
      ORDER BY po_number DESC
      LIMIT 1`,
    [propertyId, `${prefix}%`]
  );
  let seq = 1;
  if (res.rows.length > 0) {
    const last = String(res.rows[0].po_number);
    const tail = parseInt(last.slice(prefix.length), 10);
    if (!isNaN(tail) && tail >= 1) seq = tail + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

export interface CreatePurchaseOrderItemInput {
  id?: number | null;
  po_item_id?: number | null;
  product_id: number;
  packaging_id?: number | null;
  ordered_unit?: string | null;
  destination_location_id?: number | null;
  ordered_qty: number | string;
  unit_cost: number | string;
  notes?: string | null;
}

function mapPurchaseOrderRow(row: any): PosPurchaseOrderRow {
  const invoiceCount = Number(row.invoice_count ?? 0);
  const invoicedTotal = Number(row.invoiced_total_amount ?? 0);
  const paidTotal = Number(row.paid_total_amount ?? 0);
  const outstandingTotal = Number(row.outstanding_amount ?? 0);

  let paymentSettlementStatus: 'BELUM_ADA_TAGIHAN' | 'BELUM_DIBAYAR' | 'DIBAYAR_SEBAGIAN' | 'LUNAS' =
    'BELUM_ADA_TAGIHAN';
  if (invoiceCount > 0) {
    if (outstandingTotal <= 0 && invoicedTotal > 0) {
      paymentSettlementStatus = 'LUNAS';
    } else if (paidTotal > 0) {
      paymentSettlementStatus = 'DIBAYAR_SEBAGIAN';
    } else {
      paymentSettlementStatus = 'BELUM_DIBAYAR';
    }
  }

  let invoiceVerificationStatus: 'BELUM_ADA_TAGIHAN' | 'UNVERIFIED' | 'VERIFIED' | 'REJECTED' =
    'BELUM_ADA_TAGIHAN';
  if (invoiceCount > 0) {
    invoiceVerificationStatus = (row.invoice_verification_status as any) || 'UNVERIFIED';
  }

  const approvalStatus: PosPurchaseOrderApprovalStatus =
    row.approval_status ||
    (row.status === 'DRAFT'
      ? 'DRAFT'
      : row.status === 'PENDING_APPROVAL'
      ? 'PENDING_APPROVAL'
      : row.status === 'REJECTED'
      ? 'REJECTED'
      : 'APPROVED');

  const receivingStatus: PosPurchaseOrderReceivingStatus =
    row.receiving_status ||
    (row.status === 'COMPLETED'
      ? 'DITERIMA_LENGKAP'
      : row.status === 'PARTIALLY_RECEIVED'
      ? 'DITERIMA_SEBAGIAN'
      : 'BELUM_DITERIMA');

  return {
    id: Number(row.id),
    property_id: Number(row.property_id),
    po_number: String(row.po_number),
    supplier_id: Number(row.supplier_id),
    canonical_supplier_id: Number(row.canonical_supplier_id || row.supplier_id),
    legacy_pos_supplier_id:
      row.legacy_pos_supplier_id != null ? Number(row.legacy_pos_supplier_id) : null,
    supplier_name: row.supplier_name ?? undefined,
    supplier_code: row.supplier_code ?? undefined,
    order_date: normalizeDateOnly(row.order_date),
    expected_date: row.expected_date ? normalizeDateOnly(row.expected_date) : null,
    destination_location_id: row.destination_location_id ? Number(row.destination_location_id) : null,
    destination_location_name: row.destination_location_name ?? null,
    destination_location_code: row.destination_location_code ?? null,
    status: row.status as PosPurchaseOrderStatus,
    approval_status: approvalStatus,
    receiving_status: receivingStatus,
    subtotal_amount: Number(row.subtotal_amount || 0),
    tax_amount: Number(row.tax_amount || 0),
    total_amount: Number(row.total_amount || 0),
    notes: row.notes ?? null,
    created_by: row.created_by ? Number(row.created_by) : null,
    submitted_by_user_id: row.submitted_by_user_id ? Number(row.submitted_by_user_id) : null,
    submitted_by_name_snapshot: row.submitted_by_name_snapshot ?? null,
    submitted_at: row.submitted_at ?? null,
    approved_by: row.approved_by ? Number(row.approved_by) : null,
    approved_by_user_id:
      row.approved_by_user_id != null
        ? Number(row.approved_by_user_id)
        : row.approved_by != null
        ? Number(row.approved_by)
        : null,
    approved_by_name_snapshot: row.approved_by_name_snapshot ?? null,
    approved_at: row.approved_at ?? null,
    rejection_reason: row.rejection_reason ?? null,
    source_revision: Number(row.source_revision ?? 1),
    archived_at: row.archived_at ?? null,
    archived_by_user_id: row.archived_by_user_id ? Number(row.archived_by_user_id) : null,
    archived_by_name_snapshot: row.archived_by_name_snapshot ?? null,
    archive_reason: row.archive_reason ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    item_count: row.item_count !== undefined ? Number(row.item_count) : undefined,
    invoice_count: invoiceCount,
    invoiced_total_amount: invoicedTotal,
    paid_total_amount: paidTotal,
    outstanding_amount: outstandingTotal,
    payment_settlement_status: paymentSettlementStatus,
    invoice_verification_status: invoiceVerificationStatus,
    has_po_variance: Boolean(row.has_po_variance),
    grn_posted_count: Number(row.grn_posted_count ?? 0),
    grn_draft_count: Number(row.grn_draft_count ?? 0),
    receiving_progress_text: row.receiving_progress_text ?? undefined,
  };
}

export async function listPurchaseOrders(
  pool: Pool | PoolClient,
  propertyId: number,
  filters?: {
    status?: string;
    approval_status?: string;
    receiving_status?: string;
    supplier_id?: number;
    search?: string;
    include_archived?: boolean;
  }
): Promise<PosPurchaseOrderRow[]> {
  const params: any[] = [propertyId];
  let where = `WHERE po.property_id = $1`;

  if (!filters?.include_archived) {
    where += ` AND po.archived_at IS NULL`;
  }

  if (filters?.status && filters.status.trim() !== '' && filters.status !== 'ALL') {
    params.push(filters.status.trim().toUpperCase());
    where += ` AND po.status = $${params.length}`;
  }

  if (filters?.approval_status && filters.approval_status.trim() !== '' && filters.approval_status !== 'ALL') {
    params.push(filters.approval_status.trim().toUpperCase());
    where += ` AND po.approval_status = $${params.length}`;
  }

  if (filters?.receiving_status && filters.receiving_status.trim() !== '' && filters.receiving_status !== 'ALL') {
    params.push(filters.receiving_status.trim().toUpperCase());
    where += ` AND po.receiving_status = $${params.length}`;
  }

  if (filters?.supplier_id && Number.isInteger(Number(filters.supplier_id)) && Number(filters.supplier_id) > 0) {
    params.push(Number(filters.supplier_id));
    where += ` AND po.supplier_id = $${params.length}`;
  }

  if (filters?.search && filters.search.trim() !== '') {
    params.push(`%${filters.search.trim()}%`);
    where += ` AND (po.po_number ILIKE $${params.length} OR COALESCE(s.name, ps.name, '') ILIKE $${params.length} OR COALESCE(po.notes, '') ILIKE $${params.length})`;
  }

  const res = await pool.query(
    `SELECT po.*,
            COALESCE(s.name, ps.name) AS supplier_name,
            COALESCE(s.code, ps.code, 'SUP-' || LPAD(po.supplier_id::text, 4, '0')) AS supplier_code,
            sl.name AS destination_location_name,
            sl.code AS destination_location_code,
            (SELECT COUNT(*)::int FROM pos_purchase_order_items poi WHERE poi.po_id = po.id) AS item_count,
            COALESCE(inv.invoice_count, 0) AS invoice_count,
            COALESCE(inv.invoiced_total_amount, 0) AS invoiced_total_amount,
            COALESCE(inv.paid_total_amount, 0) AS paid_total_amount,
            COALESCE(inv.outstanding_amount, 0) AS outstanding_amount,
            inv.invoice_verification_status,
            COALESCE(inv.has_po_variance, FALSE) AS has_po_variance,
            COALESCE(grn_agg.grn_posted_count, 0) AS grn_posted_count,
            COALESCE(grn_agg.grn_draft_count, 0) AS grn_draft_count,
            item_agg.receiving_progress_text
       FROM pos_purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.property_id = po.property_id
       LEFT JOIN pos_suppliers ps ON ps.id = COALESCE(po.legacy_pos_supplier_id, po.supplier_id) AND ps.property_id = po.property_id
       LEFT JOIN stock_locations sl ON sl.id = po.destination_location_id AND sl.property_id = po.property_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS invoice_count,
                COALESCE(SUM(t.net_amount), 0) AS invoiced_total_amount,
                COALESCE(SUM(pt_agg.paid_amount), 0) AS paid_total_amount,
                COALESCE(SUM(GREATEST(0, t.net_amount - COALESCE(pt_agg.paid_amount, 0))), 0) AS outstanding_amount,
                CASE
                  WHEN COUNT(*) = 0 THEN 'BELUM_ADA_TAGIHAN'
                  WHEN BOOL_OR(t.verification_status = 'REJECTED') THEN 'REJECTED'
                  WHEN BOOL_AND(t.verification_status = 'VERIFIED') THEN 'VERIFIED'
                  ELSE 'UNVERIFIED'
                END AS invoice_verification_status,
                BOOL_OR(COALESCE(t.has_po_variance, FALSE)) AS has_po_variance
           FROM transactions t
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(pt.amount), 0)::numeric(14,2) AS paid_amount
               FROM payment_transactions pt
              WHERE pt.transaction_id = t.id
                AND pt.status = 'SUCCESS'
                AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
           ) pt_agg ON TRUE
          WHERE t.property_id = po.property_id
            AND t.po_id = po.id
            AND t.transaction_type = 'PURCHASE'
            AND t.deleted_at IS NULL
            AND t.transaction_status NOT IN ('VOIDED', 'REVERSED', 'CANCELLED')
            AND COALESCE(t.purchase_workflow_status, 'PROSES') <> 'BATAL'
       ) inv ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE gr.status IN ('POSTED', 'COMPLETED'))::int AS grn_posted_count,
                COUNT(*) FILTER (WHERE gr.status = 'DRAFT')::int AS grn_draft_count
           FROM pos_goods_receipts gr
          WHERE gr.property_id = po.property_id
            AND (
              gr.po_id = po.id
              OR gr.transaction_id IN (
                SELECT t2.id FROM transactions t2
                 WHERE t2.property_id = po.property_id AND t2.po_id = po.id
              )
            )
       ) grn_agg ON TRUE
       LEFT JOIN LATERAL (
         SELECT STRING_AGG(
                  TRIM(TO_CHAR(poi.received_qty, 'FM999999990.##')) || '/' ||
                  TRIM(TO_CHAR(poi.ordered_qty, 'FM999999990.##')) || ' ' ||
                  COALESCE(NULLIF(poi.ordered_unit, ''), poi.base_unit),
                  ', ' ORDER BY poi.id ASC
                ) AS receiving_progress_text
           FROM pos_purchase_order_items poi
          WHERE poi.po_id = po.id AND poi.property_id = po.property_id
       ) item_agg ON TRUE
       ${where}
      ORDER BY po.order_date DESC, po.id DESC`,
    params
  );

  return res.rows.map(mapPurchaseOrderRow);
}

export async function getPurchaseOrderById(
  pool: Pool | PoolClient,
  propertyId: number,
  poId: number
): Promise<PosPurchaseOrderRow> {
  const poRes = await pool.query(
    `SELECT po.*,
            COALESCE(s.name, ps.name) AS supplier_name,
            COALESCE(s.code, ps.code, 'SUP-' || LPAD(po.supplier_id::text, 4, '0')) AS supplier_code,
            sl.name AS destination_location_name,
            sl.code AS destination_location_code,
            COALESCE(inv.invoice_count, 0) AS invoice_count,
            COALESCE(inv.invoiced_total_amount, 0) AS invoiced_total_amount,
            COALESCE(inv.paid_total_amount, 0) AS paid_total_amount,
            COALESCE(inv.outstanding_amount, 0) AS outstanding_amount,
            inv.invoice_verification_status,
            COALESCE(inv.has_po_variance, FALSE) AS has_po_variance,
            COALESCE(grn_agg.grn_posted_count, 0) AS grn_posted_count,
            COALESCE(grn_agg.grn_draft_count, 0) AS grn_draft_count,
            item_agg.receiving_progress_text
       FROM pos_purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.property_id = po.property_id
       LEFT JOIN pos_suppliers ps ON ps.id = COALESCE(po.legacy_pos_supplier_id, po.supplier_id) AND ps.property_id = po.property_id
       LEFT JOIN stock_locations sl ON sl.id = po.destination_location_id AND sl.property_id = po.property_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS invoice_count,
                COALESCE(SUM(t.net_amount), 0) AS invoiced_total_amount,
                COALESCE(SUM(pt_agg.paid_amount), 0) AS paid_total_amount,
                COALESCE(SUM(GREATEST(0, t.net_amount - COALESCE(pt_agg.paid_amount, 0))), 0) AS outstanding_amount,
                CASE
                  WHEN COUNT(*) = 0 THEN 'BELUM_ADA_TAGIHAN'
                  WHEN BOOL_OR(t.verification_status = 'REJECTED') THEN 'REJECTED'
                  WHEN BOOL_AND(t.verification_status = 'VERIFIED') THEN 'VERIFIED'
                  ELSE 'UNVERIFIED'
                END AS invoice_verification_status,
                BOOL_OR(COALESCE(t.has_po_variance, FALSE)) AS has_po_variance
           FROM transactions t
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(pt.amount), 0)::numeric(14,2) AS paid_amount
               FROM payment_transactions pt
              WHERE pt.transaction_id = t.id
                AND pt.status = 'SUCCESS'
                AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
           ) pt_agg ON TRUE
          WHERE t.property_id = po.property_id
            AND t.po_id = po.id
            AND t.transaction_type = 'PURCHASE'
            AND t.deleted_at IS NULL
            AND t.transaction_status NOT IN ('VOIDED', 'REVERSED', 'CANCELLED')
            AND COALESCE(t.purchase_workflow_status, 'PROSES') <> 'BATAL'
       ) inv ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE gr.status IN ('POSTED', 'COMPLETED'))::int AS grn_posted_count,
                COUNT(*) FILTER (WHERE gr.status = 'DRAFT')::int AS grn_draft_count
           FROM pos_goods_receipts gr
          WHERE gr.property_id = po.property_id
            AND (
              gr.po_id = po.id
              OR gr.transaction_id IN (
                SELECT t2.id FROM transactions t2
                 WHERE t2.property_id = po.property_id AND t2.po_id = po.id
              )
            )
       ) grn_agg ON TRUE
       LEFT JOIN LATERAL (
         SELECT STRING_AGG(
                  TRIM(TO_CHAR(poi.received_qty, 'FM999999990.##')) || '/' ||
                  TRIM(TO_CHAR(poi.ordered_qty, 'FM999999990.##')) || ' ' ||
                  COALESCE(NULLIF(poi.ordered_unit, ''), poi.base_unit),
                  ', ' ORDER BY poi.id ASC
                ) AS receiving_progress_text
           FROM pos_purchase_order_items poi
          WHERE poi.po_id = po.id AND poi.property_id = po.property_id
       ) item_agg ON TRUE
      WHERE po.id = $1 AND po.property_id = $2`,
    [poId, propertyId]
  );

  if ((poRes.rowCount ?? 0) === 0) {
    throw Object.assign(new Error('Purchase Order (PO) tidak ditemukan'), {
      statusCode: 404,
      code: 'PO_NOT_FOUND',
    });
  }

  const itemsRes = await pool.query(
    `SELECT poi.*,
            pmi.name AS product_name,
            pmi.item_code AS product_code,
            COALESCE(pmi.track_stock, FALSE) AS product_track_stock,
            COALESCE(pmi.track_inventory, FALSE) AS product_track_inventory,
            ppc.packaging_code,
            COALESCE(poi.packaging_label_snapshot, ppc.packaging_label) AS packaging_label,
            COALESCE(NULLIF(poi.conversion_factor_snapshot, 0), ppc.to_base_factor, 1) AS conversion_factor,
            sl.name AS destination_location_name,
            COALESCE(inv_line.invoiced_qty, 0) AS invoiced_qty
       FROM pos_purchase_order_items poi
       JOIN pos_menu_items pmi ON pmi.id = poi.product_id AND pmi.property_id = poi.property_id
       LEFT JOIN product_packaging_conversions ppc ON ppc.id = poi.packaging_id AND ppc.property_id = poi.property_id
       LEFT JOIN stock_locations sl ON sl.id = poi.destination_location_id AND sl.property_id = poi.property_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(tl.quantity), 0) AS invoiced_qty
           FROM transaction_lines tl
           JOIN transactions t ON t.id = tl.transaction_id AND t.property_id = tl.property_id
          WHERE tl.property_id = poi.property_id
            AND tl.po_item_id = poi.id
            AND t.transaction_type = 'PURCHASE'
            AND t.transaction_status NOT IN ('VOIDED', 'REVERSED', 'CANCELLED')
            AND COALESCE(t.purchase_workflow_status, 'PROSES') <> 'BATAL'
       ) inv_line ON TRUE
      WHERE poi.po_id = $1 AND poi.property_id = $2
      ORDER BY poi.id ASC`,
    [poId, propertyId]
  );

  const invoicesRes = await pool.query(
    `SELECT t.id, t.transaction_no, t.transaction_date::text AS transaction_date,
            t.source_reference AS external_reference, t.supplier_id,
            COALESCE(s.name, t.party_name) AS supplier_name,
            t.net_amount AS total_amount,
            COALESCE(pt_agg.paid_amount, 0) AS paid_amount,
            GREATEST(0, t.net_amount - COALESCE(pt_agg.paid_amount, 0)) AS outstanding_amount,
            t.payment_status, t.approval_status,
            t.verification_status, t.verified_by_user_id, t.verified_by_name_snapshot,
            t.verified_at, t.verification_note AS verification_notes,
            t.receiving_status, t.transaction_status,
            COALESCE(t.has_po_variance, FALSE) AS has_po_variance,
            t.po_variance_summary,
            t.archived_at, t.created_at
       FROM transactions t
       LEFT JOIN suppliers s ON s.id = t.supplier_id AND s.property_id = t.property_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(pt.amount), 0)::numeric(14,2) AS paid_amount
           FROM payment_transactions pt
          WHERE pt.transaction_id = t.id
            AND pt.status = 'SUCCESS'
            AND pt.transaction_type IN ('PAYMENT', 'CORRECTION_REPLACEMENT')
       ) pt_agg ON TRUE
      WHERE t.property_id = $1
        AND t.po_id = $2
        AND t.transaction_type = 'PURCHASE'
        AND t.deleted_at IS NULL
      ORDER BY t.id DESC`,
    [propertyId, poId]
  );

  const grnsRes = await pool.query(
    `SELECT gr.id, gr.grn_number, gr.po_id, gr.transaction_id,
            t.transaction_no,
            gr.location_id, sl.name AS location_name, sl.code AS location_code,
            gr.receipt_date::text AS receipt_date, gr.status, gr.total_amount,
            gr.notes, gr.posted_at, gr.created_at
       FROM pos_goods_receipts gr
       LEFT JOIN stock_locations sl ON sl.id = gr.location_id AND sl.property_id = gr.property_id
       LEFT JOIN transactions t ON t.id = gr.transaction_id AND t.property_id = gr.property_id
      WHERE gr.property_id = $1
        AND (
          gr.po_id = $2
          OR gr.transaction_id IN (
            SELECT t2.id FROM transactions t2 WHERE t2.property_id = $1 AND t2.po_id = $2
          )
        )
      ORDER BY gr.id DESC`,
    [propertyId, poId]
  );

  const mappedPo = mapPurchaseOrderRow(poRes.rows[0]);
  mappedPo.items = itemsRes.rows.map((item: any) => {
    const ordered = Number(item.ordered_qty || 0);
    const received = Number(item.received_qty || 0);
    const baseUnit = String(item.base_unit || 'PCS');
    const orderedUnit = String(item.ordered_unit || item.packaging_code || baseUnit);
    return {
      id: Number(item.id),
      property_id: Number(item.property_id),
      po_id: Number(item.po_id),
      product_id: Number(item.product_id),
      product_name: item.product_name,
      product_code: item.product_code ?? null,
      track_stock: Boolean(item.product_track_stock),
      track_inventory: Boolean(item.product_track_inventory),
      base_unit: baseUnit,
      ordered_unit: orderedUnit,
      packaging_id: item.packaging_id != null ? Number(item.packaging_id) : null,
      packaging_code: item.packaging_code ?? null,
      packaging_label: item.packaging_label ?? null,
      conversion_factor: Number(item.conversion_factor || 1),
      destination_location_id:
        item.destination_location_id != null ? Number(item.destination_location_id) : null,
      destination_location_name: item.destination_location_name ?? null,
      ordered_qty: ordered,
      received_qty: received,
      remaining_qty: Math.max(0, Number((ordered - received).toFixed(4))),
      invoiced_qty: Number(item.invoiced_qty || 0),
      unit_cost: Number(item.unit_cost || 0),
      line_total: Number(item.line_total || 0),
      notes: item.notes ?? null,
    };
  });

  mappedPo.linked_invoices = invoicesRes.rows.map((inv: any) => ({
    id: Number(inv.id),
    transaction_no: String(inv.transaction_no),
    transaction_date: normalizeDateOnly(inv.transaction_date),
    source_reference: inv.external_reference ?? null,
    external_reference: inv.external_reference ?? null,
    supplier_id: inv.supplier_id != null ? Number(inv.supplier_id) : null,
    supplier_name: inv.supplier_name ?? null,
    net_amount: Number(inv.total_amount || 0),
    total_amount: Number(inv.total_amount || 0),
    paid_amount: Number(inv.paid_amount || 0),
    outstanding_amount: Number(inv.outstanding_amount || 0),
    payment_status: String(inv.payment_status || 'UNPAID'),
    approval_status: inv.approval_status ?? null,
    verification_status: inv.verification_status ?? 'UNVERIFIED',
    verified_by_user_id: inv.verified_by_user_id != null ? Number(inv.verified_by_user_id) : null,
    verified_by_name_snapshot: inv.verified_by_name_snapshot ?? null,
    verified_at: inv.verified_at ?? null,
    verification_notes: inv.verification_notes ?? null,
    receiving_status: inv.receiving_status ?? null,
    transaction_status: String(inv.transaction_status || 'POSTED'),
    has_po_variance: Boolean(inv.has_po_variance),
    po_variance_summary: inv.po_variance_summary ?? null,
    archived_at: inv.archived_at ?? null,
    created_at: inv.created_at,
  }));

  mappedPo.linked_goods_receipts = grnsRes.rows.map((gr: any) => ({
    id: Number(gr.id),
    grn_number: String(gr.grn_number),
    po_id: gr.po_id != null ? Number(gr.po_id) : null,
    transaction_id: gr.transaction_id != null ? Number(gr.transaction_id) : null,
    transaction_no: gr.transaction_no ?? null,
    location_id: Number(gr.location_id),
    location_name: gr.location_name ?? null,
    location_code: gr.location_code ?? null,
    receipt_date: normalizeDateOnly(gr.receipt_date),
    status: String(gr.status),
    total_amount: Number(gr.total_amount || 0),
    notes: gr.notes ?? null,
    posted_at: gr.posted_at ?? null,
    created_at: gr.created_at,
  }));

  return mappedPo;
}

interface ValidatedPoItem {
  existing_item_id: number | null;
  product_id: number;
  base_unit: string;
  ordered_unit: string;
  packaging_id: number | null;
  packaging_label_snapshot: string | null;
  conversion_factor_snapshot: number;
  destination_location_id: number | null;
  ordered_qty: number;
  unit_cost: number;
  line_total: number;
  notes: string | null;
}

async function validateAndPreparePoItems(
  client: PoolClient,
  propertyId: number,
  items: CreatePurchaseOrderItemInput[],
  defaultLocationId: number | null,
  existingItemsById?: Map<number, any>
): Promise<{ validatedItems: ValidatedPoItem[]; subtotal: number }> {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('Minimal 1 baris bahan/item wajib diisi pada Purchase Order'), {
      statusCode: 400,
      code: 'PO_ITEMS_REQUIRED',
    });
  }

  const validatedItems: ValidatedPoItem[] = [];
  let subtotal = 0;
  const seenExplicitIds = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    const productId = Number(raw.product_id);
    const orderedQty = Number(raw.ordered_qty);
    const unitCost = Number(raw.unit_cost);
    const existingItemId =
      raw.id != null && Number(raw.id) > 0
        ? Number(raw.id)
        : raw.po_item_id != null && Number(raw.po_item_id) > 0
        ? Number(raw.po_item_id)
        : null;

    if (existingItemId != null) {
      if (seenExplicitIds.has(existingItemId)) {
        throw Object.assign(
          new Error(`Baris #${i + 1}: duplikat id baris PO (#${existingItemId}) dalam satu permintaan revisi`),
          {
            statusCode: 400,
            code: 'DUPLICATE_PO_ITEM_ID',
          }
        );
      }
      seenExplicitIds.add(existingItemId);
      if (existingItemsById && !existingItemsById.has(existingItemId)) {
        throw Object.assign(
          new Error(`Baris #${i + 1}: id baris PO #${existingItemId} tidak ditemukan pada PO ini`),
          {
            statusCode: 400,
            code: 'INVALID_PO_ITEM_ID',
          }
        );
      }
    }

    if (!Number.isInteger(productId) || productId <= 0) {
      throw Object.assign(new Error(`Baris #${i + 1}: product_id tidak valid`), {
        statusCode: 400,
        code: 'INVALID_PRODUCT_ID',
      });
    }
    if (!Number.isFinite(orderedQty) || orderedQty <= 0) {
      throw Object.assign(new Error(`Baris #${i + 1}: kuantitas pesan (ordered_qty) harus > 0`), {
        statusCode: 400,
        code: 'INVALID_ORDERED_QTY',
      });
    }
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw Object.assign(new Error(`Baris #${i + 1}: harga beli (unit_cost) tidak boleh negatif`), {
        statusCode: 400,
        code: 'INVALID_UNIT_COST',
      });
    }

    const prodRes = await client.query(
      `SELECT id, name, base_unit, canonical_base_unit_code, track_stock, track_inventory, is_active
         FROM pos_menu_items
        WHERE id = $1 AND property_id = $2`,
      [productId, propertyId]
    );
    if ((prodRes.rowCount ?? 0) === 0) {
      throw Object.assign(new Error(`Baris #${i + 1}: produk #${productId} tidak ditemukan pada properti ini`), {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }
    const prod = prodRes.rows[0];
    if (!prod.is_active) {
      throw Object.assign(new Error(`Baris #${i + 1}: produk "${prod.name}" sedang nonaktif`), {
        statusCode: 400,
        code: 'PRODUCT_INACTIVE',
      });
    }
    if (!prod.track_stock || !prod.track_inventory) {
      throw Object.assign(
        new Error(
          `Baris #${i + 1}: produk "${prod.name}" (ID: ${productId}) berstatus non-stok (track_stock=${Boolean(prod.track_stock)}, track_inventory=${Boolean(prod.track_inventory)}) sehingga belum dapat dipesan sebagai item stok pengadaan/GRN. Aktifkan "Lacak Stok Fisik" pada Master Produk terlebih dahulu.`
        ),
        {
          statusCode: 400,
          code: 'PRODUCT_NOT_STOCK_TRACKED',
        }
      );
    }

    const baseUnit = String(prod.canonical_base_unit_code || prod.base_unit || 'PCS').toUpperCase();
    let packagingId: number | null =
      raw.packaging_id != null && Number(raw.packaging_id) > 0 ? Number(raw.packaging_id) : null;
    let orderedUnit = baseUnit;
    let packagingLabelSnapshot: string | null = null;
    let conversionFactorSnapshot = 1;

    if (packagingId != null) {
      const pkgRes = await client.query(
        `SELECT id, packaging_code, packaging_label, to_base_factor, is_active
           FROM product_packaging_conversions
          WHERE id = $1 AND property_id = $2 AND menu_item_id = $3`,
        [packagingId, propertyId, productId]
      );
      if ((pkgRes.rowCount ?? 0) === 0) {
        throw Object.assign(
          new Error(`Baris #${i + 1}: kemasan #${packagingId} tidak ditemukan untuk produk "${prod.name}"`),
          { statusCode: 400, code: 'PACKAGING_NOT_FOUND' }
        );
      }
      const pkg = pkgRes.rows[0];
      if (!pkg.is_active) {
        throw Object.assign(
          new Error(`Baris #${i + 1}: kemasan "${pkg.packaging_code}" sedang nonaktif`),
          { statusCode: 400, code: 'PACKAGING_INACTIVE' }
        );
      }
      orderedUnit = String(pkg.packaging_code || baseUnit).toUpperCase();
      packagingLabelSnapshot = pkg.packaging_label ? String(pkg.packaging_label) : orderedUnit;
      conversionFactorSnapshot = Number(pkg.to_base_factor || 1);
    } else if (raw.ordered_unit && String(raw.ordered_unit).trim().toUpperCase() !== baseUnit) {
      const requestedUnit = String(raw.ordered_unit).trim().toUpperCase();
      const pkgByCodeRes = await client.query(
        `SELECT id, packaging_code, packaging_label, to_base_factor, is_active
           FROM product_packaging_conversions
          WHERE property_id = $1 AND menu_item_id = $2 AND UPPER(packaging_code) = $3 AND is_active = TRUE
          ORDER BY id ASC LIMIT 1`,
        [propertyId, productId, requestedUnit]
      );
      if ((pkgByCodeRes.rowCount ?? 0) > 0) {
        const pkg = pkgByCodeRes.rows[0];
        packagingId = Number(pkg.id);
        orderedUnit = String(pkg.packaging_code).toUpperCase();
        packagingLabelSnapshot = pkg.packaging_label ? String(pkg.packaging_label) : orderedUnit;
        conversionFactorSnapshot = Number(pkg.to_base_factor || 1);
      }
    }

    // A06: Preserve historical conversion_factor_snapshot and packaging_label_snapshot when editing an existing PO line
    // with the same product_id and packaging_id so master packaging edits never mutate historical PO snapshots
    if (existingItemsById) {
      let existingRowForSnapshot = existingItemId != null ? existingItemsById.get(existingItemId) : null;
      if (!existingRowForSnapshot && existingItemId == null) {
        const matchingRows = Array.from(existingItemsById.values()).filter(
          (r: any) =>
            !seenExplicitIds.has(Number(r.id)) &&
            Number(r.product_id) === productId &&
            Number(r.packaging_id || 0) === Number(packagingId || 0)
        );
        if (matchingRows.length === 1) {
          existingRowForSnapshot = matchingRows[0];
        }
      }
      if (
        existingRowForSnapshot &&
        Number(existingRowForSnapshot.product_id) === productId &&
        Number(existingRowForSnapshot.packaging_id || 0) === Number(packagingId || 0) &&
        Number(existingRowForSnapshot.conversion_factor_snapshot || 0) > 0
      ) {
        conversionFactorSnapshot = Number(existingRowForSnapshot.conversion_factor_snapshot);
        if (existingRowForSnapshot.packaging_label_snapshot) {
          packagingLabelSnapshot = String(existingRowForSnapshot.packaging_label_snapshot);
        }
        if (existingRowForSnapshot.ordered_unit) {
          orderedUnit = String(existingRowForSnapshot.ordered_unit).toUpperCase();
        }
      }
    }

    const itemDestLocId =
      raw.destination_location_id != null && Number(raw.destination_location_id) > 0
        ? Number(raw.destination_location_id)
        : defaultLocationId;

    if (itemDestLocId != null) {
      const itemLocRes = await client.query(
        `SELECT id, is_active FROM stock_locations WHERE id = $1 AND property_id = $2`,
        [itemDestLocId, propertyId]
      );
      if ((itemLocRes.rowCount ?? 0) === 0) {
        throw Object.assign(new Error(`Baris #${i + 1}: lokasi tujuan (#${itemDestLocId}) tidak ditemukan pada properti ini`), {
          statusCode: 404,
          code: 'LOCATION_NOT_FOUND',
        });
      }
      if (!itemLocRes.rows[0].is_active) {
        throw Object.assign(new Error(`Baris #${i + 1}: lokasi tujuan (#${itemDestLocId}) sedang nonaktif`), {
          statusCode: 400,
          code: 'LOCATION_INACTIVE',
        });
      }
    }

    const lineTotal = Number((orderedQty * unitCost).toFixed(2));
    subtotal = Number((subtotal + lineTotal).toFixed(2));

    validatedItems.push({
      existing_item_id: existingItemId,
      product_id: productId,
      base_unit: baseUnit,
      ordered_unit: orderedUnit,
      packaging_id: packagingId,
      packaging_label_snapshot: packagingLabelSnapshot,
      conversion_factor_snapshot: conversionFactorSnapshot,
      destination_location_id: itemDestLocId,
      ordered_qty: Number(orderedQty.toFixed(4)),
      unit_cost: Number(unitCost.toFixed(2)),
      line_total: lineTotal,
      notes: raw.notes ? String(raw.notes).trim() : null,
    });
  }

  return { validatedItems, subtotal };
}

export async function createPurchaseOrder(
  pool: Pool,
  params: {
    property_id: number;
    supplier_id: number;
    legacy_pos_supplier_id?: number | null;
    order_date?: string | null;
    expected_date?: string | null;
    destination_location_id?: number | null;
    tax_amount?: number | string | null;
    notes?: string | null;
    initial_status?: 'DRAFT' | 'PENDING_APPROVAL' | 'ORDERED';
    submit_for_approval?: boolean;
    items: CreatePurchaseOrderItemInput[];
    created_by?: number | null;
    actor_name_snapshot?: string | null;
  }
): Promise<PosPurchaseOrderRow> {
  const propertyId = Number(params.property_id);
  const supplierIdInput = Number(params.supplier_id);
  const orderDate = normalizeDateOnly(params.order_date);
  const expectedDate = params.expected_date ? normalizeDateOnly(params.expected_date) : null;
  const destinationLocationId = params.destination_location_id ? Number(params.destination_location_id) : null;
  const taxAmount = Math.max(0, Number(params.tax_amount || 0));

  const submitForApproval =
    Boolean(params.submit_for_approval) || params.initial_status === 'PENDING_APPROVAL';
  const initialStatus: PosPurchaseOrderStatus = submitForApproval ? 'PENDING_APPROVAL' : 'DRAFT';
  const initialApprovalStatus: PosPurchaseOrderApprovalStatus = submitForApproval
    ? 'PENDING_APPROVAL'
    : 'DRAFT';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock property for safe PO numbering
    await client.query(`SELECT id FROM properties WHERE id = $1 FOR UPDATE`, [propertyId]);

    // Validate canonical supplier (and check legacy mapping/quarantine)
    const resolvedSup = await resolveCanonicalSupplierForProcurement(
      client,
      propertyId,
      supplierIdInput,
      { legacyPosSupplierId: params.legacy_pos_supplier_id, requireActive: true }
    );
    const canonicalSupplierId = resolvedSup.canonicalSupplier.id;
    const legacyPosSupplierId = resolvedSup.legacyPosSupplierId;

    // Validate destination location if provided
    if (destinationLocationId !== null) {
      const locRes = await client.query(
        `SELECT id, is_active FROM stock_locations WHERE id = $1 AND property_id = $2`,
        [destinationLocationId, propertyId]
      );
      if ((locRes.rowCount ?? 0) === 0) {
        throw Object.assign(new Error('Lokasi tujuan (destination_location_id) tidak ditemukan'), {
          statusCode: 404,
          code: 'LOCATION_NOT_FOUND',
        });
      }
      if (!locRes.rows[0].is_active) {
        throw Object.assign(new Error('Lokasi tujuan sedang nonaktif'), {
          statusCode: 400,
          code: 'LOCATION_INACTIVE',
        });
      }
    }

    const { validatedItems, subtotal } = await validateAndPreparePoItems(
      client,
      propertyId,
      params.items,
      destinationLocationId
    );

    const totalAmount = Number((subtotal + taxAmount).toFixed(2));
    const poNumber = await generatePoNumber(client, propertyId, orderDate);
    const actorId = params.created_by ? Number(params.created_by) : null;
    const actorName = params.actor_name_snapshot || (actorId ? `User #${actorId}` : 'Staff');

    const poInsert = await client.query(
      `INSERT INTO pos_purchase_orders (
         property_id, po_number, supplier_id, canonical_supplier_id, legacy_pos_supplier_id,
         order_date, expected_date, destination_location_id,
         status, approval_status, receiving_status,
         subtotal_amount, tax_amount, total_amount, total_estimated_amount, notes,
         created_by, submitted_by_user_id, submitted_by_name_snapshot, submitted_at,
         source_revision, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $3, $4,
         $5, $6, $7,
         $8, $9, 'BELUM_DITERIMA',
         $10, $11, $12, $12, $13,
         $14, $15, $16, $17,
         1, NOW(), NOW()
       )
       RETURNING id`,
      [
        propertyId,
        poNumber,
        canonicalSupplierId,
        legacyPosSupplierId,
        orderDate,
        expectedDate,
        destinationLocationId,
        initialStatus,
        initialApprovalStatus,
        subtotal,
        taxAmount,
        totalAmount,
        params.notes ? String(params.notes).trim() : null,
        actorId,
        submitForApproval ? actorId : null,
        submitForApproval ? actorName : null,
        submitForApproval ? new Date() : null,
      ]
    );
    const poId = Number(poInsert.rows[0].id);

    for (const item of validatedItems) {
      await client.query(
        `INSERT INTO pos_purchase_order_items (
           property_id, po_id, product_id, base_unit, ordered_unit,
           packaging_id, packaging_label_snapshot, conversion_factor_snapshot,
           destination_location_id,
           ordered_qty, received_qty, unit_cost, subtotal, line_total, notes,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8,
           $9,
           $10, 0, $11, $12, $12, $13,
           NOW(), NOW()
         )`,
        [
          propertyId,
          poId,
          item.product_id,
          item.base_unit,
          item.ordered_unit,
          item.packaging_id,
          item.packaging_label_snapshot,
          item.conversion_factor_snapshot,
          item.destination_location_id,
          item.ordered_qty,
          item.unit_cost,
          item.line_total,
          item.notes,
        ]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
       VALUES ('PROCUREMENT', $1, 'pos_purchase_orders', $2, $3, $4)`,
      [
        submitForApproval ? 'PO_CREATED_AND_SUBMITTED' : 'PO_CREATED_DRAFT',
        String(poId),
        JSON.stringify({
          po_id: poId,
          po_number: poNumber,
          supplier_id: canonicalSupplierId,
          status: initialStatus,
          approval_status: initialApprovalStatus,
          total_amount: totalAmount,
          actor_user_id: actorId,
          actor_name_snapshot: actorName,
        }),
        propertyId,
      ]
    );

    await client.query('COMMIT');
    return getPurchaseOrderById(pool, propertyId, poId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function updatePurchaseOrder(
  pool: Pool,
  propertyId: number,
  poId: number,
  params: {
    supplier_id?: number;
    legacy_pos_supplier_id?: number | null;
    order_date?: string | null;
    expected_date?: string | null;
    destination_location_id?: number | null;
    tax_amount?: number | string | null;
    notes?: string | null;
    submit_for_approval?: boolean;
    items: CreatePurchaseOrderItemInput[];
    actor_user_id?: number | null;
    actor_name_snapshot?: string | null;
  }
): Promise<PosPurchaseOrderRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const poRes = await client.query(
      `SELECT * FROM pos_purchase_orders WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [poId, propertyId]
    );
    if ((poRes.rowCount ?? 0) === 0) {
      throw Object.assign(new Error('Purchase Order (PO) tidak ditemukan'), {
        statusCode: 404,
        code: 'PO_NOT_FOUND',
      });
    }
    const current = poRes.rows[0];
    if (current.status === 'CANCELLED') {
      throw Object.assign(new Error('PO yang sudah dibatalkan tidak dapat diubah'), {
        statusCode: 400,
        code: 'PO_CANCELLED',
      });
    }

    const existingItemsRes = await client.query(
      `SELECT * FROM pos_purchase_order_items WHERE po_id = $1 AND property_id = $2 ORDER BY id ASC FOR UPDATE`,
      [poId, propertyId]
    );
    const existingItemsById = new Map<number, any>();
    let anyPostedReceiptOnPo = false;
    for (const row of existingItemsRes.rows) {
      existingItemsById.set(Number(row.id), row);
      if (Number(row.received_qty || 0) > 0) {
        anyPostedReceiptOnPo = true;
      }
    }

    const postedGrnCheck = await client.query(
      `SELECT COUNT(*)::int AS cnt
         FROM pos_goods_receipts
        WHERE property_id = $1 AND po_id = $2 AND status IN ('POSTED', 'COMPLETED')`,
      [propertyId, poId]
    );
    if (Number(postedGrnCheck.rows[0]?.cnt || 0) > 0) {
      anyPostedReceiptOnPo = true;
    }

    const nextSupplierIdInput =
      params.supplier_id !== undefined ? Number(params.supplier_id) : Number(current.supplier_id);
    const resolvedSup = await resolveCanonicalSupplierForProcurement(
      client,
      propertyId,
      nextSupplierIdInput,
      { legacyPosSupplierId: params.legacy_pos_supplier_id, requireActive: true }
    );
    const nextSupplierId = resolvedSup.canonicalSupplier.id;

    if (anyPostedReceiptOnPo && nextSupplierId !== Number(current.supplier_id)) {
      throw Object.assign(
        new Error(
          'Tidak dapat mengubah pemasok pada PO yang sudah memiliki penerimaan barang (GRN Posted).'
        ),
        { statusCode: 409, code: 'PO_REVISION_CONFLICTS_WITH_POSTED_GRN' }
      );
    }

    const nextOrderDate =
      params.order_date !== undefined ? normalizeDateOnly(params.order_date) : normalizeDateOnly(current.order_date);
    const nextExpectedDate =
      params.expected_date !== undefined
        ? params.expected_date
          ? normalizeDateOnly(params.expected_date)
          : null
        : current.expected_date
        ? normalizeDateOnly(current.expected_date)
        : null;
    const nextDestLocId =
      params.destination_location_id !== undefined
        ? params.destination_location_id
          ? Number(params.destination_location_id)
          : null
        : current.destination_location_id
        ? Number(current.destination_location_id)
        : null;
    const nextTaxAmount =
      params.tax_amount !== undefined ? Math.max(0, Number(params.tax_amount || 0)) : Number(current.tax_amount || 0);
    const nextNotes =
      params.notes !== undefined
        ? params.notes
          ? String(params.notes).trim()
          : null
        : current.notes ?? null;

    if (nextDestLocId !== null) {
      const locRes = await client.query(
        `SELECT id, is_active FROM stock_locations WHERE id = $1 AND property_id = $2`,
        [nextDestLocId, propertyId]
      );
      if ((locRes.rowCount ?? 0) === 0) {
        throw Object.assign(new Error('Lokasi tujuan (destination_location_id) tidak ditemukan'), {
          statusCode: 404,
          code: 'LOCATION_NOT_FOUND',
        });
      }
      if (!locRes.rows[0].is_active) {
        throw Object.assign(new Error('Lokasi tujuan sedang nonaktif'), {
          statusCode: 400,
          code: 'LOCATION_INACTIVE',
        });
      }
    }

    const { validatedItems, subtotal } = await validateAndPreparePoItems(
      client,
      propertyId,
      params.items,
      nextDestLocId,
      existingItemsById
    );

    // Match incoming items to existing items by explicit ID (or fallback to unambiguous single match)
    const matchedExistingIds = new Set<number>();
    let hasMaterialChange = nextSupplierId !== Number(current.supplier_id);

    for (const vItem of validatedItems) {
      let existingRow = vItem.existing_item_id ? existingItemsById.get(vItem.existing_item_id) : null;
      if (!existingRow && !vItem.existing_item_id) {
        const candidates = existingItemsRes.rows.filter(
          (r: any) =>
            !matchedExistingIds.has(Number(r.id)) &&
            Number(r.product_id) === vItem.product_id &&
            Number(r.packaging_id || 0) === Number(vItem.packaging_id || 0)
        );
        if (candidates.length === 1) {
          existingRow = candidates[0];
          vItem.existing_item_id = Number(existingRow.id);
        }
      }

      if (existingRow) {
        matchedExistingIds.add(Number(existingRow.id));
        const receivedQty = Number(existingRow.received_qty || 0);
        const prevProductId = Number(existingRow.product_id);
        const prevPkgId = existingRow.packaging_id != null ? Number(existingRow.packaging_id) : null;
        const prevOrderedQty = Number(existingRow.ordered_qty || 0);
        const prevUnitCost = Number(existingRow.unit_cost || 0);

        if (
          prevProductId !== vItem.product_id ||
          prevPkgId !== vItem.packaging_id ||
          Math.abs(prevOrderedQty - vItem.ordered_qty) > 0.0001 ||
          Math.abs(prevUnitCost - vItem.unit_cost) > 0.005
        ) {
          hasMaterialChange = true;
        }

        if (receivedQty > 0) {
          if (prevProductId !== vItem.product_id || prevPkgId !== vItem.packaging_id) {
            throw Object.assign(
              new Error(
                `Baris PO #${existingRow.id} sudah memiliki penerimaan barang (${receivedQty} ${existingRow.ordered_unit || existingRow.base_unit}); produk dan kemasan tidak dapat diubah.`
              ),
              { statusCode: 409, code: 'PO_LINE_ALREADY_RECEIVED' }
            );
          }
          if (vItem.ordered_qty + 0.0001 < receivedQty) {
            throw Object.assign(
              new Error(
                `Baris PO #${existingRow.id}: jumlah pesanan (${vItem.ordered_qty}) tidak boleh lebih kecil dari jumlah yang sudah diterima (${receivedQty}).`
              ),
              { statusCode: 409, code: 'PO_QTY_BELOW_RECEIVED' }
            );
          }
          if (Math.abs(prevUnitCost - vItem.unit_cost) > 0.005) {
            throw Object.assign(
              new Error(
                `Baris PO #${existingRow.id}: harga satuan pada baris PO yang sudah memiliki GRN Posted tidak dapat diubah agar histori valuasi persediaan tetap terlindungi.`
              ),
              { statusCode: 409, code: 'PO_PRICE_LOCKED_BY_POSTED_GRN' }
            );
          }
        }
      } else {
        hasMaterialChange = true;
      }
    }

    // Check any removed existing items
    for (const existingRow of existingItemsRes.rows) {
      const exId = Number(existingRow.id);
      if (!matchedExistingIds.has(exId)) {
        hasMaterialChange = true;
        if (Number(existingRow.received_qty || 0) > 0) {
          throw Object.assign(
            new Error(
              `Baris PO #${exId} sudah memiliki penerimaan barang dan tidak dapat dihapus.`
            ),
            { statusCode: 409, code: 'PO_LINE_ALREADY_RECEIVED' }
          );
        }
        const refCheck = await client.query(
          `SELECT (SELECT COUNT(*)::int FROM pos_goods_receipt_items WHERE po_item_id = $1) +
                  (SELECT COUNT(*)::int FROM transaction_lines WHERE po_item_id = $1) AS refs`,
          [exId]
        );
        if (Number(refCheck.rows[0]?.refs || 0) > 0) {
          throw Object.assign(
            new Error(
              `Baris PO #${exId} sudah dirujuk oleh dokumen GRN atau Tagihan dan tidak dapat dihapus.`
            ),
            { statusCode: 409, code: 'PO_LINE_REFERENCED' }
          );
        }
        await client.query(`DELETE FROM pos_purchase_order_items WHERE id = $1 AND property_id = $2`, [
          exId,
          propertyId,
        ]);
      }
    }

    // Apply updates / inserts for items preserving stable IDs
    for (const vItem of validatedItems) {
      if (vItem.existing_item_id && matchedExistingIds.has(vItem.existing_item_id)) {
        await client.query(
          `UPDATE pos_purchase_order_items
              SET product_id = $1,
                  base_unit = $2,
                  ordered_unit = $3,
                  packaging_id = $4,
                  packaging_label_snapshot = $5,
                  conversion_factor_snapshot = $6,
                  destination_location_id = $7,
                  ordered_qty = $8,
                  unit_cost = $9,
                  subtotal = $10,
                  line_total = $10,
                  notes = $11,
                  updated_at = NOW()
            WHERE id = $12 AND po_id = $13 AND property_id = $14`,
          [
            vItem.product_id,
            vItem.base_unit,
            vItem.ordered_unit,
            vItem.packaging_id,
            vItem.packaging_label_snapshot,
            vItem.conversion_factor_snapshot,
            vItem.destination_location_id,
            vItem.ordered_qty,
            vItem.unit_cost,
            vItem.line_total,
            vItem.notes,
            vItem.existing_item_id,
            poId,
            propertyId,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO pos_purchase_order_items (
             property_id, po_id, product_id, base_unit, ordered_unit,
             packaging_id, packaging_label_snapshot, conversion_factor_snapshot,
             destination_location_id,
             ordered_qty, received_qty, unit_cost, subtotal, line_total, notes,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8,
             $9,
             $10, 0, $11, $12, $12, $13,
             NOW(), NOW()
           )`,
          [
            propertyId,
            poId,
            vItem.product_id,
            vItem.base_unit,
            vItem.ordered_unit,
            vItem.packaging_id,
            vItem.packaging_label_snapshot,
            vItem.conversion_factor_snapshot,
            vItem.destination_location_id,
            vItem.ordered_qty,
            vItem.unit_cost,
            vItem.line_total,
            vItem.notes,
          ]
        );
      }
    }

    // Recompute PO receiving_status and status after item update
    const updatedItemsRes = await client.query(
      `SELECT ordered_qty, received_qty FROM pos_purchase_order_items WHERE po_id = $1 AND property_id = $2`,
      [poId, propertyId]
    );
    let allCompleted = updatedItemsRes.rows.length > 0;
    let anyReceived = false;
    for (const r of updatedItemsRes.rows) {
      const o = Number(r.ordered_qty || 0);
      const rec = Number(r.received_qty || 0);
      if (rec > 0) anyReceived = true;
      if (rec + 0.0001 < o) allCompleted = false;
    }
    const nextReceivingStatus: PosPurchaseOrderReceivingStatus = allCompleted
      ? 'DITERIMA_LENGKAP'
      : anyReceived
      ? 'DITERIMA_SEBAGIAN'
      : 'BELUM_DITERIMA';

    const wasApproved = current.approval_status === 'APPROVED';
    let nextApprovalStatus: PosPurchaseOrderApprovalStatus = current.approval_status || 'DRAFT';
    let nextStatus: PosPurchaseOrderStatus = current.status as PosPurchaseOrderStatus;
    let nextRevision = Number(current.source_revision || 1);

    const actorId = params.actor_user_id ? Number(params.actor_user_id) : null;
    const actorName = params.actor_name_snapshot || (actorId ? `User #${actorId}` : 'Staff');

    if (wasApproved && hasMaterialChange) {
      // Material change on an approved PO requires re-authorization
      nextRevision += 1;
      nextApprovalStatus = 'PENDING_APPROVAL';
      nextStatus = anyReceived ? 'PARTIALLY_RECEIVED' : 'PENDING_APPROVAL';
    } else if (params.submit_for_approval && nextApprovalStatus !== 'APPROVED') {
      nextApprovalStatus = 'PENDING_APPROVAL';
      nextStatus = 'PENDING_APPROVAL';
    } else if (wasApproved) {
      nextStatus = allCompleted
        ? 'COMPLETED'
        : anyReceived
        ? 'PARTIALLY_RECEIVED'
        : (current.status as PosPurchaseOrderStatus);
    }

    const totalAmount = Number((subtotal + nextTaxAmount).toFixed(2));

    await client.query(
      `UPDATE pos_purchase_orders
          SET supplier_id = $1,
              canonical_supplier_id = $1,
              legacy_pos_supplier_id = $2,
              order_date = $3,
              expected_date = $4,
              destination_location_id = $5,
              subtotal_amount = $6,
              tax_amount = $7,
              total_amount = $8,
              total_estimated_amount = $8,
              notes = $9,
              status = $10::varchar,
              approval_status = $11::varchar,
              receiving_status = $12::varchar,
              source_revision = $13,
              submitted_by_user_id = CASE WHEN $11::varchar = 'PENDING_APPROVAL' THEN COALESCE($14::varchar, submitted_by_user_id) ELSE submitted_by_user_id END,
              submitted_by_name_snapshot = CASE WHEN $11::varchar = 'PENDING_APPROVAL' THEN COALESCE($15::varchar, submitted_by_name_snapshot) ELSE submitted_by_name_snapshot END,
              submitted_at = CASE WHEN $11::varchar = 'PENDING_APPROVAL' THEN NOW() ELSE submitted_at END,
              approved_by = CASE WHEN $11::varchar = 'PENDING_APPROVAL' THEN NULL ELSE approved_by END,
              approved_by_user_id = CASE WHEN $11::varchar = 'PENDING_APPROVAL' THEN NULL ELSE approved_by_user_id END,
              approved_by_name_snapshot = CASE WHEN $11::varchar = 'PENDING_APPROVAL' THEN NULL ELSE approved_by_name_snapshot END,
              approved_at = CASE WHEN $11::varchar = 'PENDING_APPROVAL' THEN NULL ELSE approved_at END,
              updated_at = NOW()
        WHERE id = $16 AND property_id = $17`,
      [
        nextSupplierId,
        resolvedSup.legacyPosSupplierId,
        nextOrderDate,
        nextExpectedDate,
        nextDestLocId,
        subtotal,
        nextTaxAmount,
        totalAmount,
        nextNotes,
        nextStatus,
        nextApprovalStatus,
        nextReceivingStatus,
        nextRevision,
        actorId,
        actorName,
        poId,
        propertyId,
      ]
    );

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
       VALUES ('PROCUREMENT', $1, 'pos_purchase_orders', $2, $3, $4)`,
      [
        wasApproved && hasMaterialChange ? 'PO_MATERIAL_REVISION_REQUIRES_APPROVAL' : 'PO_UPDATED',
        String(poId),
        JSON.stringify({
          po_id: poId,
          has_material_change: hasMaterialChange,
          previous_approval_status: current.approval_status,
          next_approval_status: nextApprovalStatus,
          source_revision: nextRevision,
          total_amount: totalAmount,
          actor_user_id: actorId,
          actor_name_snapshot: actorName,
        }),
        propertyId,
      ]
    );

    await client.query('COMMIT');
    return getPurchaseOrderById(pool, propertyId, poId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function updatePurchaseOrderStatus(
  pool: Pool,
  propertyId: number,
  poId: number,
  targetStatusInput: string,
  actorUserId?: number | null,
  options?: {
    actorNameSnapshot?: string | null;
    rejectionReason?: string | null;
    archiveReason?: string | null;
  }
): Promise<PosPurchaseOrderRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const poRes = await client.query(
      `SELECT * FROM pos_purchase_orders WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [poId, propertyId]
    );
    if ((poRes.rowCount ?? 0) === 0) {
      throw Object.assign(new Error('Purchase Order (PO) tidak ditemukan'), {
        statusCode: 404,
        code: 'PO_NOT_FOUND',
      });
    }

    const current = poRes.rows[0];
    const currentStatus = current.status as PosPurchaseOrderStatus;
    const rawTarget = String(targetStatusInput || '').trim().toUpperCase();
    const actorId = actorUserId ? Number(actorUserId) : null;
    const actorName = options?.actorNameSnapshot || (actorId ? `User #${actorId}` : 'System');

    // Support administrative ARCHIVE / UNARCHIVE on PO
    if (rawTarget === 'ARCHIVE' || rawTarget === 'UNARCHIVE') {
      const isArchive = rawTarget === 'ARCHIVE';
      await client.query(
        `UPDATE pos_purchase_orders
            SET archived_at = $1,
                archived_by_user_id = $2,
                archived_by_name_snapshot = $3,
                archive_reason = $4,
                updated_at = NOW()
          WHERE id = $5 AND property_id = $6`,
        [
          isArchive ? new Date() : null,
          isArchive ? actorId : null,
          isArchive ? actorName : null,
          isArchive ? options?.archiveReason || null : null,
          poId,
          propertyId,
        ]
      );
      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
         VALUES ('PROCUREMENT', $1, 'pos_purchase_orders', $2, $3, $4)`,
        [
          isArchive ? 'PO_ARCHIVED' : 'PO_UNARCHIVED',
          String(poId),
          JSON.stringify({ po_id: poId, actor_user_id: actorId, actor_name_snapshot: actorName }),
          propertyId,
        ]
      );
      await client.query('COMMIT');
      return getPurchaseOrderById(pool, propertyId, poId);
    }

    if (currentStatus === 'CANCELLED') {
      throw Object.assign(
        new Error(`Purchase Order sudah berstatus ${currentStatus} dan tidak dapat diubah lagi`),
        { statusCode: 400, code: 'INVALID_PO_STATUS_TRANSITION' }
      );
    }

    if (rawTarget === 'SUBMIT' || rawTarget === 'PENDING_APPROVAL') {
      if (!['DRAFT', 'REJECTED', 'PENDING_APPROVAL'].includes(currentStatus)) {
        throw Object.assign(
          new Error(`PO berstatus ${currentStatus} tidak dapat diajukan persetujuan ulang`),
          { statusCode: 400, code: 'INVALID_PO_STATUS_TRANSITION' }
        );
      }
      await client.query(
        `UPDATE pos_purchase_orders
            SET status = 'PENDING_APPROVAL',
                approval_status = 'PENDING_APPROVAL',
                submitted_by_user_id = $1,
                submitted_by_name_snapshot = $2,
                submitted_at = NOW(),
                rejection_reason = NULL,
                updated_at = NOW()
          WHERE id = $3 AND property_id = $4`,
        [actorId, actorName, poId, propertyId]
      );
    } else if (rawTarget === 'APPROVE' || rawTarget === 'APPROVED' || rawTarget === 'ORDERED') {
      const nextStatus: PosPurchaseOrderStatus =
        currentStatus === 'PARTIALLY_RECEIVED'
          ? 'PARTIALLY_RECEIVED'
          : currentStatus === 'COMPLETED'
          ? 'COMPLETED'
          : rawTarget === 'ORDERED'
          ? 'ORDERED'
          : 'APPROVED';

      await client.query(
        `UPDATE pos_purchase_orders
            SET status = $1,
                approval_status = 'APPROVED',
                approved_by = $2,
                approved_by_user_id = $2,
                approved_by_name_snapshot = $3,
                approved_at = NOW(),
                rejection_reason = NULL,
                updated_at = NOW()
          WHERE id = $4 AND property_id = $5`,
        [nextStatus, actorId, actorName, poId, propertyId]
      );
    } else if (rawTarget === 'REJECT' || rawTarget === 'REJECTED') {
      const postedGrnCheck = await client.query(
        `SELECT COUNT(*)::int AS cnt
           FROM pos_goods_receipts
          WHERE property_id = $1 AND po_id = $2 AND status IN ('POSTED', 'COMPLETED')`,
        [propertyId, poId]
      );
      if (Number(postedGrnCheck.rows[0]?.cnt || 0) > 0) {
        throw Object.assign(
          new Error('Tidak dapat menolak PO yang sudah memiliki penerimaan barang (GRN Posted)'),
          { statusCode: 409, code: 'CANNOT_REJECT_PO_WITH_POSTED_GRN' }
        );
      }
      const reason = String(options?.rejectionReason || '').trim() || 'Ditolak oleh pejabat berwenang';
      await client.query(
        `UPDATE pos_purchase_orders
            SET status = 'REJECTED',
                approval_status = 'REJECTED',
                approved_by = $1,
                approved_by_user_id = $1,
                approved_by_name_snapshot = $2,
                approved_at = NOW(),
                rejection_reason = $3,
                updated_at = NOW()
          WHERE id = $4 AND property_id = $5`,
        [actorId, actorName, reason, poId, propertyId]
      );
    } else if (rawTarget === 'CANCELLED' || rawTarget === 'CANCEL') {
      const postedGrnCheck = await client.query(
        `SELECT COUNT(*)::int AS cnt
           FROM pos_goods_receipts
          WHERE property_id = $1 AND po_id = $2 AND status IN ('POSTED', 'COMPLETED')`,
        [propertyId, poId]
      );
      if (Number(postedGrnCheck.rows[0]?.cnt || 0) > 0) {
        throw Object.assign(
          new Error('Tidak dapat membatalkan PO yang sudah memiliki penerimaan barang (GRN Posted)'),
          { statusCode: 409, code: 'CANNOT_CANCEL_PO_WITH_POSTED_GRN' }
        );
      }
      await client.query(
        `UPDATE pos_purchase_orders
            SET status = 'CANCELLED',
                updated_at = NOW()
          WHERE id = $1 AND property_id = $2`,
        [poId, propertyId]
      );
    } else {
      throw Object.assign(
        new Error(`Status target PO "${rawTarget}" tidak didukung`),
        { statusCode: 400, code: 'INVALID_PO_STATUS' }
      );
    }

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
       VALUES ('PROCUREMENT', $1, 'pos_purchase_orders', $2, $3, $4)`,
      [
        `PO_STATUS_${rawTarget}`,
        String(poId),
        JSON.stringify({
          po_id: poId,
          previous_status: currentStatus,
          target_status: rawTarget,
          actor_user_id: actorId,
          actor_name_snapshot: actorName,
          rejection_reason: options?.rejectionReason || null,
        }),
        propertyId,
      ]
    );

    await client.query('COMMIT');
    return getPurchaseOrderById(pool, propertyId, poId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function assertProcurementApprovalAuthority(
  pool: Pool | PoolClient,
  propertyId: number,
  user: any
): Promise<{ actorUserId: number; actorNameSnapshot: string }> {
  const userId = Number(user?.id || 0);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw Object.assign(new Error('Identitas pengguna tidak terautentikasi untuk persetujuan PO.'), {
      statusCode: 401,
      code: 'UNAUTHENTICATED_APPROVER',
    });
  }

  const userRes = await pool.query(
    `SELECT u.id, u.full_name, u.username, u.role_id, u.property_id, u.is_active,
            r.name AS canonical_role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1`,
    [userId]
  );
  if ((userRes.rowCount ?? 0) === 0) {
    throw Object.assign(new Error('Pengguna tidak ditemukan.'), {
      statusCode: 403,
      code: 'APPROVER_NOT_FOUND',
    });
  }
  const dbUser = userRes.rows[0];
  if (dbUser.is_active === false) {
    throw Object.assign(new Error('Akun pengguna sedang nonaktif.'), {
      statusCode: 403,
      code: 'APPROVER_INACTIVE',
    });
  }
  if (dbUser.property_id != null && Number(dbUser.property_id) !== Number(propertyId)) {
    throw Object.assign(new Error('Pengguna tidak memiliki otoritas pada properti ini.'), {
      statusCode: 403,
      code: 'APPROVER_CROSS_PROPERTY_DENIED',
    });
  }

  const rawRoleName = String(dbUser.canonical_role_name || user?.role || user?.role_name || '').trim();
  const roleUpper = rawRoleName.toUpperCase().replace(/[\s-]+/g, '_');
  const allowedRoles = new Set([
    'OWNER',
    'SUPER_ADMIN',
    'SUPERADMIN',
    'ADMIN',
    'ADMINISTRATOR',
    'GENERAL_MANAGER',
    'GM',
    'MANAGER',
    'HOTEL_MANAGER',
    'FINANCE',
    'FINANCE_MANAGER',
    'ACCOUNTING',
    'PURCHASING',
    'PURCHASING_MANAGER',
    'PROCUREMENT_MANAGER',
  ]);
  const perms: string[] = Array.isArray(user?.permissions) ? user.permissions : [];
  const hasExplicitApprovalPerm =
    allowedRoles.has(roleUpper) ||
    perms.includes('ALL') ||
    perms.includes('*') ||
    perms.includes('Approve PO') ||
    perms.includes('Persetujuan Pengadaan') ||
    perms.includes('Finance') ||
    perms.includes('Manajemen Sistem');

  if (!hasExplicitApprovalPerm) {
    throw Object.assign(
      new Error(
        `Peran "${rawRoleName || 'UNKNOWN'}" tidak memiliki wewenang menyetujui atau menolak Purchase Order (PO). Hubungi Owner/Manager/Finance.`
      ),
      {
        statusCode: 403,
        code: 'PO_APPROVAL_FORBIDDEN',
      }
    );
  }

  const actorNameSnapshot = String(dbUser.full_name || dbUser.username || `User #${userId}`).trim();
  return { actorUserId: userId, actorNameSnapshot };
}

// Canonical aliases used by posPurchaseOrderHandlers.ts & index.ts
export const getPosSuppliers = listSuppliers;
export const getPosSupplierById = async (
  pool: Pool,
  propertyId: number,
  supplierId: number
): Promise<PosSupplierRow | null> => {
  const rows = await listSuppliers(pool, propertyId, { includeInactive: true });
  return (
    rows.find(
      (r: any) =>
        Number(r.id) === Number(supplierId) ||
        Number(r.canonical_supplier_id) === Number(supplierId) ||
        Number(r.legacy_pos_supplier_id) === Number(supplierId)
    ) || null
  );
};
export const createPosSupplier = createSupplier;
export const updatePosSupplier = updateSupplier;
export const deletePosSupplier = deactivateSupplier;
export const getPosPurchaseOrders = listPurchaseOrders;
export const getPosPurchaseOrderById = getPurchaseOrderById;
export const createPosPurchaseOrder = createPurchaseOrder;
export const updatePosPurchaseOrder = updatePurchaseOrder;
export const updatePosPurchaseOrderStatus = updatePurchaseOrderStatus;

