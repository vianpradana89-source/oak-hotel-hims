import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  calculatePhotoHash,
  getExtensionFromMime,
  getStorageAdapter,
  resolveAbsolutePath,
  validateFacePhotoUpload,
  type StorageProviderType
} from '../auth/faceEnrollmentStorageService';

export const PRIVATE_ATTENDANCE_SELFIE_PREFIX = 'attendance-selfie/';
export const LEGACY_PUBLIC_ATTENDANCE_PREFIX = 'attendance/';

const LEGACY_UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');
const LEGACY_ATTENDANCE_UPLOADS_DIR = path.join(LEGACY_UPLOADS_DIR, 'attendance');

export function isPrivateAttendanceSelfieKey(storageKey: string | null | undefined): boolean {
  return typeof storageKey === 'string' && storageKey.startsWith(PRIVATE_ATTENDANCE_SELFIE_PREFIX);
}

export function isLegacyPublicAttendanceKey(storageKey: string | null | undefined): boolean {
  return (
    typeof storageKey === 'string' &&
    storageKey.startsWith(LEGACY_PUBLIC_ATTENDANCE_PREFIX) &&
    !storageKey.startsWith(PRIVATE_ATTENDANCE_SELFIE_PREFIX)
  );
}

export function generateAttendanceSelfieStorageKey(
  propertyId: number,
  employeeId: number,
  mimeType: string
): string {
  const uuid = crypto.randomUUID();
  const ext = getExtensionFromMime(mimeType);
  return `${PRIVATE_ATTENDANCE_SELFIE_PREFIX}${propertyId}/${employeeId}/${uuid}${ext}`;
}

export async function saveAttendanceSelfie(params: {
  propertyId: number;
  employeeId: number;
  file: {
    mimetype: string;
    size: number;
    buffer: Buffer;
  };
}): Promise<{
  storageKey: string;
  hash: string;
  mimeType: string;
  fileSizeBytes: number;
  capturedAt: string;
  provider: StorageProviderType;
}> {
  const validation = validateFacePhotoUpload(params.file);
  if (!validation.valid) {
    const err: any = new Error(validation.error || 'File foto absensi tidak valid.');
    err.statusCode = 400;
    err.code = validation.code || 'INVALID_FILE';
    throw err;
  }

  const storageKey = generateAttendanceSelfieStorageKey(
    params.propertyId,
    params.employeeId,
    params.file.mimetype
  );
  const adapter = getStorageAdapter();
  await adapter.savePhoto(storageKey, params.file.buffer, params.file.mimetype);

  return {
    storageKey,
    hash: calculatePhotoHash(params.file.buffer),
    mimeType: params.file.mimetype,
    fileSizeBytes: params.file.buffer.length,
    capturedAt: new Date().toISOString(),
    provider: adapter.provider
  };
}

export async function deleteAttendanceSelfie(storageKey: string): Promise<void> {
  if (!storageKey || storageKey.includes('..') || !isPrivateAttendanceSelfieKey(storageKey)) {
    return;
  }
  try {
    const adapter = getStorageAdapter();
    await adapter.deletePhoto(storageKey);
  } catch (err) {
    console.warn(`[ATTENDANCE SELFIE] Failed to cleanup object ${storageKey}:`, err);
  }
}

export async function readAttendanceSelfieBuffer(
  storageKey: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!storageKey || storageKey.includes('..') || !isPrivateAttendanceSelfieKey(storageKey)) {
    return null;
  }

  const adapter = getStorageAdapter();
  const ext = path.extname(storageKey).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  };
  const mimeType = mimeMap[ext] || 'image/jpeg';

  if (adapter.provider === 'local') {
    const absolutePath = resolveAbsolutePath(storageKey);
    if (!fs.existsSync(absolutePath)) {
      return null;
    }
    return { buffer: await fs.promises.readFile(absolutePath), mimeType };
  }

  try {
    const bucket = (adapter as { getBucket?: () => { file: (key: string) => { download: () => Promise<Buffer[]> } } }).getBucket?.();
    if (!bucket) {
      return null;
    }
    const [buffer] = await bucket.file(storageKey).download();
    return { buffer, mimeType };
  } catch {
    return null;
  }
}

/** Legacy read-only path for historical selfies written under public /uploads. */
export function getLegacyAttendancePhotoFilePath(storageKey: string): string | null {
  if (!storageKey || storageKey.includes('..') || !isLegacyPublicAttendanceKey(storageKey)) {
    return null;
  }
  const cleanKey = storageKey.replace(/^attendance\//, '');
  const fullPath = path.join(LEGACY_ATTENDANCE_UPLOADS_DIR, cleanKey);
  if (fs.existsSync(fullPath)) {
    return fullPath;
  }
  return null;
}

export function inferMimeFromStorageKey(storageKey: string): string {
  const ext = path.extname(storageKey).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
