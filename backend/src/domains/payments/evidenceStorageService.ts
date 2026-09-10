import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Storage, type Bucket } from '@google-cloud/storage';
import {
  ALLOWED_MIME_TYPES,
  MAX_EVIDENCE_FILE_SIZE,
  AllowedMimeType
} from './paymentEvidenceTypes';

const STORAGE_BASE_DIR = path.resolve(__dirname, '..', '..', '..', 'storage');

export function getStorageBaseDir(): string {
  return STORAGE_BASE_DIR;
}

export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function validateEvidenceUpload(file: {
  mimetype: string;
  size: number;
  originalname?: string;
  buffer?: Buffer;
}): { valid: boolean; error?: string; code?: string } {
  if (!file) {
    return { valid: false, error: 'File bukti pembayaran wajib diunggah', code: 'FILE_REQUIRED' };
  }

  if (!ALLOWED_MIME_TYPES.includes(file.mimetype as AllowedMimeType)) {
    return {
      valid: false,
      error: `Tipe file tidak didukung: ${file.mimetype}. Hanya format JPG, PNG, WEBP, dan PDF yang diperbolehkan.`,
      code: 'UNSUPPORTED_MIME_TYPE'
    };
  }

  if (file.size <= 0) {
    return { valid: false, error: 'File bukti pembayaran tidak boleh kosong', code: 'EMPTY_FILE' };
  }

  if (file.size > MAX_EVIDENCE_FILE_SIZE) {
    return {
      valid: false,
      error: `Ukuran file melebihi batas maksimal 10 MB (ukuran: ${(file.size / (1024 * 1024)).toFixed(2)} MB)`,
      code: 'FILE_TOO_LARGE'
    };
  }

  return { valid: true };
}

export function getExtensionFromMime(mimeType: string, originalFilename?: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf'
  };
  if (map[mimeType]) return map[mimeType];
  if (originalFilename) {
    const ext = path.extname(originalFilename).toLowerCase();
    if (ext) return ext;
  }
  return '.bin';
}

export function generateStorageKey(propertyId: number, mimeType: string, originalFilename?: string): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID();
  const ext = getExtensionFromMime(mimeType, originalFilename);
  return `payment-evidence/${propertyId}/${year}/${month}/${uuid}${ext}`;
}

export function resolveAbsolutePath(storageKey: string): string {
  // Prevent path traversal
  const normalized = path.normalize(storageKey).replace(/^(\.\.[\/\\])+/, '');
  return path.join(STORAGE_BASE_DIR, normalized);
}

// --------------------------------------------------------------------------
// STORAGE PROVIDER ABSTRACTION (LOCAL & GCS)
// --------------------------------------------------------------------------

export type EvidenceStorageProviderType = 'local' | 'gcs';

export interface EvidenceStorageAdapter {
  readonly provider: EvidenceStorageProviderType;

  save(
    storageKey: string,
    buffer: Buffer,
    mimeType: string
  ): Promise<void>;

  delete(storageKey: string): Promise<void>;

  exists(storageKey: string): Promise<boolean>;

  read(storageKey: string): Promise<Buffer | null>;
}

export class LocalStorageAdapter implements EvidenceStorageAdapter {
  readonly provider: EvidenceStorageProviderType = 'local';

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
      console.warn(`[EVIDENCE STORAGE LOCAL] Failed to delete file ${storageKey}:`, err?.message || err);
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

export function isGcsNotFoundError(err: any): boolean {
  if (!err) return false;
  const code = Number(err.code || err.statusCode || err.status);
  if (code === 404) return true;
  if (Array.isArray(err.errors) && err.errors.some((e: any) => e?.reason === 'notFound')) {
    return true;
  }
  if (typeof err.message === 'string' && err.message.includes('No such object')) {
    return true;
  }
  return false;
}

export class GcsStorageAdapter implements EvidenceStorageAdapter {
  readonly provider: EvidenceStorageProviderType = 'gcs';
  private bucketName: string;
  private storage: Storage;

