import crypto from 'node:crypto';
import {
  getBrandingStorageAdapter,
  type BrandingStorageAdapter,
} from '../propertyBranding/brandingStorageService';
import { formatPosMenuItemRow } from './productMasterStage1';

export const MAX_PRODUCT_PHOTO_BYTES = 2 * 1024 * 1024;

export const ALLOWED_PRODUCT_PHOTO_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

const PHOTO_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function isProductPhotoStorageKey(
  key: unknown,
  propertyId: number,
  itemId?: number
): key is string {
  if (!Number.isInteger(propertyId) || propertyId <= 0 || typeof key !== 'string') {
    return false;
  }
  if (itemId !== undefined && (!Number.isInteger(itemId) || itemId <= 0)) {
    return false;
  }
  const itemPattern = itemId !== undefined ? String(itemId) : '[1-9][0-9]*';
  return new RegExp(
    `^branding/${propertyId}/product-photos/${itemPattern}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(png|jpg|webp)$`
  ).test(key);
}

export function productPhotoMime(key: string): string {
  return key.endsWith('.jpg')
    ? 'image/jpeg'
    : key.endsWith('.webp')
      ? 'image/webp'
      : 'image/png';
}

export function hasValidImageSignature(buffer: Buffer, mime: string): boolean {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mime === 'image/png') {
    return (
      buffer.length >= 24 &&
      buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  }
  if (mime === 'image/jpeg') {
    return (
      buffer.length >= 4 &&
      buffer[0] === 255 &&
      buffer[1] === 216 &&
      buffer[2] === 255
    );
  }
  if (mime === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

export function validateProductPhotoBuffer(
  file: { buffer?: Buffer; mimetype?: string; size?: number } | null | undefined
):
  | { ok: true; buffer: Buffer; mime: string; ext: string }
  | { ok: false; statusCode: number; code: string; message: string } {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      code: 'FILE_REQUIRED',
      message: 'Pilih file foto produk (PNG, JPG, atau WebP, maksimal 2 MB).',
    };
  }
  const byteLength = file.buffer.length;
  const reportedSize = typeof file.size === 'number' ? file.size : byteLength;
  if (byteLength > MAX_PRODUCT_PHOTO_BYTES || reportedSize > MAX_PRODUCT_PHOTO_BYTES) {
    return {
      ok: false,
      statusCode: 400,
      code: 'PRODUCT_PHOTO_TOO_LARGE',
      message: 'Ukuran foto produk maksimal 2 MB.',
    };
  }
  const mime = String(file.mimetype || '').toLowerCase();
  const ext = PHOTO_EXTENSIONS[mime];
  if (!ext || !hasValidImageSignature(file.buffer, mime)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'INVALID_PRODUCT_PHOTO',
      message: 'Gunakan foto produk format PNG, JPG, atau WebP yang valid (maksimal 2 MB).',
    };
  }
  return { ok: true, buffer: file.buffer, mime, ext };
}

