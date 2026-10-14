import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireEffectiveAccess } from '../settings/accessControlMiddleware';
import { hasAnyEffectivePermission } from '../settings/accessControlService';
import { MAX_QRIS_IMAGE_BYTES, savePropertyQrisImage, readPropertyQrisImage, deletePropertyQrisImage, qrisImageMime } from './qrisImageStorage';
import { Pool } from 'pg';
import { requireAuth, AuthenticatedRequest } from '../auth/authMiddleware';
import { isPlatformSuperAdmin } from '../auth/authService';
import {
  getPropertyPaymentInstructions,
  updatePropertyPaymentInstructions,
  PropertyPaymentInstructionsError,
  replacePropertyQrisImage,
  getPosPaymentConfig,
} from './propertyPaymentInstructionsService';

/**
 * Creates router for Property Payment Instructions.
 * Mountable at both:
 * 1. /api/settings/property/payment-instructions
 * 2. /api/properties/:id/payment-instructions
 */
export function createPropertyPaymentInstructionsRouter(pool: Pool): Router {
  const router = Router({ mergeParams: true });

  // Resolve target property ID from query param, route param, or request body
  const resolveTargetPropertyId = (req: AuthenticatedRequest): number | null => {
    const raw = req.params.propertyId || req.params.id || req.query.property_id || req.body?.property_id;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const num = Number(raw);
    return Number.isInteger(num) && num > 0 ? num : null;
  };

  // Property scope security verification
  const assertPropertyAccess = async (req: AuthenticatedRequest, targetPropertyId: number): Promise<boolean> => {
    const user = req.user;
    if (!user) return false;

    // Platform Super Admin has access across all properties
    if (await isPlatformSuperAdmin(pool, user.id)) {
      return true;
    }

    // Scoped property users can only view/edit their own property
    const userPropertyId = Number(user.property_id);
    return Number.isInteger(userPropertyId) && userPropertyId === targetPropertyId;
  };

  // --------------------------------------------------------------------------
  // GET / (when mounted at /api/settings/property/payment-instructions)
  // GET /:id/payment-instructions (when mounted at /api/properties)
  // --------------------------------------------------------------------------
  const handleGet = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = resolveTargetPropertyId(req);
      if (!propertyId) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'Parameter property_id wajib disertakan dan harus berupa angka positif.',
        });
      }

      const hasAccess = await assertPropertyAccess(req, propertyId);
      if (!hasAccess) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN_CROSS_PROPERTY',
          message: 'Akses ditolak: properti tidak sesuai dengan profil akun Anda.',
        });
      }

      const data = await getPropertyPaymentInstructions(pool, propertyId);
      return res.status(200).json({
        status: 'OK',
        data,
      });
    } catch (err: any) {
      if (err instanceof PropertyPaymentInstructionsError) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: 'Instruksi pembayaran belum dapat dimuat.',
      });
    }
  };

  // --------------------------------------------------------------------------
  // PUT / (when mounted at /api/settings/property/payment-instructions)
  // PUT /:id/payment-instructions (when mounted at /api/properties)
  // --------------------------------------------------------------------------
  const handlePut = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const propertyId = resolveTargetPropertyId(req);
      if (!propertyId) {
        return res.status(400).json({
          status: 'ERROR',
          code: 'VALIDATION_ERROR',
          message: 'property_id wajib disertakan dan harus berupa angka positif.',
        });
      }

      const hasAccess = await assertPropertyAccess(req, propertyId);
      if (!hasAccess) {
        return res.status(403).json({
          status: 'ERROR',
          code: 'FORBIDDEN_CROSS_PROPERTY',
          message: 'Akses ditolak: properti tidak sesuai dengan profil akun Anda.',
        });
      }

      const actor = req.user?.username || req.user?.full_name || 'Staff';
      const updated = await updatePropertyPaymentInstructions(pool, propertyId, req.body || {}, actor);

      return res.status(200).json({
        status: 'OK',
        message: 'Instruksi pembayaran properti berhasil disimpan.',
        data: updated,
      });
    } catch (err: any) {
      if (err instanceof PropertyPaymentInstructionsError) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          code: err.code,
          message: err.message,
        });
      }
      return res.status(500).json({
        status: 'ERROR',
        code: 'INTERNAL_ERROR',
        message: 'Instruksi pembayaran belum dapat disimpan.',
      });
    }
  };

  // Mount handlers for root (settings router mount) and sub-routes (property router mount)
  router.get('/', requireAuth, instructionsView(pool), handleGet);
  router.put('/', requireAuth, requireEffectiveAccess(pool, 'Pengaturan', 'edit'), handlePut);
  router.get('/:id/payment-instructions', requireAuth, instructionsView(pool), handleGet);
  router.put('/:id/payment-instructions', requireAuth, requireEffectiveAccess(pool, 'Pengaturan', 'edit'), handlePut);

  router.get('/qris-image', requireAuth, instructionsView(pool), qrisImageHandler(pool));
  router.post('/qris-image', requireAuth, requireEffectiveAccess(pool, 'Pengaturan', 'edit'),
    paymentPropertyScope(pool), qrisUpload.single('qris_image'), uploadQrisHandler(pool));
  router.delete('/qris-image', requireAuth, requireEffectiveAccess(pool, 'Pengaturan', 'edit'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = await scopedPaymentProperty(req, pool);
      const changed = await replacePropertyQrisImage(pool, id, null, req.user?.username || req.user?.full_name);
      try { await deletePropertyQrisImage(changed.previousQrisKey, id); } catch { console.warn('[QRIS] old image cleanup failed'); }
      return res.json({status:'OK',data:changed.data});
    } catch (err) { return paymentError(res, err); }
  });
  router.use((err: any, _req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({status:'ERROR',code:'QRIS_IMAGE_TOO_LARGE',message:'Gambar QRIS maksimal 2 MB.'});
    return paymentError(res, err);
  });
  return router;
}


