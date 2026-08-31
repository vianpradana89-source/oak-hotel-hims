import React, { useState, useEffect, useRef } from 'react';
import type { TransactionType, CategoryOption, DepartmentOption, DepartmentCode } from './transactionDomainTypes';
import { createManualTransactionApi, uploadTransactionAttachmentApi } from './transactionClient';

interface ManualTransactionModalProps {
  isOpen: boolean;
  propertyId: number;
  initialType?: TransactionType;
  categories: CategoryOption[];
  departments: DepartmentOption[];
  currentStaffName?: string;
  onClose: () => void;
  onSuccess: () => void;
}

export const ManualTransactionModal: React.FC<ManualTransactionModalProps> = ({
  isOpen,
  propertyId,
  initialType = 'EXPENSE',
  categories,
  departments,
  currentStaffName = 'Staff Front Desk',
  onClose,
  onSuccess
}) => {
  const [txType, setTxType] = useState<TransactionType>(initialType);
  const [categoryCode, setCategoryCode] = useState<string>('');
  const [departmentCode, setDepartmentCode] = useState<DepartmentCode>('FRONT_OFFICE');
  const [amountStr, setAmountStr] = useState<string>('');
  const [partyName, setPartyName] = useState<string>('');
  const [sourceReference, setSourceReference] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [notes, setNotes] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTxType(initialType);
      setErrorMsg(null);
      setFileError(null);
      setAmountStr('');
      setPartyName('');
      setSourceReference('');
      setDescription('');
      setNotes('');
      setSelectedFile(null);
      setPaymentMethod('CASH');
    }
  }, [isOpen, initialType]);

  // Filter categories by current transaction type and allow_manual flag
  const availableCategories = categories.filter((c) => c.type === txType && c.allow_manual !== false);

  useEffect(() => {
    if (availableCategories.length > 0) {
      const firstCat = availableCategories[0];
      setCategoryCode(firstCat.code);
      setDepartmentCode(firstCat.default_department);
    } else {
      setCategoryCode('');
    }
  }, [txType, categories]);

  const handleCategoryChange = (code: string) => {
    setCategoryCode(code);
    const selected = categories.find((c) => c.code === code);
    if (selected) {
      setDepartmentCode(selected.default_department);
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/\D/g, '');
    if (!raw) {
      setAmountStr('');
      return;
    }
    const num = parseInt(raw, 10);
    setAmountStr(num.toLocaleString('id-ID'));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const validTypes = ['image/jpeg', 'image/png', 'application/pdf'];
      if (!validTypes.includes(file.type)) {
        setFileError('Hanya file format JPG, PNG, atau PDF yang didukung');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setFileError('Ukuran file melebihi batas 10MB');
        return;
      }
      setSelectedFile(file);
    }
  };

  const removeSelectedFile = () => {
    setSelectedFile(null);
    setFileError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const rawNum = parseInt(amountStr.replace(/\./g, ''), 10);
    if (!rawNum || isNaN(rawNum) || rawNum <= 0) {
      setErrorMsg('Nominal transaksi wajib diisi lebih besar dari 0 (dalam Rupiah utuh)');
      return;
    }

    if (!categoryCode) {
      setErrorMsg('Kategori transaksi wajib dipilih');
      return;
    }

    if (!description.trim()) {
      setErrorMsg('Keterangan transaksi wajib diisi');
      return;
    }

    setIsSubmitting(true);
    try {
      const selectedCat = categories.find((c) => c.code === categoryCode);
      const createdTx = await createManualTransactionApi({
        property_id: propertyId,
        transaction_type: txType,
        category_code: categoryCode,
        category_name: selectedCat?.name || categoryCode,
        department_code: departmentCode,
        description: description.trim(),
        amount: rawNum,
        party_name: partyName.trim() || undefined,
        source_reference: sourceReference.trim() || undefined,
        payment_method: paymentMethod,
        notes: notes.trim() || undefined,
        actor_name: currentStaffName
      });

      // If an attachment file was chosen, upload it now
      if (selectedFile && createdTx?.id) {
        try {
          await uploadTransactionAttachmentApi(createdTx.id, propertyId, selectedFile, currentStaffName);
        } catch (attErr: any) {
          console.warn('Gagal mengunggah bukti transaksi:', attErr);
        }
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menyimpan transaksi');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const getPartyLabel = () => {
    switch (txType) {
      case 'PURCHASE':
        return 'Supplier / Vendor';
      case 'EXPENSE':
        return 'Penerima / Rekanan';
      case 'INCOME':
        return 'Sumber / Pembayar';
      case 'SALE':
        return 'Pelanggan / Tamu';
    }
  };

  const getPartyPlaceholder = () => {
    switch (txType) {
      case 'PURCHASE':
        return 'Contoh: PT Sumber Pangan Makmur / CV Berkah';
      case 'EXPENSE':
        return 'Contoh: Toko Listrik Sejahtera / Driver Taxi';
      case 'INCOME':
        return 'Contoh: Vendor Laundry Rekanan / Tamu Walk-in';
      case 'SALE':
        return 'Contoh: Bpk. Ahmad Wijaya / PT Multi Karya';
    }
  };

  const getThemeColor = () => {
    switch (txType) {
      case 'SALE':
        return {
          btnBg: 'bg-emerald-700 hover:bg-emerald-800',
          badge: 'bg-emerald-500',
          activeTab: 'border-emerald-600 bg-emerald-50 text-emerald-800'
        };
      case 'PURCHASE':
        return {
          btnBg: 'bg-blue-700 hover:bg-blue-800',
          badge: 'bg-blue-500',
          activeTab: 'border-blue-600 bg-blue-50 text-blue-800'
        };
      case 'EXPENSE':
        return {
          btnBg: 'bg-rose-700 hover:bg-rose-800',
          badge: 'bg-rose-500',
          activeTab: 'border-rose-600 bg-rose-50 text-rose-800'
        };
      case 'INCOME':
        return {
          btnBg: 'bg-teal-700 hover:bg-teal-800',
          badge: 'bg-teal-500',
          activeTab: 'border-teal-600 bg-teal-50 text-teal-800'
        };
    }
  };

  const getTypeTitle = () => {
    switch (txType) {
      case 'SALE':
        return 'Catat Penjualan';
      case 'PURCHASE':
        return 'Catat Pembelian';
      case 'EXPENSE':
        return 'Catat Pengeluaran';
      case 'INCOME':
        return 'Catat Pemasukan';
    }
  };

  const theme = getThemeColor();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 my-8">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${theme.badge}`} />
            <div>
              <h3 className="text-lg font-bold text-slate-800">{getTypeTitle()}</h3>
              <p className="text-xs text-slate-500">Pencatatan langsung ke registri transaksi keuangan operasional hotel</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Type Selector Tabs */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">Tipe Transaksi</label>
            <div className="grid grid-cols-3 gap-2">
              {(['EXPENSE', 'PURCHASE', 'INCOME'] as TransactionType[]).map((t) => {
                const labels: Record<string, string> = {
                  EXPENSE: 'Pengeluaran',
                  PURCHASE: 'Pembelian',
                  INCOME: 'Pemasukan'
                };
                const active = txType === t;
                const tabColor = t === 'EXPENSE' ? 'border-rose-600 bg-rose-50 text-rose-800 font-bold'
                  : t === 'PURCHASE' ? 'border-blue-600 bg-blue-50 text-blue-800 font-bold'
                  : 'border-teal-600 bg-teal-50 text-teal-800 font-bold';

                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTxType(t)}
                    className={`py-2 px-1 text-xs font-semibold rounded-xl border transition-all text-center cursor-pointer ${
                      active ? tabColor : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {labels[t]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Category & Department */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Kategori <span className="text-rose-500">*</span>
              </label>
              <select
                value={categoryCode}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                required
              >
                {availableCategories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Departemen <span className="text-rose-500">*</span>
              </label>
              <select
                value={departmentCode}
                onChange={(e) => setDepartmentCode(e.target.value as DepartmentCode)}
                className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                required
              >
                {departments.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Party Name & Reference Number */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {getPartyLabel()}
              </label>
              <input
                type="text"
                value={partyName}
                onChange={(e) => setPartyName(e.target.value)}
                placeholder={getPartyPlaceholder()}
                className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Nomor Referensi (Nota / Struk / PO)
              </label>
              <input
                type="text"
                value={sourceReference}
                onChange={(e) => setSourceReference(e.target.value)}
                placeholder="Contoh: INV-2026-0881 / NOTA-042"
                className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>
          </div>

          {/* Amount (IDR) & Payment Method */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Nominal (IDR) <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-3.5 top-2.5 text-xs font-bold text-slate-400">Rp</span>
                <input
                  type="text"
                  value={amountStr}
                  onChange={handleAmountChange}
                  placeholder="0"
                  className="w-full text-xs font-semibold bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-3 py-2.5 text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Metode Pembayaran</label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              >
                <option value="CASH">Tunai / Cash</option>
                <option value="TRANSFER_BCA">Transfer Bank (BCA)</option>
                <option value="TRANSFER_MANDIRI">Transfer Bank (Mandiri)</option>
                <option value="EDC_DEBIT">Kartu Debit (EDC)</option>
                <option value="EDC_CREDIT">Kartu Kredit (EDC)</option>
                <option value="QRIS">QRIS</option>
                <option value="OTHER">Lainnya</option>
              </select>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Keterangan Transaksi <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Contoh: Pembelian galon air mineral & kopi resepsionis"
              className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              required
            />
          </div>

          {/* File Attachment / Bukti Transaksi */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Bukti Transaksi (Nota / Kuitansi / Struk / Faktur)
            </label>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              accept="image/jpeg,image/png,application/pdf"
              className="hidden"
              id="manual-tx-file-input"
            />
            {selectedFile ? (
              <div className="flex items-center justify-between p-3 bg-emerald-50/60 border border-emerald-200 rounded-xl text-xs">
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="truncate">
                    <p className="font-semibold text-slate-800 truncate">{selectedFile.name}</p>
                    <p className="text-[10px] text-slate-500">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={removeSelectedFile}
                  className="text-rose-600 hover:text-rose-800 p-1.5 rounded-lg hover:bg-rose-100/50 transition-colors cursor-pointer shrink-0"
                  title="Hapus file"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ) : (
              <label
                htmlFor="manual-tx-file-input"
                className="flex flex-col items-center justify-center p-3.5 border-2 border-dashed border-slate-200 hover:border-emerald-500 rounded-xl bg-slate-50/50 hover:bg-emerald-50/20 cursor-pointer transition-colors"
              >
                <svg className="w-6 h-6 text-slate-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="text-xs font-medium text-slate-600">Klik untuk mengunggah bukti transaksi (JPG, PNG, PDF)</span>
                <span className="text-[10px] text-slate-400 mt-0.5">Maksimum ukuran 10 MB</span>
              </label>
            )}
            {fileError && <p className="text-xs text-rose-600 mt-1">{fileError}</p>}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Catatan Tambahan (Opsional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Catatan tambahan internal operasional..."
              rows={2}
              className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none"
            />
          </div>

          {/* Staff Info snapshot */}
          <div className="bg-slate-50 rounded-xl p-3 border border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>Petugas Pencatat:</span>
            <span className="font-semibold text-slate-700">{currentStaffName}</span>
          </div>

          {/* Footer Buttons */}
          <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={`px-5 py-2 text-xs font-semibold text-white ${theme.btnBg} rounded-xl shadow-xs transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2`}
            >
              {isSubmitting && (
                <svg className="animate-spin w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              )}
              <span>{isSubmitting ? 'Menyimpan...' : 'Simpan Transaksi'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
