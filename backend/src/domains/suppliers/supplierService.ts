import { Pool, PoolClient } from 'pg';
import {
  SupplierRow,
  CreateSupplierDto,
  UpdateSupplierDto,
  SupplierQueryParams,
  SupplierEntityType,
  SupplierStatus
} from './supplierTypes';

/**
 * Generates a collision-resistant sequential vendor/supplier code per property.
 * e.g. SUP-0001, VND-0001, BTH-0001
 * 
 * Strict Concurrency & Safety Rules:
 * - Fail-closed: Requires PostgreSQL transaction-scoped advisory lock. Any failure to acquire lock immediately aborts.
 * - Database-wide Numeric Max: Evaluates all matching codes in the database for (property_id, prefix)
 *   without arbitrary LIMITs, properly handling custom, old, or >100 records.
 */
export async function generateSupplierCode(
  clientOrPool: Pool | PoolClient,
  propertyId: number,
  entityType?: SupplierEntityType | string
): Promise<string> {
  const normalizedType = String(entityType || 'SUPPLIER').toUpperCase();
  let prefix = 'SUP';
  if (normalizedType === 'VENDOR') prefix = 'VND';
  else if (normalizedType === 'BOTH') prefix = 'BTH';

  // 1. Transaction-scoped advisory lock (Fail-Closed: no catch swallow)
  await clientOrPool.query(
    `SELECT pg_advisory_xact_lock(hashtext('oak_supplier_code_' || $1 || '_' || $2))`,
    [propertyId, prefix]
  );

  // 2. Database-wide maximum numeric suffix calculation for (property_id, prefix)
  const res = await clientOrPool.query(
    `SELECT COALESCE(MAX(
       CASE
         WHEN code ~ ('^' || $2 || '-[0-9]+$')
         THEN SUBSTRING(code FROM ('^' || $2 || '-([0-9]+)$'))::BIGINT
         ELSE 0
       END
     ), 0) AS max_num
     FROM suppliers
     WHERE property_id = $1
       AND code LIKE ($2 || '-%')`,
    [propertyId, prefix]
  );

  const maxNum = Number(res.rows[0]?.max_num ?? 0);
  const nextNum = maxNum + 1;
  const paddedNum = nextNum < 10000 ? String(nextNum).padStart(4, '0') : String(nextNum);
  return `${prefix}-${paddedNum}`;
}

const VALID_ENTITY_TYPES: SupplierEntityType[] = ['SUPPLIER', 'VENDOR', 'BOTH'];
const VALID_STATUSES: SupplierStatus[] = ['ACTIVE', 'INACTIVE', 'BLACKLISTED'];

export async function getSuppliers(pool: Pool, params: SupplierQueryParams): Promise<SupplierRow[]> {
  const conditions: string[] = ['property_id = $1'];
  const values: any[] = [params.property_id];
  let pIdx = 2;

  // Soft delete filter by default
  if (!params.include_deleted) {
    conditions.push('deleted_at IS NULL');
  }

  if (params.entity_type) {
    const et = String(params.entity_type).toUpperCase();
    if (VALID_ENTITY_TYPES.includes(et as SupplierEntityType)) {
      conditions.push(`entity_type = $${pIdx}`);
      values.push(et);
      pIdx++;
    }
  }

  if (params.category && params.category.trim()) {
    conditions.push(`category = $${pIdx}`);
    values.push(params.category.trim());
    pIdx++;
  }

  if (params.status) {
    const st = String(params.status).toUpperCase();
    if (VALID_STATUSES.includes(st as SupplierStatus)) {
      conditions.push(`status = $${pIdx}`);
      values.push(st);
      pIdx++;
    }
  }

  if (params.is_active !== undefined) {
    conditions.push(`is_active = $${pIdx}`);
    values.push(params.is_active);
    pIdx++;
  }

  if (params.search && params.search.trim()) {
    const term = `%${params.search.trim()}%`;
    conditions.push(`(
      name ILIKE $${pIdx} OR 
      legal_name ILIKE $${pIdx} OR 
      code ILIKE $${pIdx} OR 
      phone ILIKE $${pIdx} OR 
      whatsapp ILIKE $${pIdx} OR 
      contact_person ILIKE $${pIdx} OR 
      bank_account ILIKE $${pIdx} OR 
      tax_id ILIKE $${pIdx}
    )`);
    values.push(term);
    pIdx++;
  }

  let limitOffsetClause = '';
  if (params.limit !== undefined && params.limit > 0) {
    limitOffsetClause += ` LIMIT $${pIdx++}`;
    values.push(params.limit);
    if (params.offset !== undefined && params.offset >= 0) {
      limitOffsetClause += ` OFFSET $${pIdx++}`;
      values.push(params.offset);
    }
  }

  const query = `
    SELECT id::text, property_id, code, name, legal_name, entity_type, category, contact_person,
           phone, whatsapp, email, address, city, province, tax_id,
           bank_name, bank_account, bank_holder, payment_terms_days, default_department_code,
           status, notes, is_active, created_by, updated_by, created_at, updated_at, deleted_at
    FROM suppliers
    WHERE ${conditions.join(' AND ')}
    ORDER BY is_active DESC, name ASC
    ${limitOffsetClause}
  `;

  const res = await pool.query(query, values);
  return res.rows;
}

