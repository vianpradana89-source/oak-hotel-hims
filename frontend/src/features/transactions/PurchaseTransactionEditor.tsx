import React, { useState, useEffect } from 'react';
import type {
  Supplier,
  CategoryOption,
  DepartmentOption,
  ReceivingStatus
} from './transactionDomainTypes';
import {
  fetchCategoriesApi,
  createPurchaseTransactionApi,
  uploadTransactionAttachmentApi
} from './transactionClient';
import { SupplierSelectorModal } from './SupplierSelectorModal';

interface PurchaseLineItem {
  id: string;
  description_snapshot: string;
  quantity: number | string;
  unit: string;
  unit_price: number | string;
  discount_amount: number | string;
  line_total: number;
}

interface PurchaseTransactionEditorProps {
  propertyId: number;
  actorName?: string;
  onBack: () => void;
  onSuccess: (createdId: string | number) => void;
}

export const PurchaseTransactionEditor: React.FC<PurchaseTransactionEditorProps> = ({
  propertyId,
  actorName = 'Staff',
  onBack,
  onSuccess
}) => {
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);

  // Form State
  const [txDate, setTxDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [categoryCode, setCategoryCode] = useState<string>('PURCHASE_FOOD');
  const [departmentCode, setDepartmentCode] = useState<string>('FNB');
  const [sourceRef, setSourceRef] = useState<string>(''); // No Faktur / Nota
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [showSupplierModal, setShowSupplierModal] = useState<boolean>(false);
  const [receivingStatus, setReceivingStatus] = useState<ReceivingStatus>('DITERIMA');
  const [notes, setNotes] = useState<string>('');

  // Multi-line Items
  const [lines, setLines] = useState<PurchaseLineItem[]>([
    {
      id: 'item-1',
      description_snapshot: '',
      quantity: 1,
      unit: 'kg',
      unit_price: 0,
      discount_amount: 0,
      line_total: 0
    }
  ]);

  // Overall Discount & Rounding
  const [overallDiscount, setOverallDiscount] = useState<number | string>(0);
  const [roundingAmount, setRoundingAmount] = useState<number | string>(0);

  // Settlement Option
  const [isImmediatelyPaid, setIsImmediatelyPaid] = useState<boolean>(true);
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [paidAmount, setPaidAmount] = useState<number | string>('');

  // Upload Evidence
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
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
      const purchaseCats = data.categories.filter((c) => c.type === 'PURCHASE' && c.is_active !== false);
      setCategories(purchaseCats);
      setDepartments(data.departments);
      if (purchaseCats.length > 0) {
        setCategoryCode(purchaseCats[0].code);
        setDepartmentCode(purchaseCats[0].default_department || 'FNB');
      }
    } catch (err: any) {
      console.error('Failed to load categories', err);
    }
  };

  const handleCategoryChange = (code: string) => {
    setCategoryCode(code);
    const cat = categories.find((c) => c.code === code);
    if (cat && cat.default_department) {
      setDepartmentCode(cat.default_department);
    }
  };

  // Line item manipulation
  const updateLine = (id: string, field: keyof PurchaseLineItem, val: any) => {
    setLines((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: val };
        const q = Number(updated.quantity) || 0;
        const p = Number(updated.unit_price) || 0;
        const d = Number(updated.discount_amount) || 0;
        const gross = Math.round(q * p);
        updated.line_total = Math.max(0, gross - d);
        return updated;
      })
    );
  };

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      {
        id: `item-${Date.now()}`,
        description_snapshot: '',
        quantity: 1,
        unit: 'pcs',
        unit_price: 0,
        discount_amount: 0,
        line_total: 0
      }
    ]);
  };

  const removeLine = (id: string) => {
    if (lines.length <= 1) return;
    setLines((prev) => prev.filter((item) => item.id !== id));
  };

  // Total Math
  const linesSubtotal = lines.reduce((acc, curr) => acc + (curr.line_total || 0), 0);
  const numOverallDiscount = Number(overallDiscount) || 0;
  const numRounding = Number(roundingAmount) || 0;
  const grandTotal = Math.max(0, linesSubtotal - numOverallDiscount + numRounding);

  const effectivePaid = isImmediatelyPaid
    ? (paidAmount !== '' ? Number(paidAmount) || 0 : grandTotal)
    : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplier) {
      setError('Supplier / Vendor wajib dipilih');
      return;
    }

    const validLines = lines.filter((l) => l.description_snapshot.trim() !== '');
    if (validLines.length === 0) {
      setError('Minimal satu rincian item pembelian harus diisi');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const cat = categories.find((c) => c.code === categoryCode);

      const created = await createPurchaseTransactionApi({
        property_id: propertyId,
        transaction_date: txDate,
        category_code: categoryCode,
        category_name: cat?.name || categoryCode,
        department_code: departmentCode,
        supplier_id: selectedSupplier.id,
        source_reference: sourceRef.trim() || null,
        receiving_status: receivingStatus,
        discount_amount: numOverallDiscount,
        rounding_amount: numRounding,
        lines: validLines.map((l) => ({
          description_snapshot: l.description_snapshot.trim(),
          quantity: Number(l.quantity) || 1,
          unit: l.unit.trim() || 'pcs',
          unit_price: Math.round(Number(l.unit_price) || 0),
          discount_amount: Math.round(Number(l.discount_amount) || 0)
        })),
        is_immediately_paid: isImmediatelyPaid,
        payment_method: isImmediatelyPaid ? paymentMethod : undefined,
        paid_amount: isImmediatelyPaid ? effectivePaid : undefined,
        notes: notes.trim() || null,
        actor_name: actorName
      });

      // Upload Evidence Attachments
      if (invoiceFile) {
        try {
          await uploadTransactionAttachmentApi(
            created.id,
            propertyId,
            invoiceFile,
            'RECEIPT',
            actorName
          );
        } catch (_e) {
          console.error('Failed to upload invoice file', _e);
        }
      }

      if (paymentProofFile && isImmediatelyPaid) {
        try {
          await uploadTransactionAttachmentApi(
            created.id,
            propertyId,
            paymentProofFile,
            'PAYMENT_PROOF',
            actorName
          );
        } catch (_e) {
          console.error('Failed to upload payment proof', _e);
        }
      }

      onSuccess(created.id);
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan transaksi pembelian');
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Top Bar Header */}
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
            <h2 className="text-lg font-bold text-slate-800">Transaksi Pembelian Operasional</h2>
            <p className="text-xs text-slate-500">
              Catat pembelian bahan makanan, perlengkapan kamar, amenitas, atau inventaris operasional hotel
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
        {/* Section 1: Header Info & Supplier */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
            <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            1. Informasi Supplier & Dokumen
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Supplier Picker */}
            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Supplier / Vendor <span className="text-rose-500">*</span>
              </label>
              {selectedSupplier ? (
                <div className="p-3 bg-emerald-50/60 border border-emerald-300 rounded-xl flex items-center justify-between">
                  <div>
                    <div className="font-bold text-xs text-emerald-900 flex items-center gap-2">
                      <span>{selectedSupplier.name}</span>
                      {selectedSupplier.phone && (
                        <span className="font-normal text-emerald-700">• {selectedSupplier.phone}</span>
                      )}
                    </div>
                    {selectedSupplier.bank_account && (
                      <div className="text-[11px] text-emerald-700">
                        {selectedSupplier.bank_name} {selectedSupplier.bank_account} (a/n {selectedSupplier.bank_holder})
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSupplierModal(true)}
                    className="px-3 py-1.5 bg-white text-emerald-800 border border-emerald-300 text-xs font-bold rounded-lg hover:bg-emerald-50 transition-colors"
                  >
                    Ganti
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSupplierModal(true)}
                  className="w-full py-3 px-4 border-2 border-dashed border-slate-300 hover:border-emerald-500 rounded-xl text-slate-600 hover:text-emerald-700 text-xs font-bold flex items-center justify-center gap-2 transition-all bg-slate-50/50 hover:bg-emerald-50/30"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  Pilih / Tambah Rekanan Vendor
                </button>
              )}
            </div>

            {/* Tanggal */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Tanggal Pembelian <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                required
                value={txDate}
                onChange={(e) => setTxDate(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Kategori Pembelian <span className="text-rose-500">*</span>
              </label>
              <select
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
              <label className="block text-xs font-bold text-slate-700 mb-1">Departemen Alokasi</label>
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

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">No. Faktur / Nota Supplier</label>
              <input
                type="text"
                placeholder="INV-2026-XXXX / Nota #123"
                value={sourceRef}
                onChange={(e) => setSourceRef(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
              />
            </div>
          </div>
        </div>

        {/* Section 2: Multi-line Items Table */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              2. Rincian Barang / Produk
            </h3>
            <button
              type="button"
              onClick={addLine}
              className="px-3 py-1.5 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200 text-xs font-bold rounded-xl flex items-center gap-1.5 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              + Tambah Baris
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase bg-slate-50">
                  <th className="py-2.5 px-3 min-w-[220px]">Nama Barang / Deskripsi</th>
                  <th className="py-2.5 px-2 w-24">Jumlah (Qty)</th>
                  <th className="py-2.5 px-2 w-24">Satuan</th>
                  <th className="py-2.5 px-2 w-36 text-right">Harga Satuan (Rp)</th>
                  <th className="py-2.5 px-2 w-28 text-right">Diskon (Rp)</th>
                  <th className="py-2.5 px-3 w-36 text-right">Total (Rp)</th>
                  <th className="py-2.5 px-2 w-10 text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/60">
                    <td className="py-2 px-2">
                      <input
                        type="text"
                        required
                        placeholder="Contoh: Beras Premium Pandan Wangi"
                        value={item.description_snapshot}
                        onChange={(e) => updateLine(item.id, 'description_snapshot', e.target.value)}
                        className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        min="0.001"
                        step="any"
                        required
                        value={item.quantity}
                        onChange={(e) => updateLine(item.id, 'quantity', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs font-mono font-bold"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="text"
                        placeholder="kg / pcs"
                        value={item.unit}
                        onChange={(e) => updateLine(item.id, 'unit', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={item.unit_price}
                        onChange={(e) => updateLine(item.id, 'unit_price', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs text-right font-mono font-bold"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={item.discount_amount}
                        onChange={(e) => updateLine(item.id, 'discount_amount', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs text-right font-mono"
                      />
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-800">
                      Rp {item.line_total.toLocaleString('id-ID')}
                    </td>
                    <td className="py-2 px-2 text-center">
                      <button
                        type="button"
                        disabled={lines.length <= 1}
                        onClick={() => removeLine(item.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-20 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Subtotals and Grand Total Math */}
          <div className="pt-4 border-t border-slate-100 flex flex-col md:flex-row justify-between items-start gap-4">
            <div className="w-full md:w-1/2 space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Status Penerimaan Fisik Barang
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setReceivingStatus('DITERIMA')}
                    className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                      receivingStatus === 'DITERIMA'
                        ? 'bg-emerald-50 border-emerald-500 text-emerald-800 ring-1 ring-emerald-500'
                        : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    ✓ Diterima Lengkap
                  </button>
                  <button
                    type="button"
                    onClick={() => setReceivingStatus('DITERIMA_SEBAGIAN')}
                    className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                      receivingStatus === 'DITERIMA_SEBAGIAN'
                        ? 'bg-amber-50 border-amber-500 text-amber-800 ring-1 ring-amber-500'
                        : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    ◐ Diterima Sebagian
                  </button>
                  <button
                    type="button"
                    onClick={() => setReceivingStatus('BELUM_DITERIMA')}
                    className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                      receivingStatus === 'BELUM_DITERIMA'
                        ? 'bg-slate-800 border-slate-800 text-white'
                        : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    ○ Belum Diterima
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Catatan Tambahan</label>
                <textarea
                  rows={2}
                  placeholder="Catatan pengiriman, no PO, kondisi barang..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
                />
              </div>
            </div>

            {/* Calculations Box */}
            <div className="w-full md:w-80 bg-slate-50/80 rounded-2xl p-4 border border-slate-200 space-y-2 text-xs">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal Barang:</span>
                <span className="font-mono font-bold">Rp {linesSubtotal.toLocaleString('id-ID')}</span>
              </div>
              <div className="flex justify-between items-center text-slate-600">
                <span>Diskon Tambahan (Rp):</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={overallDiscount}
                  onChange={(e) => setOverallDiscount(e.target.value)}
                  className="w-28 px-2 py-1 text-right bg-white border border-slate-200 rounded-lg text-xs font-mono font-bold"
                />
              </div>
              <div className="flex justify-between items-center text-slate-600">
                <span>Pembulatan (+/- Rp):</span>
                <input
                  type="number"
                  step="1"
                  value={roundingAmount}
                  onChange={(e) => setRoundingAmount(e.target.value)}
                  className="w-28 px-2 py-1 text-right bg-white border border-slate-200 rounded-lg text-xs font-mono font-bold"
                />
              </div>
              <div className="pt-2 border-t border-slate-200 flex justify-between items-center font-bold text-sm text-slate-800">
                <span>Total Tagihan:</span>
                <span className="text-base text-emerald-800 font-mono">
                  Rp {grandTotal.toLocaleString('id-ID')}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Section 3: Pembayaran & Settlement */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
            <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            3. Status Pelunasan Pembayaran
          </h3>

          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="payment_choice"
                  checked={isImmediatelyPaid}
                  onChange={() => setIsImmediatelyPaid(true)}
                  className="accent-emerald-700 w-4 h-4"
                />
                <span className="text-xs font-bold text-slate-800">Dibayar Lunas Langsung</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="payment_choice"
                  checked={!isImmediatelyPaid}
                  onChange={() => setIsImmediatelyPaid(false)}
                  className="accent-emerald-700 w-4 h-4"
                />
                <span className="text-xs font-bold text-slate-800">Hutang Vendor (Belum Dibayar / Tempo)</span>
              </label>
            </div>

            {isImmediatelyPaid && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-slate-50 rounded-xl border border-slate-200 animate-in fade-in">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Metode Pembayaran <span className="text-rose-500">*</span>
                  </label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:border-emerald-600 outline-none font-semibold text-slate-700"
                  >
                    <option value="CASH">Tunai (Cash / Kasir)</option>
                    <option value="TRANSFER">Transfer Bank</option>
                    <option value="QRIS">QRIS</option>
                    <option value="EDC">Debit / Kartu Kredit</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Nominal Dibayarkan (Rp)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder={`Default lunas: ${grandTotal}`}
                    value={paidAmount}
                    onChange={(e) => setPaidAmount(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:border-emerald-600 outline-none font-mono font-bold"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Section 4: File Evidence & Bukti Lampiran */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
            <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            4. Lampiran Bukti Transaksi
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Bukti Nota / Struk Pembelian (Wajib)
              </label>
              <input
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                onChange={(e) => setInvoiceFile(e.target.files?.[0] || null)}
                className="w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100 cursor-pointer"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Bukti Pembayaran / Transfer Bank (Opsional)
              </label>
              <input
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                onChange={(e) => setPaymentProofFile(e.target.files?.[0] || null)}
                className="w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100 cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Submit Bar */}
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
            {submitting ? 'Menyimpan Transaksi...' : 'Simpan Transaksi Pembelian'}
          </button>
        </div>
      </form>

      {/* Supplier Modal */}
      <SupplierSelectorModal
        isOpen={showSupplierModal}
        propertyId={propertyId}
        actorName={actorName}
        selectedSupplierId={selectedSupplier?.id}
        onSelect={(sup) => setSelectedSupplier(sup)}
        onClose={() => setShowSupplierModal(false)}
      />
    </div>
  );
};
