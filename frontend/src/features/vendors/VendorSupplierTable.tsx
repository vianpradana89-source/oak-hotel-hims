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

interface VendorSupplierTableProps {
  suppliers: Supplier[];
  loading: boolean;
  capabilities: VendorSupplierCapabilities;
  onViewDetail: (supplier: Supplier) => void;
  onEdit: (supplier: Supplier) => void;
  onToggleStatus: (supplier: Supplier) => void;
  onToggleBlacklist: (supplier: Supplier) => void;
  onDelete: (supplier: Supplier) => void;
}

export const VendorSupplierTable: React.FC<VendorSupplierTableProps> = ({
  suppliers,
  loading,
  capabilities,
  onViewDetail,
  onEdit,
  onToggleStatus,
  onToggleBlacklist,
  onDelete
}) => {
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-stone-200/80 p-12 text-center shadow-xs">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#1b4332] mb-3" />
        <p className="text-sm font-medium text-stone-600">Memuat katalog rekanan vendor & supplier...</p>
      </div>
    );
  }

  if (suppliers.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-stone-200/80 p-12 text-center shadow-xs">
        <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center mx-auto mb-3 text-stone-400">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        </div>
        <h3 className="text-sm font-semibold text-stone-800">Tidak Ada Rekanan Ditemukan</h3>
        <p className="text-xs text-stone-500 mt-1 max-w-sm mx-auto">
          Tidak ada data vendor atau supplier yang sesuai dengan kriteria pencarian dan filter saat ini.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-stone-200/80 overflow-hidden shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-stone-50/90 text-stone-600 font-semibold border-b border-stone-200 uppercase tracking-wider text-[11px]">
              <th className="py-3 px-3.5">Kode</th>
              <th className="py-3 px-3.5">Nama Rekanan / Legal</th>
              <th className="py-3 px-3">Tipe</th>
              <th className="py-3 px-3">Kategori</th>
              <th className="py-3 px-3.5">Kontak & WA</th>
              <th className="py-3 px-3">Kota / Wilayah</th>
              <th className="py-3 px-3">Termin Bayar</th>
              <th className="py-3 px-3 text-center">Status</th>
              <th className="py-3 px-3">Diperbarui</th>
              <th className="py-3 px-3.5 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-200/70">
            {suppliers.map((s) => {
              const isBlacklisted = s.status === 'BLACKLISTED';
              const isInactive = s.status === 'INACTIVE' || s.is_active === false;

              return (
                <tr
                  key={s.id}
                  className={`hover:bg-stone-50/80 transition-colors ${
                    isBlacklisted ? 'bg-rose-50/30' : isInactive ? 'bg-stone-50/40 opacity-75' : ''
                  }`}
                >
                  {/* Kode */}
                  <td className="py-3 px-3.5 whitespace-nowrap font-mono font-semibold text-stone-800">
                    {s.code || '-'}
                  </td>

                  {/* Nama Rekanan & Legal Name */}
                  <td className="py-3 px-3.5">
                    <div className="font-semibold text-stone-900 flex items-center gap-1.5">
                      <span className="truncate max-w-[180px]" title={s.name}>{s.name}</span>
                      {isBlacklisted && (
                        <span className="text-[10px] bg-rose-600 text-white px-1.5 py-0.5 rounded font-bold uppercase tracking-wider shrink-0">
                          Blacklist
                        </span>
                      )}
                    </div>
                    {s.legal_name && s.legal_name !== s.name && (
                      <div className="text-[11px] text-stone-500 truncate max-w-[180px]" title={s.legal_name}>
                        {s.legal_name}
                      </div>
                    )}
                  </td>

                  {/* Tipe Entitas */}
                  <td className="py-3 px-3 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium ${getEntityTypeBadgeClass(s.entity_type)}`}>
                      {getEntityTypeLabel(s.entity_type)}
                    </span>
                  </td>

                  {/* Kategori */}
                  <td className="py-3 px-3 whitespace-nowrap text-stone-700">
                    {s.category || '-'}
                  </td>

                  {/* Kontak & WA */}
                  <td className="py-3 px-3.5">
                    {s.contact_person && (
                      <div className="font-medium text-stone-800 truncate max-w-[140px]">{s.contact_person}</div>
                    )}
                    <div className="flex items-center gap-2 text-stone-600">
                      {s.whatsapp || s.phone ? (
                        <span className="font-mono text-[11px]">{s.whatsapp || s.phone}</span>
                      ) : (
                        <span className="text-stone-400">-</span>
                      )}
                      {s.whatsapp && (
                        <a
                          href={`https://wa.me/${s.whatsapp.replace(/\D/g, '')}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-600 hover:text-emerald-700 p-0.5 hover:bg-emerald-50 rounded"
                          title="Chat WhatsApp"
                        >
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0012.04 2zm.01 1.67c4.54 0 8.24 3.7 8.24 8.24 0 2.2-.86 4.27-2.42 5.82a8.19 8.19 0 01-5.83 2.42c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 01-1.25-4.38c0-4.54 3.7-8.24 8.25-8.24zm4.52 11.64c-.25-.13-1.47-.72-1.7-.81-.23-.08-.39-.13-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.13-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.39-1.72-.14-.25-.02-.39.11-.51.11-.11.25-.29.37-.44.13-.14.17-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.35-.77-1.85-.2-.49-.41-.42-.56-.43h-.48c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1 0 1.24.9 2.44 1.03 2.61.13.17 1.78 2.72 4.31 3.81.6.26 1.07.42 1.44.54.61.19 1.16.17 1.6.1.49-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.15-1.18-.06-.1-.23-.17-.48-.29z" />
                          </svg>
                        </a>
                      )}
                    </div>
                  </td>

                  {/* Kota / Wilayah */}
                  <td className="py-3 px-3 whitespace-nowrap text-stone-700">
                    <div>{s.city || '-'}</div>
                    {s.province && <div className="text-[10px] text-stone-400">{s.province}</div>}
                  </td>

                  {/* Termin Bayar */}
                  <td className="py-3 px-3 whitespace-nowrap text-stone-700 font-medium">
                    {formatPaymentTerms(s.payment_terms_days)}
                  </td>

                  {/* Status */}
                  <td className="py-3 px-3 whitespace-nowrap text-center">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] ${getStatusBadgeClass(s.status)}`}>
                      {getStatusLabel(s.status)}
                    </span>
                  </td>

                  {/* Diperbarui */}
                  <td className="py-3 px-3 whitespace-nowrap text-stone-500 text-[11px]">
                    {formatDateLocal(s.updated_at || s.created_at)}
                  </td>

                  {/* Aksi */}
                  <td className="py-3 px-3.5 whitespace-nowrap text-right">
                    <div className="inline-flex items-center gap-1">
                      {/* View Detail */}
                      <button
                        type="button"
                        onClick={() => onViewDetail(s)}
                        className="p-1.5 text-stone-600 hover:text-[#1b4332] hover:bg-stone-100 rounded-md transition-colors"
                        title="Lihat Detail Profil"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      </button>

                      {/* Edit */}
                      {capabilities.canCreateEdit && (
                        <button
                          type="button"
                          onClick={() => onEdit(s)}
                          className="p-1.5 text-stone-600 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                          title="Edit Rekanan"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                      )}

                      {/* Toggle Active / Inactive (Hidden if BLACKLISTED) */}
                      {capabilities.canManageStatus && !isBlacklisted && (
                        <button
                          type="button"
                          onClick={() => onToggleStatus(s)}
                          className={`p-1.5 rounded-md transition-colors ${
                            s.status === 'ACTIVE'
                              ? 'text-amber-600 hover:bg-amber-50'
                              : 'text-emerald-600 hover:bg-emerald-50'
                          }`}
                          title={s.status === 'ACTIVE' ? 'Nonaktifkan Rekanan' : 'Aktifkan Rekanan'}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {s.status === 'ACTIVE' ? (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            ) : (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            )}
                          </svg>
                        </button>
                      )}

                      {/* Blacklist / Restore from Blacklist */}
                      {capabilities.canManageStatus && (
                        <button
                          type="button"
                          onClick={() => onToggleBlacklist(s)}
                          className={`p-1.5 rounded-md transition-colors ${
                            isBlacklisted
                              ? 'text-emerald-600 hover:bg-emerald-50'
                              : 'text-rose-600 hover:bg-rose-50'
                          }`}
                          title={isBlacklisted ? 'Pulihkan dari Blacklist' : 'Blacklist Rekanan'}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {isBlacklisted ? (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            ) : (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                            )}
                          </svg>
                        </button>
                      )}

                      {/* Delete */}
                      {capabilities.canDelete && (
                        <button
                          type="button"
                          onClick={() => onDelete(s)}
                          className="p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                          title="Hapus Rekanan"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
