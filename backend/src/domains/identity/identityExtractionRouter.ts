import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  extractIdentityFromDocument,
  confirmVerifiedIdentity
} from './identityExtractionService';

export function createIdentityExtractionRouter(pool: Pool, uploadDir: string): Router {
  const router = Router();

  // Storage directory: prefer backend/storage/identity/ for private storage
  const privateStorageDir = path.resolve(uploadDir, 'identity');
  if (!fs.existsSync(privateStorageDir)) {
    fs.mkdirSync(privateStorageDir, { recursive: true });
  }

  const maxFileMb = Number(process.env.IDENTITY_OCR_MAX_FILE_MB) || 10;
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req: any, _file: any, cb: (error: Error | null, destination: string) => void) => {
        cb(null, privateStorageDir);
      },
      filename: (_req: any, file: any, cb: (error: Error | null, filename: string) => void) => {
        const ext = path.extname(file.originalname || '.jpg');
        const safeName = `ktp-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, safeName);
      }
    }),
    limits: { fileSize: maxFileMb * 1024 * 1024 },
    fileFilter: (_req: any, file: any, cb: any) => {
      const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
      if (allowed.includes(file.mimetype)) return cb(null, true);
      cb(new Error('Format file tidak didukung. Harap unggah file JPG, PNG, atau PDF.'));
    }
  });

  // POST /api/identity/extract and /api/identity/extract-ktp
  const handleExtract = (req: Request, res: Response) => {
    upload.single('ktp')(req as any, res as any, async (err: any) => {
      if (err) {
        return res.status(400).json({
          success: false,
          status: 'FAILED',
          error: 'UPLOAD_ERROR',
          message: err.message || 'Gagal mengunggah file KTP',
          warnings: ['UPLOAD_ERROR']
        });
      }

      try {
        if (!req.file) {
          return res.status(400).json({
            success: false,
            status: 'FAILED',
            error: 'FILE_REQUIRED',
            message: 'File KTP wajib diunggah',
            warnings: ['FILE_REQUIRED']
          });
        }

        const storedRelativePath = `/api/identity/document/${req.file.filename}`;
        const localFilePath = req.file.path;
        const guestName = req.body.guest_name ? String(req.body.guest_name) : null;
        const guestId = req.body.guest_id ? Number(req.body.guest_id) : null;
        const propertyId = req.body.property_id ? Number(req.body.property_id) : 1;

        const result = await extractIdentityFromDocument(
          pool,
          localFilePath,
          storedRelativePath,
          {
            property_id: propertyId,
            guest_name: guestName,
            guest_id: guestId
          }
        );

        return res.json(result);
      } catch (err: any) {
        console.error('[IdentityExtractionRouter] Extraction error:', err.message);
        return res.status(500).json({
          success: false,
          status: 'FAILED',
          error: 'EXTRACTION_ERROR',
          message: 'Gagal memproses ekstraksi identitas',
          warnings: ['SERVER_ERROR']
        });
      }
    });
  };

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
  router.get('/document/:filename', (req: Request, res: Response) => {
    const filename = req.params.filename;
    // Prevent directory traversal
    if (!filename || /[^a-zA-Z0-9_\-\.]/.test(filename) || filename.includes('..')) {
      return res.status(400).json({ success: false, error: 'INVALID_FILENAME', message: 'Nama file tidak valid' });
    }

    const targetPath = path.resolve(privateStorageDir, filename);
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Dokumen tidak ditemukan' });
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.pdf': 'application/pdf'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(targetPath).pipe(res);
  });

  return router;
}
