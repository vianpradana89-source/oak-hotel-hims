import { useMemo } from 'react';
import type {
  QuotationDraft,
  QuotationDraftItem,
  QuotationAdjustmentType,
} from './quotationDraft';
import {
  createQuotationDraftItem,
  calculateQuotationDraftTotals,
} from './quotationDraft';
import { formatHotelCurrency } from './GuestDocumentContent';

export interface QuotationEditorProps {
  draft: QuotationDraft;
  onChange: (draft: QuotationDraft) => void;
}

export default function QuotationEditor({ draft, onChange }: QuotationEditorProps) {
  // Update helpers ensuring immutable updates
  const updateDraftField = <K extends keyof QuotationDraft>(key: K, value: QuotationDraft[K]) => {
    onChange({
      ...draft,
      [key]: value,
    });
  };

  const updateItem = (index: number, patch: Partial<QuotationDraftItem>) => {
    const newItems = draft.items.map((item, idx) => {
      if (idx !== index) return item;
      return {
        ...item,
        ...patch,
      };
    });
    onChange({
      ...draft,
      items: newItems,
    });
  };

  const removeItem = (index: number) => {
    const newItems = draft.items.filter((_, idx) => idx !== index);
    onChange({
      ...draft,
      items: newItems,
    });
  };

  const addItem = () => {
    const newItem = createQuotationDraftItem();
    onChange({
      ...draft,
      items: [...draft.items, newItem],
    });
  };

  // Live financial totals calculation
  const totals = useMemo(() => calculateQuotationDraftTotals(draft), [draft]);

  return (
    <div className="space-y-4 text-stone-800 text-xs sm:text-sm">
      {/* 1. Mode Header */}
      <div className="bg-white border border-stone-200 rounded-lg p-3 sm:p-4 shadow-sm">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
            Mode Penawaran
          </span>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              draft.mode === 'reservation'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-stone-100 text-stone-700'
            }`}
          >
            {draft.mode === 'reservation' ? 'Dari Reservasi' : 'Manual'}
          </span>
        </div>
        <p className="text-xs text-stone-500 leading-relaxed">
          {draft.mode === 'reservation'
            ? 'Data awal diambil dari reservasi. Perubahan di dokumen ini tidak mengubah reservasi.'
            : 'Penawaran manual — tidak terhubung ke reservasi.'}
        </p>
      </div>

      {/* Customer Section + Quotation Meta - side by side on large screens */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {/* Left card: Informasi Pelanggan */}
        <div className="bg-white border border-stone-200 rounded-lg p-3 sm:p-4 shadow-sm space-y-3">
          <div className="text-xs font-semibold text-stone-700 uppercase tracking-wider border-b border-stone-100 pb-2">
            Informasi Pelanggan
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Nama Tamu / Perusahaan <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                className="w-full rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                placeholder="Contoh: PT. Maju Bersama / Bpk. Bambang"
                value={draft.customerName}
                onChange={(e) => updateDraftField('customerName', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Contact Person
              </label>
              <input
                type="text"
                className="w-full rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                placeholder="Nama PIC jika perwakilan"
                value={draft.contactPerson || ''}
                onChange={(e) => updateDraftField('contactPerson', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Telepon
              </label>
              <input
                type="text"
                className="w-full rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                placeholder="08xxxxxxxxxx"
                value={draft.phone || ''}
                onChange={(e) => updateDraftField('phone', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Email
              </label>
              <input
                type="email"
                className="w-full rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                placeholder="kontak@email.com"
                value={draft.email || ''}
                onChange={(e) => updateDraftField('email', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Alamat
              </label>
              <input
                type="text"
                className="w-full rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                placeholder="Kota / Alamat lengkap"
                value={draft.address || ''}
                onChange={(e) => updateDraftField('address', e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Right card: Detail Penawaran */}
        <div className="bg-white border border-stone-200 rounded-lg p-3 sm:p-4 shadow-sm space-y-3">
          <div className="text-xs font-semibold text-stone-700 uppercase tracking-wider border-b border-stone-100 pb-2">
            Detail Penawaran
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Nomor Quotation
              </label>
              <input
                type="text"
                className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                placeholder="Opsional / Draft manual"
                value={draft.quotationNumber || ''}
                onChange={(e) => updateDraftField('quotationNumber', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Tanggal Quotation <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                value={draft.quotationDate || ''}
                onChange={(e) => updateDraftField('quotationDate', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Referensi / BID
              </label>
              <input
                type="text"
                className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                placeholder="Contoh: BID-2026-0012"
                value={draft.reference || ''}
                onChange={(e) => updateDraftField('reference', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Berlaku Sampai
              </label>
              <input
                type="date"
                className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                value={draft.validUntil || ''}
                onChange={(e) => updateDraftField('validUntil', e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-stone-600 mb-1">
                Perihal
              </label>
              <input
                type="text"
                className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                placeholder="Contoh: Penawaran Harga Kamar Rombongan"
                value={draft.subject || ''}
                onChange={(e) => updateDraftField('subject', e.target.value)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 4. Stay Information (Optional) */}
      <div className="bg-white border border-stone-200 rounded-lg p-3 sm:p-4 shadow-sm space-y-3">
        <div className="text-xs font-semibold text-stone-700 uppercase tracking-wider border-b border-stone-100 pb-2">
          Informasi Menginap <span className="text-stone-400 font-normal lowercase">(opsional)</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Check-in
            </label>
            <input
              type="date"
              className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              value={draft.checkIn || ''}
              onChange={(e) => updateDraftField('checkIn', e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Check-out
            </label>
            <input
              type="date"
              className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              value={draft.checkOut || ''}
              onChange={(e) => updateDraftField('checkOut', e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Jumlah Tamu (Pax)
            </label>
            <input
              type="number"
              min="1"
              className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              placeholder="-"
              value={draft.guestCount ?? ''}
              onChange={(e) => {
                const val = e.target.value;
                updateDraftField('guestCount', val === '' ? null : Math.max(1, Number(val)));
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Nomor Kamar
            </label>
            <input
              type="text"
              className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              placeholder="Contoh: 101"
              value={draft.roomNumber || ''}
              onChange={(e) => updateDraftField('roomNumber', e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Tipe Kamar
            </label>
            <input
              type="text"
              className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              placeholder="Contoh: Deluxe King"
              value={draft.roomType || ''}
              onChange={(e) => updateDraftField('roomType', e.target.value)}
            />
          </div>
        </div>
      </div>

       {/* 5. Line Items */}
       <div className="bg-white border border-stone-200 rounded-lg p-3 sm:p-4 shadow-sm space-y-3">
         <div className="border-b border-stone-100 pb-2">
           <span className="text-xs font-semibold text-stone-700 uppercase tracking-wider">
             Item Penawaran ({draft.items.length})
           </span>
         </div>

         {draft.items.length === 0 ? (
           <div className="text-center py-6 text-xs text-stone-400 bg-stone-50 rounded border border-dashed border-stone-200">
              Belum ada item penawaran. Klik &quot;+ Tambah Item&quot; untuk menambahkan item.
           </div>
         ) : (
           <div className="space-y-2.5">
             {draft.items.map((item, index) => {
               const itemTotal = Math.round(
                 Math.max(0, Number(item.qty) || 0) * Math.max(0, Number(item.unitPrice) || 0)
               );
               return (
                 <div
                   key={item.id}
                   className="p-2.5 rounded-lg border border-stone-200 bg-stone-50/50 space-y-2"
                 >
                   {/* Header: Item Index & Delete Button */}
                   <div className="flex items-center justify-between text-xs">
                     <span className="font-semibold text-stone-500">#{index + 1}</span>
                     <button
                       type="button"
                       onClick={() => removeItem(index)}
                       className="text-rose-600 hover:text-rose-800 font-medium hover:underline inline-flex items-center gap-1"
                     >
                       Hapus
                     </button>
                   </div>

                   {/* Main Fields Row: Deskripsi, Qty, Satuan, Harga Satuan */}
                   <div className="grid grid-cols-12 sm:grid-cols-[minmax(0,1fr)_68px_90px_155px] gap-2">
                     {/* 1. Deskripsi Item */}
                     <div className="col-span-12 sm:col-auto min-w-0">
                       <input
                         type="text"
                         className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600 bg-white"
                         placeholder="Deskripsi item *"
                         value={item.description}
                         onChange={(e) => updateItem(index, { description: e.target.value })}
                       />
                     </div>

                     {/* 2. Qty */}
                     <div className="col-span-3 sm:col-auto min-w-0">
                       <input
                         type="number"
                         min="0"
                         step="1"
                         className="w-full min-w-0 rounded border border-stone-300 px-2 py-1.5 text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600 bg-white text-center"
                         placeholder="Qty"
                         value={item.qty}
                         onChange={(e) => {
                           const val = e.target.value;
                           updateItem(index, {
                             qty: val === '' ? 0 : Math.max(0, Number(val)),
                           });
                         }}
                       />
                     </div>

                     {/* 3. Satuan */}
                     <div className="col-span-4 sm:col-auto min-w-0">
                       <input
                         type="text"
                         className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600 bg-white"
                         placeholder="Satuan"
                         value={item.unit}
                         onChange={(e) => updateItem(index, { unit: e.target.value })}
                       />
                     </div>

                     {/* 4. Harga Satuan */}
                     <div className="col-span-5 sm:col-auto min-w-0">
                       <div className="relative flex items-stretch rounded border border-stone-300 bg-white focus-within:ring-1 focus-within:ring-emerald-600 focus-within:border-emerald-600 overflow-hidden">
                         <span className="inline-flex items-center px-2 text-xs font-medium text-stone-500 bg-stone-100 border-r border-stone-200 select-none">
                           Rp
                         </span>
                         <input
                           type="number"
                           min="0"
                           step="1000"
                           className="w-full min-w-0 px-2 py-1.5 text-xs text-stone-800 bg-transparent focus:outline-none font-mono"
                           placeholder="Harga"
                           value={item.unitPrice}
                           onChange={(e) => {
                             const val = e.target.value;
                             updateItem(index, {
                               unitPrice: val === '' ? 0 : Math.max(0, Number(val)),
                             });
                           }}
                         />
                       </div>
                     </div>
                   </div>

                   {/* Note Row: Full Width */}
                   <div>
                     <input
                       type="text"
                       className="w-full min-w-0 rounded border border-stone-200 px-2.5 py-1.5 text-xs text-stone-600 placeholder-stone-400 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
                       placeholder="Catatan baris item (opsional)..."
                       value={item.note || ''}
                       onChange={(e) => updateItem(index, { note: e.target.value })}
                     />
                   </div>

                   {/* Subtotal Row */}
                   <div className="flex items-center justify-between pt-1 border-t border-stone-200/60 text-xs">
                     <span className="text-[11px] text-stone-500">Subtotal Item:</span>
                     <span className="font-semibold text-stone-800 font-mono">
                       {formatHotelCurrency(itemTotal)}
                     </span>
                   </div>
                 </div>
               );
             })}
           </div>
         )}

         {/* Add Item button at bottom, after all items */}
         <div className="flex justify-end pt-2">
           <button
             type="button"
             onClick={addItem}
             className="inline-flex items-center gap-1 px-3 py-1.5 border border-emerald-600 text-xs font-medium rounded text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors"
           >
             <span>+</span> Tambah Item
           </button>
         </div>
       </div>

       {/* 6. Adjustments */}
      <div className="bg-white border border-stone-200 rounded-lg p-3 sm:p-4 shadow-sm space-y-3">
        <div className="text-xs font-semibold text-stone-700 uppercase tracking-wider border-b border-stone-100 pb-2">
          Penyesuaian (Diskon, Service &amp; Pajak)
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          {/* Discount */}
          <div className="p-3 rounded-lg border border-stone-200 bg-stone-50/50 space-y-1.5">
            <div className="text-xs font-medium text-stone-700">Diskon</div>
            <div className="flex items-center gap-2">
              <select
                className="w-28 flex-shrink-0 rounded border border-stone-300 px-2 py-1.5 text-xs text-stone-800 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-600"
                value={draft.discountType}
                onChange={(e) => {
                  const nextType = e.target.value as QuotationAdjustmentType;
                  if (nextType === 'percent' && draft.discountValue > 100) {
                    onChange({
                      ...draft,
                      discountType: nextType,
                      discountValue: Math.min(100, draft.discountValue),
                    });
                  } else {
                    updateDraftField('discountType', nextType);
                  }
                }}
              >
                <option value="amount">Nominal</option>
                <option value="percent">Persen (%)</option>
              </select>
              <div className="relative flex-1 min-w-0 flex items-stretch rounded border border-stone-300 bg-white focus-within:ring-1 focus-within:ring-emerald-600 focus-within:border-emerald-600 overflow-hidden">
                {draft.discountType === 'amount' && (
                  <span className="inline-flex items-center px-2 text-xs font-medium text-stone-500 bg-stone-100 border-r border-stone-200 select-none">
                    Rp
                  </span>
                )}
                <input
                  type="number"
                  min="0"
                  max={draft.discountType === 'percent' ? 100 : undefined}
                  step={draft.discountType === 'percent' ? '0.1' : '1000'}
                  className="w-full min-w-0 px-2 py-1.5 text-xs text-stone-800 bg-transparent focus:outline-none"
                  value={draft.discountValue}
                  onChange={(e) => {
                    const val = e.target.value;
                    const num = val === '' ? 0 : Number(val);
                    const clamped =
                      draft.discountType === 'percent'
                        ? Math.min(100, Math.max(0, num))
                        : Math.max(0, num);
                    updateDraftField('discountValue', clamped);
                  }}
                />
                {draft.discountType === 'percent' && (
                  <span className="inline-flex items-center px-2 text-xs font-medium text-stone-500 bg-stone-100 border-l border-stone-200 select-none">
                    %
                  </span>
                )}
              </div>
            </div>
            <div className="text-[11px] font-medium text-rose-600">
              Nilai diskon: - {formatHotelCurrency(totals.discountAmount)}
            </div>
          </div>

          {/* Service */}
          <div className="p-3 rounded-lg border border-stone-200 bg-stone-50/50 space-y-1.5">
            <div className="text-xs font-medium text-stone-700">Service</div>
            <div className="flex items-center gap-2">
              <select
                className="w-28 flex-shrink-0 rounded border border-stone-300 px-2 py-1.5 text-xs text-stone-800 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-600"
                value={draft.serviceType}
                onChange={(e) => {
                  const nextType = e.target.value as QuotationAdjustmentType;
                  if (nextType === 'percent' && draft.serviceValue > 100) {
                    onChange({
                      ...draft,
                      serviceType: nextType,
                      serviceValue: Math.min(100, draft.serviceValue),
                    });
                  } else {
                    updateDraftField('serviceType', nextType);
                  }
                }}
              >
                <option value="amount">Nominal</option>
                <option value="percent">Persen (%)</option>
              </select>
              <div className="relative flex-1 min-w-0 flex items-stretch rounded border border-stone-300 bg-white focus-within:ring-1 focus-within:ring-emerald-600 focus-within:border-emerald-600 overflow-hidden">
                {draft.serviceType === 'amount' && (
                  <span className="inline-flex items-center px-2 text-xs font-medium text-stone-500 bg-stone-100 border-r border-stone-200 select-none">
                    Rp
                  </span>
                )}
                <input
                  type="number"
                  min="0"
                  max={draft.serviceType === 'percent' ? 100 : undefined}
                  step={draft.serviceType === 'percent' ? '0.1' : '1000'}
                  className="w-full min-w-0 px-2 py-1.5 text-xs text-stone-800 bg-transparent focus:outline-none"
                  value={draft.serviceValue}
                  onChange={(e) => {
                    const val = e.target.value;
                    const num = val === '' ? 0 : Number(val);
                    const clamped =
                      draft.serviceType === 'percent'
                        ? Math.min(100, Math.max(0, num))
                        : Math.max(0, num);
                    updateDraftField('serviceValue', clamped);
                  }}
                />
                {draft.serviceType === 'percent' && (
                  <span className="inline-flex items-center px-2 text-xs font-medium text-stone-500 bg-stone-100 border-l border-stone-200 select-none">
                    %
                  </span>
                )}
              </div>
            </div>
            <div className="text-[11px] font-medium text-stone-600">
              Nilai service: + {formatHotelCurrency(totals.serviceAmount)}
            </div>
          </div>

          {/* Tax */}
          <div className="p-3 rounded-lg border border-stone-200 bg-stone-50/50 space-y-1.5">
            <div className="text-xs font-medium text-stone-700">Pajak</div>
            <div className="flex items-center gap-2">
              <select
                className="w-28 flex-shrink-0 rounded border border-stone-300 px-2 py-1.5 text-xs text-stone-800 bg-white focus:outline-none focus:ring-1 focus:ring-emerald-600"
                value={draft.taxType}
                onChange={(e) => {
                  const nextType = e.target.value as QuotationAdjustmentType;
                  if (nextType === 'percent' && draft.taxValue > 100) {
                    onChange({
                      ...draft,
                      taxType: nextType,
                      taxValue: Math.min(100, draft.taxValue),
                    });
                  } else {
                    updateDraftField('taxType', nextType);
                  }
                }}
              >
                <option value="amount">Nominal</option>
                <option value="percent">Persen (%)</option>
              </select>
              <div className="relative flex-1 min-w-0 flex items-stretch rounded border border-stone-300 bg-white focus-within:ring-1 focus-within:ring-emerald-600 focus-within:border-emerald-600 overflow-hidden">
                {draft.taxType === 'amount' && (
                  <span className="inline-flex items-center px-2 text-xs font-medium text-stone-500 bg-stone-100 border-r border-stone-200 select-none">
                    Rp
                  </span>
                )}
                <input
                  type="number"
                  min="0"
                  max={draft.taxType === 'percent' ? 100 : undefined}
                  step={draft.taxType === 'percent' ? '0.1' : '1000'}
                  className="w-full min-w-0 px-2 py-1.5 text-xs text-stone-800 bg-transparent focus:outline-none"
                  value={draft.taxValue}
                  onChange={(e) => {
                    const val = e.target.value;
                    const num = val === '' ? 0 : Number(val);
                    const clamped =
                      draft.taxType === 'percent'
                        ? Math.min(100, Math.max(0, num))
                        : Math.max(0, num);
                    updateDraftField('taxValue', clamped);
                  }}
                />
                {draft.taxType === 'percent' && (
                  <span className="inline-flex items-center px-2 text-xs font-medium text-stone-500 bg-stone-100 border-l border-stone-200 select-none">
                    %
                  </span>
                )}
              </div>
            </div>
            <div className="text-[11px] font-medium text-stone-600">
              Nilai pajak: + {formatHotelCurrency(totals.taxAmount)}
            </div>
          </div>
        </div>
      </div>

      {/* 7. Live Total Summary */}
      <div className="bg-stone-50 border border-stone-300 rounded-lg p-3 sm:p-4 shadow-sm">
        <div className="text-xs font-semibold text-stone-700 uppercase tracking-wider mb-2">
          Ringkasan Total
        </div>
        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between py-1 border-b border-stone-200">
            <span className="text-stone-600">Subtotal</span>
            <span className="font-mono font-medium text-stone-800">
              {formatHotelCurrency(totals.subtotal)}
            </span>
          </div>
          {totals.discountAmount > 0 ? (
            <div className="flex justify-between py-1 border-b border-stone-200 text-rose-600">
              <span>Diskon</span>
              <span className="font-mono font-medium">
                - {formatHotelCurrency(totals.discountAmount)}
              </span>
            </div>
          ) : null}
          {totals.serviceAmount > 0 ? (
            <div className="flex justify-between py-1 border-b border-stone-200 text-stone-700">
              <span>Service</span>
              <span className="font-mono font-medium">
                + {formatHotelCurrency(totals.serviceAmount)}
              </span>
            </div>
          ) : null}
          {totals.taxAmount > 0 ? (
            <div className="flex justify-between py-1 border-b border-stone-200 text-stone-700">
              <span>Pajak</span>
              <span className="font-mono font-medium">
                + {formatHotelCurrency(totals.taxAmount)}
              </span>
            </div>
          ) : null}
          <div className="flex justify-between pt-2 text-sm sm:text-base font-bold text-stone-900">
            <span>Grand Total</span>
            <span className="font-mono text-emerald-800">
              {formatHotelCurrency(totals.grandTotal)}
            </span>
          </div>
        </div>
      </div>

      {/* 8. Notes & Terms */}
      <div className="bg-white border border-stone-200 rounded-lg p-3 sm:p-4 shadow-sm space-y-3">
        <div className="text-xs font-semibold text-stone-700 uppercase tracking-wider border-b border-stone-100 pb-2">
          Catatan &amp; Ketentuan
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Catatan
            </label>
            <textarea
              rows={2}
              className="w-full rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              placeholder="Catatan khusus untuk pelanggan..."
              value={draft.notes || ''}
              onChange={(e) => updateDraftField('notes', e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Syarat &amp; Ketentuan
            </label>
            <textarea
              rows={2}
              className="w-full rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              placeholder="Kebijakan pembatalan, pembayaran DP, dll..."
              value={draft.terms || ''}
              onChange={(e) => updateDraftField('terms', e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 9. Payment Instructions */}
      <div className="bg-white border border-stone-200 rounded-lg p-3 sm:p-4 shadow-sm space-y-3">
        <div className="text-xs font-semibold text-stone-700 uppercase tracking-wider border-b border-stone-100 pb-2">
          Instruksi Pembayaran
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Nama Bank
            </label>
            <input
              type="text"
              className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              placeholder="Contoh: Bank Mandiri / BCA"
              value={draft.bankName || ''}
              onChange={(e) => updateDraftField('bankName', e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Nama Rekening
            </label>
            <input
              type="text"
              className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              placeholder="Atas Nama (A/N)"
              value={draft.bankAccountName || ''}
              onChange={(e) => updateDraftField('bankAccountName', e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-stone-600 mb-1">
              Nomor Rekening
            </label>
            <input
              type="text"
              className="w-full min-w-0 rounded border border-stone-300 px-2.5 py-1.5 text-xs text-stone-800 focus:outline-none focus:ring-1 focus:ring-emerald-600 focus:border-emerald-600"
              placeholder="Nomor Rekening Bank"
              value={draft.bankAccountNumber || ''}
              onChange={(e) => updateDraftField('bankAccountNumber', e.target.value)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
