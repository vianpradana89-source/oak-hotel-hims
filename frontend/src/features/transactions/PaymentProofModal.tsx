import React from 'react';
import { useSecureDocumentBlob } from '../common/useSecureDocumentBlob';

export interface PaymentProofModalProps {
  filePath: string | null;
  title: string;
  onClose: () => void;
}

export const PaymentProofModal: React.FC<PaymentProofModalProps> = ({ filePath, title, onClose }) => {
  const { blobUrl, loading, error } = useSecureDocumentBlob(filePath, Boolean(filePath));

  if (!filePath) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh]"
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
        <div className="p-5 overflow-auto flex-1 flex items-center justify-center min-h-[320px] bg-slate-100/50">
          {loading ? (
            <div className="text-center text-slate-400 text-xs flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
              <span>Memuat dokumen bukti bayar...</span>
            </div>
          ) : error || !blobUrl ? (
            <div className="text-center text-rose-500 text-xs font-semibold">
              Berkas bukti bayar tidak tersedia atau gagal dimuat.
            </div>
          ) : (
            <div className="w-full flex flex-col items-center gap-3">
              <img
                src={blobUrl}
                alt={title}
                className="max-h-[60vh] max-w-full object-contain rounded-lg shadow-sm border border-slate-200"
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
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
                  Buka Dokumen di Tab Penuh
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
