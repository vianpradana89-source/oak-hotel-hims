import { Pool, PoolClient } from 'pg';
import { getEffectivePurchaseFieldPolicy } from './purchaseFieldRulesService';

export const SYSTEM_PURCHASE_CATEGORY_SEEDS = [
  { code: 'SUPPLIES_PURCHASE', name: 'Pembelian Perlengkapan Kantor / FO', department_code: 'FRONT_OFFICE', sort_order: 10 },
  { code: 'AMENITIES_PURCHASE', name: 'Pembelian Amenities & Perlengkapan Kamar', department_code: 'HOUSEKEEPING', sort_order: 20 },
  { code: 'LINEN_PURCHASE', name: 'Pembelian Linen & Bedding', department_code: 'HOUSEKEEPING', sort_order: 30 },
  { code: 'FNB_INGREDIENTS_PURCHASE', name: 'Pembelian Bahan Baku Makanan & Minuman', department_code: 'FNB', sort_order: 40 },
  { code: 'MAINTENANCE_PARTS_PURCHASE', name: 'Pembelian Suku Cadang & Alat Perbaikan', department_code: 'MAINTENANCE', sort_order: 50 },
  { code: 'OUTSOURCED_SERVICES', name: 'Jasa Pihak Ketiga / Outsourcing', department_code: 'ADMIN', sort_order: 60 },
  { code: 'OTHER_PURCHASE', name: 'Pembelian Barang Lainnya', department_code: 'GENERAL', sort_order: 70 },
] as const;

export interface PurchaseCategoryRow {
  id: number;
  property_id: number;
  code: string;
  name: string;
  description: string | null;
  transaction_type: 'PURCHASE';
  is_active: boolean;
  is_system_default: boolean;
  sort_order: number;
  referenced: boolean;
  created_at?: string;
  updated_at?: string | null;
}

export interface PurchaseDepartmentOption {
  id: number;
  property_id: number;
  code: string;
  name: string;
  is_active: boolean;
  allowed: boolean;
}

function httpError(statusCode: number, message: string, code: string): Error {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function generatePurchaseCategoryCode(name: string): string {
  const base = String(name || '')
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 40);
  return base || 'PURCHASE_CAT';
}

export async function ensurePropertyPurchaseCategories(
  poolOrClient: Pool | PoolClient,
  propertyId: number
): Promise<void> {
  await poolOrClient.query(
    `INSERT INTO transaction_custom_categories (
       property_id, code, name, transaction_type, department_code,
       is_active, is_system_default, sort_order, created_at, updated_at
     )
     SELECT
       $1,
       seed.code,
       seed.name,
       'PURCHASE',
       seed.department_code,
       TRUE,
       TRUE,
       seed.sort_order,
       NOW(),
       NOW()
     FROM (
       VALUES
         ('SUPPLIES_PURCHASE', 'Pembelian Perlengkapan Kantor / FO', 'FRONT_OFFICE', 10),
         ('AMENITIES_PURCHASE', 'Pembelian Amenities & Perlengkapan Kamar', 'HOUSEKEEPING', 20),
         ('LINEN_PURCHASE', 'Pembelian Linen & Bedding', 'HOUSEKEEPING', 30),
         ('FNB_INGREDIENTS_PURCHASE', 'Pembelian Bahan Baku Makanan & Minuman', 'FNB', 40),
         ('MAINTENANCE_PARTS_PURCHASE', 'Pembelian Suku Cadang & Alat Perbaikan', 'MAINTENANCE', 50),
         ('OUTSOURCED_SERVICES', 'Jasa Pihak Ketiga / Outsourcing', 'ADMIN', 60),
         ('OTHER_PURCHASE', 'Pembelian Barang Lainnya', 'GENERAL', 70)
     ) AS seed(code, name, department_code, sort_order)
     ON CONFLICT (property_id, code) DO UPDATE
       SET is_system_default = TRUE,
           updated_at = COALESCE(transaction_custom_categories.updated_at, NOW())`,
    [propertyId]
  );
}

