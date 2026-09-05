import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  extractIdentityFromDocument,
  confirmVerifiedIdentity
} from './identityExtractionService';
import { isPlatformSuperAdmin, verifyToken, type AuthUserPayload } from '../auth/authService';

export function createIdentityExtractionRouter(pool: Pool, uploadDir: string): Router {
  const router = Router();

  // Storage directory: prefer backend/storage/identity/ for private storage
  const privateStorageDir = path.resolve(uploadDir, 'identity');
  if (!fs.existsSync(privateStorageDir)) {
    fs.mkdirSync(privateStorageDir, { recursive: true });
  }

  const maxFileMb = 15;

  // Multer instance supporting any image field
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req: any, _file: any, cb: (error: Error | null, destination: string) => void) => {
        cb(null, privateStorageDir);
      },
      filename: (_req: any, file: any, cb: (error: Error | null, filename: string) => void) => {
        const ext = path.extname(file.originalname || '.jpg') || '.jpg';
        const safeName = `ktp-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, safeName);
      }
    }),
    limits: { fileSize: maxFileMb * 1024 * 1024 },
    fileFilter: (_req: any, file: any, cb: any) => {
      const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
      if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/')) return cb(null, true);
      cb(new Error('Format file tidak didukung. Harap unggah file JPG, PNG, atau WebP.'));
    }
  });

  // Handler for /scan-id, /scan, /extract, /extract-ktp
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

      try {
        let localFilePath: string | null = null;
        let storedRelativePath: string | null = null;

        const files = (req as any).files as Express.Multer.File[];
        if (files && files.length > 0) {
          const mainFile = files[0];
          localFilePath = mainFile.path;
          storedRelativePath = `/api/identity/document/${mainFile.filename}`;
        } else if (req.body.image_base64 || req.body.base64_image || req.body.image) {
          // Handle base64 payload
          const rawBase64 = String(req.body.image_base64 || req.body.base64_image || req.body.image);
          const matches = rawBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          const base64Data = matches ? matches[2] : rawBase64;
          const ext = matches && matches[1].includes('png') ? '.png' : '.jpg';
          const filename = `ktp-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
          localFilePath = path.resolve(privateStorageDir, filename);
          fs.writeFileSync(localFilePath, Buffer.from(base64Data, 'base64'));
          storedRelativePath = `/api/identity/document/${filename}`;
        }

        if (!localFilePath || !fs.existsSync(localFilePath)) {
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
        const propertyId = req.body.property_id ? Number(req.body.property_id) : 1;

        const result = await extractIdentityFromDocument(
          pool,
          localFilePath,
          storedRelativePath || localFilePath,
          {
            property_id: propertyId,
            guest_name: guestName,
            guest_id: guestId
          }
        );

        // Enrich response with standard Indonesian aliases for seamless frontend consumption
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
          candidate: enrichedData
        });
      } catch (err: any) {
        console.error('[IdentityExtractionRouter] Extraction error:', err.message);
        return res.status(500).json({
          success: false,
          status: 'FAILED',
          error: 'EXTRACTION_ERROR',
          message: 'Gagal memproses ekstraksi identitas: ' + (err.message || 'Unknown error'),
          warnings: ['SERVER_ERROR']
        });
      }
    });
  };

  router.post('/scan-id', handleExtract);
  router.post('/scan', handleExtract);
  router.post('/extract', handleExtract);
  router.post('/extract-ktp', handleExtract);

  // POST /api/identity/confirm
  router.post('/confirm', async (req: Request, res: Response) => {
    try {
      const {
        guest_id,
        property_id = 1,
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
        identity_path,
        identity_type = 'KTP',
        confidence,
        ocr_provider
      } = req.body;

      if (!name || !String(name).trim()) {
        return res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Nama pada identitas wajib diisi'
        });
      }

      const guest = await confirmVerifiedIdentity(pool, {
        guest_id: guest_id ? Number(guest_id) : null,
        property_id: Number(property_id),
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
        identity_path: identity_path ? String(identity_path) : null,
        identity_type: String(identity_type || 'KTP'),
        confidence: confidence ? Number(confidence) : 1.0,
        ocr_provider: ocr_provider ? String(ocr_provider) : undefined
      });

      return res.json({
        success: true,
        data: guest,
        message: 'Identitas tamu berhasil diverifikasi dan disimpan ke CRM'
      });
    } catch (err: any) {
      console.error('[IdentityExtractionRouter] Confirm error:', err.message);
      return res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Gagal menyimpan identitas tamu'
      });
    }
  });

  // GET /api/identity/document/:filename (Protected Document Serving)
  router.get('/document/:filename', async (req: Request, res: Response) => {
    const filename = req.params.filename;
    // 1. Prevent directory traversal and validate filename format
    if (!filename || /[^a-zA-Z0-9_\-\.]/.test(filename) || filename.includes('..')) {
      return res.status(400).json({ success: false, error: 'INVALID_FILENAME', message: 'Nama file tidak valid' });
    }

    // 2. Authentication: Strictly require Authorization header (No JWT in query params)
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

    // 3. Fail-Closed Document Ownership & Property Isolation
    const isSuperAdmin = await isPlatformSuperAdmin(pool, user.id);

    let docPropId: number | null = null;
    try {
      const docRes = await pool.query(
        `SELECT property_id FROM (
           SELECT r.property_id FROM reservations r WHERE r.ktp_path LIKE '%' || $1
           UNION
           SELECT g.property_id FROM guests g WHERE g.identity_path LIKE '%' || $1
         ) doc_props LIMIT 1`,
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
    } catch (err: any) {
      console.error('[IdentityRouter] Document property isolation query error:', err.message);
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: 'Gagal memverifikasi kepemilikan dokumen.'
      });
    }

    // Enforce property isolation: Only Super Admin may cross properties; GM, FO, and staff are strictly property-scoped
    if (!isSuperAdmin) {
      if (!user.property_id || !docPropId || Number(user.property_id) !== docPropId) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: 'Akses ditolak. Anda tidak memiliki izin untuk melihat dokumen dari properti lain.'
        });
      }
    }

    // 4. File existence and stream response
    const targetPath = path.resolve(privateStorageDir, filename);
    let resolvedFilePath = targetPath;
    if (!fs.existsSync(resolvedFilePath)) {
      const fallbackPath = path.resolve(uploadDir, filename);
      if (fs.existsSync(fallbackPath)) {
        resolvedFilePath = fallbackPath;
      } else {
        return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'File dokumen fisik tidak ditemukan' });
      }
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    fs.createReadStream(resolvedFilePath).pipe(res);
  });

  return router;
}
