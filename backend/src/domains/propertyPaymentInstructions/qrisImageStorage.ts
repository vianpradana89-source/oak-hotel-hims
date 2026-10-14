import crypto from 'node:crypto';
import { getBrandingStorageAdapter } from '../propertyBranding/brandingStorageService';

export const MAX_QRIS_IMAGE_BYTES = 2 * 1024 * 1024;
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function isPropertyQrisImageKey(key: unknown, propertyId: number): key is string {
  return Number.isInteger(propertyId) && propertyId > 0 && typeof key === 'string' && new RegExp(
    `^branding/${propertyId}/payment-qris/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(png|jpg|webp)$`
  ).test(key);
}
export function qrisImageMime(key: string): string {
  return key.endsWith('.jpg') ? 'image/jpeg' : key.endsWith('.webp') ? 'image/webp' : 'image/png';
}
export async function savePropertyQrisImage(propertyId: number, file: { buffer: Buffer; mimetype: string }): Promise<string> {
  const b = file.buffer;
  const mime = file.mimetype;
  const signature = mime === 'image/png' ? b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    mime === 'image/jpeg' ? b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255 :
    mime === 'image/webp' ? b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP' : false;
  if (!Number.isInteger(propertyId) || propertyId <= 0 || !extensions[mime] || !signature || b.length > MAX_QRIS_IMAGE_BYTES) {
    throw Object.assign(new Error('Gunakan gambar QRIS PNG, JPG, atau WebP yang valid, maksimal 2 MB.'),
      {statusCode: 400, code: 'INVALID_QRIS_IMAGE'});
  }
  const key = `branding/${propertyId}/payment-qris/${crypto.randomUUID()}.${extensions[mime]}`;
  await getBrandingStorageAdapter().save(key, b, mime);
  return key;
}
export async function propertyQrisImageExists(key: unknown, propertyId: number): Promise<boolean> {
  return isPropertyQrisImageKey(key, propertyId) && await getBrandingStorageAdapter().exists(key);
}
export async function readPropertyQrisImage(key: unknown, propertyId: number): Promise<Buffer> {
  if (!isPropertyQrisImageKey(key, propertyId)) {
    throw Object.assign(new Error('Gambar QRIS belum tersedia.'), {statusCode:404,code:'QRIS_IMAGE_NOT_FOUND'});
  }
  const b = await getBrandingStorageAdapter().read(key);
  if (!b) throw Object.assign(new Error('Gambar QRIS belum tersedia.'), {statusCode:404,code:'QRIS_IMAGE_NOT_FOUND'});
  return b;
}
export async function deletePropertyQrisImage(key: unknown, propertyId: number): Promise<void> {
  if (isPropertyQrisImageKey(key, propertyId)) await getBrandingStorageAdapter().delete(key);
}
