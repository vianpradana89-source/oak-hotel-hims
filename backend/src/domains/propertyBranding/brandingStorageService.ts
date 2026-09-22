import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Storage, type Bucket } from '@google-cloud/storage';

// --------------------------------------------------------------------------
// CONSTANTS
// --------------------------------------------------------------------------

const STORAGE_BASE_DIR = path.resolve(__dirname, '..', '..', '..', 'storage', 'branding');

export const ALLOWED_BRANDING_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type BrandingMimeType = typeof ALLOWED_BRANDING_MIME_TYPES[number];

export const MAX_BRANDING_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

const BRANDING_PREFIX = 'branding/';

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

export function getStorageBaseDir(): string {
  return STORAGE_BASE_DIR;
}

export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function resolveAbsolutePath(storageKey: string): string {
  const normalized = path.normalize(storageKey).replace(/^(\.\.[\/\\])+/, '');
  return path.join(STORAGE_BASE_DIR, normalized);
}

export function getExtensionFromMime(mimeType: string, originalFilename?: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  if (map[mimeType]) return map[mimeType];
  if (originalFilename) {
    const ext = path.extname(originalFilename).toLowerCase();
    if (ext) return ext;
  }
  return '.png';
}

export function generateStorageKey(propertyId: number, variant: 'logo' | 'compact', mimeType: string): string {
  const uuid = crypto.randomUUID();
  const ext = getExtensionFromMime(mimeType);
  return `${BRANDING_PREFIX}${propertyId}/${variant}/${uuid}${ext}`;
}

export function isBrandingStorageKey(storageKey: string | null | undefined): boolean {
  if (!storageKey || typeof storageKey !== 'string') return false;
  if (storageKey.includes('..') || storageKey.includes('\\')) return false;
  return storageKey.startsWith(BRANDING_PREFIX);
}

export function brandingKeyPropertyId(storageKey: string | null | undefined): number | null {
  if (!isBrandingStorageKey(storageKey)) return null;
  const parts = String(storageKey).replace(/\\/g, '/').split('/').filter(Boolean);
  // branding/{propertyId}/{variant}/{uuid}.png
  if (parts.length < 4 || parts[0] !== 'branding') return null;
  const propertyId = Number(parts[1]);
  if (!Number.isInteger(propertyId) || propertyId <= 0) return null;
  return propertyId;
}

export function assertBrandingKeyForProperty(
  storageKey: string | null | undefined,
  propertyId: number
): boolean {
  const keyPropertyId = brandingKeyPropertyId(storageKey);
  const expected = Number(propertyId);
  return keyPropertyId !== null && Number.isInteger(expected) && expected > 0 && keyPropertyId === expected;
}

// --------------------------------------------------------------------------
// VALIDATION
// --------------------------------------------------------------------------

export function validateBrandingUpload(file: {
  mimetype: string;
  size: number;
  originalname?: string;
  buffer?: Buffer;
}): { valid: boolean; error?: string; code?: string } {
  if (!file) {
    return { valid: false, error: 'File logo wajib diunggah', code: 'FILE_REQUIRED' };
  }

  if (!file.buffer || file.buffer.length <= 0) {
    return { valid: false, error: 'File logo tidak boleh kosong', code: 'EMPTY_FILE' };
  }

  const mime = (file.mimetype || '').toLowerCase() as BrandingMimeType;
  if (!(ALLOWED_BRANDING_MIME_TYPES as readonly string[]).includes(mime)) {
    return {
      valid: false,
      error: `Tipe file tidak didukung: ${file.mimetype}. Hanya format JPG, PNG, dan WebP yang diperbolehkan.`,
      code: 'UNSUPPORTED_MIME_TYPE',
    };
  }

  const size = file.size || file.buffer?.length || 0;
  if (size > MAX_BRANDING_FILE_SIZE) {
    return {
      valid: false,
      error: `Ukuran file melebihi batas maksimal 2 MB (ukuran: ${(size / (1024 * 1024)).toFixed(2)} MB)`,
      code: 'FILE_TOO_LARGE',
    };
  }

  return { valid: true };
}

// --------------------------------------------------------------------------
// STORAGE PROVIDER ABSTRACTION (LOCAL & GCS)
// --------------------------------------------------------------------------

export type BrandingStorageProviderType = 'local' | 'gcs';

export interface BrandingStorageAdapter {
  readonly provider: BrandingStorageProviderType;

  save(storageKey: string, buffer: Buffer, mimeType: string): Promise<void>;

