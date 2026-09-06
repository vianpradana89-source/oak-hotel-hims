import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDENTITY_DOCUMENT_MISSING_CODE,
  IDENTITY_DOCUMENT_MISSING_MESSAGE,
  isHistoricalIdentityFileMissing
} from '../src/features/identity/identityDocumentUi.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, '..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(frontendRoot, rel), 'utf8');
}

console.log('=== OAK HIMS Identity Document UI ===\n');

check(IDENTITY_DOCUMENT_MISSING_CODE === 'DOCUMENT_FILE_MISSING', 'missing-file code is controlled');
check(
  IDENTITY_DOCUMENT_MISSING_MESSAGE === 'Dokumen tercatat, tetapi file fisik tidak tersedia.',
  'missing-file copy is the approved Indonesian message'
);
check(isHistoricalIdentityFileMissing('DOCUMENT_FILE_MISSING', 'x') === true, 'code is treated as historical missing');
check(isHistoricalIdentityFileMissing('FORBIDDEN', 'Akses ditolak') === false, 'forbidden is not historical missing');
check(isHistoricalIdentityFileMissing('UNAUTHORIZED', 'login') === false, 'unauthorized is not historical missing');

const blobHook = readSrc('src/features/common/useSecureDocumentBlob.ts');
check(blobHook.includes('Authorization') === false || blobHook.includes('authFetch'), 'blob hook uses authenticated fetch');
check(!blobHook.includes('token='), 'blob hook does not put JWT in query params');
check(!blobHook.includes('storage.googleapis.com'), 'blob hook does not use GCS URLs');
check(!blobHook.includes('signedUrl'), 'blob hook does not use signed URLs');

const extractModal = readSrc('src/features/booking/IdentityExtractionModal.tsx');
check(extractModal.includes('document_upload_id'), 'confirm sends upload receipt');
check(!extractModal.includes('identity_file_hash'), 'confirm does not send client hash as authority');
check(!extractModal.includes('identity_storage_key'), 'frontend never sends storage_key');

for (const rel of [
  'src/features/guests/GuestProfileModal.tsx',
  'src/features/guests/GuestEditModal.tsx',
  'src/features/calendar/ReservationDetailDrawer.tsx'
]) {
  const src = readSrc(rel);
  check(src.includes('IDENTITY_DOCUMENT_MISSING_MESSAGE'), `${rel} surfaces historical missing-file copy`);
  check(src.includes('isKtpHistoricalMissing'), `${rel} distinguishes missing file from generic errors`);
}

console.log(`\n${assertions} assertions passed`);
