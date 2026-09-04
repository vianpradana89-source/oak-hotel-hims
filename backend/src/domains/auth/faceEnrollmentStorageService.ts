import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Storage, type Bucket } from '@google-cloud/storage';

export const ALLOWED_FACE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp'
] as const;

export type AllowedFaceMimeType = typeof ALLOWED_FACE_MIME_TYPES[number];

export const MAX_FACE_PHOTO_SIZE = 5 * 1024 * 1024; // 5 MB

const STORAGE_BASE_DIR = path.resolve(__dirname, '..', '..', '..', 'storage');

export function getStorageBaseDir(): string {
  return STORAGE_BASE_DIR;
}

export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Validates image header magic bytes for JPEG, PNG, and WEBP.
 */
export function isValidImageContent(buffer: Buffer, mimetype: string): boolean {
  if (!buffer || buffer.length < 12) return false;

  if (mimetype === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (mimetype === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }

  if (mimetype === 'image/webp') {
    const isRiff =
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46; // 'RIFF'
    const isWebp =
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50; // 'WEBP'
    return isRiff && isWebp;
  }

  return false;
}

export function validateFacePhotoUpload(file?: {
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}): { valid: boolean; error?: string; code?: string } {
  if (!file || !file.buffer) {
    return { valid: false, error: 'File foto wajah wajib diunggah.', code: 'FILE_REQUIRED' };
  }

  if (file.size !== undefined && file.size <= 0) {
    return { valid: false, error: 'File foto wajah tidak boleh kosong.', code: 'EMPTY_FILE' };
  }

  if (file.buffer.length <= 0) {
    return { valid: false, error: 'File foto wajah tidak boleh kosong.', code: 'EMPTY_FILE' };
  }

  const mime = (file.mimetype || '').toLowerCase();
  if (!ALLOWED_FACE_MIME_TYPES.includes(mime as AllowedFaceMimeType)) {
    return {
      valid: false,
      error: `Format file ${file.mimetype || 'tidak dikenal'} tidak didukung. Hanya JPG, PNG, dan WEBP yang diperbolehkan.`,
      code: 'UNSUPPORTED_MIME_TYPE'
    };
  }

  const effectiveSize = file.size !== undefined ? file.size : file.buffer.length;
  if (effectiveSize > MAX_FACE_PHOTO_SIZE) {
    return {
      valid: false,
      error: `Ukuran file melebihi batas maksimal 5 MB (ukuran: ${(effectiveSize / (1024 * 1024)).toFixed(2)} MB).`,
      code: 'FILE_TOO_LARGE'
    };
  }

  if (!isValidImageContent(file.buffer, mime)) {
    return {
      valid: false,
      error: 'Konten file foto tidak valid atau rusak.',
      code: 'INVALID_IMAGE_CONTENT'
    };
  }

  return { valid: true };
}

export function getExtensionFromMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    default:
      return '.jpg';
  }
}

export function generateFaceStorageKey(propertyId: number, employeeId: number, mimeType: string): string {
  const uuid = crypto.randomUUID();
  const ext = getExtensionFromMime(mimeType);
  return `face-enrollment/${propertyId}/${employeeId}/${uuid}${ext}`;
}

export function resolveAbsolutePath(storageKey: string): string {
  // Prevent path traversal
  const normalized = path.normalize(storageKey).replace(/^(\.\.[\/\\])+/, '');
  return path.join(STORAGE_BASE_DIR, normalized);
}

export function calculatePhotoHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// --------------------------------------------------------------------------
// STORAGE PROVIDER ABSTRACTION (LOCAL & GCS)
// --------------------------------------------------------------------------

export type StorageProviderType = 'local' | 'gcs';

export interface FaceEnrollmentStorageAdapter {
  readonly provider: StorageProviderType;
  savePhoto(storageKey: string, buffer: Buffer, mimetype: string): Promise<void>;
  deletePhoto(storageKey: string): Promise<void>;
  photoExists(storageKey: string): Promise<boolean>;
}

export class LocalStorageAdapter implements FaceEnrollmentStorageAdapter {
  readonly provider: StorageProviderType = 'local';

  async savePhoto(storageKey: string, buffer: Buffer, _mimetype: string): Promise<void> {
    const absolutePath = resolveAbsolutePath(storageKey);
    const dirPath = path.dirname(absolutePath);
    ensureDirectory(dirPath);
    await fs.promises.writeFile(absolutePath, buffer);
  }

  async deletePhoto(storageKey: string): Promise<void> {
    if (!storageKey || storageKey.includes('..')) return;
    try {
      const absolutePath = resolveAbsolutePath(storageKey);
      if (fs.existsSync(absolutePath)) {
        await fs.promises.unlink(absolutePath);
      }
    } catch (err) {
      console.warn(`[FACE STORAGE LOCAL] Failed to unlink file ${storageKey}:`, err);
    }
  }

  async photoExists(storageKey: string): Promise<boolean> {
    if (!storageKey || storageKey.includes('..')) return false;
    const absolutePath = resolveAbsolutePath(storageKey);
    return fs.existsSync(absolutePath);
  }
}

