import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isPlatformSuperAdmin, type AuthUserPayload } from '../auth/authService';
import {
  assertIdentityStorageKeyForProperty,
  buildIdentityDocumentApiPath,
  deleteIdentityDocument,
  identityDocumentExists,
  omitIdentityStorageKey,
  type IdentityDocumentPersistResult
} from './identityDocumentStorageService';
import { normalizeNik } from './ktpParser';
import type { ConfirmIdentityInput } from './identityTypes';

export const IDENTITY_UPLOAD_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED'
} as const;

export const IDENTITY_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function httpError(message: string, statusCode: number, code: string): never {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  throw err;
}

export async function resolveAuthoritativeIdentityPropertyId(
  pool: Pool | PoolClient,
  user: AuthUserPayload | undefined,
  requestedPropertyId?: unknown
): Promise<number> {
  if (!user?.id) {
    httpError('Akses ditolak. Silakan login terlebih dahulu untuk mengakses dokumen identitas.', 401, 'UNAUTHORIZED');
  }

  const tokenPropertyId = Number(user.property_id);
  const isSuperAdmin = await isPlatformSuperAdmin(pool, user.id);

  if (isSuperAdmin) {
    const requested = Number(requestedPropertyId);
    if (!Number.isInteger(requested) || requested <= 0) {
      httpError('property_id wajib diisi untuk operasi Super Admin lintas properti.', 400, 'INVALID_PROPERTY_ID');
    }
    const propertyRes = await pool.query('SELECT id FROM properties WHERE id = $1', [requested]);
    if ((propertyRes.rowCount ?? 0) === 0) {
      httpError('Properti tidak ditemukan.', 404, 'PROPERTY_NOT_FOUND');
    }
    return requested;
  }

  if (!Number.isInteger(tokenPropertyId) || tokenPropertyId <= 0) {
    httpError('Properti pengguna tidak valid.', 403, 'PROPERTY_UNRESOLVED');
  }
  return tokenPropertyId;
}

export function publicIdentityUploadReceipt(row: {
  id: string;
  apiPath?: string;
  mime_type?: string | null;
  original_filename?: string | null;
}): { document_upload_id: string; file_path: string } {
  return {
    document_upload_id: String(row.id),
    file_path: row.apiPath || ''
  };
}