function mapCategoryRow(row: any): PurchaseCategoryRow {
  return {
    id: Number(row.id),
    property_id: Number(row.property_id),
    code: String(row.code),
    name: String(row.name),
    description: row.description || null,
    transaction_type: 'PURCHASE',
    is_active: row.is_active !== false,
    is_system_default: row.is_system_default === true,
    sort_order: Number(row.sort_order || 0),
    referenced: Number(row.referenced_count || 0) > 0,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

export async function listPurchaseCategories(
  pool: Pool,
  propertyId: number,
  options: { activeOnly?: boolean } = {}
): Promise<PurchaseCategoryRow[]> {
  await ensurePropertyPurchaseCategories(pool, propertyId);
  const res = await pool.query(
    `SELECT c.id, c.property_id, c.code, c.name, c.description, c.is_active,
            c.is_system_default, c.sort_order, c.created_at, c.updated_at,
            (
              SELECT COUNT(*)::int
              FROM transactions t
              WHERE t.property_id = c.property_id
                AND t.transaction_type = 'PURCHASE'
                AND (
                  t.purchase_category_id = c.id
                  OR t.category_code = c.code
                )
            ) AS referenced_count
     FROM transaction_custom_categories c
     WHERE c.property_id = $1
       AND c.transaction_type = 'PURCHASE'
       AND ($2::boolean IS NOT TRUE OR c.is_active = TRUE)
     ORDER BY c.sort_order ASC, c.name ASC, c.id ASC`,
    [propertyId, options.activeOnly === true]
  );
  return res.rows.map(mapCategoryRow);
}

export async function createPurchaseCategory(
  pool: Pool,
  dto: {
    property_id: number;
    name: string;
    code?: string | null;
    description?: string | null;
    sort_order?: number | null;
    actor_name?: string | null;
  }
): Promise<PurchaseCategoryRow> {
  const name = String(dto.name || '').trim();
  if (!name) {
    throw httpError(400, 'Nama kategori pembelian wajib diisi', 'VALIDATION_ERROR');
  }
  await ensurePropertyPurchaseCategories(pool, dto.property_id);

  let code = String(dto.code || '').trim().toUpperCase() || generatePurchaseCategoryCode(name);
  const existing = await pool.query(
    `SELECT id FROM transaction_custom_categories WHERE property_id = $1 AND code = $2`,
    [dto.property_id, code]
  );
  if ((existing.rowCount ?? 0) > 0) {
    if (dto.code) {
      throw httpError(409, `Kode kategori '${code}' sudah digunakan pada properti ini`, 'CATEGORY_CODE_EXISTS');
    }
    code = `${code}_${Date.now().toString().slice(-4)}`.slice(0, 50);
  }

  const sortOrder = Number.isInteger(Number(dto.sort_order)) ? Number(dto.sort_order) : 100;
  const insert = await pool.query(
    `INSERT INTO transaction_custom_categories (
       property_id, code, name, description, transaction_type, department_code,
       is_active, is_system_default, sort_order, created_at, updated_at, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, 'PURCHASE', 'GENERAL',
       TRUE, FALSE, $5, NOW(), NOW(), $6, $6
     )
     RETURNING id, property_id, code, name, description, is_active, is_system_default, sort_order, created_at, updated_at`,
    [dto.property_id, code, name, dto.description?.trim() || null, sortOrder, dto.actor_name || 'Staff']
  );

  await pool.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('TRANSACTIONS', 'PURCHASE_CATEGORY_CREATED', 'transaction_custom_categories', $1, $2, $3)`,
    [String(insert.rows[0].id), JSON.stringify({ code, name, actor: dto.actor_name || 'Staff' }), dto.property_id]
  );

  return mapCategoryRow({ ...insert.rows[0], referenced_count: 0 });
}

export async function updatePurchaseCategory(
  pool: Pool,
  propertyId: number,
  categoryId: number,
  dto: { name?: string | null; description?: string | null; sort_order?: number | null; actor_name?: string | null }
): Promise<PurchaseCategoryRow> {
  const current = await loadPurchaseCategory(pool, propertyId, categoryId);
  const name = dto.name !== undefined ? String(dto.name || '').trim() : current.name;
  if (!name) {
    throw httpError(400, 'Nama kategori pembelian wajib diisi', 'VALIDATION_ERROR');
  }
  const description = dto.description !== undefined ? (String(dto.description || '').trim() || null) : current.description;
  const sortOrder = dto.sort_order !== undefined && Number.isInteger(Number(dto.sort_order))
    ? Number(dto.sort_order)
    : current.sort_order;

  const updated = await pool.query(
    `UPDATE transaction_custom_categories
     SET name = $1, description = $2, sort_order = $3, updated_at = NOW(), updated_by = $4
     WHERE id = $5 AND property_id = $6 AND transaction_type = 'PURCHASE'
     RETURNING id, property_id, code, name, description, is_active, is_system_default, sort_order, created_at, updated_at`,
    [name, description, sortOrder, dto.actor_name || 'Staff', categoryId, propertyId]
  );

  await pool.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('TRANSACTIONS', 'PURCHASE_CATEGORY_UPDATED', 'transaction_custom_categories', $1, $2, $3)`,
    [String(categoryId), JSON.stringify({ previous_name: current.name, name, actor: dto.actor_name || 'Staff' }), propertyId]
  );

  return (await listPurchaseCategories(pool, propertyId)).find((row) => row.id === Number(updated.rows[0].id))!;
}

export async function setPurchaseCategoryActive(
  pool: Pool,
  propertyId: number,
  categoryId: number,
  isActive: boolean,
  actorName?: string | null
): Promise<PurchaseCategoryRow> {
  await loadPurchaseCategory(pool, propertyId, categoryId);
  await pool.query(
    `UPDATE transaction_custom_categories
     SET is_active = $1, updated_at = NOW(), updated_by = $2
     WHERE id = $3 AND property_id = $4 AND transaction_type = 'PURCHASE'`,
    [isActive, actorName || 'Staff', categoryId, propertyId]
  );
  await pool.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('TRANSACTIONS', $1, 'transaction_custom_categories', $2, $3, $4)`,
    [
      isActive ? 'PURCHASE_CATEGORY_ACTIVATED' : 'PURCHASE_CATEGORY_DEACTIVATED',
      String(categoryId),
      JSON.stringify({ is_active: isActive, actor: actorName || 'Staff' }),
      propertyId,
    ]
  );
  return (await listPurchaseCategories(pool, propertyId)).find((row) => row.id === categoryId)!;
}

export async function deletePurchaseCategory(
  pool: Pool,
  propertyId: number,
  categoryId: number,
  actorName?: string | null
): Promise<{ success: true }> {
  const current = await loadPurchaseCategory(pool, propertyId, categoryId);
  if (current.is_system_default) {
    throw httpError(409, 'Kategori default sistem tidak dapat dihapus. Nonaktifkan jika tidak ingin dipakai.', 'CATEGORY_SYSTEM_DEFAULT');
  }
  const refs = await pool.query(
    `SELECT id FROM transactions
     WHERE property_id = $1
       AND transaction_type = 'PURCHASE'
       AND (purchase_category_id = $2 OR category_code = $3)
     LIMIT 1`,
    [propertyId, categoryId, current.code]
  );
  if ((refs.rowCount ?? 0) > 0) {
    throw httpError(
      409,
      'Kategori sudah dipakai transaksi pembelian. Nonaktifkan kategori alih-alih menghapusnya.',
      'CATEGORY_IN_USE'
    );
  }

  await pool.query(
    `DELETE FROM transaction_custom_categories
     WHERE id = $1 AND property_id = $2 AND transaction_type = 'PURCHASE' AND is_system_default = FALSE`,
    [categoryId, propertyId]
  );
  await pool.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
     VALUES ('TRANSACTIONS', 'PURCHASE_CATEGORY_DELETED', 'transaction_custom_categories', $1, $2, $3)`,
    [String(categoryId), JSON.stringify({ code: current.code, name: current.name, actor: actorName || 'Staff' }), propertyId]
  );
  return { success: true };
}

