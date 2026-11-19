import React, { useState, useRef, useEffect } from 'react';
import { useSecureDocumentBlob } from '../common/useSecureDocumentBlob';
import { useAuth } from '../auth/AuthContext';

export interface PaymentProofModalProps {
  filePath: string | null;
  title: string;
  onClose: () => void;
  uploadId?: string | number | null;
  propertyId?: number;
  onUploaded?: (newFilePath?: string) => void;
}

function deriveUploadTargetId(filePath: string | null, explicitId?: string | number | null): string | null {
  if (explicitId !== undefined && explicitId !== null && String(explicitId).trim() !== '') {
    return String(explicitId).trim();
  }
  if (!filePath) return null;
  const txMatch = filePath.match(/\/api\/transactions\/(\d+)\/attachments\//);
  if (txMatch?.[1]) {
    return `HIMS-PUR-${txMatch[1]}`;
  }
  const apMatch = filePath.match(/\/api\/reports\/accounting\/payables\/(\d+)\/proof/);
  if (apMatch?.[1]) {
    return `MANUAL-AP-${apMatch[1]}`;
  }
  return null;
}

export const PaymentProofModal: React.FC<PaymentProofModalProps> = ({
  filePath,
  title,
  onClose,
  uploadId = null,
  propertyId = 1,
  onUploaded,
}) => {
  const { authFetch } = useAuth();
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(filePath);
  const { blobUrl, mimeType, loading, error } = useSecureDocumentBlob(currentFilePath, Boolean(currentFilePath));
  const [imageFailed, setImageFailed] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCurrentFilePath(filePath);
    setImageFailed(false);
    setUploadError(null);
  }, [filePath]);

  const targetId = deriveUploadTargetId(currentFilePath, uploadId);

  if (!currentFilePath && !targetId) return null;

  const isPdfFile = Boolean(
    (mimeType && mimeType.includes('pdf')) ||
      (currentFilePath && currentFilePath.toLowerCase().split('?')[0].endsWith('.pdf'))
  );

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !targetId) return;

    setUploading(true);
    setUploadError(null);
    setImageFailed(false);
    try {
      const formData = new FormData();
      formData.append('property_id', String(propertyId || 1));
      formData.append('file', file);

      const res = await authFetch(`/api/reports/accounting/payables/${encodeURIComponent(targetId)}/proof`, {
        method: 'POST',
        body: formData,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal mengunggah bukti bayar');
      }

      const nextPath = json.data?.file_path || currentFilePath;
      if (nextPath) {
        setCurrentFilePath(nextPath);
      }
      if (onUploaded) {
        onUploaded(nextPath || undefined);
      }
    } catch (err: any) {
      setUploadError(err.message || 'Gagal mengunggah bukti bayar');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-3xl w-full overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 bg-slate-50/80">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-600" />
            <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition cursor-pointer"
          >
            ✕
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="hidden"
          onChange={handleFileChange}
        />

        <div className="p-5 overflow-auto flex-1 flex items-center justify-center min-h-[360px] bg-slate-100/50">
          {loading || uploading ? (
            <div className="text-center text-slate-500 text-xs flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
              <span>{uploading ? 'Mengunggah & menyimpan bukti bayar...' : 'Memuat dokumen bukti bayar...'}</span>
            </div>
          ) : error || !blobUrl ? (
            <div className="text-center max-w-md px-4 flex flex-col items-center gap-3">
              <div className="text-rose-600 text-xs font-semibold">
                {uploadError || error || 'Berkas bukti bayar belum tersedia.'}
              </div>
              {targetId && (
                <div className="flex flex-col items-center gap-2 mt-1">
                  <p className="text-[11px] text-slate-500">
                    Unggah file gambar (JPG, PNG, WEBP) atau PDF bukti transfer untuk disimpan permanen.
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2.5 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-bold transition shadow-sm inline-flex items-center gap-2 cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Pilih &amp; Unggah Bukti Bayar
                  </button>
                </div>
              )}
            </div>
          ) : isPdfFile || imageFailed ? (
            <div className="w-full flex flex-col items-center gap-3">
              {uploadError && (
                <div className="text-rose-600 text-xs font-semibold">{uploadError}</div>
              )}
              <iframe
                src={blobUrl}
                title={title}
                className="w-full h-[62vh] rounded-lg border border-slate-200 bg-white shadow-sm"
              />
              <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                <a
                  href={blobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-bold transition shadow-sm inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  Buka Dokumen di Tab Penuh
                </a>
                <a
                  href={blobUrl}
                  download="bukti-bayar"
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition border border-slate-300 inline-flex items-center gap-1.5 cursor-pointer"
                >
                  Unduh Berkas
                </a>
                {targetId && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 rounded-xl bg-white hover:bg-slate-50 text-emerald-800 text-xs font-bold transition border border-emerald-300 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    Ganti Bukti Bayar
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="w-full flex flex-col items-center gap-3">
              {uploadError && (
                <div className="text-rose-600 text-xs font-semibold">{uploadError}</div>
              )}
              <img
                src={blobUrl}
                alt={title}
                className="max-h-[62vh] max-w-full object-contain rounded-lg shadow-sm border border-slate-200 bg-white"
                onError={() => {
                  setImageFailed(true);
                }}
              />
              <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                <a
                  href={blobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-bold transition shadow-sm inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  Buka Gambar di Tab Penuh
                </a>
                <a
                  href={blobUrl}
                  download="bukti-bayar"
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition border border-slate-300 inline-flex items-center gap-1.5 cursor-pointer"
                >
                  Unduh Berkas
                </a>
                {targetId && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 rounded-xl bg-white hover:bg-slate-50 text-emerald-800 text-xs font-bold transition border border-emerald-300 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    Ganti Bukti Bayar
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
