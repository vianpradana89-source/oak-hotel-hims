export function buildHrdFacePhotoPath(employeeId: number | string): string {
  return `/api/hrd/employees/${employeeId}/face-enrollment/photo`;
}

export function buildTransactionAttachmentFilePath(
  transactionId: number | string,
  attachmentId: number | string,
  propertyId?: number
): string {
  const base = `/api/transactions/${transactionId}/attachments/${attachmentId}/file`;
  if (propertyId == null || !Number.isInteger(propertyId) || propertyId <= 0) {
    return base;
  }
  return `${base}?property_id=${propertyId}`;
}

export async function fetchAuthenticatedBlobObjectUrl(
  url: string,
  authFetch: (input: string, init?: RequestInit) => Promise<Response>
): Promise<string> {
  const res = await authFetch(url);
  if (!res.ok) {
    const errData = await res.json().catch(() => ({} as { message?: string }));
    const error = new Error(errData.message || `Gagal memuat dokumen (${res.status})`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