  delete(storageKey: string): Promise<void>;

  exists(storageKey: string): Promise<boolean>;

  read(storageKey: string): Promise<Buffer | null>;
}

export class LocalBrandingStorageAdapter implements BrandingStorageAdapter {
  readonly provider: BrandingStorageProviderType = 'local';

  async save(storageKey: string, buffer: Buffer, _mimeType: string): Promise<void> {
    if (!storageKey || storageKey.includes('..')) {
      const err: any = new Error('Invalid storage key: path traversal detected');
      err.statusCode = 400;
      err.code = 'INVALID_STORAGE_KEY';
      throw err;
    }
    const absolutePath = resolveAbsolutePath(storageKey);
    const dirPath = path.dirname(absolutePath);
    ensureDirectory(dirPath);
    await fs.promises.writeFile(absolutePath, buffer);
  }

  async delete(storageKey: string): Promise<void> {
    if (!storageKey || storageKey.includes('..')) return;
    try {
      const absolutePath = resolveAbsolutePath(storageKey);
      if (fs.existsSync(absolutePath)) {
        await fs.promises.unlink(absolutePath);
      }
    } catch (err: any) {
      console.warn('[BRANDING STORAGE LOCAL] Failed to delete file %s: %s', storageKey, err?.message || err);
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    if (!storageKey || storageKey.includes('..')) return false;
    const absolutePath = resolveAbsolutePath(storageKey);
    return fs.existsSync(absolutePath);
  }

  async read(storageKey: string): Promise<Buffer | null> {
    if (!storageKey || storageKey.includes('..')) return null;
    const absolutePath = resolveAbsolutePath(storageKey);
    if (!fs.existsSync(absolutePath)) return null;
    return fs.promises.readFile(absolutePath);
  }
}

export function isBrandingGcsNotFoundError(err: any): boolean {
  if (!err) return false;
  const code = Number(err.code || err.statusCode || err.status);
  if (code === 404) return true;
  if (Array.isArray(err.errors) && err.errors.some((e: any) => e?.reason === 'notFound')) return true;
  if (typeof err.message === 'string' && err.message.includes('No such object')) return true;
  return false;
}

export class GcsBrandingStorageAdapter implements BrandingStorageAdapter {
  readonly provider: BrandingStorageProviderType = 'gcs';
  private bucketName: string;
  private storage: Storage;

  constructor(bucketName: string, customStorage?: Storage) {
    if (!bucketName || typeof bucketName !== 'string' || bucketName.trim().length === 0) {
      const err: any = new Error('GCS storage provider requires PROPERTY_LOGO_GCS_BUCKET environment variable.');
      err.statusCode = 500;
      err.code = 'STORAGE_CONFIGURATION_ERROR';
      throw err;
    }
    this.bucketName = bucketName.trim();
    this.storage = customStorage || new Storage();
  }

  getBucket(): Bucket {
    return this.storage.bucket(this.bucketName);
  }

  getBucketName(): string {
    return this.bucketName;
  }

  async save(storageKey: string, buffer: Buffer, mimeType: string): Promise<void> {
    if (!storageKey || storageKey.includes('..')) {
      const err: any = new Error('Invalid storage key: path traversal detected');
      err.statusCode = 400;
      err.code = 'INVALID_STORAGE_KEY';
      throw err;
    }
    const bucket = this.getBucket();
    const file = bucket.file(storageKey);
    // Private object; Uniform Bucket Level Access enforced.
    // Cache-control set to public for logo images (cacheable by browser/CDN).
    await file.save(buffer, {
      contentType: mimeType,
      resumable: false,
      metadata: {
        cacheControl: 'public, max-age=86400, immutable',
      },
    });
  }

