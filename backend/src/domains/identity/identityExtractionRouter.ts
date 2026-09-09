import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { extractIdentityFromDocument } from './identityExtractionService';
import { requireAuth, type AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin, verifyToken, type AuthUserPayload } from '../auth/authService';
import {
  IDENTITY_DOCUMENT_MISSING_CODE,
  IDENTITY_DOCUMENT_MISSING_MESSAGE,
  MAX_IDENTITY_DOCUMENT_BYTES,
  assertIdentityStorageKeyForProperty,
  buildIdentityStorageKeyFromBasename,
  cleanupIdentityTempFile,
  decodeIdentityBase64Payload,
  identityDocumentExists,
  isIdentityDocumentStorageKey,
  persistIdentityDocument,
  readIdentityDocument,
  writeIdentityOcrTempFile
} from './identityDocumentStorageService';
import {
  confirmVerifiedIdentity,
  createPendingIdentityDocumentUpload,
  resolveAuthoritativeIdentityPropertyId
} from './identityDocumentUploadService';

export function createIdentityExtractionRouter(pool: Pool, uploadDir: string): Router {
  const router = Router();
  router.use(requireAuth);

  const privateStorageDir = path.resolve(uploadDir, 'identity');
  if (!fs.existsSync(privateStorageDir)) {
    fs.mkdirSync(privateStorageDir, { recursive: true });
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IDENTITY_DOCUMENT_BYTES },
    fileFilter: (_req: any, file: any, cb: any) => {
      const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
      if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/')) return cb(null, true);
      cb(new Error('Format file tidak didukung. Harap unggah file JPG, PNG, atau WebP.'));
    }
  });

  const handleExtract = (req: Request, res: Response) => {
    upload.any()(req as any, res as any, async (err: any) => {
      if (err) {
        return res.status(400).json({
          success: false,
          status: 'FAILED',
          error: 'UPLOAD_ERROR',
          message: err.message || 'Gagal mengunggah file gambar identitas',
          warnings: ['UPLOAD_ERROR']
        });
      }

      let ocrTempPath: string | null = null;
      try {
        const user = (req as any).user as AuthUserPayload | undefined;
        const propertyId = await resolveAuthoritativeIdentityPropertyId(pool, user, req.body?.property_id);
        if (!user?.id) {
          return res.status(401).json({
            success: false,
            status: 'FAILED',
            error: 'UNAUTHORIZED',
            message: 'Akses ditolak. Silakan login terlebih dahulu untuk mengakses dokumen identitas.'
          });
        }

        let buffer: Buffer | null = null;
        let mimeType = 'image/jpeg';
        let originalFilename: string | null = null;

        const files = (req as any).files as Express.Multer.File[];
        if (files && files.length > 0) {
          const mainFile = files[0];
          buffer = mainFile.buffer;
          mimeType = mainFile.mimetype || mimeType;
          originalFilename = mainFile.originalname || null;
        } else if (req.body.image_base64 || req.body.base64_image || req.body.image) {
          const decoded = decodeIdentityBase64Payload(
            String(req.body.image_base64 || req.body.base64_image || req.body.image)
          );
          buffer = decoded.buffer;
          mimeType = decoded.mimeType || mimeType;
          originalFilename = mimeType.includes('png') ? 'identity.png' : 'identity.jpg';
        }

        if (!buffer || buffer.length === 0) {
          return res.status(400).json({
            success: false,
            status: 'FAILED',
            error: 'FILE_REQUIRED',
            message: 'File atau gambar identitas KTP/Paspor wajib diunggah',
            warnings: ['FILE_REQUIRED']
          });
        }

        const guestName = req.body.guest_name ? String(req.body.guest_name) : null;
        const guestId = req.body.guest_id ? Number(req.body.guest_id) : null;

        ocrTempPath = await writeIdentityOcrTempFile(buffer, mimeType);
        const result = await extractIdentityFromDocument(
          pool,
          ocrTempPath,
          '',
          {
            property_id: propertyId,
            guest_name: guestName,
            guest_id: guestId
          }
        );

        const persisted = await persistIdentityDocument({
          propertyId,
          buffer,
          mimeType,
          originalFilename,
          size: buffer.length
        });

        const receipt = await createPendingIdentityDocumentUpload(pool, {
          propertyId,
          uploadedByUserId: Number(user.id),
          persistResult: persisted
        });

        const c = result.data;
        const enrichedData = {
          ...c,
          nik: c.identity_number,
          nama: c.full_name,
          tempat_lahir: c.birth_place,
          tanggal_lahir: c.birth_date,
          jenis_kelamin: c.gender === 'MALE' ? 'LAKI-LAKI' : (c.gender === 'FEMALE' ? 'PEREMPUAN' : null),
          alamat: c.address,
          rt_rw: c.rt_rw,
          kelurahan: c.village_kelurahan,
          kecamatan: c.district_kecamatan,
          agama: c.religion,
          status_perkawinan: c.marital_status,
          pekerjaan: c.occupation,
          kewarganegaraan: c.citizenship,
          berlaku_hingga: c.valid_until
        };

        return res.json({
          ...result,
          success: true,
          data: enrichedData,
          ktpData: enrichedData,
          candidate: enrichedData,
          file_path: receipt.apiPath,
          document_upload_id: receipt.documentUploadId
        });
      } catch (extractErr: any) {
        console.error('[IdentityExtractionRouter] Extraction error:', extractErr.message);
        return res.status(extractErr.statusCode || 500).json({
          success: false,
          status: 'FAILED',
          error: extractErr.code || 'EXTRACTION_ERROR',
          message: 'Gagal memproses ekstraksi identitas: ' + (extractErr.message || 'Unknown error'),
          warnings: ['SERVER_ERROR']
        });
      } finally {
        await cleanupIdentityTempFile(ocrTempPath);
      }
    });
  };

  router.post('/scan-id', handleExtract);
  router.post('/scan', handleExtract);
  router.post('/extract', handleExtract);
  router.post('/extract-ktp', handleExtract);

  router.post('/confirm', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const propertyId = await resolveAuthoritativeIdentityPropertyId(pool, user, req.body?.property_id);
      const isSuperAdmin = await isPlatformSuperAdmin(pool, user?.id);
      const {
         guest_id,
         name,
         phone,
         nik,
         birth_place,
         birth_date,
         gender,
         address,
         rt_rw,
         village_kelurahan,
         district_kecamatan,
         religion,
         marital_status,
         occupation,
         citizenship,
         valid_until,
         identity_type = 'KTP',
         confidence,
         ocr_provider,
         document_upload_id,
         context
       } = req.body;

      if (!name || !String(name).trim()) {
        return res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Nama pada identitas wajib diisi'
        });
      }

       const guest = await confirmVerifiedIdentity(pool, {
         document_upload_id: document_upload_id ? String(document_upload_id) : '',
         actor_user_id: Number(user!.id),
         is_platform_super_admin: isSuperAdmin,
         guest_id: guest_id ? Number(guest_id) : null,
         property_id: propertyId,
         name: String(name),
         phone: phone ? String(phone) : null,
         nik: String(nik || ''),
         birth_place: birth_place ? String(birth_place) : null,
         birth_date: birth_date ? String(birth_date) : null,
         gender: gender ? String(gender) : null,
         address: address ? String(address) : null,
         rt_rw: rt_rw ? String(rt_rw) : null,
         village_kelurahan: village_kelurahan ? String(village_kelurahan) : null,
         district_kecamatan: district_kecamatan ? String(district_kecamatan) : null,
         religion: religion ? String(religion) : null,
         marital_status: marital_status ? String(marital_status) : null,
         occupation: occupation ? String(occupation) : null,
         citizenship: citizenship ? String(citizenship) : null,
         valid_until: valid_until ? String(valid_until) : null,
         identity_type: String(identity_type || 'KTP'),
         confidence: confidence ? Number(confidence) : 1.0,
         ocr_provider: ocr_provider ? String(ocr_provider) : undefined,
         context: context || 'CRM_EDIT'
       });

      return res.json({
        success: true,
        data: guest,
        message: 'Identitas tamu berhasil diverifikasi dan disimpan ke CRM'
      });
    } catch (confirmErr: any) {
      console.error('[IdentityExtractionRouter] Confirm error:', confirmErr.message);
      return res.status(confirmErr.statusCode || 500).json({
        success: false,
        error: confirmErr.code || 'INTERNAL_ERROR',
        message: confirmErr.message || 'Gagal menyimpan identitas tamu'
      });
    }
  });

  router.get('/document/:filename', async (req: Request, res: Response) => {
    const filename = req.params.filename;
    if (!filename || /[^a-zA-Z0-9_\-\.]/.test(filename) || filename.includes('..')) {
      return res.status(400).json({ success: false, error: 'INVALID_FILENAME', message: 'Nama file tidak valid' });
    }

    const authHeader = req.headers.authorization;
    let token: string | null = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        status: 'ERROR',
        code: 'UNAUTHORIZED',
        message: 'Akses ditolak. Silakan login terlebih dahulu untuk mengakses dokumen identitas.'
      });
    }

    let user: AuthUserPayload;
    try {
      user = verifyToken(token);
    } catch {
      return res.status(401).json({
        status: 'ERROR',
        code: 'INVALID_TOKEN',
        message: 'Sesi login telah kedaluwarsa atau token tidak valid. Silakan login kembali.'
      });
    }

    const isSuperAdmin = await isPlatformSuperAdmin(pool, user.id);

    let docPropId: number | null = null;
    let storageKey: string | null = null;
    try {
      const docRes = await pool.query(
        `SELECT property_id, storage_key FROM (
           SELECT COALESCE(b.property_id, rm.property_id) AS property_id,
                  NULL::text AS storage_key
           FROM reservations r
           LEFT JOIN bookings b ON b.id = r.booking_id
           LEFT JOIN rooms rm ON rm.id = r.room_id
           WHERE r.ktp_path LIKE '%' || $1
           UNION ALL
           SELECT g.created_property_id AS property_id,
                  g.identity_storage_key AS storage_key
           FROM guests g
           WHERE g.identity_path LIKE '%' || $1
              OR g.identity_storage_key LIKE '%' || $1
         ) doc_props
         WHERE property_id IS NOT NULL
         ORDER BY CASE WHEN storage_key IS NOT NULL THEN 0 ELSE 1 END
         LIMIT 1`,
        [filename]
      );

      if (docRes.rows.length === 0) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'DOCUMENT_NOT_FOUND',
          message: 'Dokumen tidak terdaftar atau tidak ditemukan pada sistem.'
        });
      }

      docPropId = docRes.rows[0].property_id ? Number(docRes.rows[0].property_id) : null;
      storageKey = docRes.rows[0].storage_key ? String(docRes.rows[0].storage_key) : null;
    } catch (queryErr: any) {
      console.error('[IdentityRouter] Document property isolation query error:', queryErr.message);
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: 'Gagal memverifikasi kepemilikan dokumen.'
      });
    }

    if (!isSuperAdmin) {
      if (!user.property_id || !docPropId || Number(user.property_id) !== docPropId) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: 'Akses ditolak. Anda tidak memiliki izin untuk melihat dokumen dari properti lain.'
        });
      }
    }

    const sendPrivateStream = (buffer: Buffer, mimeType: string) => {
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.end(buffer);
    };

    if (storageKey && isIdentityDocumentStorageKey(storageKey)) {
      if (!docPropId || !assertIdentityStorageKeyForProperty(storageKey, docPropId)) {
        return res.status(404).json({
          status: 'ERROR',
          code: IDENTITY_DOCUMENT_MISSING_CODE,
          message: IDENTITY_DOCUMENT_MISSING_MESSAGE
        });
      }
      const stored = await readIdentityDocument(storageKey);
      if (stored) {
        sendPrivateStream(stored.buffer, stored.mimeType);
        return;
      }
      return res.status(404).json({
        status: 'ERROR',
        code: IDENTITY_DOCUMENT_MISSING_CODE,
        message: IDENTITY_DOCUMENT_MISSING_MESSAGE
      });
    }

    if (docPropId) {
      const reconstructed = buildIdentityStorageKeyFromBasename(docPropId, filename);
      if (reconstructed && assertIdentityStorageKeyForProperty(reconstructed, docPropId) && await identityDocumentExists(reconstructed)) {
        const stored = await readIdentityDocument(reconstructed);
        if (stored) {
          sendPrivateStream(stored.buffer, stored.mimeType);
          return;
        }
      }
    }

    const targetPath = path.resolve(privateStorageDir, filename);
    let resolvedFilePath: string | null = fs.existsSync(targetPath) ? targetPath : null;
    if (!resolvedFilePath) {
      const fallbackPath = path.resolve(uploadDir, filename);
      if (fs.existsSync(fallbackPath)) {
        resolvedFilePath = fallbackPath;
      }
    }

    if (resolvedFilePath) {
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf'
      };
      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      fs.createReadStream(resolvedFilePath).pipe(res);
      return;
    }

    return res.status(404).json({
      status: 'ERROR',
      code: IDENTITY_DOCUMENT_MISSING_CODE,
      message: IDENTITY_DOCUMENT_MISSING_MESSAGE
    });
  });

  return router;
}
