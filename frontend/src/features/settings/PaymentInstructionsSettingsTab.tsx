import React, { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import type {
  PropertyPaymentInstructionsDto,
  UpdatePropertyPaymentInstructionsPayload,
} from './paymentInstructionsTypes';

export interface PaymentInstructionsSettingsTabProps {
  propertyId: number;
  activeProperty?: {
    id: number;
    name: string;
    property_code?: string;
  };
  apiBaseUrl?: string;
}

export const PaymentInstructionsSettingsTab: React.FC<PaymentInstructionsSettingsTabProps> = ({
  propertyId,
  activeProperty,
  apiBaseUrl = '/api',
}) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Form states
  const [bankName, setBankName] = useState<string>('');
  const [bankAccountName, setBankAccountName] = useState<string>('');
  const [bankAccountNumber, setBankAccountNumber] = useState<string>('');
  const [bankBranch, setBankBranch] = useState<string>('');
  const [paymentNote, setPaymentNote] = useState<string>('');
  const [isActive, setIsActive] = useState<boolean>(true);

  // Metadata
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);

  // Initial copy for cancel/reset
  const [initialData, setInitialData] = useState<PropertyPaymentInstructionsDto | null>(null);

  const applyData = (data: PropertyPaymentInstructionsDto) => {
    setBankName(data.bank_name || '');
    setBankAccountName(data.bank_account_name || '');
    setBankAccountNumber(data.bank_account_number || '');
    setBankBranch(data.bank_branch || '');
    setPaymentNote(data.payment_note || '');
    setIsActive(data.is_active !== false);
    setUpdatedAt(data.updated_at || null);
    setUpdatedBy(data.updated_by || null);
    setInitialData(data);
  };

  const loadInstructions = useCallback(async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch(
        `${apiBaseUrl}/settings/property/payment-instructions?property_id=${propertyId}`
      );
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `Gagal memuat instruksi pembayaran (HTTP ${res.status})`);
      }
      const json = await res.json();
      if (json.data) {
        applyData(json.data);
      }
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Gagal memuat konfigurasi instruksi pembayaran.',
      });
    } finally {
      setLoading(false);
    }
  }, [propertyId, apiBaseUrl]);

  useEffect(() => {
    loadInstructions();
  }, [loadInstructions]);

  const handleReset = () => {
    if (initialData) {
      applyData(initialData);
      setFeedback(null);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);

    const payload: UpdatePropertyPaymentInstructionsPayload = {
      property_id: propertyId,
      bank_name: bankName.trim() || null,
      bank_account_name: bankAccountName.trim() || null,
      bank_account_number: bankAccountNumber.trim() || null,
      bank_branch: bankBranch.trim() || null,
      payment_note: paymentNote.trim() || null,
      is_active: isActive,
    };

    try {
      const res = await authenticatedFetch(
        `${apiBaseUrl}/settings/property/payment-instructions`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menyimpan instruksi pembayaran.');
      }

      if (json.data) {
        applyData(json.data);
      }

      setFeedback({
        type: 'success',
        message: 'Instruksi pembayaran properti berhasil disimpan.',
      });
      setTimeout(() => setFeedback(null), 5000);
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Terjadi kesalahan saat menyimpan pengaturan.',
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-neutral-200/90 p-8 text-center space-y-3 shadow-xs">
        <div className="inline-block animate-spin w-6 h-6 border-2 border-emerald-700 border-t-transparent rounded-full" />
        <p className="text-xs text-neutral-500 font-medium">Memuat instruksi pembayaran...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Property Context Header */}
      <div className="bg-white rounded-2xl border border-neutral-200/90 p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-neutral-900 tracking-tight">
                Instruksi Pembayaran Properti
              </h2>
              <span className="px-2.5 py-0.5 text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full">
                Dokumen & Billing
              </span>
            </div>
            <p className="text-xs text-neutral-500 mt-1">
              Konfigurasi rekening bank resmi dan catatan transfer yang digunakan untuk auto-prefill penawaran (Quotation) dan Invoice tamu.
            </p>
          </div>

          {activeProperty && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#faf9f6] border border-[#e5dfd3] rounded-xl self-start sm:self-auto">
              <span className="w-2 h-2 rounded-full bg-emerald-600" />
              <span className="text-xs font-semibold text-neutral-800">
                {activeProperty.name}
              </span>
              {activeProperty.property_code && (
                <span className="text-[10px] px-1.5 py-0.5 bg-neutral-200 text-neutral-700 rounded font-mono font-bold">
                  {activeProperty.property_code}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Feedback Alert */}
      {feedback && (
        <div
          className={`p-3.5 rounded-xl text-xs font-semibold border flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-neutral-400 hover:text-neutral-700 font-bold ml-3"
          >
            ×
          </button>
        </div>
      )}

      {/* Form Card */}
      <form onSubmit={handleSave} className="bg-white rounded-2xl border border-neutral-200/90 p-5 shadow-xs space-y-6">
        {/* Section 1: Bank Information */}
        <div className="space-y-4">
          <div className="border-b border-neutral-100 pb-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-600">
              Informasi Rekening Bank
            </h3>
            <p className="text-[11px] text-neutral-400">
              Data rekening tujuan transfer pembayaran oleh tamu atau instansi.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-neutral-700 mb-1">
                Nama Bank
              </label>
              <input
                type="text"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="Contoh: BCA / Bank Mandiri / BRI / BNI"
                className="w-full text-xs px-3 py-2 border border-neutral-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-700/30 focus:border-emerald-700 transition"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-neutral-700 mb-1">
                Nomor Rekening
              </label>
              <input
                type="text"
                value={bankAccountNumber}
                onChange={(e) => setBankAccountNumber(e.target.value)}
                placeholder="Contoh: 1234567890"
                className="w-full text-xs px-3 py-2 border border-neutral-300 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-emerald-700/30 focus:border-emerald-700 transition"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-neutral-700 mb-1">
                Nama Rekening / Atas Nama
              </label>
              <input
                type="text"
                value={bankAccountName}
                onChange={(e) => setBankAccountName(e.target.value)}
                placeholder="Contoh: PT Oak Hotel Management"
                className="w-full text-xs px-3 py-2 border border-neutral-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-700/30 focus:border-emerald-700 transition"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-neutral-700 mb-1">
                Cabang Bank (Opsional)
              </label>
              <input
                type="text"
                value={bankBranch}
                onChange={(e) => setBankBranch(e.target.value)}
                placeholder="Contoh: KCP Lawang Malang"
                className="w-full text-xs px-3 py-2 border border-neutral-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-700/30 focus:border-emerald-700 transition"
              />
            </div>
          </div>
        </div>

        {/* Section 2: Payment Notes & Instructions */}
        <div className="space-y-4">
          <div className="border-b border-neutral-100 pb-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-600">
              Catatan & Petunjuk Transfer
            </h3>
            <p className="text-[11px] text-neutral-400">
              Petunjuk transfer tambahan yang tercetak pada lembar penawaran / invoice.
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold text-neutral-700 mb-1">
              Catatan Pembayaran
            </label>
            <textarea
              rows={3}
              value={paymentNote}
              onChange={(e) => setPaymentNote(e.target.value)}
              placeholder="Contoh: Mohon sertakan Kode Booking pada berita transfer dan kirimkan bukti pembayaran ke WhatsApp Front Desk."
              className="w-full text-xs px-3 py-2 border border-neutral-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-700/30 focus:border-emerald-700 transition resize-y"
            />
          </div>
        </div>

        {/* Section 3: Status Toggle */}
        <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-200/80 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold text-neutral-800">
              Aktifkan Instruksi Pembayaran
            </div>
            <div className="text-[11px] text-neutral-500">
              Jika aktif, instruksi ini akan otomatis diprefill saat membuat dokumen penawaran atau invoice.
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-neutral-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-700"></div>
          </label>
        </div>

        {/* Audit info */}
        {updatedAt && (
          <div className="text-[11px] text-neutral-400 italic">
            Terakhir diperbarui:{' '}
            <span className="font-medium text-neutral-600">
              {new Date(updatedAt).toLocaleString('id-ID')}
            </span>
            {updatedBy && (
              <>
                {' '}oleh <span className="font-semibold text-neutral-700">{updatedBy}</span>
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-neutral-100">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving}
            className="px-4 py-2 text-xs font-semibold text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-xl transition cursor-pointer disabled:opacity-50"
          >
            Batal
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 text-xs font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl shadow-xs transition flex items-center gap-2 cursor-pointer disabled:opacity-60"
          >
            {saving ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Menyimpan...</span>
              </>
            ) : (
              <span>Simpan Instruksi Pembayaran</span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