  async delete(storageKey: string): Promise<void> {
    if (!storageKey || storageKey.includes('..')) return;
    try {
      const bucket = this.getBucket();
      const file = bucket.file(storageKey);
      await file.delete({ ignoreNotFound: true });
    } catch (err: any) {
      console.warn('[BRANDING STORAGE GCS] Failed to delete object %s: %s', storageKey, err?.message || err);
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    if (!storageKey || storageKey.includes('..')) return false;
    try {
      const bucket = this.getBucket();
      const file = bucket.file(storageKey);
      const [exists] = await file.exists();
      return !!exists;
    } catch (err: any) {
      if (isBrandingGcsNotFoundError(err)) return false;
      throw err;
    }
  }

  async read(storageKey: string): Promise<Buffer | null> {
    if (!storageKey || storageKey.includes('..')) return null;
    try {
      const bucket = this.getBucket();
      const [buffer] = await bucket.file(storageKey).download();
      return buffer;
    } catch (err: any) {
      if (isBrandingGcsNotFoundError(err)) return null;
      throw err;
    }
  }
}

// --------------------------------------------------------------------------
// FACTORY
// --------------------------------------------------------------------------

let activeAdapterOverride: BrandingStorageAdapter | null = null;

export function setBrandingStorageAdapterForTesting(adapter: BrandingStorageAdapter | null): void {
  activeAdapterOverride = adapter;
}

export function getActiveBrandingStorageProvider(): BrandingStorageProviderType {
  if (activeAdapterOverride) {
    return activeAdapterOverride.provider;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const rawProvider = (process.env.PROPERTY_LOGO_STORAGE_PROVIDER || '').toLowerCase().trim();

  if (!rawProvider) {
    if (isProduction) {
      const err: any = new Error('Production environment requires explicit PROPERTY_LOGO_STORAGE_PROVIDER (e.g. "gcs").');
      err.statusCode = 500;
      err.code = 'STORAGE_CONFIGURATION_ERROR';
      throw err;
    }
    return 'local';
  }

  if (rawProvider === 'gcs') return 'gcs';
  if (rawProvider === 'local') return 'local';

  const err: any = new Error(`Unsupported storage provider "${rawProvider}". Supported values: "local", "gcs".`);
  err.statusCode = 500;
  err.code = 'STORAGE_CONFIGURATION_ERROR';
  throw err;
}

export function getBrandingStorageAdapter(): BrandingStorageAdapter {
  if (activeAdapterOverride) return activeAdapterOverride;

  const provider = getActiveBrandingStorageProvider();
  if (provider === 'gcs') {
    const bucketName = process.env.PROPERTY_LOGO_GCS_BUCKET;
    if (!bucketName || bucketName.trim().length === 0) {
      const err: any = new Error('GCS storage provider requires PROPERTY_LOGO_GCS_BUCKET environment variable.');
      err.statusCode = 500;
      err.code = 'STORAGE_CONFIGURATION_ERROR';
      throw err;
    }
    return new GcsBrandingStorageAdapter(bucketName);
  }

  return new LocalBrandingStorageAdapter();
}

// --------------------------------------------------------------------------
// PUBLIC API
// --------------------------------------------------------------------------

export interface SavedBrandingResult {
  storageKey: string;
  mimeType: string;
  fileSizeBytes: number;
  provider: BrandingStorageProviderType;
}

export async function saveBrandingFile(
  propertyId: number,
  variant: 'logo' | 'compact',
  file: {
    mimetype: string;
    size: number;
    originalname: string;
    buffer: Buffer;
  }
): Promise<SavedBrandingResult> {
  const validation = validateBrandingUpload(file);
  if (!validation.valid) {
    throw { statusCode: 400, code: validation.code, message: validation.error };
  }

  const storageKey = generateStorageKey(propertyId, variant, file.mimetype);
  const adapter = getBrandingStorageAdapter();

  await adapter.save(storageKey, file.buffer, file.mimetype);

  return {
    storageKey,
    mimeType: file.mimetype,
    fileSizeBytes: file.size,
    provider: adapter.provider,
  };
}

export async function deleteBrandingFile(storageKey: string): Promise<void> {
  if (!isBrandingStorageKey(storageKey)) return;
  try {
    const adapter = getBrandingStorageAdapter();
    await adapter.delete(storageKey);
  } catch (err: any) {
    console.error('[BRANDING STORAGE] Failed to delete file %s:', storageKey, err);
  }
}

export async function brandingFileExists(storageKey: string): Promise<boolean> {
  if (!isBrandingStorageKey(storageKey)) return false;
  const adapter = getBrandingStorageAdapter();
  return await adapter.exists(storageKey);
}

export async function getBrandingFileBuffer(storageKey: string): Promise<Buffer> {
  if (!isBrandingStorageKey(storageKey)) {
    throw { statusCode: 404, code: 'FILE_NOT_FOUND', message: 'Branding file not found' };
  }
  const adapter = getBrandingStorageAdapter();
  const buffer = await adapter.read(storageKey);
  if (!buffer) {
    throw { statusCode: 404, code: 'FILE_NOT_FOUND', message: 'Branding file not found' };
  }
  return buffer;
}
