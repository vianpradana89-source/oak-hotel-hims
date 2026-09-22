import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import multer from 'multer';
import path from 'node:path';
import type { AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import { requireAuth } from '../auth/authMiddleware';
import { requireEffectiveAccess } from '../settings/accessControlMiddleware';
import {
  getPropertyBranding,
  updatePropertyBranding,
  cleanupOldBrandingFiles,
  PropertyBrandingError,
} from './propertyBrandingService';
import {
  saveBrandingFile,
  deleteBrandingFile,
  getBrandingFileBuffer,
  isBrandingStorageKey,
  assertBrandingKeyForProperty,
  ALLOWED_BRANDING_MIME_TYPES,
  MAX_BRANDING_FILE_SIZE,
} from './brandingStorageService';

// --------------------------------------------------------------------------
// Canonical property scope guard - mirrors index.ts:254-260 pattern
// Non-super-admin users may only mutate branding for their own property.
// --------------------------------------------------------------------------
async function assertPropertyScope(req: AuthenticatedRequest, propertyId: number, pool: Pool): Promise<void> {
  // Super Admin check FIRST - Super Admin bypasses property scope entirely.
  // Must run before property_id validation so a Super Admin without property_id
  // still gets authorization instead of 403.
  const isSuperAdmin = req.user?.id ? await isPlatformSuperAdmin(pool, req.user.id) : false;
  if (isSuperAdmin) return;

  const tokenPropertyId = Number((req.user as any)?.property_id);
  if (isNaN(tokenPropertyId) || tokenPropertyId <= 0) {
    throw Object.assign(new Error('Akses ditolak: akun tidak terkait properti yang valid.'), {
      statusCode: 403,
      code: 'PROPERTY_SCOPE_REQUIRED',
    });
  }
  if (tokenPropertyId !== propertyId) {
    throw Object.assign(new Error('Tidak memiliki akses ke properti ini'), {
      statusCode: 403,
      code: 'PROPERTY_SCOPE_REQUIRED',
    });
  }
}

// --------------------------------------------------------------------------
// Multer config - memory storage for logo upload
// --------------------------------------------------------------------------

const brandingMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BRANDING_FILE_SIZE },
  fileFilter: (_req: Request, file: any, cb: any) => {
    const allowed = ALLOWED_BRANDING_MIME_TYPES as readonly string[];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Tipe file tidak didukung: ${file.mimetype}. Hanya JPG, PNG, WebP.`));
  },
});

export function createPropertyBrandingRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/properties/:id/branding
  router.get('/:id/branding', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.params.id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Invalid property ID parameter',
        });
      }

      const branding = await getPropertyBranding(pool, propertyId);
      return res.status(200).json({
        status: 'OK',
        data: branding,
      });
    } catch (err: any) {
      if (err instanceof PropertyBrandingError) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error while fetching property branding',
      });
    }
  });

  // PUT /api/properties/:id/branding
  // Updates display name, colors, and other branding settings.
  // Requires authentication and canonical settings/edit permission.
  const canEditBranding = [requireAuth, requireEffectiveAccess(pool, 'Pengaturan', 'edit')];
  router.put('/:id/branding', ...canEditBranding, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = Number(req.params.id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Invalid property ID parameter',
        });
      }

      // Canonical property authorization
      await assertPropertyScope(req, propertyId, pool);

      const updated = await updatePropertyBranding(pool, propertyId, req.body || {});
      return res.status(200).json({
        status: 'OK',
        message: 'Property branding updated successfully',
        data: updated,
      });
    } catch (err: any) {
      if (err instanceof PropertyBrandingError) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error while updating property branding',
      });
    }
  });

  // POST /api/properties/:id/branding/logo
  // Uploads a logo image and updates both logo_url and compact_logo_url
  // to point to the managed storage key (API-served, not public GCS URL).
  router.post(
    '/:id/branding/logo',
    requireAuth,
    requireEffectiveAccess(pool, 'Pengaturan', 'edit'),
    brandingMemoryUpload.single('logo'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const propertyId = Number(req.params.id);
        if (!Number.isInteger(propertyId) || propertyId <= 0) {
          return res.status(400).json({
            status: 'ERROR',
            code: 'VALIDATION_ERROR',
            message: 'Invalid property ID parameter',
          });
        }

        // Canonical property authorization
        await assertPropertyScope(req, propertyId, pool);

        const file = req.file;
        if (!file) {
          return res.status(400).json({
            status: 'ERROR',
            code: 'FILE_REQUIRED',
            message: 'File logo wajib diunggah.',
          });
        }

        // Verify property existence (404 if not found)
        const propCheck = await pool.query(
          'SELECT id FROM properties WHERE id = $1',
          [propertyId]
        );
        if ((propCheck.rowCount ?? 0) === 0) {
          return res.status(404).json({
            status: 'ERROR',
            code: 'PROPERTY_NOT_FOUND',
            message: `Property with ID ${propertyId} not found`,
          });
        }

        // Capture old logo keys BEFORE upload (for cleanup after success)
        const oldBranding = await getPropertyBranding(pool, propertyId);
        const oldLogoUrl = oldBranding.logo_url;
        const oldCompactLogoUrl = oldBranding.compact_logo_url;

        // Step 1: Save to storage (GCS or local)
        const saved = await saveBrandingFile(propertyId, 'logo', {
          mimetype: file.mimetype,
          size: file.size,
          originalname: file.originalname || 'logo',
          buffer: file.buffer,
        });

        // Step 2: Update DB with the storage key
        // If this fails, we best-effort clean up the newly saved file to avoid orphan
        let updated;
        try {
          updated = await updatePropertyBranding(pool, propertyId, {
            logo_url: saved.storageKey,
            compact_logo_url: saved.storageKey,
          });
        } catch (dbErr: any) {
          // DB update failed - best-effort rollback: delete the newly saved file
          try {
            await deleteBrandingFile(saved.storageKey);
          } catch (cleanupErr: any) {
            console.warn('[BRANDING LOGO] Rollback cleanup failed:', cleanupErr?.message);
          }
          throw dbErr;
        }

        // Step 3: Best-effort cleanup of old managed logo files
        await cleanupOldBrandingFiles(pool, propertyId, oldLogoUrl, oldCompactLogoUrl);

        return res.status(200).json({
          status: 'OK',
          message: 'Logo uploaded successfully',
          data: {
            logo_url: updated.logo_url,
            compact_logo_url: updated.compact_logo_url,
            storage_key: saved.storageKey,
            provider: saved.provider,
          },
        });
      } catch (err: any) {
        const statusCode = err.statusCode || 500;
        const code = err.code || 'INTERNAL_ERROR';
        const message = err.message || 'Failed to upload logo';
        return res.status(statusCode).json({
          status: 'ERROR',
          code,
          message,
        });
      }
    }
  );

  // DELETE /api/properties/:id/branding/logo
  // Removes the managed logo from storage and clears DB fields
  router.delete('/:id/branding/logo', requireAuth, requireEffectiveAccess(pool, 'Pengaturan', 'edit'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = Number(req.params.id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Invalid property ID parameter',
        });
      }

      // Canonical property authorization
      await assertPropertyScope(req, propertyId, pool);

      // Step 1: Fetch current branding to get the stored storage key
      const branding = await getPropertyBranding(pool, propertyId);

      // Step 2: Update DB FIRST (clear fields before deleting storage)
      // If this fails, DB remains unchanged and we don't touch storage
      await updatePropertyBranding(pool, propertyId, {
        logo_url: null,
        compact_logo_url: null,
      });

      // Step 3: Best-effort cleanup of BOTH previous managed keys.
      // Reuse cleanupOldBrandingFiles which handles deduplication via Set
      // and validates property scope for each key.
      await cleanupOldBrandingFiles(pool, propertyId, branding.logo_url, branding.compact_logo_url);

      return res.status(200).json({
        status: 'OK',
        message: 'Logo deleted successfully',
      });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      const code = err.code || 'INTERNAL_ERROR';
      return res.status(statusCode).json({
        status: 'ERROR',
        code,
        message: err.message || 'Failed to delete logo',
      });
    }
  });

  // GET /api/properties/:id/branding/logo/:variant
  // Serves the logo file directly from storage.
  // Public endpoint: no auth required (like /uploads). Property scoping is validated server-side.
  router.get('/:id/branding/logo/:variant', async (req: Request, res: Response) => {
    try {
      const propertyId = Number(req.params.id);
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Invalid property ID parameter',
        });
      }

      const variant = req.params.variant as 'logo' | 'compact' | string;
      if (variant !== 'logo' && variant !== 'compact') {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Invalid variant. Use "logo" or "compact".',
        });
      }

      // Fetch current branding to get the storage key
      const branding = await getPropertyBranding(pool, propertyId);
      const storageKey = variant === 'compact' ? branding.compact_logo_url : branding.logo_url;

      if (!storageKey || !isBrandingStorageKey(storageKey)) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'FILE_NOT_FOUND',
          message: 'Logo not found for this property',
        });
      }

      // Verify property scoping
      if (!assertBrandingKeyForProperty(storageKey, propertyId)) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN',
          message: 'Logo storage key does not belong to this property',
        });
      }

      const buffer = await getBrandingFileBuffer(storageKey);

      // Infer MIME type from storage key extension
      const ext = path.extname(storageKey).toLowerCase();
      const mimeTypeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
      };
      const mimeType = mimeTypeMap[ext] || 'image/png';

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    } catch (err: any) {
      const statusCode = err.statusCode || 404;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: err.code || 'FILE_NOT_FOUND',
        message: err.message || 'Logo file not found',
      });
    }
  });

  return router;
}