async function loadPurchaseCategory(
  pool: Pool | PoolClient,
  propertyId: number,
  categoryId: number
): Promise<PurchaseCategoryRow> {
  const res = await pool.query(
    `SELECT id, property_id, code, name, description, transaction_type, is_active, is_system_default, sort_order, created_at, updated_at
     FROM transaction_custom_categories
     WHERE id = $1`,
    [categoryId]
  );
  if ((res.rowCount ?? 0) === 0) {
    throw httpError(404, `Kategori pembelian #${categoryId} tidak ditemukan`, 'CATEGORY_NOT_FOUND');
  }
  const row = res.rows[0];
  if (Number(row.property_id) !== propertyId) {
    throw httpError(403, 'Kategori pembelian bukan milik properti ini', 'CROSS_PROPERTY_CATEGORY');
  }
  if (String(row.transaction_type || '').toUpperCase() !== 'PURCHASE') {
    throw httpError(400, `Kategori '${row.code}' bukan kategori pembelian`, 'VALIDATION_ERROR');
  }
  return mapCategoryRow(row);
}

export async function listPurchaseDepartmentOptions(
  pool: Pool,
  propertyId: number
): Promise<{ empty_allow_list_means: 'ALL_ACTIVE'; departments: PurchaseDepartmentOption[] }> {
  const depts = await pool.query(
    `SELECT d.id, d.property_id, d.code, d.name, d.is_active,
            EXISTS (
              SELECT 1 FROM property_purchase_allowed_departments a
              WHERE a.property_id = d.property_id AND a.department_id = d.id
            ) AS allowed
     FROM hr_departments d
     WHERE d.property_id = $1
     ORDER BY d.sort_order ASC, d.name ASC, d.id ASC`,
    [propertyId]
  );
  return {
    empty_allow_list_means: 'ALL_ACTIVE',
    departments: depts.rows.map((row) => ({
      id: Number(row.id),
      property_id: Number(row.property_id),
      code: String(row.code),
      name: String(row.name),
      is_active: row.is_active === true,
      allowed: row.allowed === true,
    })),
  };
}

