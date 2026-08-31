import React, { useState, useEffect } from 'react';
import type { CategoryOption, DepartmentOption } from './transactionDomainTypes';
import {
  fetchCategoriesApi,
  createIncomeTransactionApi,
  uploadTransactionAttachmentApi
} from './transactionClient';
import { ExpenseCategoryManagerModal } from './ExpenseCategoryManagerModal';

interface IncomeTransactionEditorProps {
  propertyId: number;
  actorName?: string;
  onBack: () => void;
  onSuccess: (createdId: string | number) => void;
}

export const IncomeTransactionEditor: React.FC<IncomeTransactionEditorProps> = ({
  propertyId,
  actorName = 'Staff',
  onBack,
  onSuccess
}) => {
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);

  // Form State
  const [txDate, setTxDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [categoryCode, setCategoryCode] = useState<string>('INCOME_OTHER');
  const [departmentCode, setDepartmentCode] = useState<string>('GENERAL');
  const [partyName, setPartyName] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [showCategoryModal, setShowCategoryModal] = useState<boolean>(false);
  const [description, setDescription] = useState<string>('');
  const [amount, setAmount] = useState<number | string>('');
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [sourceRef, setSourceRef] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  // Upload Evidence
  const [paymentProofFile, setPaymentProofFile] = useState<File | null>(null);

  // Status
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCategories();
  }, [propertyId]);

  const loadCategories = async () => {
    try {
      const data = await fetchCategoriesApi(propertyId);
      const incomeCats = data.categories.filter((c) => c.type === 'INCOME' && c.is_active !== false);
      setCategories(incomeCats);
      setDepartments(data.departments);
      if (incomeCats.length > 0) {
        setCategoryCode(incomeCats[0].code);
        setDepartmentCode(incomeCats[0].default_department || 'GENERAL');
      }
    } catch (err: any) {
      console.error('Failed to load income categories', err);
    }
  };

  const handleCategoryChange = (code: string) => {
    setCategoryCode(code);
    const cat = categories.find((c) => c.code === code);
    if (cat && cat.default_department) {
      setDepartmentCode(cat.default_department);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partyName.trim()) {
      setError('Nama pihak pembayar / pelanggan wajib diisi');
      return;
    }
    if (!description.trim()) {
      setError('Keterangan pemasukan wajib diisi');
      return;
    }
    const numAmount = Math.round(Number(amount) || 0);
    if (numAmount <= 0) {
      setError('Nominal pemasukan harus lebih besar dari Rp 0');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const cat = categories.find((c) => c.code === categoryCode);

      const created = await createIncomeTransactionApi({
        property_id: propertyId,
        transaction_date: txDate,
        category_code: categoryCode,
        category_name: cat?.name || categoryCode,
        department_code: departmentCode,
        party_name: partyName.trim(),
        phone: phone.trim() || null,
        description: description.trim(),
        amount: numAmount,
        payment_method: paymentMethod,
        source_reference: sourceRef.trim() || null,
        notes: notes.trim() || null,
        actor_name: actorName
      });

      // Upload Payment Proof Attachment
      if (paymentProofFile) {
        try {
          await uploadTransactionAttachmentApi(
            created.id,
            propertyId,
            paymentProofFile,
            'PAYMENT_PROOF',
            actorName
          );
        } catch (_e) {
          console.error('Failed to upload income payment proof', _e);
        }
      }

      onSuccess(created.id);
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan transaksi pemasukan');
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-slate-200/80 pb-4 bg-white px-6 py-4 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div>
            <h2 className="text-lg font-bold text-slate-800">Transaksi Pemasukan Kas Masuk</h2>
            <p className="text-xs text-slate-500">
              Catat pendapatan non-kamar seperti sewa ruang serbaguna, sewa lahan reklame/tenant, penerimaan klaim ganti rugi, atau penerimaan lain
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-start gap-2.5">
          <svg className="w-5 h-5 flex-shrink-0 text-rose-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div>
            <div className="font-bold">Gagal Menyimpan Transaksi</div>
            <div>{error}</div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section 1: Pembayar & Kontak */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
            <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            1. Pihak Pembayar / Pelanggan
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Nama Pihak / Penyetor / Instansi <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="Contoh: PT Surya Kencana / Bpk. Hendra Wijaya"
                value={partyName}
                onChange={(e) => setPartyName(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">No. WhatsApp / Telepon</label>
              <input
                type="text"
                placeholder="081234567890"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
              />
            </div>
          </div>
        </div>

        {/* Section 2: Klasifikasi & Keterangan */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              2. Rincian Sumber Pemasukan
            </h3>
            <button
              type="button"
              onClick={() => setShowCategoryModal(true)}
              className="text-xs text-emerald-700 font-bold hover:underline flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Kelola Kategori
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Tanggal Transaksi <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                required
                value={txDate}
                onChange={(e) => setTxDate(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Kategori Pemasukan <span className="text-rose-500">*</span>
              </label>
              <select
                required
                value={categoryCode}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none font-semibold text-slate-700"
              >
                {categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Departemen Terkait</label>
              <select
                value={departmentCode}
                onChange={(e) => setDepartmentCode(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none font-semibold text-slate-700"
              >
                {departments.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Keterangan / Uraian Pemasukan <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="Contoh: Sewa Ruang Serbaguna Acara Seminar 1 Hari"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
            />
          </div>
        </div>

        {/* Section 3: Nominal, Penerimaan & Bukti */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Nominal & Method */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
              <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
              </svg>
              3. Nominal & Penerimaan Dana
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Nominal Diterima (Rp) <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">Rp</span>
                  <input
                    type="number"
                    required
                    min="1"
                    step="1"
                    placeholder="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 text-base font-extrabold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
                  />
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  {Number(amount) > 0
                    ? `Terbilang: Rp ${Number(amount).toLocaleString('id-ID')}`
                    : 'Pemasukan akan langsung tercatat LUNAS pada jurnal'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Metode Penerimaan <span className="text-rose-500">*</span>
                </label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none font-semibold text-slate-700"
                >
                  <option value="CASH">Kas Tunai (Cash / Kasir)</option>
                  <option value="TRANSFER">Transfer Rekening Hotel</option>
                  <option value="QRIS">QRIS Statis / Dinamis</option>
                  <option value="EDC">Debit / Kartu Kredit</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  No. Bukti / Kuitansi / Ref (Opsional)
                </label>
                <input
                  type="text"
                  placeholder="KW-IN-2026-001"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
                />
              </div>
            </div>
          </div>

          {/* Upload Bukti */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
              <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              4. Lampiran Bukti Setoran / Kuitansi
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Bukti Slip Transfer / Kuitansi Setoran
                </label>
                <input
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  onChange={(e) => setPaymentProofFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100 cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Catatan Tambahan</label>
                <textarea
                  rows={3}
                  placeholder="Keterangan tambahan untuk audit keuangan..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onBack}
            className="px-5 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
          >
            Batal
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2.5 bg-emerald-800 hover:bg-emerald-900 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
            {submitting ? 'Menyimpan Pemasukan...' : 'Simpan Transaksi Pemasukan'}
          </button>
        </div>
      </form>

      {/* Custom Category Modal */}
      <ExpenseCategoryManagerModal
        isOpen={showCategoryModal}
        propertyId={propertyId}
        transactionType="INCOME"
        actorName={actorName}
        onClose={() => setShowCategoryModal(false)}
        onCategoriesUpdated={loadCategories}
      />
    </div>
  );
};
