import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  calculatePhotoHash,
  getStorageAdapter,
  resolveAbsolutePath,
  type FaceEnrollmentStorageAdapter,
  type StorageProviderType
} from '../auth/faceEnrollmentStorageService';

// Reuses the existing private FACE_ENROLLMENT storage adapter / GCS client.
// Do not instantiate a second Storage() client here.

export const PRIVATE_IDENTITY_DOCUMENT_PREFIX = 'identity-documents/';
export const IDENTITY_DOCUMENT_MISSING_CODE = 'DOCUMENT_FILE_MISSING';
export const IDENTITY_DOCUMENT_MISSING_MESSAGE =
  'Dokumen tercatat, tetapi file fisik tidak tersedia.';

export const ALLOWED_IDENTITY_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf'
] as const;

export const MAX_IDENTITY_DOCUMENT_BYTES = 15 * 1024 * 1024;

const UUID_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i;
const SAFE_BASENAME = /^[a-zA-Z0-9._-]+$/;

export interface IdentityDocumentPersistResult {
  storageKey: string;
  apiPath: string;
  basename: string;
  hash: string;
  mimeType: string;
  originalFilename: string | null;
  fileSizeBytes: number;
  provider: StorageProviderType;
}

function httpError(message: string, statusCode: number, code: string): never {
  const err: any = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  throw err;
}

export function getIdentityStorageAdapter(): FaceEnrollmentStorageAdapter {
  return getStorageAdapter();
}

export function omitIdentityStorageKey<T>(guest: T): T {
  if (!guest || typeof guest !== 'object') return guest;
  const { identity_storage_key: _omit, ...safe } = guest as T & { identity_storage_key?: string };
  return safe as T;
}

export function isIdentityDocumentStorageKey(storageKey: string | null | undefined): boolean {
  if (!storageKey || typeof storageKey !== 'string') return false;
  if (storageKey.includes('..') || storageKey.includes('\\')) return false;
  return storageKey.startsWith(PRIVATE_IDENTITY_DOCUMENT_PREFIX);
}

export function storageKeyPropertyId(storageKey: string | null | undefined): number | null {
  if (!isIdentityDocumentStorageKey(storageKey)) return null;
  const parts = String(storageKey).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'identity-documents') return null;
  const propertyId = Number(parts[1]);
  if (!Number.isInteger(propertyId) || propertyId <= 0) return null;
  return propertyId;
}

export function assertIdentityStorageKeyForProperty(
  storageKey: string | null | undefined,
  propertyId: number
): boolean {
  const keyPropertyId = storageKeyPropertyId(storageKey);
  const expected = Number(propertyId);
  return keyPropertyId !== null && Number.isInteger(expected) && expected > 0 && keyPropertyId === expected;
}

export async function deleteIdentityDocument(storageKey: string): Promise<boolean> {
  if (!isIdentityDocumentStorageKey(storageKey)) return false;
  try {
    await getIdentityStorageAdapter().deletePhoto(storageKey);
    return true;
  } catch (err) {
    console.warn('[IDENTITY STORAGE] Failed exact-key orphan cleanup:', err);
    return false;
  }
}

export function estimateBase64DecodedBytes(raw: string): number {
  const cleaned = String(raw || '').replace(/\s/g, '');
  if (!cleaned) return 0;
  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
}

export function decodeIdentityBase64Payload(raw: string): {
  buffer: Buffer;
  mimeType: string;
} {
  const source = String(raw || '');
  const matches = source.match(/^data:([A-Za-z0-9.+/-]+);base64,(.+)$/);
  const mimeType = matches && matches[1] ? matches[1] : 'image/jpeg';
  const base64Data = matches ? matches[2] : source;
  if (estimateBase64DecodedBytes(base64Data) > MAX_IDENTITY_DOCUMENT_BYTES) {
    httpError('Ukuran file melebihi batas maksimum 15 MB.', 400, 'FILE_TOO_LARGE');
  }
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_IDENTITY_DOCUMENT_BYTES) {
    httpError('Ukuran file melebihi batas maksimum 15 MB.', 400, 'FILE_TOO_LARGE');
  }
  return { buffer, mimeType };
}

