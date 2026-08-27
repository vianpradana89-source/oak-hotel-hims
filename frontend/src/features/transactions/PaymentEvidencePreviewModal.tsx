import React, { useEffect } from 'react';
import type {
  PaymentEvidenceItem
} from './paymentEvidenceTypes.ts';
import {
  formatEvidenceDate,
  formatEvidenceFileSize,
  formatEvidenceType,
  isEvidenceImage,
  isEvidencePdf
} from './paymentEvidenceHelpers.ts';
import { formatActorName } from './paymentCorrectionHelpers.ts';

interface PaymentEvidencePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  evidence: PaymentEvidenceItem | null;
  propertyId: number;
  apiBaseUrl?: string;
}

export const PaymentEvidencePreviewModal: React.FC<PaymentEvidencePreviewModalProps> = ({
  isOpen,
  onClose,
  evidence,
  propertyId,
  apiBaseUrl = ''
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !evidence) return null;

  const contentUrl = `${apiBaseUrl}/api/reservations/${evidence.reservation_id}/payments/${evidence.payment_transaction_id}/evidences/${evidence.id}/content?property_id=${propertyId}`;
  const downloadUrl = `${contentUrl}&download=1`;

  const isImg = isEvidenceImage(evidence.mime_type);
  const isPdf = isEvidencePdf(evidence.mime_type);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh] border border-slate-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center space-x-3">
            <span className="text-xl">📎</span>
            <div>
              <h3 className="text-base font-bold text-white tracking-wide truncate max-w-md">
                {evidence.original_filename}
              </h3>
              <div className="flex items-center space-x-2 text-xs text-slate-300">
                <span className="font-semibold text-emerald-400">
                  {formatEvidenceType(evidence.evidence_type)}
                </span>
                <span>•</span>
                <span>{formatEvidenceFileSize(evidence.file_size_bytes)}</span>
                <span>•</span>
                <span>{formatEvidenceDate(evidence.uploaded_at)}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <a
              href={downloadUrl}
              download={evidence.original_filename}
              className="inline-flex items-center px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
              title="Unduh file bukti"
            >
              📥 Unduh
            </a>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
              aria-label="Tutup"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-auto bg-slate-950 p-4 flex items-center justify-center min-h-[300px]">
          {isImg && (
            <img
              src={contentUrl}
              alt={evidence.original_filename}
              className="max-h-[60vh] max-w-full object-contain rounded shadow-lg border border-slate-800"
            />
          )}

          {isPdf && (
            <div className="w-full h-[65vh] flex flex-col items-center justify-center bg-white rounded-lg p-2">
              <iframe
                src={contentUrl}
                title={evidence.original_filename}
                className="w-full h-full rounded border-0"
              />
            </div>
          )}

          {!isImg && !isPdf && (
            <div className="text-center p-8 bg-slate-900 rounded-xl border border-slate-800">
              <div className="text-4xl mb-3">📄</div>
              <p className="text-slate-200 font-semibold mb-2">Pratinjau langsung tidak didukung untuk tipe file ini</p>
              <a
                href={downloadUrl}
                download={evidence.original_filename}
                className="inline-block mt-3 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold"
              >
                Unduh untuk Melihat
              </a>
            </div>
          )}
        </div>

        {/* Metadata Footer */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 text-xs text-slate-600 flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            {evidence.note && (
              <div>
                <span className="font-semibold text-slate-700">Catatan: </span>
                <span className="text-slate-600">{evidence.note}</span>
              </div>
            )}
            <div>
              <span className="font-semibold text-slate-700">Pengunggah: </span>
              <span className="text-slate-600">{formatActorName(evidence.uploaded_by_name_snapshot)}</span>
              {evidence.uploaded_by_role_snapshot && (
                <span className="ml-1 text-slate-500">({evidence.uploaded_by_role_snapshot})</span>
              )}
            </div>
          </div>
          <div>
            {!evidence.is_active && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-rose-100 text-rose-800 border border-rose-300">
                Bukti Dinonaktifkan: {evidence.deactivation_reason || '-'}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