export async function createPendingIdentityDocumentUpload(
  pool: Pool | PoolClient,
  params: {
    propertyId: number;
    uploadedByUserId: number;
    persistResult: IdentityDocumentPersistResult;
  }
): Promise<{ documentUploadId: string; apiPath: string }> {
  if (!assertIdentityStorageKeyForProperty(params.persistResult.storageKey, params.propertyId)) {
    await deleteIdentityDocument(params.persistResult.storageKey);
    httpError('Object key dokumen identitas tidak sesuai properti.', 500, 'INVALID_STORAGE_KEY');
  }

  const documentUploadId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + IDENTITY_UPLOAD_TTL_MS);

  try {
    await pool.query(
      `INSERT INTO identity_document_uploads (
         id, property_id, uploaded_by_user_id, storage_key, mime_type, file_hash,
         original_filename, status, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        documentUploadId,
        params.propertyId,
        params.uploadedByUserId,
        params.persistResult.storageKey,
        params.persistResult.mimeType,
        params.persistResult.hash,
        params.persistResult.originalFilename,
        IDENTITY_UPLOAD_STATUS.PENDING,
        expiresAt.toISOString()
      ]
    );
  } catch (err) {
    const deleted = await deleteIdentityDocument(params.persistResult.storageKey);
    if (!deleted) {
      console.error('[IDENTITY UPLOAD] Receipt insert failed and exact-key cleanup failed', {
        propertyId: params.propertyId,
        uploadedByUserId: params.uploadedByUserId,
        storageKey: params.persistResult.storageKey
      });
    }
    throw err;
  }

  return {
    documentUploadId,
    apiPath: params.persistResult.apiPath
  };
}

function normalizeGender(gender?: string | null): 'MALE' | 'FEMALE' | null {
  return gender === 'MALE' || gender === 'FEMALE' ? gender : null;
}

async function loadTargetGuest(
  client: PoolClient,
  propertyId: number,
  guestId: number | null,
  normNik: string | null,
  cleanPhone: string | null,
  normPhone: string | null
): Promise<{ id: number; identity_storage_key: string | null } | null> {
  if (guestId) {
    const guestRes = await client.query(
      `SELECT id, created_property_id, identity_storage_key
       FROM guests
       WHERE id = $1
       FOR UPDATE`,
      [guestId]
    );
    if ((guestRes.rowCount ?? 0) === 0) {
      httpError('Data tamu tidak ditemukan', 404, 'NOT_FOUND');
    }
    const guest = guestRes.rows[0];
    if (Number(guest.created_property_id) !== propertyId) {
      httpError('Tamu tidak berada pada properti yang berwenang.', 403, 'GUEST_PROPERTY_MISMATCH');
    }
    return { id: Number(guest.id), identity_storage_key: guest.identity_storage_key || null };
  }

  if (normNik) {
    const nikRes = await client.query(
      `SELECT id, identity_storage_key
       FROM guests
       WHERE normalized_identity_number = $1
         AND created_property_id = $2
       LIMIT 1
       FOR UPDATE`,
      [normNik, propertyId]
    );
    if ((nikRes.rowCount ?? 0) > 0) {
      return {
        id: Number(nikRes.rows[0].id),
        identity_storage_key: nikRes.rows[0].identity_storage_key || null
      };
    }
  }

  if (cleanPhone) {
    const phoneRes = await client.query(
      `SELECT id, identity_storage_key
       FROM guests
       WHERE created_property_id = $1
         AND (phone = $2 OR (normalized_phone IS NOT NULL AND normalized_phone = $3))
       LIMIT 1
       FOR UPDATE`,
      [propertyId, cleanPhone, normPhone]
    );
    if ((phoneRes.rowCount ?? 0) > 0) {
      return {
        id: Number(phoneRes.rows[0].id),
        identity_storage_key: phoneRes.rows[0].identity_storage_key || null
      };
    }
  }

  return null;
}

export async function confirmVerifiedIdentity(
  pool: Pool,
  input: ConfirmIdentityInput
): Promise<any> {
  const documentUploadId = String(input.document_upload_id || '').trim();
  if (!documentUploadId) {
    httpError('document_upload_id wajib diisi.', 400, 'DOCUMENT_UPLOAD_REQUIRED');
  }

  const propertyId = Number(input.property_id);
  const actorUserId = Number(input.actor_user_id);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    httpError('property_id tidak valid.', 400, 'INVALID_PROPERTY_ID');
  }
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    httpError('Pengguna tidak valid.', 401, 'UNAUTHORIZED');
  }

  const cleanName = (input.name || '').trim();
  if (!cleanName) {
    httpError('Nama pada identitas wajib diisi', 400, 'VALIDATION_ERROR');
  }

  const cleanNik = (input.nik || '').trim();
  const cleanPhone = (input.phone || '').trim();
  const normPhone = cleanPhone ? cleanPhone.replace(/\D/g, '') || null : null;
  const normNik = cleanNik ? normalizeNik(cleanNik) : null;
  const normGender = normalizeGender(input.gender);
  const numConfidence = Number.isFinite(input.confidence) ? Number(input.confidence) : 1.0;
  const identityType = String(input.identity_type || 'KTP');
  const requestedGuestId = input.guest_id ? Number(input.guest_id) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const uploadRes = await client.query(
      `SELECT id, property_id, uploaded_by_user_id, storage_key, mime_type, file_hash,
              original_filename, status, expires_at, confirmed_guest_id
       FROM identity_document_uploads
       WHERE id = $1
       FOR UPDATE`,
      [documentUploadId]
    );
    if ((uploadRes.rowCount ?? 0) === 0) {
      httpError('Dokumen unggahan tidak ditemukan.', 404, 'DOCUMENT_UPLOAD_NOT_FOUND');
    }

    const upload = uploadRes.rows[0];
    if (Number(upload.property_id) !== propertyId) {
      httpError('Dokumen unggahan tidak berada pada properti yang berwenang.', 403, 'DOCUMENT_UPLOAD_PROPERTY_MISMATCH');
    }
    if (!input.is_platform_super_admin && Number(upload.uploaded_by_user_id) !== actorUserId) {
      httpError('Anda tidak berwenang mengonfirmasi unggahan identitas ini.', 403, 'DOCUMENT_UPLOAD_NOT_OWNED');
    }
    if (!assertIdentityStorageKeyForProperty(upload.storage_key, propertyId)) {
      httpError('Object key dokumen identitas tidak sesuai properti.', 409, 'INVALID_STORAGE_KEY');
    }

    const expired = upload.expires_at && new Date(upload.expires_at).getTime() <= Date.now();
    if (upload.status === IDENTITY_UPLOAD_STATUS.EXPIRED || expired) {
      if (upload.status === IDENTITY_UPLOAD_STATUS.PENDING && expired) {
        await client.query(
          `UPDATE identity_document_uploads SET status = $1 WHERE id = $2 AND status = $3`,
          [IDENTITY_UPLOAD_STATUS.EXPIRED, documentUploadId, IDENTITY_UPLOAD_STATUS.PENDING]
        );
      }
      httpError('Unggahan identitas telah kedaluwarsa.', 409, 'DOCUMENT_UPLOAD_EXPIRED');
    }
    if (upload.status === IDENTITY_UPLOAD_STATUS.FAILED) {
      httpError('Unggahan identitas tidak dapat dikonfirmasi.', 409, 'DOCUMENT_UPLOAD_FAILED');
    }

    const targetGuest = await loadTargetGuest(
      client,
      propertyId,
      Number.isInteger(requestedGuestId) && requestedGuestId! > 0 ? requestedGuestId : null,
      normNik,
      cleanPhone || null,
      normPhone
    );

    if (upload.status === IDENTITY_UPLOAD_STATUS.CONFIRMED) {
      const confirmedGuestId = upload.confirmed_guest_id ? Number(upload.confirmed_guest_id) : null;
      if (!confirmedGuestId || !targetGuest || confirmedGuestId !== targetGuest.id) {
        httpError('Unggahan identitas sudah dikonfirmasi untuk tamu lain.', 409, 'DOCUMENT_UPLOAD_ALREADY_CONSUMED');
      }
      const existing = await client.query('SELECT * FROM guests WHERE id = $1', [confirmedGuestId]);
      await client.query('COMMIT');
      return omitIdentityStorageKey(existing.rows[0]);
    }

    if (!(await identityDocumentExists(String(upload.storage_key)))) {
      httpError('File dokumen identitas tidak tersedia di penyimpanan.', 409, 'DOCUMENT_FILE_MISSING');
    }

    const apiPath = buildIdentityDocumentApiPath(String(upload.storage_key));
    const previousStorageKey = targetGuest?.identity_storage_key || null;

    const updateSql = `
      UPDATE guests
      SET full_name = COALESCE(NULLIF($1, ''), full_name),
          normalized_name = LOWER(COALESCE(NULLIF($1, ''), full_name)),
          phone = COALESCE(NULLIF($2, ''), phone),
          normalized_phone = COALESCE($3, normalized_phone),
          identity_number = COALESCE(NULLIF($4, ''), identity_number),
          normalized_identity_number = COALESCE($5, normalized_identity_number),
          identity_type = $6,
          identity_path = $7,
          identity_storage_key = $8,
          identity_mime_type = $9,
          identity_file_hash = $10,
          identity_original_filename = $11,
          identity_uploaded_at = NOW(),
          identity_uploaded_by = $12,
          has_valid_identity = TRUE,
          birth_place = COALESCE(NULLIF($13, ''), birth_place),
          birth_date = COALESCE(NULLIF($14, '')::DATE, birth_date),
          gender = COALESCE($15, gender),
          address = COALESCE(NULLIF($16, ''), address),
          rt_rw = COALESCE(NULLIF($17, ''), rt_rw),
          village_kelurahan = COALESCE(NULLIF($18, ''), village_kelurahan),
          district_kecamatan = COALESCE(NULLIF($19, ''), district_kecamatan),
          religion = COALESCE(NULLIF($20, ''), religion),
          marital_status = COALESCE(NULLIF($21, ''), marital_status),
          occupation = COALESCE(NULLIF($22, ''), occupation),
          citizenship = COALESCE(NULLIF($23, ''), citizenship),
          valid_until = COALESCE(NULLIF($24, ''), valid_until),
          ktp_ocr_confidence = COALESCE($25, ktp_ocr_confidence),
          ktp_ocr_provider = COALESCE(NULLIF($26, ''), ktp_ocr_provider),
          ktp_extracted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $27
        AND created_property_id = $28
      RETURNING *`;

    const updateParams = (guestId: number) => [
      cleanName,
      cleanPhone,
      normPhone,
      cleanNik,
      normNik,
      identityType,
      apiPath,
      upload.storage_key,
      upload.mime_type,
      upload.file_hash,
      upload.original_filename,
      Number(upload.uploaded_by_user_id),
      input.birth_place || null,
      input.birth_date || null,
      normGender,
      input.address || null,
      input.rt_rw || null,
      input.village_kelurahan || null,
      input.district_kecamatan || null,
      input.religion || null,
      input.marital_status || null,
      input.occupation || null,
      input.citizenship || null,
      input.valid_until || null,
      numConfidence,
      input.ocr_provider || null,
      guestId,
      propertyId
    ];

    let guestRow: any;
    if (targetGuest) {
      const updated = await client.query(updateSql, updateParams(targetGuest.id));
      if ((updated.rowCount ?? 0) === 0) {
        httpError('Tamu tidak berada pada properti yang berwenang.', 403, 'GUEST_PROPERTY_MISMATCH');
      }
      guestRow = updated.rows[0];
    } else {
      const inserted = await client.query(
        `INSERT INTO guests (
           full_name, normalized_name, phone, normalized_phone, identity_number, normalized_identity_number,
           identity_type, identity_path, has_valid_identity, birth_place, birth_date, gender, address,
           rt_rw, village_kelurahan, district_kecamatan, religion, marital_status, occupation, citizenship, valid_until,
           ktp_ocr_confidence, ktp_ocr_provider, ktp_extracted_at, created_property_id,
           identity_storage_key, identity_mime_type, identity_file_hash, identity_original_filename,
           identity_uploaded_at, identity_uploaded_by
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, TRUE, $9, NULLIF($10, '')::DATE, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, CURRENT_TIMESTAMP, $23,
           $24, $25, $26, $27,
           NOW(), $28
         )
         RETURNING *`,
        [
          cleanName,
          cleanName.toLowerCase(),
          cleanPhone || null,
          normPhone,
          cleanNik || null,
          normNik,
          identityType,
          apiPath,
          input.birth_place || null,
          input.birth_date || null,
          normGender,
          input.address || null,
          input.rt_rw || null,
          input.village_kelurahan || null,
          input.district_kecamatan || null,
          input.religion || null,
          input.marital_status || null,
          input.occupation || null,
          input.citizenship || null,
          input.valid_until || null,
          numConfidence,
          input.ocr_provider || null,
          propertyId,
          upload.storage_key,
          upload.mime_type,
          upload.file_hash,
          upload.original_filename,
          Number(upload.uploaded_by_user_id)
        ]
      );
      const newGuest = inserted.rows[0];
      const guestCode = `GST-${String(newGuest.id).padStart(5, '0')}`;
      const coded = await client.query(
        `UPDATE guests SET guest_code = $1 WHERE id = $2 AND created_property_id = $3 RETURNING *`,
        [guestCode, newGuest.id, propertyId]
      );
      guestRow = coded.rows[0];
    }

    const consume = await client.query(
      `UPDATE identity_document_uploads
       SET status = $1,
           confirmed_at = NOW(),
           confirmed_guest_id = $2
       WHERE id = $3
         AND status = $4
         AND property_id = $5
       RETURNING id`,
      [
        IDENTITY_UPLOAD_STATUS.CONFIRMED,
        guestRow.id,
        documentUploadId,
        IDENTITY_UPLOAD_STATUS.PENDING,
        propertyId
      ]
    );
    if ((consume.rowCount ?? 0) === 0) {
      httpError('Unggahan identitas sudah dikonfirmasi untuk tamu lain.', 409, 'DOCUMENT_UPLOAD_ALREADY_CONSUMED');
    }

    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'IDENTITY',
        previousStorageKey && previousStorageKey !== upload.storage_key
          ? 'IDENTITY_DOCUMENT_REPLACED'
          : 'IDENTITY_DOCUMENT_STORED',
        'GUEST',
        String(guestRow.id),
        JSON.stringify({
          guest_id: guestRow.id,
          document_upload_id: documentUploadId,
          identity_storage_key: upload.storage_key,
          previous_identity_storage_key: previousStorageKey,
          identity_path: apiPath,
          identity_mime_type: upload.mime_type,
          identity_file_hash: upload.file_hash,
          identity_uploaded_by: Number(upload.uploaded_by_user_id)
        }),
        String(actorUserId),
        propertyId
      ]
    );

    await client.query('COMMIT');
    return omitIdentityStorageKey(guestRow);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
