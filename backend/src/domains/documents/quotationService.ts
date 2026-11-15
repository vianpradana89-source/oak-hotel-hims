/**
 * Quotation Domain Service
 * 
 * Mengelola siklus hidup penawaran harga (Quotation):
 * - Pembuatan mandiri SEBELUM ada reservasi (tidak memerlukan BID, ID reservasi, atau tamu operasional).
 * - Penomoran server stabil & unik: QT-${propertyCode}-${YYMMDD}-${seq4}.
 * - Penyimpanan dan revisi terversi (R1, R2, dst.) dengan snapshot JSONB immutable.
 * - Concurrency protection: optimistic locking via version column (menolak overwrite 409).
 * - Soft delete dengan audit trail (deleted_at, deleted_by) dan restore tanpa mengubah nomor.
 * - Invariant: TIDAK PERNAH mengunci inventory kamar, membuat reservasi, atau memutasi ledger finansial.
 */

import { Pool, PoolClient } from 'pg';

export interface QuotationItem {
  description: string;
  quantity: number;
  unit_price: number;
  discount?: number;
  amount?: number;
}

export interface QuotationPricing {
  subtotal: number;
  service_rate?: number;
  service_amount?: number;
  tax_rate?: number;
  tax_amount?: number;
  total_discount?: number;
  total_amount: number;
}

export interface QuotationDraftPayload {
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
  check_in_date?: string | null;
  check_out_date?: string | null;
  items: QuotationItem[];
  pricing?: Partial<QuotationPricing>;
  notes?: string | null;
  terms_conditions?: string | null;
  bank_details?: any;
  change_summary?: string | null;
}

/**
 * Validasi dan kalkulasi finansial penawaran harga secara authoritative di sisi server.
 */
export function calculateQuotationTotals(
  items: QuotationItem[],
  pricing?: Partial<QuotationPricing>
): QuotationPricing {
  let subtotal = 0;
  for (const item of items) {
    const qty = Math.max(0, Number(item.quantity) || 0);
    const price = Math.max(0, Number(item.unit_price) || 0);
    const disc = Math.max(0, Number(item.discount) || 0);
    const lineTotal = Math.max(0, (qty * price) - disc);
    subtotal += lineTotal;
  }

  const serviceRate = Math.max(0, Number(pricing?.service_rate) || 0);
  const taxRate = Math.max(0, Number(pricing?.tax_rate) || 0);
  const totalDiscount = Math.max(0, Number(pricing?.total_discount) || 0);

  const serviceAmount = pricing?.service_amount !== undefined && pricing.service_amount !== null
    ? Math.max(0, Number(pricing.service_amount))
    : Math.round(subtotal * (serviceRate / 100));

  const taxableBase = subtotal + serviceAmount;
  const taxAmount = pricing?.tax_amount !== undefined && pricing.tax_amount !== null
    ? Math.max(0, Number(pricing.tax_amount))
    : Math.round(taxableBase * (taxRate / 100));

  const totalAmount = Math.max(0, Math.round(subtotal + serviceAmount + taxAmount - totalDiscount));

  return {
    subtotal,
    service_rate: serviceRate,
    service_amount: serviceAmount,
    tax_rate: taxRate,
    tax_amount: taxAmount,
    total_discount: totalDiscount,
    total_amount: totalAmount,
  };
}

/**
 * Penomoran unik: QT-${propertyCode}-${YYMMDD}-${seq4}
 * Dilindungi advisory lock per properti per tanggal agar tidak terjadi tabrakan nomor sequence.
 */
