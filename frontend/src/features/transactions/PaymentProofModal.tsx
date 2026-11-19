import React, { useState } from 'react';
import { useSecureDocumentBlob } from '../common/useSecureDocumentBlob';

export interface PaymentProofModalProps {
  filePath: string | null;
  title: string;
  onClose: () => void;
}

export const PaymentProofModal: React.FC<PaymentProofModalProps> = ({ filePath, title, onClose }) => {
  const { blobUrl, mimeType, loading, error } = useSecureDocumentBlob(filePath, Boolean(filePath));
  const [imageFailed, setImageFailed] = useState<boolean>(false);

  if (!filePath) return null;

  const isPdfFile = Boolean(
    (mimeType && mimeType.includes('pdf')) ||
    filePath.toLowerCase().split('?')[0].endsWith('.pdf')
  );

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
        <div className="p-5 overflow-auto flex-1 flex items-center justify-center min-h-[360px] bg-slate-100/50">
          {loading ? (
            <div className="text-center text-slate-400 text-xs flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
              <span>Memuat dokumen bukti bayar...</span>
            </div>
          ) : error || !blobUrl ? (
            <div className="text-center text-rose-500 text-xs font-semibold max-w-md px-4">
              {error || 'Berkas bukti bayar tidak tersedia atau gagal dimuat.'}
            </div>
          ) : isPdfFile || imageFailed ? (
            <div className="w-full flex flex-col items-center gap-3">
              <iframe
                src={blobUrl}
                title={title}
                className="w-full h-[62vh] rounded-lg border border-slate-200 bg-white shadow-sm"
              />
              <div className="flex items-center gap-2 pt-2">
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
              </div>
            </div>
          ) : (
            <div className="w-full flex flex-col items-center gap-3">
              <img
                src={blobUrl}
                alt={title}
                className="max-h-[62vh] max-w-full object-contain rounded-lg shadow-sm border border-slate-200 bg-white"
                onError={() => {
                  setImageFailed(true);
                }}
              />
              <div className="flex items-center gap-2 pt-2">
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
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