export function getExtensionFromIdentityMime(mimeType: string, originalFilename?: string | null): string {
  const mime = (mimeType || '').toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'application/pdf') return '.pdf';
  if (originalFilename) {
    const ext = path.extname(originalFilename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  }
  return '.jpg';
}

export function inferIdentityMimeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  return 'image/jpeg';
}

export function isValidIdentityDocumentContent(buffer: Buffer, mimeType: string): boolean {
  if (!buffer || buffer.length < 5) return false;
  const mime = (mimeType || '').toLowerCase();
  if (mime === 'application/pdf') {
    return buffer.slice(0, 4).toString('utf8') === '%PDF';
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }
  if (mime === 'image/webp') {
    return (
      buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

export function validateIdentityDocumentUpload(file?: {
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
  originalname?: string;
}): { valid: boolean; error?: string; code?: string } {
  if (!file || !file.buffer) {
    return { valid: false, error: 'File atau gambar identitas KTP/Paspor wajib diunggah.', code: 'FILE_REQUIRED' };
  }
  if (file.buffer.length <= 0 || (file.size !== undefined && file.size <= 0)) {
    return { valid: false, error: 'File identitas tidak boleh kosong.', code: 'EMPTY_FILE' };
  }
  const mime = (file.mimetype || '').toLowerCase();
  const allowed = ALLOWED_IDENTITY_DOCUMENT_MIME_TYPES as readonly string[];
  if (!allowed.includes(mime) && !mime.startsWith('image/')) {
    return {
      valid: false,
      error: 'Format file tidak didukung. Harap unggah file JPG, PNG, WebP, atau PDF.',
      code: 'UNSUPPORTED_MIME_TYPE'
    };
  }
  const size = file.size !== undefined ? file.size : file.buffer.length;
  if (size > MAX_IDENTITY_DOCUMENT_BYTES) {
    return {
      valid: false,
      error: 'Ukuran file melebihi batas maksimum 15 MB.',
      code: 'FILE_TOO_LARGE'
    };
  }
  const canonicalMime = mime === 'image/jpg' ? 'image/jpeg' : mime.startsWith('image/') && !allowed.includes(mime)
    ? 'image/jpeg'
    : mime;
  if (!isValidIdentityDocumentContent(file.buffer, canonicalMime === 'image/jpg' ? 'image/jpeg' : mime)) {
    return {
      valid: false,
      error: 'Konten file identitas tidak valid atau rusak.',
      code: 'INVALID_IMAGE_CONTENT'
    };
  }
  return { valid: true };
}

export function generateIdentityDocumentStorageKey(
  propertyId: number,
  mimeType: string,
  originalFilename?: string | null
): string {
  const parsedPropertyId = Number(propertyId);
  if (!Number.isInteger(parsedPropertyId) || parsedPropertyId <= 0) {
    httpError('property_id wajib diisi untuk menyimpan dokumen identitas.', 400, 'INVALID_PROPERTY_ID');
  }
  const uuid = crypto.randomUUID();
  const ext = getExtensionFromIdentityMime(mimeType, originalFilename);
  return `${PRIVATE_IDENTITY_DOCUMENT_PREFIX}${parsedPropertyId}/${uuid}${ext}`;
}

export function identityDocumentContainsPii(storageKey: string): boolean {
  const lowered = storageKey.toLowerCase();
  return (
    /nik|email|phone|nama|guest|ktp-\d{16}/i.test(lowered) ||
    lowered.includes('@')
  );
}

export function basenameFromStorageKey(storageKey: string): string {
  return path.posix.basename(storageKey.replace(/\\/g, '/'));
}

export function buildIdentityDocumentApiPath(storageKey: string): string {
  return `/api/identity/document/${basenameFromStorageKey(storageKey)}`;
}

export function parseIdentityDocumentBasename(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^https?:\/\/[^/]+/i, '').split('?')[0];
  const parts = cleaned.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (!last || last.includes('..') || !SAFE_BASENAME.test(last)) return null;
  return last;
}

export function buildIdentityStorageKeyFromBasename(propertyId: number, basename: string): string | null {
  const parsedPropertyId = Number(propertyId);
  if (!Number.isInteger(parsedPropertyId) || parsedPropertyId <= 0) return null;
  if (!basename || basename.includes('..') || !SAFE_BASENAME.test(basename)) return null;
  if (!UUID_FILENAME.test(basename)) return null;
  return `${PRIVATE_IDENTITY_DOCUMENT_PREFIX}${parsedPropertyId}/${basename}`;
}

export function isLegacyIdentityApiPath(raw: string | null | undefined): boolean {
  const basename = parseIdentityDocumentBasename(raw);
  return !!basename && !UUID_FILENAME.test(basename);
}

export async function persistIdentityDocument(params: {
  propertyId: number;
  buffer: Buffer;
  mimeType: string;
  originalFilename?: string | null;
  size?: number;
}): Promise<IdentityDocumentPersistResult> {
  const mimeType = (params.mimeType || '').toLowerCase() === 'image/jpg'
    ? 'image/jpeg'
    : params.mimeType;
  const validation = validateIdentityDocumentUpload({
    buffer: params.buffer,
    mimetype: mimeType,
    size: params.size,
    originalname: params.originalFilename || undefined
  });
  if (!validation.valid) {
    httpError(validation.error || 'File identitas tidak valid.', 400, validation.code || 'INVALID_FILE');
  }

  const storageKey = generateIdentityDocumentStorageKey(
    params.propertyId,
    mimeType,
    params.originalFilename
  );
  if (identityDocumentContainsPii(storageKey)) {
    httpError('Object key dokumen identitas tidak boleh mengandung data pribadi.', 500, 'INVALID_STORAGE_KEY');
  }

  const adapter = getIdentityStorageAdapter();
  await adapter.savePhoto(storageKey, params.buffer, mimeType);

  return {
    storageKey,
    apiPath: buildIdentityDocumentApiPath(storageKey),
    basename: basenameFromStorageKey(storageKey),
    hash: calculatePhotoHash(params.buffer),
    mimeType,
    originalFilename: params.originalFilename ? path.basename(params.originalFilename) : null,
    fileSizeBytes: params.buffer.length,
    provider: adapter.provider
  };
}

export async function identityDocumentExists(storageKey: string): Promise<boolean> {
  if (!isIdentityDocumentStorageKey(storageKey)) return false;
  try {
    return await getIdentityStorageAdapter().photoExists(storageKey);
  } catch {
    return false;
  }
}

export async function readIdentityDocument(
  storageKey: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!isIdentityDocumentStorageKey(storageKey)) return null;
  const adapter = getIdentityStorageAdapter();
  const mimeType = inferIdentityMimeFromName(storageKey);

  if (typeof adapter.readPhoto === 'function') {
    const buffer = await adapter.readPhoto(storageKey);
    if (!buffer) return null;
    return { buffer, mimeType };
  }

  if (adapter.provider === 'local') {
    const absolutePath = resolveAbsolutePath(storageKey);
    if (!fs.existsSync(absolutePath)) return null;
    return { buffer: await fs.promises.readFile(absolutePath), mimeType };
  }

  try {
    const bucket = (adapter as { getBucket?: () => { file: (key: string) => { download: () => Promise<Buffer[]> } } }).getBucket?.();
    if (!bucket) return null;
    const [buffer] = await bucket.file(storageKey).download();
    return { buffer, mimeType };
  } catch {
    return null;
  }
}

export async function writeIdentityOcrTempFile(buffer: Buffer, mimeType: string): Promise<string> {
  const ext = getExtensionFromIdentityMime(mimeType);
  const tempPath = path.join(os.tmpdir(), `oak-identity-ocr-${crypto.randomUUID()}${ext}`);
  await fs.promises.writeFile(tempPath, buffer);
  return tempPath;
}

export async function cleanupIdentityTempFile(tempPath: string | null | undefined): Promise<void> {
  if (!tempPath) return;
  try {
    const resolved = path.resolve(tempPath);
    const tmpRoot = path.resolve(os.tmpdir());
    if (!resolved.startsWith(tmpRoot)) return;
    if (fs.existsSync(resolved)) {
      await fs.promises.unlink(resolved);
    }
  } catch (err) {
    console.warn('[IDENTITY STORAGE] Failed to cleanup OCR temp file:', err);
  }
}
