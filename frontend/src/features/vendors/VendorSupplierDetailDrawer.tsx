import React from 'react';
import type { Supplier } from './vendorSupplierTypes';
import {
  getEntityTypeLabel,
  getEntityTypeBadgeClass,
  getStatusLabel,
  getStatusBadgeClass,
  formatPaymentTerms,
  formatDateLocal
} from './vendorSupplierHelpers';
import type { VendorSupplierCapabilities } from './vendorSupplierHelpers';

interface VendorSupplierDetailDrawerProps {
  supplier: Supplier | null;
  isOpen: boolean;
  capabilities: VendorSupplierCapabilities;
  onClose: () => void;
  onEdit: (supplier: Supplier) => void;
}

export const VendorSupplierDetailDrawer: React.FC<VendorSupplierDetailDrawerProps> = ({
  supplier,
  isOpen,
  capabilities,
  onClose,
  onEdit
}) => {
  if (!isOpen || !supplier) return null;

  const isBlacklisted = supplier.status === 'BLACKLISTED';

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-slate-900/50 backdrop-blur-xs flex justify-end">
      <div className="w-full max-w-lg bg-white h-full shadow-2xl flex flex-col transform transition-transform ease-in-out duration-300 border-l border-stone-200">
        {/* Drawer Header */}
        <div className="px-6 py-5 bg-stone-900 text-white shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs bg-stone-800 text-stone-300 px-2 py-0.5 rounded border border-stone-700">
                {supplier.code || 'NO-CODE'}
              </span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${getStatusBadgeClass(supplier.status)}`}>
                {getStatusLabel(supplier.status)}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-stone-400 hover:text-white p-1 rounded-lg hover:bg-stone-800 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <h2 className="text-lg font-bold text-white mt-2 truncate">{supplier.name}</h2>
          {supplier.legal_name && supplier.legal_name !== supplier.name && (
            <p className="text-xs text-stone-400 mt-0.5 truncate">{supplier.legal_name}</p>
          )}

          {/* Quick Contact Buttons */}
          <div className="flex items-center gap-2 mt-4">
            {supplier.whatsapp && (
              <a
                href={`https://wa.me/${supplier.whatsapp.replace(/\D/g, '')}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0012.04 2zm.01 1.67c4.54 0 8.24 3.7 8.24 8.24 0 2.2-.86 4.27-2.42 5.82a8.19 8.19 0 01-5.83 2.42c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 01-1.25-4.38c0-4.54 3.7-8.24 8.25-8.24zm4.52 11.64c-.25-.13-1.47-.72-1.7-.81-.23-.08-.39-.13-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.13-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.39-1.72-.14-.25-.02-.39.11-.51.11-.11.25-.29.37-.44.13-.14.17-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.35-.77-1.85-.2-.49-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1 0 1.24.9 2.44 1.03 2.61.13.17 1.78 2.72 4.31 3.81.6.26 1.07.42 1.44.54.61.19 1.16.17 1.6.1.49-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.15-1.18-.06-.1-.23-.17-.48-.29z" />
                </svg>
                WhatsApp PIC
              </a>
            )}

            {supplier.phone && (
              <a
                href={`tel:${supplier.phone}`}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-medium rounded-lg border border-stone-700 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                Telepon
              </a>
            )}

            {supplier.email && (
              <a
                href={`mailto:${supplier.email}`}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-medium rounded-lg border border-stone-700 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Email
              </a>
            )}
          </div>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs text-stone-700">
          {/* Blacklist Warning */}
          {isBlacklisted && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5">
              <span className="text-rose-600 text-lg shrink-0">⛔</span>
              <div>
                <div className="font-bold text-rose-900">Rekanan ini sedang Di-Blacklist</div>
                <div className="text-[11px] text-rose-700 mt-0.5">
                  Rekanan berstatus blacklist dilarang keras untuk digunakan dalam transaksi pembelian atau pengeluaran operasional baru.
                </div>
              </div>
            </div>
          )}

          {/* Section 1: Profil & Identitas */}
          <div className="space-y-3">
            <h3 className="font-bold text-stone-900 uppercase tracking-wider text-[11px] flex items-center gap-2 border-b border-stone-200 pb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1b4332]" />
              Profil & Identitas Usaha
            </h3>

            <div className="grid grid-cols-2 gap-3 bg-stone-50 p-3 rounded-xl border border-stone-200/80">
              <div>
                <span className="text-stone-400 text-[10px] block">Tipe Entitas</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] mt-0.5 ${getEntityTypeBadgeClass(supplier.entity_type)}`}>
                  {getEntityTypeLabel(supplier.entity_type)}
                </span>
              </div>

              <div>
                <span className="text-stone-400 text-[10px] block">Kategori</span>
                <span className="font-semibold text-stone-800 text-xs block mt-0.5">{supplier.category || '-'}</span>
              </div>

              <div>
                <span className="text-stone-400 text-[10px] block">PIC / Kontak Utama</span>
                <span className="font-medium text-stone-800 text-xs block mt-0.5">{supplier.contact_person || '-'}</span>
              </div>

              <div>
                <span className="text-stone-400 text-[10px] block">Departemen Terkait</span>
                <span className="font-medium text-stone-800 text-xs block mt-0.5">{supplier.default_department_code || 'GENERAL'}</span>
              </div>
            </div>
          </div>

          {/* Section 2: Alamat & Perpajakan */}
          <div className="space-y-3">
            <h3 className="font-bold text-stone-900 uppercase tracking-wider text-[11px] flex items-center gap-2 border-b border-stone-200 pb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1b4332]" />
              Alamat & Perpajakan
            </h3>

            <div className="bg-stone-50 p-3 rounded-xl border border-stone-200/80 space-y-2">
              <div>
                <span className="text-stone-400 text-[10px] block">Alamat Kantor / Gudang</span>
                <span className="font-medium text-stone-800 text-xs block mt-0.5">{supplier.address || '-'}</span>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1 border-t border-stone-200/60">
                <div>
                  <span className="text-stone-400 text-[10px] block">Kota & Provinsi</span>
                  <span className="font-medium text-stone-800 text-xs block mt-0.5">
                    {supplier.city ? `${supplier.city}, ${supplier.province || ''}` : '-'}
                  </span>
                </div>

                <div>
                  <span className="text-stone-400 text-[10px] block">NPWP / Tax ID</span>
                  <span className="font-mono text-stone-800 text-xs block mt-0.5">{supplier.tax_id || '-'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Rekening Bank & Termin */}
          <div className="space-y-3">
            <h3 className="font-bold text-stone-900 uppercase tracking-wider text-[11px] flex items-center gap-2 border-b border-stone-200 pb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1b4332]" />
              Informasi Rekening Bank & Termin
            </h3>

            <div className="bg-stone-50 p-3 rounded-xl border border-stone-200/80 space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-stone-400 text-[10px] block">Bank Tujuan</span>
                  <span className="font-semibold text-stone-800 text-xs block mt-0.5">{supplier.bank_name || '-'}</span>
                </div>

                <div>
                  <span className="text-stone-400 text-[10px] block">Termin Pembayaran (TOP)</span>
                  <span className="font-semibold text-stone-800 text-xs block mt-0.5">
                    {formatPaymentTerms(supplier.payment_terms_days)}
                  </span>
                </div>
              </div>

              <div className="pt-1 border-t border-stone-200/60">
                <span className="text-stone-400 text-[10px] block">Nomor Rekening & Atas Nama</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-mono font-bold text-stone-900 text-sm">
                    {supplier.bank_account || '-'}
                  </span>
                  {supplier.bank_holder && (
                    <span className="text-stone-500 text-xs">a.n. {supplier.bank_holder}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: Catatan Internal */}
          {supplier.notes && (
            <div className="space-y-2">
              <h3 className="font-bold text-stone-900 uppercase tracking-wider text-[11px] flex items-center gap-2 border-b border-stone-200 pb-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#1b4332]" />
                Catatan Internal Operasional
              </h3>
              <div className="bg-stone-50 p-3 rounded-xl border border-stone-200/80 text-stone-700 italic">
                "{supplier.notes}"
              </div>
            </div>
          )}

          {/* Section 5: Audit Metadata */}
          <div className="pt-2 border-t border-stone-200 text-[11px] text-stone-400 space-y-1">
            <div className="flex justify-between">
              <span>Dibuat pada:</span>
              <span className="font-medium text-stone-600">{formatDateLocal(supplier.created_at)}</span>
            </div>
            <div className="flex justify-between">
              <span>Terakhir diperbarui:</span>
              <span className="font-medium text-stone-600">{formatDateLocal(supplier.updated_at || supplier.created_at)}</span>
            </div>
          </div>
        </div>

        {/* Drawer Footer */}
        <div className="px-6 py-4 bg-stone-50 border-t border-stone-200 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-stone-700 hover:bg-stone-200 rounded-lg font-medium transition-colors cursor-pointer"
          >
            Tutup
          </button>

          {capabilities.canCreateEdit && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onEdit(supplier);
              }}
              className="px-5 py-2 bg-[#1b4332] hover:bg-[#143427] text-white rounded-lg font-semibold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit Rekanan
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
