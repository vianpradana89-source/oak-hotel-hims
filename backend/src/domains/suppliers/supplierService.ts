import { Pool } from 'pg';
import { SupplierRow, CreateSupplierDto, UpdateSupplierDto, SupplierQueryParams } from './supplierTypes';

export async function getSuppliers(pool: Pool, params: SupplierQueryParams): Promise<SupplierRow[]> {
  const conditions: string[] = ['property_id = $1'];
  const values: any[] = [params.property_id];
  let pIdx = 2;

  if (params.is_active !== undefined) {
    conditions.push(`is_active = $${pIdx}`);
    values.push(params.is_active);
    pIdx++;
  }

  if (params.search && params.search.trim()) {
    conditions.push(`(name ILIKE $${pIdx} OR phone ILIKE $${pIdx} OR bank_account ILIKE $${pIdx})`);
    values.push(`%${params.search.trim()}%`);
    pIdx++;
  }

  const query = `
    SELECT id::text, property_id, name, phone, bank_name, bank_account, address, is_active,
           created_at, updated_at
    FROM suppliers
    WHERE ${conditions.join(' AND ')}
    ORDER BY is_active DESC, name ASC
  `;

  const res = await pool.query(query, values);
  return res.rows;
}

export async function getSupplierById(pool: Pool, propertyId: number, id: number | string): Promise<SupplierRow | null> {
  const res = await pool.query(
    `SELECT id::text, property_id, name, phone, bank_name, bank_account, address, is_active,
            created_at, updated_at
     FROM suppliers
     WHERE property_id = $1 AND id = $2`,
    [propertyId, id]
  );
  return res.rows[0] || null;
}

export async function createSupplier(pool: Pool, dto: CreateSupplierDto): Promise<SupplierRow> {
  if (!dto.name || !dto.name.trim()) {
    throw new Error('Nama supplier wajib diisi');
  }

  const trimmedName = dto.name.trim();

  // Search-before-create / Normalized duplicate check
  const dupCheck = await pool.query(
    `SELECT id::text, name FROM suppliers
     WHERE property_id = $1 AND LOWER(TRIM(name)) = LOWER($2)`,
    [dto.property_id, trimmedName]
  );

  if ((dupCheck.rowCount ?? 0) > 0) {
    throw new Error(`Supplier dengan nama "${trimmedName}" sudah terdaftar`);
  }

  const insertQuery = `
    INSERT INTO suppliers (
      property_id, name, phone, bank_name, bank_account, address, is_active, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
    RETURNING id::text, property_id, name, phone, bank_name, bank_account, address, is_active, created_at, updated_at
  `;

  const res = await pool.query(insertQuery, [
    dto.property_id,
    trimmedName,
    dto.phone?.trim() || null,
    dto.bank_name?.trim() || null,
    dto.bank_account?.trim() || null,
    dto.address?.trim() || null
  ]);

  return res.rows[0];
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

  if (dto.name && dto.name.trim()) {
    const trimmedName = dto.name.trim();
    const dupCheck = await pool.query(
      `SELECT id::text FROM suppliers
       WHERE property_id = $1 AND LOWER(TRIM(name)) = LOWER($2) AND id != $3`,
      [propertyId, trimmedName, id]
    );
    if ((dupCheck.rowCount ?? 0) > 0) {
      throw new Error(`Supplier dengan nama "${trimmedName}" sudah digunakan`);
    }
  }

  const name = dto.name !== undefined ? dto.name.trim() : current.name;
  const phone = dto.phone !== undefined ? (dto.phone ? dto.phone.trim() : null) : current.phone;
  const bankName = dto.bank_name !== undefined ? (dto.bank_name ? dto.bank_name.trim() : null) : current.bank_name;
  const bankAccount = dto.bank_account !== undefined ? (dto.bank_account ? dto.bank_account.trim() : null) : current.bank_account;
  const address = dto.address !== undefined ? (dto.address ? dto.address.trim() : null) : current.address;
  const isActive = dto.is_active !== undefined ? dto.is_active : current.is_active;

  const updateQuery = `
    UPDATE suppliers
    SET name = $1, phone = $2, bank_name = $3, bank_account = $4, address = $5, is_active = $6, updated_at = NOW()
    WHERE property_id = $7 AND id = $8
    RETURNING id::text, property_id, name, phone, bank_name, bank_account, address, is_active, created_at, updated_at
  `;

  const res = await pool.query(updateQuery, [
    name,
    phone,
    bankName,
    bankAccount,
    address,
    isActive,
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

  const newStatus = !current.is_active;
  return await updateSupplier(pool, propertyId, id, { is_active: newStatus, actor_name: actorName });
}