export async function replacePurchaseAllowedDepartments(
  pool: Pool,
  propertyId: number,
  departmentIds: number[],
  actorName?: string | null
): Promise<{ empty_allow_list_means: 'ALL_ACTIVE'; departments: PurchaseDepartmentOption[] }> {
  const uniqueIds = [...new Set((departmentIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (uniqueIds.length > 0) {
    const found = await pool.query(
      `SELECT id, property_id FROM hr_departments WHERE id = ANY($1::int[])`,
      [uniqueIds]
    );
    if (found.rows.length !== uniqueIds.length) {
      throw httpError(400, 'Salah satu departemen alokasi tidak ditemukan', 'DEPARTMENT_NOT_FOUND');
    }
    const foreign = found.rows.find((row) => Number(row.property_id) !== propertyId);
    if (foreign) {
      throw httpError(403, 'Departemen alokasi bukan milik properti ini', 'CROSS_PROPERTY_DEPARTMENT');
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM property_purchase_allowed_departments WHERE property_id = $1', [propertyId]);
    for (const departmentId of uniqueIds) {
      await client.query(
        `INSERT INTO property_purchase_allowed_departments (property_id, department_id)
         VALUES ($1, $2)
         ON CONFLICT (property_id, department_id) DO NOTHING`,
        [propertyId, departmentId]
      );
    }
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, property_id)
       VALUES ('TRANSACTIONS', 'PURCHASE_ALLOWED_DEPARTMENTS_UPDATED', 'property_purchase_allowed_departments', $1, $2, $3)`,
      [String(propertyId), JSON.stringify({ department_ids: uniqueIds, actor: actorName || 'Staff' }), propertyId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return listPurchaseDepartmentOptions(pool, propertyId);
}

export async function listAllowedActivePurchaseDepartments(
  pool: Pool | PoolClient,
  propertyId: number
): Promise<Array<{ id: number; code: string; name: string }>> {
  const allowCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM property_purchase_allowed_departments WHERE property_id = $1`,
    [propertyId]
  );
  const hasAllowList = Number(allowCount.rows[0].n) > 0;
  const res = await pool.query(
    `SELECT d.id, d.code, d.name
     FROM hr_departments d
     WHERE d.property_id = $1
       AND d.is_active = TRUE
       AND (
         $2::boolean = FALSE
         OR EXISTS (
           SELECT 1 FROM property_purchase_allowed_departments a
           WHERE a.property_id = d.property_id AND a.department_id = d.id
         )
       )
     ORDER BY d.sort_order ASC, d.name ASC, d.id ASC`,
    [propertyId, hasAllowList]
  );
  return res.rows.map((row) => ({
    id: Number(row.id),
    code: String(row.code),
    name: String(row.name),
  }));
}

export async function getPurchaseFormOptions(
  pool: Pool,
  propertyId: number
): Promise<{
  categories: Array<{ id: number; code: string; name: string }>;
  departments: Array<{ id: number; code: string; name: string }>;
  empty_allow_list_means: 'ALL_ACTIVE';
  field_policy: Awaited<ReturnType<typeof getEffectivePurchaseFieldPolicy>>;
}> {
  const categories = await listPurchaseCategories(pool, propertyId, { activeOnly: true });
  const departments = await listAllowedActivePurchaseDepartments(pool, propertyId);
  const field_policy = await getEffectivePurchaseFieldPolicy(pool, propertyId);
  return {
    categories: categories.map((row) => ({ id: row.id, code: row.code, name: row.name })),
    departments,
    empty_allow_list_means: 'ALL_ACTIVE',
    field_policy,
  };
}

function canonicalPurchaseCategory(row: {
  id: unknown;
  code: unknown;
  name: unknown;
}): { id: number; code: string; name: string } {
  return {
    id: Number(row.id),
    code: String(row.code),
    name: String(row.name),
  };
}

export async function resolvePurchaseCategoryBinding(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  dto: { purchase_category_id?: number | string | null; category_code?: string | null; category_name?: string | null }
): Promise<{ id: number; code: string; name: string }> {
  await ensurePropertyPurchaseCategories(poolOrClient, propertyId);

  const requestedId = Number(dto.purchase_category_id);
  if (Number.isInteger(requestedId) && requestedId > 0) {
    const byId = await poolOrClient.query(
      `SELECT id, property_id, code, name, transaction_type, is_active
       FROM transaction_custom_categories
       WHERE id = $1`,
      [requestedId]
    );
    if ((byId.rowCount ?? 0) === 0) {
      throw httpError(400, `Kategori pembelian #${requestedId} tidak valid`, 'VALIDATION_ERROR');
    }
    const row = byId.rows[0];
    if (Number(row.property_id) !== propertyId) {
      throw httpError(403, 'Kategori pembelian bukan milik properti ini', 'CROSS_PROPERTY_CATEGORY');
    }
    if (String(row.transaction_type || '').toUpperCase() !== 'PURCHASE') {
      throw httpError(400, `Kategori '${row.code}' bukan kategori pembelian`, 'VALIDATION_ERROR');
    }
    if (row.is_active === false) {
      throw httpError(400, `Kategori pembelian '${row.code}' tidak aktif`, 'VALIDATION_ERROR');
    }
    return canonicalPurchaseCategory(row);
  }

  const categoryCode = String(dto.category_code || '').trim();
  if (!categoryCode) {
    throw httpError(400, 'Kategori pembelian wajib dipilih', 'VALIDATION_ERROR');
  }

  const byCode = await poolOrClient.query(
    `SELECT id, code, name, transaction_type, is_active
     FROM transaction_custom_categories
     WHERE property_id = $1 AND code = $2`,
    [propertyId, categoryCode]
  );
  if ((byCode.rowCount ?? 0) === 0) {
    throw httpError(400, `Kategori pembelian '${categoryCode}' tidak valid`, 'VALIDATION_ERROR');
  }
  const row = byCode.rows[0];
  if (String(row.transaction_type || '').toUpperCase() !== 'PURCHASE') {
    throw httpError(400, `Kategori '${categoryCode}' bukan kategori pembelian`, 'VALIDATION_ERROR');
  }
  if (row.is_active === false) {
    throw httpError(400, `Kategori pembelian '${categoryCode}' tidak aktif`, 'VALIDATION_ERROR');
  }
  return canonicalPurchaseCategory(row);
}

export async function resolvePurchaseDepartmentBinding(
  poolOrClient: Pool | PoolClient,
  propertyId: number,
  dto: { department_id?: number | string | null; department_code?: string | null }
): Promise<{ id: number | null; code: string; name: string | null }> {
  const requestedId = Number(dto.department_id);
  if (Number.isInteger(requestedId) && requestedId > 0) {
    const found = await poolOrClient.query(
      `SELECT id, property_id, code, name, is_active
       FROM hr_departments
       WHERE id = $1`,
      [requestedId]
    );
    if ((found.rowCount ?? 0) === 0) {
      throw httpError(400, `Departemen #${requestedId} tidak valid`, 'VALIDATION_ERROR');
    }
    const row = found.rows[0];
    if (Number(row.property_id) !== propertyId) {
      throw httpError(403, 'Departemen bukan milik properti ini', 'CROSS_PROPERTY_DEPARTMENT');
    }
    if (row.is_active === false) {
      throw httpError(400, `Departemen '${row.name}' tidak aktif`, 'VALIDATION_ERROR');
    }
    const allowed = await listAllowedActivePurchaseDepartments(poolOrClient, propertyId);
    if (allowed.length > 0 && !allowed.some((dept) => dept.id === Number(row.id))) {
      throw httpError(400, `Departemen '${row.name}' tidak diizinkan untuk alokasi pembelian`, 'VALIDATION_ERROR');
    }
    return {
      id: Number(row.id),
      code: String(row.code),
      name: String(row.name),
    };
  }

  const legacyCode = String(dto.department_code || '').trim() || 'GENERAL';
  return { id: null, code: legacyCode, name: null };
}

export async function departmentHasPurchaseHistory(
  client: Pool | PoolClient,
  departmentId: number
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM transactions WHERE department_id = $1 LIMIT 1`,
    [departmentId]
  );
  return (res.rowCount ?? 0) > 0;
}