export async function saveProductPhoto(
  propertyId: number,
  itemId: number,
  file: { buffer: Buffer; mimetype: string; size?: number },
  adapter: BrandingStorageAdapter = getBrandingStorageAdapter()
): Promise<string> {
  if (!Number.isInteger(propertyId) || propertyId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
    throw Object.assign(new Error('Identitas properti atau produk tidak valid.'), {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const check = validateProductPhotoBuffer(file);
  if (!check.ok) {
    throw Object.assign(new Error(check.message), {
      statusCode: check.statusCode,
      code: check.code,
    });
  }
  const key = `branding/${propertyId}/product-photos/${itemId}/${crypto.randomUUID()}.${check.ext}`;
  await adapter.save(key, check.buffer, check.mime);
  return key;
}

export async function productPhotoExists(
  key: unknown,
  propertyId: number,
  itemId?: number,
  adapter: BrandingStorageAdapter = getBrandingStorageAdapter()
): Promise<boolean> {
  return isProductPhotoStorageKey(key, propertyId, itemId) && (await adapter.exists(key));
}

export async function readProductPhoto(
  key: unknown,
  propertyId: number,
  itemId?: number,
  adapter: BrandingStorageAdapter = getBrandingStorageAdapter()
): Promise<Buffer> {
  if (!isProductPhotoStorageKey(key, propertyId, itemId)) {
    throw Object.assign(new Error('Foto produk belum tersedia.'), {
      statusCode: 404,
      code: 'PRODUCT_PHOTO_NOT_FOUND',
    });
  }
  const bytes = await adapter.read(key);
  if (!bytes) {
    throw Object.assign(new Error('Foto produk belum tersedia.'), {
      statusCode: 404,
      code: 'PRODUCT_PHOTO_NOT_FOUND',
    });
  }
  return bytes;
}

export async function deleteProductPhoto(
  key: unknown,
  propertyId: number,
  itemId?: number,
  adapter: BrandingStorageAdapter = getBrandingStorageAdapter()
): Promise<void> {
  if (isProductPhotoStorageKey(key, propertyId, itemId)) {
    await adapter.delete(key);
  }
}

export interface ProductPhotoHandlerDeps {
  pool: {
    query: (sql: string, params?: any[]) => Promise<any>;
    connect: () => Promise<{
      query: (sql: string, params?: any[]) => Promise<any>;
      release: () => void;
    }>;
  };
  assertPropertyScope: (req: any, propertyId: number) => Promise<void>;
  canViewMasterProduct?: (req: any, propertyId: number) => Promise<boolean>;
  storageAdapter?: BrandingStorageAdapter;
}

function parseItemAndPropertyIds(req: any):
  | { ok: true; itemId: number; propertyId: number }
  | { ok: false; statusCode: number; code: string; message: string } {
  const itemId = Number(req.params?.id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return { ok: false, statusCode: 400, code: 'VALIDATION_ERROR', message: 'invalid item id' };
  }
  const propertyIdRaw = req.query?.property_id ?? req.body?.property_id;
  if (propertyIdRaw === undefined || propertyIdRaw === null || String(propertyIdRaw).trim() === '') {
    return { ok: false, statusCode: 400, code: 'VALIDATION_ERROR', message: 'property_id is required' };
  }
  const propertyId = Number(propertyIdRaw);
  if (!Number.isInteger(propertyId) || propertyId <= 0) {
    return { ok: false, statusCode: 400, code: 'VALIDATION_ERROR', message: 'invalid property_id' };
  }
  return { ok: true, itemId, propertyId };
}

/**
 * Handler produksi untuk POST /api/pos/menu/items/:id/photo.
 * - Menyimpan file baru ke storage adapter setelah memvalidasi scope, produk, dan isi file.
 * - Menautkan photo_storage_key di DB dalam transaksi.
 * - Menghapus foto lama hanya setelah COMMIT berhasil.
 * - Jika gagal sebelum/saat COMMIT, hanya menghapus file baru bila pembacaan ulang DB
 *   membuktikan key baru tidak tereferensi.
 */
export function createProductPhotoUploadHandler(deps: ProductPhotoHandlerDeps) {
  return async (req: any, res: any) => {
    let newKey: string | null = null;
    let itemId: number | null = null;
    let propertyId: number | null = null;
    let committed = false;

    try {
      const parsedIds = parseItemAndPropertyIds(req);
      if (!parsedIds.ok) {
        return res
          .status(parsedIds.statusCode)
          .json({ status: 'ERROR', code: parsedIds.code, message: parsedIds.message });
      }
      itemId = parsedIds.itemId;
      propertyId = parsedIds.propertyId;

      await deps.assertPropertyScope(req, propertyId);

      const fileCheck = validateProductPhotoBuffer(req.file);
      if (!fileCheck.ok) {
        return res
          .status(fileCheck.statusCode)
          .json({ status: 'ERROR', code: fileCheck.code, message: fileCheck.message });
      }

      const existingItem = await deps.pool.query(
        'SELECT id FROM pos_menu_items WHERE id = $1 AND property_id = $2',
        [itemId, propertyId]
      );
      if ((existingItem.rowCount ?? 0) === 0) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'NOT_FOUND',
          message: `menu item ${itemId} not found for property ${propertyId}`,
        });
      }

      const adapter = deps.storageAdapter ?? getBrandingStorageAdapter();
      newKey = await saveProductPhoto(propertyId, itemId, req.file, adapter);

      let previousKey: string | null = null;
      let updatedRow: Record<string, any> | null = null;

      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        const lockRes = await client.query(
          'SELECT id, photo_storage_key FROM pos_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE',
          [itemId, propertyId]
        );
        if ((lockRes.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          throw Object.assign(new Error(`menu item ${itemId} not found for property ${propertyId}`), {
            statusCode: 404,
            code: 'NOT_FOUND',
          });
        }
        previousKey = lockRes.rows[0].photo_storage_key ?? null;

        const updateRes = await client.query(
          'UPDATE pos_menu_items SET photo_storage_key = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND property_id = $3 RETURNING *',
          [newKey, itemId, propertyId]
        );
        updatedRow = updateRes.rows[0];
        await client.query('COMMIT');
        committed = true;
      } catch (dbErr) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback error */
        }
        throw dbErr;
      } finally {
        client.release();
      }

      if (previousKey && previousKey !== newKey) {
        try {
          await deleteProductPhoto(previousKey, propertyId, itemId, adapter);
        } catch {
          console.warn('[ProductPhoto] old photo cleanup failed');
        }
      }

      return res.status(200).json({
        status: 'OK',
        data: formatPosMenuItemRow(updatedRow!),
      });
    } catch (err: any) {
      if (newKey && propertyId && itemId && !committed) {
        const adapter = deps.storageAdapter ?? getBrandingStorageAdapter();
        try {
          const fresh = await deps.pool.query(
            'SELECT photo_storage_key FROM pos_menu_items WHERE id = $1 AND property_id = $2',
            [itemId, propertyId]
          );
          const currentKey = fresh.rows?.[0]?.photo_storage_key ?? null;
          if (currentKey !== newKey) {
            await deleteProductPhoto(newKey, propertyId, itemId, adapter);
          }
        } catch {
          console.warn('[ProductPhoto] uncertain upload retained for reconciliation');
        }
      }
      const statusCode = Number(err?.statusCode) || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : err?.code || 'VALIDATION_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : err.message,
      });
    }
  };
}