export class GcsStorageAdapter implements FaceEnrollmentStorageAdapter {
  readonly provider: StorageProviderType = 'gcs';
  private bucketName: string;
  private storage: Storage;

  constructor(bucketName: string, customStorage?: Storage) {
    if (!bucketName || typeof bucketName !== 'string' || bucketName.trim().length === 0) {
      const err: any = new Error('GCS storage provider requires FACE_ENROLLMENT_GCS_BUCKET environment variable.');
      err.statusCode = 500;
      err.code = 'STORAGE_CONFIGURATION_ERROR';
      throw err;
    }
    this.bucketName = bucketName.trim();
    // Google Application Default Credentials without JSON key requirement
    this.storage = customStorage || new Storage();
  }

  getBucket(): Bucket {
    return this.storage.bucket(this.bucketName);
  }

  getBucketName(): string {
    return this.bucketName;
  }

  async savePhoto(storageKey: string, buffer: Buffer, mimetype: string): Promise<void> {
    const bucket = this.getBucket();
    const file = bucket.file(storageKey);

    // Private object upload; Uniform Bucket Level Access enforced; NEVER call makePublic()
    await file.save(buffer, {
      contentType: mimetype,
      resumable: false,
      metadata: {
        cacheControl: 'private, max-age=0, no-transform'
      }
    });
  }

  async deletePhoto(storageKey: string): Promise<void> {
    if (!storageKey || storageKey.includes('..')) return;
    try {
      const bucket = this.getBucket();
      const file = bucket.file(storageKey);
      await file.delete({ ignoreNotFound: true });
    } catch (err: any) {
      console.warn(`[FACE STORAGE GCS] Failed to delete object ${storageKey}:`, err?.message || err);
    }
  }

  async photoExists(storageKey: string): Promise<boolean> {
    if (!storageKey || storageKey.includes('..')) return false;
    try {
      const bucket = this.getBucket();
      const file = bucket.file(storageKey);
      const [exists] = await file.exists();
      return !!exists;
    } catch {
      return false;
    }
  }
}

// Global active adapter override for test isolation & dependency injection
let activeAdapterOverride: FaceEnrollmentStorageAdapter | null = null;

export function setStorageAdapterForTesting(adapter: FaceEnrollmentStorageAdapter | null): void {
  activeAdapterOverride = adapter;
}

export function getActiveStorageProvider(): StorageProviderType {
  if (activeAdapterOverride) {
    return activeAdapterOverride.provider;
  }
  const rawProvider = (process.env.FACE_ENROLLMENT_STORAGE_PROVIDER || 'local').toLowerCase().trim();
  if (rawProvider === 'gcs') {
    return 'gcs';
  }
  return 'local';
}

export function getStorageAdapter(): FaceEnrollmentStorageAdapter {
  if (activeAdapterOverride) {
    return activeAdapterOverride;
  }

  const provider = getActiveStorageProvider();
  if (provider === 'gcs') {
    const bucketName = process.env.FACE_ENROLLMENT_GCS_BUCKET;
    if (!bucketName || bucketName.trim().length === 0) {
      const err: any = new Error('GCS storage provider requires FACE_ENROLLMENT_GCS_BUCKET environment variable.');
      err.statusCode = 500;
      err.code = 'STORAGE_CONFIGURATION_ERROR';
      throw err;
    }
    return new GcsStorageAdapter(bucketName);
  }

  return new LocalStorageAdapter();
}

export async function saveFaceEnrollmentPhoto(
  propertyId: number,
  employeeId: number,
  file: {
    mimetype: string;
    size: number;
    buffer: Buffer;
  }
): Promise<{
  storageKey: string;
  absolutePath?: string;
  hash: string;
  fileSizeBytes: number;
  provider: StorageProviderType;
}> {
  const validation = validateFacePhotoUpload(file);
  if (!validation.valid) {
    throw { statusCode: 400, code: validation.code, message: validation.error };
  }

  const storageKey = generateFaceStorageKey(propertyId, employeeId, file.mimetype);
  const adapter = getStorageAdapter();

  await adapter.savePhoto(storageKey, file.buffer, file.mimetype);
  const hash = calculatePhotoHash(file.buffer);

  const result: {
    storageKey: string;
    absolutePath?: string;
    hash: string;
    fileSizeBytes: number;
    provider: StorageProviderType;
  } = {
    storageKey,
    hash,
    fileSizeBytes: file.buffer.length,
    provider: adapter.provider
  };

  if (adapter.provider === 'local') {
    result.absolutePath = resolveAbsolutePath(storageKey);
  }

  return result;
}

export async function deleteFaceEnrollmentPhoto(storageKey: string): Promise<void> {
  if (!storageKey || storageKey.includes('..')) {
    return;
  }
  try {
    const adapter = getStorageAdapter();
    await adapter.deletePhoto(storageKey);
  } catch (err) {
    console.warn(`[FACE STORAGE] Failed to cleanup object ${storageKey}:`, err);
  }
}

export async function faceEnrollmentPhotoExists(storageKey: string): Promise<boolean> {
  if (!storageKey || storageKey.includes('..')) {
    return false;
  }
  try {
    const adapter = getStorageAdapter();
    return await adapter.photoExists(storageKey);
  } catch {
    return false;
  }
}
