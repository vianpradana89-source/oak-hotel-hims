import { Pool } from 'pg';
import { OtaSource, CreateOtaSourceInput, UpdateOtaSourceInput } from './otaTypes';

export async function listOtaSources(
  pool: Pool,
  propertyId: number,
  includeArchived: boolean = false
): Promise<OtaSource[]> {
  const query = includeArchived
    ? 'SELECT * FROM ota_sources WHERE property_id = $1 ORDER BY display_order ASC, id ASC'
    : 'SELECT * FROM ota_sources WHERE property_id = $1 AND is_archived = FALSE ORDER BY display_order ASC, id ASC';
  const res = await pool.query(query, [propertyId]);
  return res.rows;
}

export async function getOtaSourceById(
  pool: Pool,
  id: number,
  propertyId?: number
): Promise<OtaSource | null> {
  const query = propertyId && propertyId > 0
    ? 'SELECT * FROM ota_sources WHERE id = $1 AND property_id = $2'
    : 'SELECT * FROM ota_sources WHERE id = $1';
  const params = propertyId && propertyId > 0 ? [id, propertyId] : [id];
  const res = await pool.query(query, params);
  return res.rows[0] || null;
}

export async function createOtaSource(
  pool: Pool,
  input: CreateOtaSourceInput
): Promise<OtaSource> {
  const { property_id, code, name, description = null, commission_rate_percent = null, display_order = 0, is_active = true } = input;
  const cleanCode = code.trim().toUpperCase().replace(/\s+/g, '_');
  const cleanName = name.trim();

  if (!cleanCode) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Kode OTA wajib diisi' };
  }
  if (!cleanName) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Nama OTA wajib diisi' };
  }

  // Check unique code per property
  const existing = await pool.query(
    'SELECT * FROM ota_sources WHERE property_id = $1 AND code = $2',
    [property_id, cleanCode]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    // If archived, unarchive and update
    if (existing.rows[0].is_archived) {
      const unarchiveRes = await pool.query(
        `UPDATE ota_sources
         SET name = $1, description = $2, commission_rate_percent = $3, is_active = $4, is_archived = FALSE, display_order = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $6 RETURNING *`,
        [cleanName, description, commission_rate_percent, is_active, display_order, existing.rows[0].id]
      );
      return unarchiveRes.rows[0];
    }
    throw { statusCode: 400, code: 'DUPLICATE_CODE', message: `Sumber OTA dengan kode '${cleanCode}' sudah ada` };
  }

  const res = await pool.query(
    `INSERT INTO ota_sources (property_id, code, name, description, commission_rate_percent, display_order, is_active, is_archived)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
     RETURNING *`,
    [property_id, cleanCode, cleanName, description, commission_rate_percent, display_order, is_active]
  );
  return res.rows[0];
}

export async function updateOtaSource(
  pool: Pool,
  id: number,
  propertyId: number | undefined,
  input: UpdateOtaSourceInput
): Promise<OtaSource> {
  const current = await getOtaSourceById(pool, id, propertyId);
  if (!current) {
    throw { statusCode: 404, code: 'NOT_FOUND', message: 'Sumber OTA tidak ditemukan' };
  }

  const updates: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    const cleanName = input.name.trim();
    if (!cleanName) {
      throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Nama OTA tidak boleh kosong' };
    }
    updates.push(`name = $${idx++}`);
    values.push(cleanName);
  }

  if (input.description !== undefined) {
    updates.push(`description = $${idx++}`);
    values.push(input.description ? input.description.trim() : null);
  }

  if (input.commission_rate_percent !== undefined) {
    updates.push(`commission_rate_percent = $${idx++}`);
    values.push(input.commission_rate_percent !== null && input.commission_rate_percent !== undefined ? Number(input.commission_rate_percent) : null);
  }

  if (input.is_active !== undefined) {
    updates.push(`is_active = $${idx++}`);
    values.push(Boolean(input.is_active));
  }

  if (input.is_archived !== undefined) {
    updates.push(`is_archived = $${idx++}`);
    values.push(Boolean(input.is_archived));
  }

  if (input.display_order !== undefined) {
    updates.push(`display_order = $${idx++}`);
    values.push(Number(input.display_order));
  }

  if (updates.length === 0) {
    return current;
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const res = await pool.query(
    `UPDATE ota_sources SET ${updates.join(', ')} WHERE id = $${idx++} RETURNING *`,
    values
  );
  return res.rows[0];
}

export async function deleteOrArchiveOtaSource(
  pool: Pool,
  id: number,
  propertyId?: number
): Promise<{ action: 'DELETED' | 'ARCHIVED'; source: OtaSource }> {
  const current = await getOtaSourceById(pool, id, propertyId);
  if (!current) {
    throw { statusCode: 404, code: 'NOT_FOUND', message: 'Sumber OTA tidak ditemukan' };
  }

  // Check if referenced in bookings or reservations
  const refBooking = await pool.query(
    'SELECT 1 FROM bookings WHERE ota_source_id = $1 OR booking_source = $2 LIMIT 1',
    [id, current.code]
  );
  const refResv = await pool.query(
    'SELECT 1 FROM reservations WHERE ota_source_id = $1 OR booking_type = $2 LIMIT 1',
    [id, current.code]
  );

  const isReferenced = (refBooking.rowCount ?? 0) > 0 || (refResv.rowCount ?? 0) > 0;

  if (isReferenced) {
    // Safe archive
    const res = await pool.query(
      `UPDATE ota_sources
       SET is_archived = TRUE, is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return { action: 'ARCHIVED', source: res.rows[0] };
  } else {
    // Hard delete
    await pool.query(
      'DELETE FROM ota_sources WHERE id = $1',
      [id]
    );
    return { action: 'DELETED', source: current };
  }
}
