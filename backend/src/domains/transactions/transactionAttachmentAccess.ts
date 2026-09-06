import path from 'path';
import type { Pool } from 'pg';

export const TRANSACTION_ATTACHMENT_UPLOAD_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'uploads',
  'transactions'
);

const SAFE_ATTACHMENT_FILENAME = /^[a-zA-Z0-9_\-\.]+$/;

export interface ScopedTransactionAttachment {
  id: number | string;
  transaction_id: number | string;
  property_id: number;
  mime_type: string | null;
  original_name: string | null;
  file_name: string | null;
  storage_path: string;
}

/**
 * Resolve a stored attachment path to a file inside the transaction upload root.
 * Never follows client-supplied paths; only the basename is used.
 */
export function resolveSafeTransactionAttachmentPath(
  storagePath: string | null | undefined,
  uploadRoot: string = TRANSACTION_ATTACHMENT_UPLOAD_DIR
): string | null {
  if (!storagePath || typeof storagePath !== 'string') return null;
  const normalized = storagePath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\0')) return null;
  if (normalized.split('/').some((part) => part === '..')) return null;

  const base = path.basename(normalized);
  if (!base || base === '.' || base === '..' || base.includes('..')) return null;
  if (!SAFE_ATTACHMENT_FILENAME.test(base)) return null;

  const root = path.resolve(uploadRoot);
  const resolved = path.resolve(root, base);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

export async function getScopedTransactionAttachment(
  pool: Pool,
  propertyId: number,
  transactionId: number,
  attachmentId: number
): Promise<{ transactionFound: boolean; attachment: ScopedTransactionAttachment | null }> {
  const txRes = await pool.query(
    `SELECT id, property_id
     FROM transactions
     WHERE id = $1 AND property_id = $2`,
    [transactionId, propertyId]
  );
  if ((txRes.rowCount ?? 0) === 0) {
    return { transactionFound: false, attachment: null };
  }

  const attRes = await pool.query(
    `SELECT id, transaction_id, property_id, mime_type, original_name, file_name, storage_path
     FROM transaction_attachments
     WHERE id = $1 AND transaction_id = $2 AND property_id = $3`,
    [attachmentId, transactionId, propertyId]
  );
  if ((attRes.rowCount ?? 0) === 0) {
    return { transactionFound: true, attachment: null };
  }

  return { transactionFound: true, attachment: attRes.rows[0] as ScopedTransactionAttachment };
}