/**
 * Handler produksi untuk DELETE /api/pos/menu/items/:id/photo.
 * - Mengosongkan photo_storage_key di DB terlebih dahulu dalam transaksi.
 * - Menghapus file fisik dari storage hanya setelah COMMIT berhasil.
 */
export function createProductPhotoDeleteHandler(deps: ProductPhotoHandlerDeps) {
  return async (req: any, res: any) => {
    try {
      const parsedIds = parseItemAndPropertyIds(req);
      if (!parsedIds.ok) {
        return res
          .status(parsedIds.statusCode)
          .json({ status: 'ERROR', code: parsedIds.code, message: parsedIds.message });
      }
      const { itemId, propertyId } = parsedIds;

      await deps.assertPropertyScope(req, propertyId);

      let previousKey: string | null = null;
      let updatedRow: Record<string, any> | null = null;

      const client = await deps.pool.connect();
      try {
        await client.query('BEGIN');
        const lockRes = await client.query(
          'SELECT id, photo_storage_key FROM pos_menu_items WHERE id = $1 AND property_id = $2 FOR UPDATE',
          [itemId, propertyId]
        );
        if ((lockRes.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            status: 'ERROR',
            code: 'NOT_FOUND',
            message: `menu item ${itemId} not found for property ${propertyId}`,
          });
        }
        previousKey = lockRes.rows[0].photo_storage_key ?? null;

        const updateRes = await client.query(
          'UPDATE pos_menu_items SET photo_storage_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND property_id = $2 RETURNING *',
          [itemId, propertyId]
        );
        updatedRow = updateRes.rows[0];
        await client.query('COMMIT');
      } catch (dbErr) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback error */
        }
        throw dbErr;
      } finally {
        client.release();
      }

      if (previousKey) {
        const adapter = deps.storageAdapter ?? getBrandingStorageAdapter();
        try {
          await deleteProductPhoto(previousKey, propertyId, itemId, adapter);
        } catch {
          console.warn('[ProductPhoto] deleted photo cleanup failed');
        }
      }

      return res.status(200).json({
        status: 'OK',
        data: formatPosMenuItemRow(updatedRow!),
      });
    } catch (err: any) {
      const statusCode = Number(err?.statusCode) || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : err?.code || 'VALIDATION_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : err.message,
      });
    }
  };
}

/**
 * Handler produksi untuk GET /api/pos/menu/items/:id/photo.
 * - Memeriksa scope properti.
 * - Produk yang layak katalog POS (is_active = true, is_sellable_pos != false, price != null)
 *   dapat dibaca oleh pemegang izin POS maupun Master Produk.
 * - Produk internal atau nonaktif memerlukan izin Master Produk (view).
 */
export function createProductPhotoGetHandler(deps: ProductPhotoHandlerDeps) {
  return async (req: any, res: any) => {
    try {
      const parsedIds = parseItemAndPropertyIds(req);
      if (!parsedIds.ok) {
        return res
          .status(parsedIds.statusCode)
          .json({ status: 'ERROR', code: parsedIds.code, message: parsedIds.message });
      }
      const { itemId, propertyId } = parsedIds;

      await deps.assertPropertyScope(req, propertyId);

      const itemRes = await deps.pool.query(
        'SELECT id, property_id, is_active, is_sellable_pos, price, photo_storage_key FROM pos_menu_items WHERE id = $1 AND property_id = $2',
        [itemId, propertyId]
      );
      if ((itemRes.rowCount ?? 0) === 0) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'NOT_FOUND',
          message: `menu item ${itemId} not found for property ${propertyId}`,
        });
      }

      const row = itemRes.rows[0];
      const isCatalogEligible =
        row.is_active === true &&
        row.is_sellable_pos !== false &&
        row.price !== null &&
        row.price !== undefined;

      if (!isCatalogEligible && deps.canViewMasterProduct) {
        const allowed = await deps.canViewMasterProduct(req, propertyId);
        if (!allowed) {
          return res.status(403).json({
            status: 'ERROR',
            code: 'FORBIDDEN',
            message: "Akses ditolak. Akun Anda tidak memiliki hak akses VIEW pada 'Master Produk'.",
          });
        }
      }

      const storageKey = row.photo_storage_key;
      if (!storageKey) {
        return res.status(404).json({
          status: 'ERROR',
          code: 'PRODUCT_PHOTO_NOT_FOUND',
          message: 'Foto produk belum tersedia.',
        });
      }

      const adapter = deps.storageAdapter ?? getBrandingStorageAdapter();
      const bytes = await readProductPhoto(storageKey, propertyId, itemId, adapter);
      res.setHeader('Content-Type', productPhotoMime(storageKey));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(bytes);
    } catch (err: any) {
      const statusCode = Number(err?.statusCode) || 500;
      return res.status(statusCode).json({
        status: 'ERROR',
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : err?.code || 'VALIDATION_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : err.message,
      });
    }
  };
}
