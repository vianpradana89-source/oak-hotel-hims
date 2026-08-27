import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

export async function saveEvidenceFile(
  propertyId: number,
  file: {
    mimetype: string;
    size: number;
    originalname: string;
    buffer: Buffer;
  }
): Promise<{ storageKey: string; absolutePath: string; fileSizeBytes: number }> {
  const validation = validateEvidenceUpload(file);
  if (!validation.valid) {
    throw { statusCode: 400, code: validation.code, message: validation.error };
  }

  const storageKey = generateStorageKey(propertyId, file.mimetype, file.originalname);
  const absolutePath = resolveAbsolutePath(storageKey);
  const dirPath = path.dirname(absolutePath);

  ensureDirectory(dirPath);
  await fs.promises.writeFile(absolutePath, file.buffer);

  return {
    storageKey,
    absolutePath,
    fileSizeBytes: file.size
  };
}

export async function deleteEvidenceFile(storageKey: string): Promise<void> {
  try {
    const absolutePath = resolveAbsolutePath(storageKey);
    if (fs.existsSync(absolutePath)) {
      await fs.promises.unlink(absolutePath);
    }
  } catch (err) {
    console.error(`Failed to delete evidence file at ${storageKey}:`, err);
  }
}

export function evidenceFileExists(storageKey: string): boolean {
  const absolutePath = resolveAbsolutePath(storageKey);
  return fs.existsSync(absolutePath);
}

export function getEvidenceFileBuffer(storageKey: string): Buffer {
  const absolutePath = resolveAbsolutePath(storageKey);
  if (!fs.existsSync(absolutePath)) {
    throw { statusCode: 404, code: 'FILE_NOT_FOUND', message: 'Evidence file not found in storage' };
  }
  return fs.readFileSync(absolutePath);
}

export function createEvidenceReadStream(storageKey: string): fs.ReadStream {
  const absolutePath = resolveAbsolutePath(storageKey);
  if (!fs.existsSync(absolutePath)) {
    throw { statusCode: 404, code: 'FILE_NOT_FOUND', message: 'Evidence file not found in storage' };
  }
  return fs.createReadStream(absolutePath);
}