export async function getSupplierById(pool: Pool, propertyId: number, id: number | string): Promise<SupplierRow | null> {
  const res = await pool.query(
    `SELECT id::text, property_id, code, name, legal_name, entity_type, category, contact_person,
            phone, whatsapp, email, address, city, province, tax_id,
            bank_name, bank_account, bank_holder, payment_terms_days, default_department_code,
            status, notes, is_active, created_by, updated_by, created_at, updated_at, deleted_at
     FROM suppliers
     WHERE property_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [propertyId, id]
  );
  return res.rows[0] || null;
}

/**
 * Creates a new supplier / vendor canonical entity.
 * 
 * Transaction Contract:
 * - When passed a Pool: automatically acquires a dedicated PoolClient, begins a transaction (BEGIN),
 *   executes the fail-closed advisory lock, sequential code generation, duplicate check, and INSERT,
 *   then commits (COMMIT) and releases the client. On failure, rolls back (ROLLBACK).
 * - When passed an existing PoolClient: assumes the caller has already opened an active transaction
 *   (e.g., createPurchaseTransaction). Runs lock, code generation, and INSERT within the caller's transaction.
 *   Does NOT issue nested BEGIN/COMMIT.
 */
export async function createSupplier(
  poolOrClient: Pool | PoolClient,
  dto: CreateSupplierDto
): Promise<SupplierRow> {
  if (!dto.name || !dto.name.trim()) {
    throw new Error('Nama supplier wajib diisi');
  }

  const trimmedName = dto.name.trim();

  // Validate entity_type
  let entityType: SupplierEntityType = 'SUPPLIER';
  if (dto.entity_type) {
    const rawType = String(dto.entity_type).toUpperCase() as SupplierEntityType;
    if (!VALID_ENTITY_TYPES.includes(rawType)) {
      throw new Error(`entity_type tidak valid. Pilihan yang diperbolehkan: ${VALID_ENTITY_TYPES.join(', ')}`);
    }
    entityType = rawType;
  }

  // Validate status & is_active synchronization
  let status: SupplierStatus = 'ACTIVE';
  let isActive = true;

  if (dto.status) {
    const rawStatus = String(dto.status).toUpperCase() as SupplierStatus;
    if (!VALID_STATUSES.includes(rawStatus)) {
      throw new Error(`status tidak valid. Pilihan yang diperbolehkan: ${VALID_STATUSES.join(', ')}`);
    }
    status = rawStatus;
    isActive = status === 'ACTIVE';
  } else if (dto.is_active !== undefined) {
    isActive = Boolean(dto.is_active);
    status = isActive ? 'ACTIVE' : 'INACTIVE';
  }

  const isPool = typeof (poolOrClient as Pool).connect === 'function';
  const client: PoolClient | Pool = isPool ? await (poolOrClient as Pool).connect() : poolOrClient;
  const isDirectClient = !isPool;

  try {
    if (!isDirectClient) {
      await (client as PoolClient).query('BEGIN');
    }

    // Duplicate Check on name (property_id + normalized name where deleted_at IS NULL)
    const dupCheck = await client.query(
      `SELECT id::text, name FROM suppliers
       WHERE property_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2)) AND deleted_at IS NULL`,
      [dto.property_id, trimmedName]
    );

    if ((dupCheck.rowCount ?? 0) > 0) {
      throw new Error(`Supplier dengan nama "${trimmedName}" sudah terdaftar`);
    }

    // Code Handling: Auto-generate with concurrency-safe advisory lock or validate manual code
    let code = dto.code ? dto.code.trim().toUpperCase() : null;
    if (!code) {
      code = await generateSupplierCode(client, dto.property_id, entityType);
    } else {
      // Validate uniqueness of manual code within property
      const codeCheck = await client.query(
        `SELECT id::text FROM suppliers
         WHERE property_id = $1 AND UPPER(TRIM(code)) = UPPER(TRIM($2)) AND deleted_at IS NULL`,
        [dto.property_id, code]
      );
      if ((codeCheck.rowCount ?? 0) > 0) {
        throw new Error(`Kode "${code}" sudah terdaftar pada properti ini`);
      }
    }

    const paymentTermsDays = dto.payment_terms_days !== undefined && dto.payment_terms_days !== null
      ? Math.max(0, parseInt(String(dto.payment_terms_days), 10) || 0)
      : 0;

    const insertQuery = `
      INSERT INTO suppliers (
        property_id, code, name, legal_name, entity_type, category, contact_person,
        phone, whatsapp, email, address, city, province, tax_id,
        bank_name, bank_account, bank_holder, payment_terms_days, default_department_code,
        status, notes, is_active, created_by, updated_by, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, NOW(), NOW()
      )
      RETURNING id::text, property_id, code, name, legal_name, entity_type, category, contact_person,
                phone, whatsapp, email, address, city, province, tax_id,
                bank_name, bank_account, bank_holder, payment_terms_days, default_department_code,
                status, notes, is_active, created_by, updated_by, created_at, updated_at, deleted_at
    `;

    const creator = dto.actor_name?.trim() || dto.created_by?.trim() || 'Staff';

    const res = await client.query(insertQuery, [
      dto.property_id,
      code,
      trimmedName,
      dto.legal_name?.trim() || null,
      entityType,
      dto.category?.trim() || null,
      dto.contact_person?.trim() || null,
      dto.phone?.trim() || null,
      dto.whatsapp?.trim() || null,
      dto.email?.trim() || null,
      dto.address?.trim() || null,
      dto.city?.trim() || null,
      dto.province?.trim() || null,
      dto.tax_id?.trim() || null,
      dto.bank_name?.trim() || null,
      dto.bank_account?.trim() || null,
      dto.bank_holder?.trim() || null,
      paymentTermsDays,
      dto.default_department_code?.trim() || null,
      status,
      dto.notes?.trim() || null,
      isActive,
      creator,
      creator
    ]);

    if (!isDirectClient) {
      await (client as PoolClient).query('COMMIT');
    }

    return res.rows[0];
  } catch (err) {
    if (!isDirectClient) {
      try {
        await (client as PoolClient).query('ROLLBACK');
      } catch (_rbErr) {}
    }
    throw err;
  } finally {
    if (!isDirectClient && isPool) {
      (client as PoolClient).release();
    }
  }
}

export async function updateSupplier(
  pool: Pool,
  propertyId: number,
  id: number | string,
  dto: UpdateSupplierDto
): Promise<SupplierRow> {
  const current = await getSupplierById(pool, propertyId, id);
  if (!current) {
    throw new Error(`Supplier dengan ID ${id} tidak ditemukan`);
  }

  let name = current.name;
  if (dto.name && dto.name.trim()) {
    const trimmedName = dto.name.trim();
    const dupCheck = await pool.query(
      `SELECT id::text FROM suppliers
       WHERE property_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2)) AND id != $3 AND deleted_at IS NULL`,
      [propertyId, trimmedName, id]
    );
    if ((dupCheck.rowCount ?? 0) > 0) {
      throw new Error(`Supplier dengan nama "${trimmedName}" sudah digunakan`);
    }
    name = trimmedName;
  }

  let entityType = current.entity_type;
  if (dto.entity_type) {
    const rawType = String(dto.entity_type).toUpperCase() as SupplierEntityType;
    if (!VALID_ENTITY_TYPES.includes(rawType)) {
      throw new Error(`entity_type tidak valid. Pilihan yang diperbolehkan: ${VALID_ENTITY_TYPES.join(', ')}`);
    }
    entityType = rawType;
  }

  let status = current.status;
  let isActive = current.is_active;

  if (dto.status) {
    const rawStatus = String(dto.status).toUpperCase() as SupplierStatus;
    if (!VALID_STATUSES.includes(rawStatus)) {
      throw new Error(`status tidak valid. Pilihan yang diperbolehkan: ${VALID_STATUSES.join(', ')}`);
    }
    status = rawStatus;
    isActive = status === 'ACTIVE';
  } else if (dto.is_active !== undefined) {
    isActive = Boolean(dto.is_active);
    status = isActive ? 'ACTIVE' : (current.status === 'BLACKLISTED' ? 'BLACKLISTED' : 'INACTIVE');
  }

  let code = current.code;
  if (dto.code !== undefined) {
    const rawCode = dto.code ? dto.code.trim().toUpperCase() : null;
    if (rawCode && rawCode !== current.code) {
      const codeCheck = await pool.query(
        `SELECT id::text FROM suppliers
         WHERE property_id = $1 AND UPPER(TRIM(code)) = UPPER(TRIM($2)) AND id != $3 AND deleted_at IS NULL`,
        [propertyId, rawCode, id]
      );
      if ((codeCheck.rowCount ?? 0) > 0) {
        throw new Error(`Kode "${rawCode}" sudah digunakan oleh rekanan lain`);
      }
    }
    code = rawCode;
  }

  const legalName = dto.legal_name !== undefined ? (dto.legal_name ? dto.legal_name.trim() : null) : current.legal_name;
  const category = dto.category !== undefined ? (dto.category ? dto.category.trim() : null) : current.category;
  const contactPerson = dto.contact_person !== undefined ? (dto.contact_person ? dto.contact_person.trim() : null) : current.contact_person;
  const phone = dto.phone !== undefined ? (dto.phone ? dto.phone.trim() : null) : current.phone;
  const whatsapp = dto.whatsapp !== undefined ? (dto.whatsapp ? dto.whatsapp.trim() : null) : current.whatsapp;
  const email = dto.email !== undefined ? (dto.email ? dto.email.trim() : null) : current.email;
  const address = dto.address !== undefined ? (dto.address ? dto.address.trim() : null) : current.address;
  const city = dto.city !== undefined ? (dto.city ? dto.city.trim() : null) : current.city;
  const province = dto.province !== undefined ? (dto.province ? dto.province.trim() : null) : current.province;
  const taxId = dto.tax_id !== undefined ? (dto.tax_id ? dto.tax_id.trim() : null) : current.tax_id;
  const bankName = dto.bank_name !== undefined ? (dto.bank_name ? dto.bank_name.trim() : null) : current.bank_name;
  const bankAccount = dto.bank_account !== undefined ? (dto.bank_account ? dto.bank_account.trim() : null) : current.bank_account;
  const bankHolder = dto.bank_holder !== undefined ? (dto.bank_holder ? dto.bank_holder.trim() : null) : current.bank_holder;
  const paymentTermsDays = dto.payment_terms_days !== undefined && dto.payment_terms_days !== null
    ? Math.max(0, parseInt(String(dto.payment_terms_days), 10) || 0)
    : current.payment_terms_days;
  const defaultDepartmentCode = dto.default_department_code !== undefined
    ? (dto.default_department_code ? dto.default_department_code.trim() : null)
    : current.default_department_code;
  const notes = dto.notes !== undefined ? (dto.notes ? dto.notes.trim() : null) : current.notes;
  const updater = dto.actor_name?.trim() || dto.updated_by?.trim() || 'Staff';

  const updateQuery = `
    UPDATE suppliers
    SET code = $1,
        name = $2,
        legal_name = $3,
        entity_type = $4,
        category = $5,
        contact_person = $6,
        phone = $7,
        whatsapp = $8,
        email = $9,
        address = $10,
        city = $11,
        province = $12,
        tax_id = $13,
        bank_name = $14,
        bank_account = $15,
        bank_holder = $16,
        payment_terms_days = $17,
        default_department_code = $18,
        status = $19,
        notes = $20,
        is_active = $21,
        updated_by = $22,
        updated_at = NOW()
    WHERE property_id = $23 AND id = $24 AND deleted_at IS NULL
    RETURNING id::text, property_id, code, name, legal_name, entity_type, category, contact_person,
              phone, whatsapp, email, address, city, province, tax_id,
              bank_name, bank_account, bank_holder, payment_terms_days, default_department_code,
              status, notes, is_active, created_by, updated_by, created_at, updated_at, deleted_at
  `;

  const res = await pool.query(updateQuery, [
    code,
    name,
    legalName,
    entityType,
    category,
    contactPerson,
    phone,
    whatsapp,
    email,
    address,
    city,
    province,
    taxId,
    bankName,
    bankAccount,
    bankHolder,
    paymentTermsDays,
    defaultDepartmentCode,
    status,
    notes,
    isActive,
    updater,
    propertyId,
    id
  ]);

  return res.rows[0];
}

export async function toggleSupplier(
  pool: Pool,
  propertyId: number,
  id: number | string,
  actorName?: string
): Promise<SupplierRow> {
  const current = await getSupplierById(pool, propertyId, id);
  if (!current) {
    throw new Error(`Supplier dengan ID ${id} tidak ditemukan`);
  }

  const newStatus: SupplierStatus = current.is_active ? 'INACTIVE' : 'ACTIVE';
  return await updateSupplier(pool, propertyId, id, {
    status: newStatus,
    is_active: newStatus === 'ACTIVE',
    actor_name: actorName
  });
}

/**
 * Logical soft delete for supplier.
 * Guard: Rejects deletion if referenced by any transactions.
 */
export async function deleteSupplier(
  pool: Pool,
  propertyId: number,
  id: number | string,
  actorName?: string
): Promise<{ success: boolean; message: string }> {
  const current = await getSupplierById(pool, propertyId, id);
  if (!current) {
    throw new Error(`Supplier dengan ID ${id} tidak ditemukan`);
  }

  // Guard against physical/logical deletion if transaction history exists
  const txCheck = await pool.query(
    `SELECT COUNT(*)::int AS count FROM transactions WHERE property_id = $1 AND supplier_id = $2`,
    [propertyId, id]
  );
  const txCount = Number(txCheck.rows[0]?.count || 0);
  if (txCount > 0) {
    throw new Error(
      `Rekanan tidak dapat dihapus karena sudah memiliki ${txCount} riwayat transaksi. Silakan ubah status menjadi NONAKTIF atau BLACKLIST.`
    );
  }

  const updater = actorName?.trim() || 'Staff';
  await pool.query(
    `UPDATE suppliers
     SET deleted_at = NOW(),
         is_active = FALSE,
         status = 'INACTIVE',
         updated_by = $1,
         updated_at = NOW()
     WHERE property_id = $2 AND id = $3`,
    [updater, propertyId, id]
  );

  return { success: true, message: `Rekanan "${current.name}" berhasil dihapus` };
}