async function generateQuotationNumber(client: PoolClient, propertyId: number): Promise<string> {
  const propRes = await client.query('SELECT property_code FROM properties WHERE id = $1', [propertyId]);
  const rawCode = (propRes.rows[0]?.property_code || 'LWG').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const propCode = rawCode.slice(0, 5) || 'LWG';

  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dtf.formatToParts(now);
  const yy = parts.find((p) => p.type === 'year')?.value || '26';
  const mm = parts.find((p) => p.type === 'month')?.value || '11';
  const dd = parts.find((p) => p.type === 'day')?.value || '07';
  const yymmdd = `${yy}${mm}${dd}`;

  const lockKey = `oak_quotation_seq_${propertyId}_${yymmdd}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);

  const prefix = `QT-${propCode}-${yymmdd}-`;
  const seqRes = await client.query(
    `SELECT quotation_number FROM quotations 
     WHERE property_id = $1 AND quotation_number LIKE $2
     ORDER BY quotation_number DESC LIMIT 1`,
    [propertyId, `${prefix}%`]
  );

  let nextSeq = 1;
  if (seqRes.rows.length > 0) {
    const lastNum = seqRes.rows[0].quotation_number;
    const p = lastNum.split('-');
    const lastDigits = parseInt(p[p.length - 1], 10);
    if (!isNaN(lastDigits)) {
      nextSeq = lastDigits + 1;
    }
  }

  const seqStr = String(nextSeq).padStart(4, '0');
  return `${prefix}${seqStr}`;
}

/**
 * Membuat Quotation baru (R1)
 */
export async function createQuotation(
  pool: Pool,
  propertyId: number,
  userId: number,
  payload: QuotationDraftPayload
) {
  if (!payload.customer_name || !payload.customer_name.trim()) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Nama pelanggan (customer_name) wajib diisi' };
  }
  if (!payload.items || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Item penawaran minimal 1 baris' };
  }

  const pricing = calculateQuotationTotals(payload.items, payload.pricing);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const quotationNumber = await generateQuotationNumber(client, propertyId);

    const qInsert = await client.query(
      `INSERT INTO quotations (
        property_id, quotation_number, customer_name, customer_email,
        customer_phone, customer_address, check_in_date, check_out_date,
        status, total_amount, version, notes, terms_conditions,
        created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9, 1, $10, $11, $12, $12)
      RETURNING *`,
      [
        propertyId,
        quotationNumber,
        payload.customer_name.trim(),
        payload.customer_email?.trim() || null,
        payload.customer_phone?.trim() || null,
        payload.customer_address?.trim() || null,
        payload.check_in_date || null,
        payload.check_out_date || null,
        pricing.total_amount,
        payload.notes?.trim() || null,
        payload.terms_conditions?.trim() || null,
        userId,
      ]
    );
    const rawQuotation = qInsert.rows[0];
    const quotation = {
      ...rawQuotation,
      id: Number(rawQuotation.id),
      version: Number(rawQuotation.version),
    };

    const snapshot = {
      quotation_number: quotationNumber,
      revision_number: 1,
      revision_label: 'R1',
      customer: {
        name: payload.customer_name.trim(),
        email: payload.customer_email?.trim() || null,
        phone: payload.customer_phone?.trim() || null,
        address: payload.customer_address?.trim() || null,
      },
      stay_dates: {
        check_in_date: payload.check_in_date || null,
        check_out_date: payload.check_out_date || null,
      },
      items: payload.items,
      pricing,
      notes: payload.notes?.trim() || null,
      terms_conditions: payload.terms_conditions?.trim() || null,
      bank_details: payload.bank_details || null,
      created_at: quotation.created_at,
      created_by: userId,
    };

    const revInsert = await client.query(
      `INSERT INTO quotation_revisions (
        quotation_id, revision_number, revision_label, snapshot, change_summary, created_by
      ) VALUES ($1, 1, 'R1', $2, $3, $4)
      RETURNING *`,
      [
        quotation.id,
        JSON.stringify(snapshot),
        payload.change_summary?.trim() || 'Pembuatan quotation baru (R1)',
        userId,
      ]
    );

    await client.query('COMMIT');

    const rawRev = revInsert.rows[0];
    const revision = {
      ...rawRev,
      id: Number(rawRev.id),
      quotation_id: Number(rawRev.quotation_id),
      revision_number: Number(rawRev.revision_number),
    };
    return {
      status: 'SUCCESS',
      data: {
        ...quotation,
        quotation,
        revision,
        latest_revision: revision,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Menyimpan revisi quotation (R2, R3, dst) dengan optimistic locking.
 */
export async function updateQuotationRevision(
  pool: Pool,
  id: number,
  propertyId: number,
  userId: number,
  expectedVersion: number,
  payload: QuotationDraftPayload
) {
  if (!payload.customer_name || !payload.customer_name.trim()) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Nama pelanggan (customer_name) wajib diisi' };
  }
  if (!payload.items || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Item penawaran minimal 1 baris' };
  }

  const pricing = calculateQuotationTotals(payload.items, payload.pricing);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock quotation row
    const qRes = await client.query(
      'SELECT * FROM quotations WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [id, propertyId]
    );
    if (qRes.rows.length === 0) {
      throw { statusCode: 404, code: 'QUOTATION_NOT_FOUND', message: 'Quotation tidak ditemukan' };
    }
    const current = qRes.rows[0];

    if (current.status === 'DELETED') {
      throw {
        statusCode: 400,
        code: 'QUOTATION_DELETED',
        message: 'Quotation berstatus terhapus. Pulihkan terlebih dahulu sebelum mengubah.',
      };
    }

    // 2. Optimistic Concurrency Check
    if (Number(current.version) !== Number(expectedVersion)) {
      throw {
        statusCode: 409,
        code: 'CONCURRENCY_CONFLICT',
        message: `Quotation telah diperbarui oleh pengguna lain (versi saat ini: ${current.version}, versi Anda: ${expectedVersion}). Silakan muat ulang data terbaru sebelum menyimpan revisi.`,
        current_version: current.version,
      };
    }

    // 3. Determine next revision
    const maxRevRes = await client.query(
      'SELECT COALESCE(MAX(revision_number), 1) as max_rev FROM quotation_revisions WHERE quotation_id = $1',
      [id]
    );
    const nextRevNum = Number(maxRevRes.rows[0].max_rev) + 1;
    const nextRevLabel = `R${nextRevNum}`;
    const nextVersion = Number(current.version) + 1;

    // 4. Update quotations header
    const updateRes = await client.query(
      `UPDATE quotations SET
        customer_name = $1,
        customer_email = $2,
        customer_phone = $3,
        customer_address = $4,
        check_in_date = $5,
        check_out_date = $6,
        total_amount = $7,
        version = $8,
        notes = $9,
        terms_conditions = $10,
        updated_by = $11,
        updated_at = NOW()
      WHERE id = $12 AND property_id = $13
      RETURNING *`,
      [
        payload.customer_name.trim(),
        payload.customer_email?.trim() || null,
        payload.customer_phone?.trim() || null,
        payload.customer_address?.trim() || null,
        payload.check_in_date || null,
        payload.check_out_date || null,
        pricing.total_amount,
        nextVersion,
        payload.notes?.trim() || null,
        payload.terms_conditions?.trim() || null,
        userId,
        id,
        propertyId,
      ]
    );
    const rawUpdated = updateRes.rows[0];
    const updatedQuotation = {
      ...rawUpdated,
      id: Number(rawUpdated.id),
      version: Number(rawUpdated.version),
    };

    // 5. Create snapshot and insert into quotation_revisions
    const snapshot = {
      quotation_number: updatedQuotation.quotation_number,
      revision_number: nextRevNum,
      revision_label: nextRevLabel,
      customer: {
        name: payload.customer_name.trim(),
        email: payload.customer_email?.trim() || null,
        phone: payload.customer_phone?.trim() || null,
        address: payload.customer_address?.trim() || null,
      },
      stay_dates: {
        check_in_date: payload.check_in_date || null,
        check_out_date: payload.check_out_date || null,
      },
      items: payload.items,
      pricing,
      notes: payload.notes?.trim() || null,
      terms_conditions: payload.terms_conditions?.trim() || null,
      bank_details: payload.bank_details || null,
      updated_at: updatedQuotation.updated_at,
      updated_by: userId,
    };

    const revInsert = await client.query(
      `INSERT INTO quotation_revisions (
        quotation_id, revision_number, revision_label, snapshot, change_summary, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        id,
        nextRevNum,
        nextRevLabel,
        JSON.stringify(snapshot),
        payload.change_summary?.trim() || `Revisi quotation (${nextRevLabel})`,
        userId,
      ]
    );

    await client.query('COMMIT');

    const rawRev = revInsert.rows[0];
    const revision = {
      ...rawRev,
      id: Number(rawRev.id),
      quotation_id: Number(rawRev.quotation_id),
      revision_number: Number(rawRev.revision_number),
    };
    return {
      status: 'SUCCESS',
      data: {
        ...updatedQuotation,
        quotation: updatedQuotation,
        revision,
        latest_revision: revision,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Daftar quotation (filter status: ACTIVE | DELETED | ALL, search, pagination).
 */
export async function listQuotations(
  pool: Pool,
  propertyId: number,
  options: {
    status?: 'ACTIVE' | 'DELETED' | 'ALL';
    search?: string;
    page?: number;
    limit?: number;
  }
) {
  const status = options.status || 'ACTIVE';
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = (page - 1) * limit;

  const conditions = ['q.property_id = $1'];
  const values: any[] = [propertyId];
  let paramIdx = 2;

  if (status !== 'ALL') {
    conditions.push(`q.status = $${paramIdx}`);
    values.push(status);
    paramIdx++;
  }

  if (options.search && options.search.trim()) {
    conditions.push(`(q.quotation_number ILIKE $${paramIdx} OR q.customer_name ILIKE $${paramIdx})`);
    values.push(`%${options.search.trim()}%`);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');

  const countRes = await pool.query(
    `SELECT COUNT(*) as total FROM quotations q WHERE ${whereClause}`,
    values
  );
  const total = Number(countRes.rows[0]?.total || 0);

  const query = `
    SELECT 
      q.*,
      COALESCE(u1.full_name, u1.username) as created_by_name,
      COALESCE(u2.full_name, u2.username) as updated_by_name,
      COALESCE(u3.full_name, u3.username) as deleted_by_name,
      (
        SELECT json_build_object(
          'revision_number', qr.revision_number,
          'revision_label', qr.revision_label,
          'created_at', qr.created_at
        )
        FROM quotation_revisions qr
        WHERE qr.quotation_id = q.id
        ORDER BY qr.revision_number DESC
        LIMIT 1
      ) as latest_revision
    FROM quotations q
    LEFT JOIN users u1 ON q.created_by = u1.id
    LEFT JOIN users u2 ON q.updated_by = u2.id
    LEFT JOIN users u3 ON q.deleted_by = u3.id
    WHERE ${whereClause}
    ORDER BY q.updated_at DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
  `;
  values.push(limit, offset);

  const listRes = await pool.query(query, values);

  return {
    status: 'SUCCESS',
    data: listRes.rows.map((row: any) => ({ ...row, id: Number(row.id), version: Number(row.version) })),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  };
}

/**
 * Detail quotation beserta snapshot revisi terakhir dan riwayat revisi.
 */
export async function getQuotationDetail(pool: Pool, id: number, propertyId: number) {
  const qRes = await pool.query(
    `SELECT q.*,
      COALESCE(u1.full_name, u1.username) as created_by_name,
      COALESCE(u2.full_name, u2.username) as updated_by_name,
      COALESCE(u3.full_name, u3.username) as deleted_by_name
    FROM quotations q
    LEFT JOIN users u1 ON q.created_by = u1.id
    LEFT JOIN users u2 ON q.updated_by = u2.id
    LEFT JOIN users u3 ON q.deleted_by = u3.id
    WHERE q.id = $1 AND q.property_id = $2`,
    [id, propertyId]
  );
  if (qRes.rows.length === 0) {
    throw { statusCode: 404, code: 'QUOTATION_NOT_FOUND', message: 'Quotation tidak ditemukan' };
  }
  const rawQuotation = qRes.rows[0];
  const quotation = {
    ...rawQuotation,
    id: Number(rawQuotation.id),
    version: Number(rawQuotation.version),
  };

  const revRes = await pool.query(
    `SELECT qr.id, qr.revision_number, qr.revision_label, qr.snapshot, qr.change_summary, qr.created_at, COALESCE(u.full_name, u.username) as created_by_name
     FROM quotation_revisions qr
     LEFT JOIN users u ON qr.created_by = u.id
     WHERE qr.quotation_id = $1
     ORDER BY qr.revision_number DESC`,
    [id]
  );

  const rawLatest = revRes.rows[0] || null;
  const latestRevision = rawLatest ? { ...rawLatest, id: Number(rawLatest.id), quotation_id: Number(rawLatest.quotation_id), revision_number: Number(rawLatest.revision_number) } : null;

  return {
    status: 'SUCCESS',
    data: {
      ...quotation,
      quotation,
      latest_revision: latestRevision,
      revision: latestRevision,
      revisions: revRes.rows.map((r: any) => ({
        id: Number(r.id),
        revision_number: Number(r.revision_number),
        revision_label: r.revision_label,
        change_summary: r.change_summary,
        created_at: r.created_at,
        created_by_name: r.created_by_name,
      })),
    },
  };
}

/**
 * Soft delete: memindahkan ke sampah (status = 'DELETED').
 */
export async function softDeleteQuotation(pool: Pool, id: number, propertyId: number, userId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const qRes = await client.query(
      'SELECT * FROM quotations WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [id, propertyId]
    );
    if (qRes.rows.length === 0) {
      throw { statusCode: 404, code: 'QUOTATION_NOT_FOUND', message: 'Quotation tidak ditemukan' };
    }
    const current = qRes.rows[0];
    if (current.status === 'DELETED') {
      await client.query('COMMIT');
      return { status: 'SUCCESS', message: 'Quotation sudah berstatus terhapus', data: current };
    }

    const updateRes = await client.query(
      `UPDATE quotations SET
        status = 'DELETED',
        deleted_at = NOW(),
        deleted_by = $1,
        updated_at = NOW()
      WHERE id = $2 AND property_id = $3
      RETURNING *`,
      [userId, id, propertyId]
    );

    await client.query('COMMIT');
    return {
      status: 'SUCCESS',
      message: `Quotation ${current.quotation_number} berhasil dipindahkan ke sampah`,
      data: { ...updateRes.rows[0], id: Number(updateRes.rows[0].id), version: Number(updateRes.rows[0].version) },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Restore: memulihkan quotation dari sampah (status = 'ACTIVE').
 */
export async function restoreQuotation(pool: Pool, id: number, propertyId: number, userId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const qRes = await client.query(
      'SELECT * FROM quotations WHERE id = $1 AND property_id = $2 FOR UPDATE',
      [id, propertyId]
    );
    if (qRes.rows.length === 0) {
      throw { statusCode: 404, code: 'QUOTATION_NOT_FOUND', message: 'Quotation tidak ditemukan' };
    }
    const current = qRes.rows[0];
    if (current.status === 'ACTIVE') {
      await client.query('COMMIT');
      return { status: 'SUCCESS', message: 'Quotation sudah aktif', data: current };
    }

    const updateRes = await client.query(
      `UPDATE quotations SET
        status = 'ACTIVE',
        deleted_at = NULL,
        deleted_by = NULL,
        updated_by = $1,
        updated_at = NOW()
      WHERE id = $2 AND property_id = $3
      RETURNING *`,
      [userId, id, propertyId]
    );

    await client.query('COMMIT');
    return {
      status: 'SUCCESS',
      message: `Quotation ${current.quotation_number} berhasil dipulihkan`,
      data: { ...updateRes.rows[0], id: Number(updateRes.rows[0].id), version: Number(updateRes.rows[0].version) },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
