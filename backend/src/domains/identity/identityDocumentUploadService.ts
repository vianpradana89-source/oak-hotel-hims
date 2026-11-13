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

function normalizeComparableName(value?: string | null): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

interface TargetGuestCandidate {
  id: number;
  identity_storage_key: string | null;
  full_name?: string | null;
  normalized_identity_number?: string | null;
  has_valid_identity?: boolean;
  total_res_count?: number;
  matched_by?: 'ID' | 'NIK' | 'PHONE';
}

async function loadTargetGuest(
   client: PoolClient,
   propertyId: number,
   guestId: number | null,
   normNik: string | null,
   cleanPhone: string | null,
   normPhone: string | null,
   skipPhoneFallback: boolean = false
 ): Promise<TargetGuestCandidate | null> {
   if (guestId) {
     const guestRes = await client.query(
       `SELECT id, created_property_id, identity_storage_key, full_name, normalized_identity_number, has_valid_identity,
               (SELECT COUNT(DISTINCT rg.reservation_id)::int FROM reservation_guests rg WHERE rg.guest_id = guests.id) AS total_res_count
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
     return {
       id: Number(guest.id),
       identity_storage_key: guest.identity_storage_key || null,
       full_name: guest.full_name,
       normalized_identity_number: guest.normalized_identity_number,
       has_valid_identity: guest.has_valid_identity,
       total_res_count: guest.total_res_count !== undefined ? Number(guest.total_res_count) : undefined,
       matched_by: 'ID'
     };
   }

   if (normNik) {
     const nikRes = await client.query(
       `SELECT id, identity_storage_key, full_name, normalized_identity_number, has_valid_identity,
               (SELECT COUNT(DISTINCT rg.reservation_id)::int FROM reservation_guests rg WHERE rg.guest_id = guests.id) AS total_res_count
        FROM guests
        WHERE normalized_identity_number = $1
          AND created_property_id = $2
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE`,
       [normNik, propertyId]
     );
     if ((nikRes.rowCount ?? 0) > 0) {
       const row = nikRes.rows[0];
       return {
         id: Number(row.id),
         identity_storage_key: row.identity_storage_key || null,
         full_name: row.full_name,
         normalized_identity_number: row.normalized_identity_number,
         has_valid_identity: row.has_valid_identity,
         total_res_count: row.total_res_count !== undefined ? Number(row.total_res_count) : undefined,
         matched_by: 'NIK'
       };
     }
   }

   // In reservation contexts, skip phone fallback to prevent
   // overwriting existing Guest A's CRM data when KTP B has the same phone.
   if (cleanPhone && !skipPhoneFallback) {
     const phoneRes = await client.query(
       `SELECT id, identity_storage_key, full_name, normalized_identity_number, has_valid_identity,
               (SELECT COUNT(DISTINCT rg.reservation_id)::int FROM reservation_guests rg WHERE rg.guest_id = guests.id) AS total_res_count
        FROM guests
        WHERE created_property_id = $1
          AND (phone = $2 OR (normalized_phone IS NOT NULL AND normalized_phone = $3))
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE`,
       [propertyId, cleanPhone, normPhone]
     );
     if ((phoneRes.rowCount ?? 0) > 0) {
       const row = phoneRes.rows[0];
       return {
         id: Number(row.id),
         identity_storage_key: row.identity_storage_key || null,
         full_name: row.full_name,
         normalized_identity_number: row.normalized_identity_number,
         has_valid_identity: row.has_valid_identity,
         total_res_count: row.total_res_count !== undefined ? Number(row.total_res_count) : undefined,
         matched_by: 'PHONE'
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

  const rawReservationId = input.reservation_id;
  const reservationId =
    rawReservationId !== undefined && rawReservationId !== null && String(rawReservationId).trim() !== ''
      ? Number(rawReservationId)
      : null;
  if (reservationId !== null && (!Number.isInteger(reservationId) || reservationId <= 0)) {
    httpError('reservation_id tidak valid.', 400, 'INVALID_RESERVATION_ID');
  }

  const rawExpectedPrimaryGuestId = input.expected_primary_guest_id;
  const expectedPrimaryGuestId =
    rawExpectedPrimaryGuestId !== undefined &&
    rawExpectedPrimaryGuestId !== null &&
    String(rawExpectedPrimaryGuestId).trim() !== ''
      ? Number(rawExpectedPrimaryGuestId)
      : null;
  if (
    expectedPrimaryGuestId !== null &&
    (!Number.isInteger(expectedPrimaryGuestId) || expectedPrimaryGuestId <= 0)
  ) {
    httpError('expected_primary_guest_id tidak valid.', 400, 'INVALID_EXPECTED_PRIMARY_GUEST_ID');
  }

  const cleanNik = (input.nik || '').trim();
  const cleanPhone = (input.phone || '').trim();
  const normPhone = cleanPhone ? cleanPhone.replace(/\D/g, '') || null : null;
  const normNik = cleanNik ? normalizeNik(cleanNik) : null;
  const normGender = normalizeGender(input.gender);
  const numConfidence = Number.isFinite(input.confidence) ? Number(input.confidence) : 1.0;
  const identityType = String(input.identity_type || 'KTP');
  const requestedGuestId = input.guest_id ? Number(input.guest_id) : null;
  const context = input.context || 'CRM_EDIT';
  const isReservationContext =
    context === 'CHECKIN_IDENTITY_SCAN' ||
    context === 'RESERVATION_IDENTITY_ASSIGN' ||
    context === 'RESERVATION_EDIT_IDENTITY' ||
    reservationId !== null;
  const skipPhoneFallback = isReservationContext;
  const relinkReservationPrimaryGuest =
    input.relink_reservation_primary_guest !== undefined
      ? Boolean(input.relink_reservation_primary_guest)
      : reservationId !== null && context !== 'RESERVATION_EDIT_IDENTITY';

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

    let lockedReservation: any = null;
    let currentPrimaryRel: { id: number; guest_id: number } | null = null;
    let currentPrimaryGuestId: number | null = null;

    if (reservationId !== null) {
      const resLock = await client.query(
        `SELECT r.id, r.guest_name, r.guest_phone, r.identity_number, r.has_valid_identity, r.ktp_path,
                b.property_id
         FROM reservations r
         JOIN bookings b ON b.id = r.booking_id
         WHERE r.id = $1
         FOR UPDATE OF r`,
        [reservationId]
      );
      if ((resLock.rowCount ?? 0) === 0) {
        httpError('Reservasi tidak ditemukan.', 404, 'RESERVATION_NOT_FOUND');
      }
      lockedReservation = resLock.rows[0];
      if (Number(lockedReservation.property_id) !== propertyId) {
        httpError('Reservasi tidak berada pada properti yang berwenang.', 403, 'RESERVATION_PROPERTY_MISMATCH');
      }

      const pgRelRes = await client.query(
        `SELECT id, guest_id
         FROM reservation_guests
         WHERE reservation_id = $1 AND role = 'PRIMARY_GUEST'
         FOR UPDATE`,
        [reservationId]
      );
      if ((pgRelRes.rowCount ?? 0) > 0) {
        currentPrimaryRel = {
          id: Number(pgRelRes.rows[0].id),
          guest_id: Number(pgRelRes.rows[0].guest_id)
        };
        currentPrimaryGuestId = currentPrimaryRel.guest_id;
      }

      if (expectedPrimaryGuestId !== null && upload.status !== IDENTITY_UPLOAD_STATUS.CONFIRMED) {
        if (currentPrimaryGuestId === null || currentPrimaryGuestId !== expectedPrimaryGuestId) {
          httpError(
            'PRIMARY_GUEST has changed since the identity was confirmed. Please refresh and retry.',
            409,
            'PRIMARY_GUEST_CHANGED'
          );
        }
      }
    }

    if (upload.status === IDENTITY_UPLOAD_STATUS.CONFIRMED) {
      const confirmedGuestId = upload.confirmed_guest_id ? Number(upload.confirmed_guest_id) : null;
      if (
        !confirmedGuestId ||
        (requestedGuestId !== null && requestedGuestId !== confirmedGuestId)
      ) {
        httpError(
          'Unggahan identitas sudah dikonfirmasi untuk tamu lain. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }

      // Read operation binding AFTER the FOR UPDATE lock on identity_document_uploads
      // is acquired so concurrent retries observe the latest committed audit record.
      const auditBindRes = await client.query(
        `SELECT new_value
         FROM audit_logs
         WHERE module = 'IDENTITY'
           AND entity = 'GUEST'
           AND record_id = $1
           AND property_id = $2
           AND (new_value::jsonb->>'document_upload_id') = $3
         ORDER BY audit_id DESC
         LIMIT 1`,
        [String(confirmedGuestId), propertyId, documentUploadId]
      );

      let auditPayload: any = null;
      const rawAuditValue = auditBindRes.rows[0]?.new_value;
      if (rawAuditValue) {
        try {
          auditPayload =
            typeof rawAuditValue === 'string' ? JSON.parse(rawAuditValue) : rawAuditValue;
        } catch {
          auditPayload = null;
        }
      }

      const binding =
        auditPayload &&
        typeof auditPayload === 'object' &&
        auditPayload.operation_binding &&
        typeof auditPayload.operation_binding === 'object'
          ? auditPayload.operation_binding
          : null;
      const currentRelink = Boolean(reservationId !== null && relinkReservationPrimaryGuest);
      const hasVerifiableBinding = Boolean(
        binding &&
          binding.document_upload_id === documentUploadId &&
          Number(binding.property_id) === propertyId &&
          Number(binding.confirmed_guest_id) === confirmedGuestId &&
          'reservation_id' in binding &&
          'relink_reservation_primary_guest' in binding &&
          typeof binding.context === 'string' &&
          typeof binding.normalized_name === 'string' &&
          'normalized_nik' in binding
      );

      if (!hasVerifiableBinding) {
        httpError(
          'Asal operasi unggahan identitas tidak dapat diverifikasi. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }

      if (!input.is_platform_super_admin && Number(binding.actor_user_id) !== actorUserId) {
        httpError('Anda tidak berwenang mengonfirmasi unggahan identitas ini.', 403, 'DOCUMENT_UPLOAD_NOT_OWNED');
      }

      const origReservationId = binding.reservation_id ?? null;
      const origContext = String(binding.context);
      const origRelink = Boolean(binding.relink_reservation_primary_guest);
      const origRequestedGuestId = binding.requested_guest_id ?? null;
      const origNormName = String(binding.normalized_name);
      const origNormNik = binding.normalized_nik ?? null;

      if (reservationId !== origReservationId) {
        httpError(
          'Unggahan identitas sudah dikonfirmasi untuk reservasi atau konteks lain. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }
      if (context !== origContext || currentRelink !== origRelink) {
        httpError(
          'Unggahan identitas sudah dikonfirmasi dengan mode operasi berbeda. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }
      if (requestedGuestId !== origRequestedGuestId) {
        httpError(
          'Unggahan identitas sudah dikonfirmasi untuk target tamu berbeda. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }
      if (normalizeComparableName(cleanName) !== origNormName) {
        httpError(
          'Unggahan identitas sudah dikonfirmasi untuk nama tamu berbeda. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }
      if ((normNik || null) !== origNormNik) {
        httpError(
          'Unggahan identitas sudah dikonfirmasi untuk NIK berbeda. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }

      if (reservationId !== null) {
        if (currentRelink) {
          if (currentPrimaryGuestId !== confirmedGuestId) {
            httpError(
              'PRIMARY_GUEST has changed since the identity was confirmed. Please refresh and retry.',
              409,
              'PRIMARY_GUEST_CHANGED'
            );
          }
          if (
            expectedPrimaryGuestId !== null &&
            expectedPrimaryGuestId !== confirmedGuestId &&
            expectedPrimaryGuestId !== (binding.expected_primary_guest_id ?? null)
          ) {
            httpError(
              'PRIMARY_GUEST has changed since the identity was confirmed. Please refresh and retry.',
              409,
              'PRIMARY_GUEST_CHANGED'
            );
          }
        } else {
          if (expectedPrimaryGuestId !== null && currentPrimaryGuestId !== expectedPrimaryGuestId) {
            httpError(
              'PRIMARY_GUEST has changed since the identity was confirmed. Please refresh and retry.',
              409,
              'PRIMARY_GUEST_CHANGED'
            );
          }
          if (
            binding.expected_primary_guest_id != null &&
            currentPrimaryGuestId !== Number(binding.expected_primary_guest_id)
          ) {
            httpError(
              'PRIMARY_GUEST has changed since the identity was confirmed. Please refresh and retry.',
              409,
              'PRIMARY_GUEST_CHANGED'
            );
          }
        }
      }

      const existing = await client.query('SELECT * FROM guests WHERE id = $1', [confirmedGuestId]);
      const existingRow = existing.rows[0];
      if (!existingRow) {
        httpError(
          'Unggahan identitas sudah dikonfirmasi untuk tamu lain. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }
      if (
        normNik &&
        existingRow.normalized_identity_number &&
        existingRow.normalized_identity_number !== normNik
      ) {
        httpError(
          'Unggahan identitas sudah dikonfirmasi untuk tamu lain. Silakan unggah ulang dokumen identitas.',
          409,
          'DOCUMENT_UPLOAD_ALREADY_CONSUMED'
        );
      }
      await client.query('COMMIT');
      return omitIdentityStorageKey(existingRow);
    }

    let targetGuest = await loadTargetGuest(
       client,
       propertyId,
       Number.isInteger(requestedGuestId) && requestedGuestId! > 0 ? requestedGuestId : null,
       normNik,
       cleanPhone || null,
       normPhone,
       skipPhoneFallback
     );

     // SAFETY: Validate target guest across ALL contexts (reservation AND legacy CRM_EDIT / null reservation_id)
     // when confirming a PENDING upload so shared/group/verified profiles can never be overwritten by another person.
     if (targetGuest && requestedGuestId) {
       let guestNormNik = targetGuest.normalized_identity_number;
       if (normNik && guestNormNik === undefined) {
         const guestNikRes = await client.query(
           `SELECT normalized_identity_number FROM guests WHERE id = $1`,
           [targetGuest.id]
         );
         guestNormNik = guestNikRes.rows[0]?.normalized_identity_number;
       }
       if (normNik && guestNormNik && guestNormNik !== normNik) {
         httpError('NIK pada KTP tidak cocok dengan tamu yang dipilih. Gunakan opsi lain.', 409, 'NIK_MISMATCH');
       }
       if (!normNik && targetGuest.has_valid_identity && guestNormNik) {
         httpError(
           'Profil tamu yang dipilih sudah terverifikasi dengan NIK; tidak dapat ditimpa tanpa NIK yang cocok.',
           409,
           'NIK_MISMATCH'
         );
       }

       if (typeof targetGuest.full_name === 'string' && targetGuest.full_name.trim() !== '') {
         if (normalizeComparableName(targetGuest.full_name) !== normalizeComparableName(cleanName)) {
           httpError(
             'Nama pada identitas tidak cocok dengan profil tamu yang dipilih. Jangan menimpa profil tamu lama.',
             409,
             'GUEST_IDENTITY_TARGET_MISMATCH'
           );
         }

         let isSharedGuest = false;
         if (reservationId !== null) {
           const sharedCheck = await client.query(
             `SELECT COUNT(*)::int AS other_count
              FROM reservation_guests
              WHERE guest_id = $1
                AND ($2::int IS NULL OR reservation_id <> $2)`,
             [targetGuest.id, reservationId]
           );
           isSharedGuest =
             Number(sharedCheck.rows[0]?.other_count || 0) > 0 ||
             Number(targetGuest.total_res_count || 0) > 1;
         } else if (targetGuest.total_res_count !== undefined) {
           isSharedGuest = Number(targetGuest.total_res_count) > 1;
         } else {
           const sharedCheck = await client.query(
             `SELECT COUNT(*)::int AS other_count
              FROM reservation_guests
              WHERE guest_id = $1
                AND ($2::int IS NULL OR reservation_id <> $2)`,
             [targetGuest.id, null]
           );
           isSharedGuest = Number(sharedCheck.rows[0]?.other_count || 0) > 1;
         }

         const hasStrongNikMatch = Boolean(
           normNik &&
           guestNormNik &&
           guestNormNik === normNik
         );
         if (isSharedGuest && !hasStrongNikMatch) {
           httpError(
             'Profil tamu yang dipilih digunakan pada reservasi lain dan tidak memiliki kecocokan NIK yang kuat. Buat atau pilih profil tamu khusus untuk reservasi ini.',
             409,
             'SHARED_PRIMARY_GUEST_CONFLICT'
           );
         }
       }
     } else if (
       targetGuest &&
       !requestedGuestId &&
       targetGuest.matched_by === 'NIK' &&
       typeof targetGuest.full_name === 'string' &&
       targetGuest.full_name.trim() !== ''
     ) {
       if (normalizeComparableName(targetGuest.full_name) !== normalizeComparableName(cleanName)) {
         httpError(
           'NIK pada KTP sudah terdaftar pada profil tamu lain dengan nama berbeda.',
           409,
           'NIK_MISMATCH'
         );
       }
     } else if (
       targetGuest &&
       !requestedGuestId &&
       targetGuest.matched_by === 'PHONE'
     ) {
       // Phone number alone is NEVER proof of identity for a different person,
       // an already-verified guest with a different/missing NIK, or a shared group profile.
       if (
         typeof targetGuest.full_name === 'string' &&
         targetGuest.full_name.trim() !== '' &&
         normalizeComparableName(targetGuest.full_name) !== normalizeComparableName(cleanName)
       ) {
         httpError(
           'Nomor telepon cocok dengan profil tamu lain dengan nama berbeda. Jangan menimpa profil tamu lama.',
           409,
           'GUEST_IDENTITY_TARGET_MISMATCH'
         );
       }
       if (
         (targetGuest.normalized_identity_number &&
           normNik &&
           targetGuest.normalized_identity_number !== normNik) ||
         (targetGuest.has_valid_identity &&
           (!normNik || targetGuest.normalized_identity_number !== normNik))
       ) {
         httpError(
           'Nomor telepon cocok dengan profil tamu yang sudah memiliki identitas berbeda.',
           409,
           'NIK_MISMATCH'
         );
       }
       const phoneSharedCount =
         targetGuest.total_res_count !== undefined ? Number(targetGuest.total_res_count) : 0;
       const hasStrongPhoneNikMatch = Boolean(
         normNik &&
         targetGuest.normalized_identity_number &&
         targetGuest.normalized_identity_number === normNik
       );
       if (phoneSharedCount > 1 && !hasStrongPhoneNikMatch) {
         httpError(
           'Nomor telepon terhubung ke profil tamu bersama pada beberapa reservasi. Buat atau pilih profil tamu khusus.',
           409,
           'SHARED_PRIMARY_GUEST_CONFLICT'
         );
       }
     } else if (
       skipPhoneFallback &&
       !targetGuest &&
       !requestedGuestId &&
       reservationId !== null &&
       currentPrimaryGuestId !== null
     ) {
       // Only reuse the reservation's current PRIMARY_GUEST in-place if it is an
       // isolated, unverified placeholder for the exact same person on this single reservation.
       const candidateRes = await client.query(
         `SELECT g.id, g.created_property_id, g.full_name, g.identity_storage_key,
                 g.normalized_identity_number, g.has_valid_identity,
                 (SELECT COUNT(*)::int FROM reservation_guests rg
                  WHERE rg.guest_id = g.id AND rg.reservation_id <> $2) AS other_res_count
          FROM guests g
          WHERE g.id = $1
          FOR UPDATE`,
         [currentPrimaryGuestId, reservationId]
       );
       if ((candidateRes.rowCount ?? 0) > 0) {
         const cand = candidateRes.rows[0];
         const isSameProperty = Number(cand.created_property_id) === propertyId;
         const isIsolatedToThisReservation = Number(cand.other_res_count || 0) === 0;
         const isSamePersonName =
           Boolean(cand.full_name) &&
           normalizeComparableName(cand.full_name) === normalizeComparableName(cleanName);
         const isUnverifiedPlaceholder =
           !cand.has_valid_identity &&
           !cand.identity_storage_key &&
           (!cand.normalized_identity_number || cand.normalized_identity_number === normNik);
         if (isSameProperty && isIsolatedToThisReservation && isSamePersonName && isUnverifiedPlaceholder) {
           targetGuest = {
             id: Number(cand.id),
             identity_storage_key: cand.identity_storage_key || null,
             full_name: cand.full_name,
             normalized_identity_number: cand.normalized_identity_number || null,
             has_valid_identity: Boolean(cand.has_valid_identity),
             matched_by: 'ID'
           };
         }
       }
     }

    if (!(await identityDocumentExists(String(upload.storage_key)))) {
      httpError('File dokumen identitas tidak tersedia di penyimpanan.', 409, 'DOCUMENT_FILE_MISSING');
    }

    const apiPath = buildIdentityDocumentApiPath(String(upload.storage_key));
    const previousStorageKey = targetGuest?.identity_storage_key || null;
    // Validate ktp_regency_id when provided
    const rawKtpRegencyId = input.ktp_regency_id;
    const ktpRegencyId = rawKtpRegencyId != null ? Number(rawKtpRegencyId) : null;

    if (ktpRegencyId != null && (!Number.isInteger(ktpRegencyId) || ktpRegencyId <= 0)) {
      httpError('ID kabupaten/kota KTP tidak valid.', 400, 'INVALID_KTP_REGENCY_ID');
    }

    if (ktpRegencyId != null) {
      const regencyCheck = await client.query(
        'SELECT 1 FROM regencies WHERE id = $1 LIMIT 1',
        [ktpRegencyId]
      );

      if ((regencyCheck.rowCount ?? 0) === 0) {
        httpError('Kota/Kabupaten KTP tidak ditemukan.', 400, 'INVALID_KTP_REGENCY_ID');
      }
    }

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
          ktp_regency_id = COALESCE($27, ktp_regency_id),
          ktp_extracted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $28
        AND created_property_id = $29
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
      ktpRegencyId,
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
           identity_uploaded_at, identity_uploaded_by, ktp_regency_id
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, TRUE, $9, NULLIF($10, '')::DATE, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, CURRENT_TIMESTAMP, $23,
           $24, $25, $26, $27,
           NOW(), $28, $29
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
          Number(upload.uploaded_by_user_id),
          ktpRegencyId
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

    if (reservationId !== null && relinkReservationPrimaryGuest) {
      let relationRecordId: number;
      if (currentPrimaryRel) {
        relationRecordId = currentPrimaryRel.id;
        await client.query(
          `UPDATE reservation_guests
           SET guest_id = $1,
               is_staying = TRUE,
               identity_verified = TRUE,
               relation_source = 'CHECKIN_IDENTITY_CONFIRMATION',
               updated_at = NOW()
           WHERE id = $2`,
          [guestRow.id, currentPrimaryRel.id]
        );
      } else {
        const insertedRel = await client.query(
          `INSERT INTO reservation_guests (
             reservation_id, guest_id, role, relationship, is_staying,
             identity_verified, relation_source, created_at, updated_at
           )
           VALUES ($1, $2, 'PRIMARY_GUEST', 'STAYING', TRUE, TRUE, 'CHECKIN_IDENTITY_CONFIRMATION', NOW(), NOW())
           RETURNING id`,
          [reservationId, guestRow.id]
        );
        relationRecordId = Number(insertedRel.rows[0].id);
      }

      await client.query(
        `UPDATE reservations
         SET guest_name = $1,
             guest_phone = COALESCE(NULLIF($2, ''), guest_phone),
             identity_number = $3,
             has_valid_identity = $4,
             ktp_path = $5
         WHERE id = $6`,
        [
          guestRow.full_name,
          guestRow.phone || cleanPhone || null,
          guestRow.identity_number || null,
          Boolean(guestRow.has_valid_identity),
          guestRow.identity_path || apiPath,
          reservationId
        ]
      );

      await client.query(
        `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          'GUEST_CRM',
          currentPrimaryGuestId !== Number(guestRow.id)
            ? 'PRIMARY_GUEST_REPLACE'
            : 'RESERVATION_GUEST_UPDATE',
          'RESERVATION_GUEST',
          String(relationRecordId),
          JSON.stringify({
            reservation_id: reservationId,
            previous_guest_id: currentPrimaryGuestId,
            new_guest_id: Number(guestRow.id),
            role: 'PRIMARY_GUEST',
            relation_source: 'CHECKIN_IDENTITY_CONFIRMATION',
            before: lockedReservation
              ? {
                  guest_id: currentPrimaryGuestId,
                  guest_name: lockedReservation.guest_name,
                  guest_phone: lockedReservation.guest_phone,
                  ktp_path: lockedReservation.ktp_path,
                  has_valid_identity: Boolean(lockedReservation.has_valid_identity)
                }
              : null,
            after: {
              guest_id: Number(guestRow.id),
              guest_name: guestRow.full_name,
              guest_phone: guestRow.phone || lockedReservation?.guest_phone || null,
              ktp_path: guestRow.identity_path || apiPath,
              has_valid_identity: Boolean(guestRow.has_valid_identity)
            }
          }),
          String(actorUserId),
          propertyId,
          String(actorUserId)
        ]
      );
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
          reservation_id: reservationId,
          context,
          document_upload_id: documentUploadId,
          identity_storage_key: upload.storage_key,
          previous_identity_storage_key: previousStorageKey,
          identity_path: apiPath,
          identity_mime_type: upload.mime_type,
          identity_file_hash: upload.file_hash,
          identity_uploaded_by: Number(upload.uploaded_by_user_id),
          operation_binding: {
            document_upload_id: documentUploadId,
            property_id: propertyId,
            actor_user_id: actorUserId,
            confirmed_guest_id: Number(guestRow.id),
            requested_guest_id: requestedGuestId,
            reservation_id: reservationId,
            expected_primary_guest_id: expectedPrimaryGuestId,
            relink_reservation_primary_guest: Boolean(
              reservationId !== null && relinkReservationPrimaryGuest
            ),
            context,
            normalized_name: normalizeComparableName(cleanName),
            normalized_nik: normNik || null
          },
          before: targetGuest
            ? {
                guest_id: targetGuest.id,
                full_name: targetGuest.full_name ?? null,
                identity_storage_key: previousStorageKey
              }
            : null,
          after: {
            guest_id: guestRow.id,
            full_name: guestRow.full_name,
            has_valid_identity: Boolean(guestRow.has_valid_identity),
            identity_path: apiPath
          }
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