  constructor(bucketName: string, customStorage?: Storage) {
    if (!bucketName || typeof bucketName !== 'string' || bucketName.trim().length === 0) {
      const err: any = new Error('GCS storage provider requires PAYMENT_EVIDENCE_GCS_BUCKET environment variable.');
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

  async save(storageKey: string, buffer: Buffer, mimeType: string): Promise<void> {
    if (!storageKey || storageKey.includes('..')) {
      const err: any = new Error('Invalid storage key: path traversal detected');
      err.statusCode = 400;
      err.code = 'INVALID_STORAGE_KEY';
      throw err;
    }
    const bucket = this.getBucket();
    const file = bucket.file(storageKey);

    // Private object upload; Uniform Bucket Level Access enforced; NEVER call makePublic()
    await file.save(buffer, {
      contentType: mimeType,
      resumable: false,
      metadata: {
        cacheControl: 'private, max-age=0, no-transform'
      }
    });
  }

  async delete(storageKey: string): Promise<void> {
    if (!storageKey || storageKey.includes('..')) return;
    try {
      const bucket = this.getBucket();
      const file = bucket.file(storageKey);
      await file.delete({ ignoreNotFound: true });
    } catch (err: any) {
      console.warn(`[EVIDENCE STORAGE GCS] Failed to delete object ${storageKey}:`, err?.message || err);
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
      if (isGcsNotFoundError(err)) {
        return false;
      }
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
      if (isGcsNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }
}

// Global active adapter override for test isolation & dependency injection
let activeAdapterOverride: EvidenceStorageAdapter | null = null;

export function setStorageAdapterForTesting(adapter: EvidenceStorageAdapter | null): void {
  activeAdapterOverride = adapter;
}

export function getActiveStorageProvider(): EvidenceStorageProviderType {
  if (activeAdapterOverride) {
    return activeAdapterOverride.provider;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const rawProvider = (process.env.PAYMENT_EVIDENCE_STORAGE_PROVIDER || '').toLowerCase().trim();

  if (!rawProvider) {
    if (isProduction) {
      const err: any = new Error('Production environment requires explicit PAYMENT_EVIDENCE_STORAGE_PROVIDER (e.g. "gcs").');
      err.statusCode = 500;
      err.code = 'STORAGE_CONFIGURATION_ERROR';
      throw err;
    }
    return 'local';
  }

  if (rawProvider === 'gcs') {
    return 'gcs';
  }

  if (rawProvider === 'local') {
    return 'local';
  }

  const err: any = new Error(`Unsupported storage provider "${rawProvider}". Supported values: "local", "gcs".`);
  err.statusCode = 500;
  err.code = 'STORAGE_CONFIGURATION_ERROR';
  throw err;
}

export function getStorageAdapter(): EvidenceStorageAdapter {
  if (activeAdapterOverride) {
    return activeAdapterOverride;
  }

  const provider = getActiveStorageProvider();
  if (provider === 'gcs') {
    const bucketName = process.env.PAYMENT_EVIDENCE_GCS_BUCKET;
    if (!bucketName || bucketName.trim().length === 0) {
      const err: any = new Error('GCS storage provider requires PAYMENT_EVIDENCE_GCS_BUCKET environment variable.');
      err.statusCode = 500;
      err.code = 'STORAGE_CONFIGURATION_ERROR';
      throw err;
    }
    return new GcsStorageAdapter(bucketName);
  }

  return new LocalStorageAdapter();
}

export interface SavedEvidenceResult {
  storageKey: string;
  absolutePath: string;
  fileSizeBytes: number;
  provider: EvidenceStorageProviderType;
}

export async function saveEvidenceFile(
  propertyId: number,
  file: {
    mimetype: string;
    size: number;
    originalname: string;
    buffer: Buffer;
  }
): Promise<SavedEvidenceResult> {
  const validation = validateEvidenceUpload(file);
  if (!validation.valid) {
    throw { statusCode: 400, code: validation.code, message: validation.error };
  }

  const storageKey = generateStorageKey(propertyId, file.mimetype, file.originalname);
  const adapter = getStorageAdapter();

  await adapter.save(storageKey, file.buffer, file.mimetype);

  return {
    storageKey,
    absolutePath: adapter.provider === 'local' ? resolveAbsolutePath(storageKey) : '',
    fileSizeBytes: file.size,
    provider: adapter.provider
  };
}

export async function deleteEvidenceFile(storageKey: string): Promise<void> {
  if (!storageKey || storageKey.includes('..')) return;
  try {
    const adapter = getStorageAdapter();
    await adapter.delete(storageKey);
  } catch (err: any) {
    console.error(`Failed to delete evidence file at ${storageKey}:`, err);
  }
}

export async function evidenceFileExists(storageKey: string): Promise<boolean> {
  if (!storageKey || storageKey.includes('..')) return false;
  const adapter = getStorageAdapter();
  return await adapter.exists(storageKey);
}

export async function getEvidenceFileBuffer(storageKey: string): Promise<Buffer> {
  if (!storageKey || storageKey.includes('..')) {
    throw { statusCode: 404, code: 'FILE_NOT_FOUND', message: 'Evidence file not found in storage' };
  }
  const adapter = getStorageAdapter();
  const buffer = await adapter.read(storageKey);
  if (!buffer) {
    throw { statusCode: 404, code: 'FILE_NOT_FOUND', message: 'Evidence file not found in storage' };
  }
  return buffer;
}

export function createEvidenceReadStream(storageKey: string): fs.ReadStream {
  const absolutePath = resolveAbsolutePath(storageKey);
  if (!fs.existsSync(absolutePath)) {
    throw { statusCode: 404, code: 'FILE_NOT_FOUND', message: 'Evidence file not found in storage' };
  }
  return fs.createReadStream(absolutePath);
}
