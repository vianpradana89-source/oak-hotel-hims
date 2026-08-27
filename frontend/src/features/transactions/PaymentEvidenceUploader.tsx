import React, { useRef } from 'react';
import {
  EVIDENCE_TYPE_OPTIONS,
  type PaymentEvidenceType
} from './paymentEvidenceTypes.ts';
import {
  formatEvidenceFileSize,
  validateEvidenceFile
} from './paymentEvidenceHelpers.ts';

export interface PaymentEvidenceFormState {
  file: File | null;
  evidenceType: PaymentEvidenceType;
  note: string;
  error?: string;
}

interface PaymentEvidenceUploaderProps {
  state: PaymentEvidenceFormState;
  onChange: (next: PaymentEvidenceFormState) => void;
  disabled?: boolean;
  isRequired?: boolean;
}

export const PaymentEvidenceUploader: React.FC<PaymentEvidenceUploaderProps> = ({
  state,
  onChange,
  disabled = false,
  isRequired = false
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const validation = validateEvidenceFile(selected);
    if (!validation.valid) {
      onChange({
        ...state,
        file: null,
        error: validation.error
      });
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    onChange({
      ...state,
      file: selected,
      error: undefined
    });
  };

  const handleClearFile = () => {
    onChange({
      ...state,
      file: null,
      error: undefined
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="space-y-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
      <div className="flex items-center justify-between">
        <label className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center space-x-1">
          <span>📎 Bukti Pembayaran</span>
          {isRequired && <span className="text-rose-500">*</span>}
        </label>
        <span className="text-[11px] text-slate-500">JPG, PNG, WEBP, PDF (maks 10 MB)</span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={handleFileChange}
        disabled={disabled}
        className="hidden"
        id="payment-evidence-file-input"
      />

      {!state.file ? (
        <div
          onClick={() => !disabled && fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition ${
            disabled
              ? 'border-slate-200 bg-slate-100 cursor-not-allowed opacity-60'
              : 'border-slate-300 hover:border-emerald-500 bg-white hover:bg-emerald-50/30'
          }`}
        >
          <div className="flex flex-col items-center justify-center space-y-1">
            <span className="text-2xl">📸</span>
            <p className="text-xs font-semibold text-slate-700">
              Klik untuk Unggah / Ambil Foto Bukti
            </p>
            <p className="text-[11px] text-slate-400">
              Pilih tangkapan layar transfer, struk EDC, atau foto kwitansi
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-emerald-300 rounded-xl p-3 flex items-center justify-between shadow-sm">
          <div className="flex items-center space-x-3 overflow-hidden">
            <span className="text-2xl">📄</span>
            <div className="truncate">
              <p className="text-xs font-bold text-slate-800 truncate">{state.file.name}</p>
              <p className="text-[11px] text-slate-500">{formatEvidenceFileSize(state.file.size)}</p>
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="text-xs text-emerald-700 hover:text-emerald-800 font-semibold px-2 py-1 rounded hover:bg-emerald-50 transition"
            >
              Ganti
            </button>
            <button
              type="button"
              onClick={handleClearFile}
              disabled={disabled}
              className="text-xs text-rose-600 hover:text-rose-700 font-semibold px-2 py-1 rounded hover:bg-rose-50 transition"
            >
              Hapus
            </button>
          </div>
        </div>
      )}

      {state.error && (
        <p className="text-xs text-rose-600 font-semibold bg-rose-50 p-2 rounded-lg border border-rose-200">
          ⚠️ {state.error}
        </p>
      )}

      {/* Type and Note Selection if file attached or entering details */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Tipe Bukti
          </label>
          <select
            value={state.evidenceType}
            onChange={e => onChange({ ...state, evidenceType: e.target.value as PaymentEvidenceType })}
            disabled={disabled}
            className="w-full text-xs rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            {EVIDENCE_TYPE_OPTIONS.map(opt => (
              <option key={opt.type} value={opt.type}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Catatan Bukti (Opsional)
          </label>
          <input
            type="text"
            value={state.note}
            onChange={e => onChange({ ...state, note: e.target.value })}
            placeholder="Contoh: Transfer via BCA a.n. John"
            disabled={disabled}
            className="w-full text-xs rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
      </div>
    </div>
  );
};
