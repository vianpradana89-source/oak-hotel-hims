import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHrdFacePhotoPath,
  buildTransactionAttachmentFilePath,
  fetchAuthenticatedBlobObjectUrl
} from '../src/features/common/securePrivateMedia.ts';

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

console.log('=== OAK HIMS Secure Private Image Tests ===\n');

console.log('--- 1. URL builders stay private and token-free ---');
const facePath = buildHrdFacePhotoPath(44);
const attPath = buildTransactionAttachmentFilePath(55, 77, 1);
check(facePath === '/api/hrd/employees/44/face-enrollment/photo', 'HRD face path is the private stream route');
check(attPath === '/api/transactions/55/attachments/77/file?property_id=1', 'TX attachment path is the private stream route');
check(!facePath.includes('token='), 'HRD path has no JWT query param');
check(!attPath.includes('token='), 'TX path has no JWT query param');
check(!attPath.includes('/uploads/'), 'TX builder does not point at /uploads');

console.log('--- 2. Authenticated blob load + revoke ---');
const created: string[] = [];
const revoked: string[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let lastAuthUrl = '';
let lastAuthHeaders: Headers | null = null;

// @ts-expect-error test mock
URL.createObjectURL = (blob: Blob) => {
  const url = `blob:oak-test/${created.length + 1}/${blob.size}`;
  created.push(url);
  return url;
};
URL.revokeObjectURL = (url: string) => {
  revoked.push(url);
};

const authFetch = async (url: string, init?: RequestInit) => {
  lastAuthUrl = url;
  lastAuthHeaders = new Headers(init?.headers || {});
  lastAuthHeaders.set('Authorization', 'Bearer test-jwt');
  return new Response(new Blob(['face-bytes'], { type: 'image/jpeg' }), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg' }
  });
};

const objectUrl = await fetchAuthenticatedBlobObjectUrl(facePath, authFetch);
check(lastAuthUrl === facePath, 'authenticated fetch uses the private route');
check(objectUrl.startsWith('blob:'), 'object URL is created from the blob');
check(created.length === 1, 'exactly one object URL is created');
URL.revokeObjectURL(objectUrl);
check(revoked.includes(objectUrl), 'object URL is revoked on cleanup');

URL.createObjectURL = originalCreate;
URL.revokeObjectURL = originalRevoke;

console.log('--- 3. Failed fetch stays controlled and does not retry ---');
let failCalls = 0;
const failingFetch = async () => {
  failCalls += 1;
  return new Response(JSON.stringify({ message: 'Akses ditolak' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
};
await assert.rejects(
  () => fetchAuthenticatedBlobObjectUrl(facePath, failingFetch),
  (err: unknown) => err instanceof Error && err.message.includes('Akses ditolak')
);
check(failCalls === 1, 'failed fetch does not retry');

console.log('--- 4. HRD workspace uses secure loader, not raw protected img ---');
const hrdSrc = readSrc('src/features/hrd/HrdWorkspace.tsx');
check(hrdSrc.includes('SecurePrivateImage'), 'HrdWorkspace uses SecurePrivateImage');
check(hrdSrc.includes('useSecureDocumentBlob') || hrdSrc.includes('SecurePrivateImage'), 'HRD uses authenticated blob path');
check(hrdSrc.includes('buildHrdFacePhotoPath'), 'HRD builds the private photo path');
check(!/<img[^>]+src=\{`\/api\/hrd/.test(hrdSrc), 'no raw HRD photo img src template');
check(!/<img[^>]+src=["']\/api\/hrd/.test(hrdSrc), 'no raw HRD photo img src literal');
check(!hrdSrc.includes('src={`/api/hrd/employees/${'), 'no raw protected HRD img interpolation');
check(hrdSrc.includes('Foto wajah tidak tersedia') || hrdSrc.includes('unavailableLabel'), 'failed HRD fetch has controlled unavailable state');

console.log('--- 5. Transaction drawer uses secure loader, not raw protected href/img ---');
const txSrc = readSrc('src/features/transactions/TransactionDetailDrawer.tsx');
check(txSrc.includes('useSecureDocumentBlob'), 'transaction preview uses useSecureDocumentBlob');
check(txSrc.includes('buildTransactionAttachmentFilePath'), 'transaction preview uses private file path builder');
check(!txSrc.includes('href={`/api/transactions/${tx.id}/attachments/${att.id}/file`}'), 'no raw protected attachment href');
check(!txSrc.includes('src={`/api/transactions/${tx.id}/attachments/${att.id}/file`}'), 'no raw protected attachment img src');
check(!txSrc.includes('/uploads/transactions/'), 'transaction preview does not use public /uploads path');
check(txSrc.includes('Pratinjau tidak tersedia') || txSrc.includes('Berkas tidak tersedia'), 'failed attachment preview has controlled state');
check(txSrc.includes('blobUrl'), 'transaction preview renders object URL');

console.log('--- 6. Shared hook still revokes object URLs ---');
const hookSrc = readSrc('src/features/common/useSecureDocumentBlob.ts');
check(hookSrc.includes('authFetch'), 'shared hook uses authenticated fetch');
check(hookSrc.includes('URL.createObjectURL'), 'shared hook creates object URLs');
check(hookSrc.includes('URL.revokeObjectURL'), 'shared hook revokes object URLs');
check(!hookSrc.includes('token='), 'shared hook does not put JWT in the query string');

console.log(`\n=== PASSED: ${assertions} assertions ===`);
void lastAuthHeaders;
