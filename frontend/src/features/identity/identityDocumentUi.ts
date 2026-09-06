export const IDENTITY_DOCUMENT_MISSING_CODE = 'DOCUMENT_FILE_MISSING';
export const IDENTITY_DOCUMENT_MISSING_MESSAGE =
  'Dokumen tercatat, tetapi file fisik tidak tersedia.';

export function isHistoricalIdentityFileMissing(errorCode?: string | null, message?: string | null): boolean {
  if (errorCode === IDENTITY_DOCUMENT_MISSING_CODE) return true;
  return typeof message === 'string' && message.includes('file fisik tidak tersedia');
}