function paymentError(res: Response, err: any) {
  const code = Number(err?.statusCode) || 500;
  return res.status(code).json({status:'ERROR',code:code >= 500 ? 'INTERNAL_ERROR' : err.code || 'VALIDATION_ERROR',
    message:code >= 500 ? 'Pengaturan pembayaran belum dapat diproses.' : err.message});
}
async function scopedPaymentProperty(req: AuthenticatedRequest, pool: Pool): Promise<number> {
  const raw = req.query.property_id ?? req.params.id ?? req.body?.property_id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('property_id wajib integer positif.'),{statusCode:400,code:'VALIDATION_ERROR'});
  if (!req.user || (!await isPlatformSuperAdmin(pool,req.user.id) && Number(req.user.property_id) !== id))
    throw Object.assign(new Error('Tidak memiliki akses ke properti ini.'),{statusCode:403,code:'PROPERTY_SCOPE_REQUIRED'});
  return id;
}
function instructionsView(pool: Pool) {
  return async (req: AuthenticatedRequest,res: Response,next: NextFunction) => {
    try {
      if (!req.user)
        return res.status(403).json({status:'ERROR',code:'FORBIDDEN',message:'Tidak memiliki izin membaca instruksi pembayaran.'});

      if (await isPlatformSuperAdmin(pool, req.user.id)) {
        next();
        return;
      }

      if (!await hasAnyEffectivePermission(pool,Number(req.user.property_id),req.user.id,['Pengaturan','Dokumen & Print'],'view'))
        return res.status(403).json({status:'ERROR',code:'FORBIDDEN',message:'Tidak memiliki izin membaca instruksi pembayaran.'});

      next();
    } catch (err) {return paymentError(res,err);}
  };
}
function paymentPropertyScope(pool: Pool) {
  return async (req: AuthenticatedRequest,res: Response,next: NextFunction) => {
    try {await scopedPaymentProperty(req,pool);next();} catch(err) {return paymentError(res,err);}
  };
}
const qrisUpload = multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_QRIS_IMAGE_BYTES}});
function qrisImageHandler(pool: Pool) {
  return async (req: AuthenticatedRequest,res: Response) => {
    try {
      const id = await scopedPaymentProperty(req,pool);
      const cfg = await getPropertyPaymentInstructions(pool,id);
      const bytes = await readPropertyQrisImage(cfg.qris_image_path,id);
      res.setHeader('Content-Type',qrisImageMime(cfg.qris_image_path!));
      res.setHeader('Cache-Control','private, no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      return res.send(bytes);
    } catch(err) {return paymentError(res,err);}
  };
}
function uploadQrisHandler(pool: Pool) {
  return async (req: AuthenticatedRequest,res: Response) => {
    let key: string | null = null, id: number | null = null, committed = false;
    try {
      id = await scopedPaymentProperty(req,pool);
      if (!(await pool.query('SELECT id FROM properties WHERE id=$1',[id])).rows.length)
        throw Object.assign(new Error('Properti tidak ditemukan.'),{statusCode:404,code:'PROPERTY_NOT_FOUND'});
      if (!req.file) throw Object.assign(new Error('Pilih gambar QRIS resmi.'),{statusCode:400,code:'FILE_REQUIRED'});
      key = await savePropertyQrisImage(id,req.file);
      const changed = await replacePropertyQrisImage(pool,id,key,req.user?.username || req.user?.full_name);
      committed = true;
      try {await deletePropertyQrisImage(changed.previousQrisKey,id);} catch {console.warn('[QRIS] old image cleanup failed');}
      return res.json({status:'OK',data:changed.data});
    } catch(err) {
      if (key && id && !committed) {
        // A COMMIT/release error can leave the new key committed. Delete only after a fresh DB read proves it is unreferenced.
        try {
          const current = await getPropertyPaymentInstructions(pool,id);
          if (current.qris_image_path !== key) await deletePropertyQrisImage(key,id);
        } catch {console.warn('[QRIS] uncertain upload retained for reconciliation');}
      }
      return paymentError(res,err);
    }
  };
}
/** Cashiers can read official instructions/image with POS View; no mutation routes. */
export function createPosPaymentConfigRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireAuth,requireEffectiveAccess(pool,'POS','view'));
  router.get('/',async(req: AuthenticatedRequest,res: Response) => {
    try {const id=await scopedPaymentProperty(req,pool);return res.json({status:'OK',data:await getPosPaymentConfig(pool,id)});}
    catch(err) {return paymentError(res,err);}
  });
  router.get('/qris-image',qrisImageHandler(pool));
  return router;
}
