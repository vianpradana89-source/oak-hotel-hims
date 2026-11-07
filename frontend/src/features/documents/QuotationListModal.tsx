import { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

export interface QuotationListItem {
  id: number;
  property_id: number;
  quotation_number: string;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  check_in_date?: string | null;
  check_out_date?: string | null;
  status: 'ACTIVE' | 'DELETED';
  total_amount: number | string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  created_by_name?: string | null;
  updated_by_name?: string | null;
  deleted_by_name?: string | null;
  latest_revision?: {
    revision_number: number;
    revision_label: string;
    created_at: string;
  } | null;
}

interface QuotationListModalProps {
  isOpen: boolean;
  onClose: () => void;
  propertyId: number;
  onSelectQuotation: (quotationId: number) => Promise<void>;
  onDeleteQuotation?: (quotationId: number) => void;
}

export default function QuotationListModal({
  isOpen,
  onClose,
  propertyId,
  onSelectQuotation,
  onDeleteQuotation,
}: QuotationListModalProps) {
  const [tab, setTab] = useState<'ACTIVE' | 'DELETED'>('ACTIVE');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<QuotationListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Delete confirmation state
  const [deletingItem, setDeletingItem] = useState<QuotationListItem | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchQuotations = useCallback(async () => {
    if (!isOpen || !propertyId) return;
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        property_id: String(propertyId),
        status: tab,
        limit: '100',
      });
      if (search.trim()) {
        q.set('search', search.trim());
      }
      const res = await authenticatedFetch(`/api/documents/quotations?${q.toString()}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `Gagal memuat daftar quotation (HTTP ${res.status})`);
      }
      const json = await res.json();
      setItems(json.data || []);
    } catch (err: any) {
      setError(err.message || 'Terjadi kesalahan saat memuat data');
    } finally {
      setLoading(false);
    }
  }, [isOpen, propertyId, tab, search]);

  useEffect(() => {
    fetchQuotations();
  }, [fetchQuotations]);

  const handleOpenQuotation = async (item: QuotationListItem) => {
    setActionLoading(true);
    try {
      await onSelectQuotation(item.id);
      onClose();
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err.message || 'Gagal membuka quotation' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingItem) return;
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await authenticatedFetch(
        `/api/documents/quotations/${deletingItem.id}?property_id=${propertyId}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Gagal memindahkan quotation ke sampah');
      }
      setDeletingItem(null);
      if (onDeleteQuotation) {
        onDeleteQuotation(deletingItem.id);
      }
      setActionMessage({ type: 'success', text: `Quotation ${deletingItem.quotation_number} berhasil dipindahkan ke sampah.` });
      fetchQuotations();
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err.message || 'Gagal menghapus quotation' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestore = async (item: QuotationListItem) => {
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await authenticatedFetch(
        `/api/documents/quotations/${item.id}/restore?property_id=${propertyId}`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Gagal memulihkan quotation');
      }
      setActionMessage({ type: 'success', text: `Quotation ${item.quotation_number} berhasil dipulihkan.` });
      fetchQuotations();
    } catch (err: any) {
      setActionMessage({ type: 'error', text: err.message || 'Gagal memulihkan quotation' });
    } finally {
      setActionLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden border border-stone-200 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-stone-200 bg-[#2D4A3E] text-white flex items-center justify-between">
          <div>
            <h3 className="text-base sm:text-lg font-bold flex items-center gap-2">
              <svg className="w-5 h-5 text-[#D4AF37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Daftar Quotation & Penawaran Harga
            </h3>
            <p className="text-xs text-emerald-100 mt-0.5">
              Simpan, buka kembali revisi, dan kelola penawaran harga tanpa mempengaruhi inventori kamar.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-stone-300 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Action message banner */}
        {actionMessage && (
          <div className={`p-3 text-xs flex items-center justify-between ${
            actionMessage.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-b border-emerald-200' : 'bg-red-50 text-red-800 border-b border-red-200'
          }`}>
            <span>{actionMessage.text}</span>
            <button
              type="button"
              onClick={() => setActionMessage(null)}
              className="text-stone-500 hover:text-stone-800 underline ml-2"
            >
              Tutup
            </button>
          </div>
        )}

        {/* Toolbar: Tabs & Search */}
        <div className="p-3 sm:p-4 bg-stone-50 border-b border-stone-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 bg-stone-200/80 p-0.5 rounded-lg text-xs font-semibold">
            <button
              type="button"
              onClick={() => { setTab('ACTIVE'); setActionMessage(null); }}
              className={`px-3 py-1.5 rounded-md transition-all ${
                tab === 'ACTIVE'
                  ? 'bg-white text-emerald-900 shadow-xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              Quotation Aktif
            </button>
            <button
              type="button"
              onClick={() => { setTab('DELETED'); setActionMessage(null); }}
              className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 ${
                tab === 'DELETED'
                  ? 'bg-white text-red-900 shadow-xs'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              <svg className="w-3.5 h-3.5 text-stone-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Sampah / Dihapus
            </button>
          </div>

          <div className="relative flex-1 max-w-xs">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari no. quotation / klien..."
              className="w-full text-xs pl-8 pr-3 py-1.5 rounded-lg border border-stone-300 focus:outline-none focus:ring-1 focus:ring-[#2D4A3E] bg-white"
            />
            <svg className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Content Table */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 min-h-[300px]">
          {loading ? (
            <div className="py-16 text-center text-stone-400 text-sm flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
              <span>Memuat daftar quotation...</span>
            </div>
          ) : error ? (
            <div className="py-12 text-center text-red-600 text-sm">
              {error}
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-stone-400 text-sm">
              {tab === 'ACTIVE'
                ? 'Belum ada quotation tersimpan. Buat penawaran baru dan klik "Simpan Quotation".'
                : 'Tidak ada quotation di kotak sampah.'}
            </div>
          ) : (
            <div className="border border-stone-200 rounded-xl overflow-hidden shadow-xs">
              <table className="w-full text-left text-xs">
                <thead className="bg-stone-50 border-b border-stone-200 text-stone-600 font-semibold uppercase text-[10px] tracking-wider">
                  <tr>
                    <th className="py-2.5 px-3">No. Quotation</th>
                    <th className="py-2.5 px-3">Tamu / Klien</th>
                    <th className="py-2.5 px-3">Periode Stay</th>
                    <th className="py-2.5 px-3 text-right">Total Penawaran</th>
                    <th className="py-2.5 px-3 text-center">Revisi</th>
                    <th className="py-2.5 px-3">Terakhir Diubah</th>
                    <th className="py-2.5 px-3 text-center">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {items.map((item) => {
                    const revLabel = item.latest_revision?.revision_label || 'R1';
                    const stayText = item.check_in_date && item.check_out_date
                      ? `${item.check_in_date} s/d ${item.check_out_date}`
                      : (item.check_in_date || '-');
                    const updatedText = new Date(item.updated_at).toLocaleDateString('id-ID', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    });

                    return (
                      <tr key={item.id} className="hover:bg-stone-50/70 transition-colors">
                        <td className="py-2.5 px-3 font-mono font-bold text-[#2D4A3E]">
                          {item.quotation_number}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-stone-900">
                          <div>{item.customer_name}</div>
                          {item.customer_phone && (
                            <div className="text-[10px] text-stone-400">{item.customer_phone}</div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-stone-600">
                          {stayText}
                        </td>
                        <td className="py-2.5 px-3 text-right font-bold text-stone-800">
                          Rp{Number(item.total_amount || 0).toLocaleString('id-ID')}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#F4EBD0] text-[#8C6D23] border border-[#D4AF37]/40">
                            {revLabel}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-stone-500 text-[11px]">
                          <div>{updatedText}</div>
                          <div className="text-[10px] text-stone-400">{item.updated_by_name || item.created_by_name || '-'}</div>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {tab === 'ACTIVE' ? (
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleOpenQuotation(item)}
                                disabled={actionLoading}
                                className="px-2.5 py-1 rounded bg-[#2D4A3E] hover:bg-[#243c32] text-white font-medium text-xs shadow-xs transition-colors cursor-pointer"
                              >
                                Buka
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeletingItem(item)}
                                disabled={actionLoading}
                                title="Hapus ke sampah"
                                className="p-1 rounded text-stone-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleRestore(item)}
                              disabled={actionLoading}
                              className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs shadow-xs transition-colors cursor-pointer flex items-center gap-1 mx-auto"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              Pulihkan
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 sm:p-4 bg-stone-50 border-t border-stone-200 flex items-center justify-between">
          <span className="text-xs text-stone-500">
            Total {items.length} quotation {tab === 'ACTIVE' ? 'aktif' : 'di sampah'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-stone-300 text-stone-700 text-xs font-semibold hover:bg-stone-100 transition-colors"
          >
            Tutup
          </button>
        </div>

        {/* Delete Confirmation Modal */}
        {deletingItem && (
          <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/50">
            <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-4 border border-stone-200">
              <div className="flex items-center gap-3 text-red-600 mb-2">
                <div className="p-2 rounded-full bg-red-100">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <h4 className="font-bold text-stone-900 text-sm">Hapus Quotation ke Sampah?</h4>
              </div>
              <p className="text-xs text-stone-600 mb-4 leading-relaxed">
                Quotation <b className="font-mono text-stone-800">{deletingItem.quotation_number}</b> atas nama <b>{deletingItem.customer_name}</b> akan dipindahkan ke tab Sampah. Riwayat revisi tetap aman dan dapat dipulihkan sewaktu-waktu.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeletingItem(null)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:text-stone-900"
                >
                  Batal
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs font-bold bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-xs"
                >
                  {actionLoading ? 'Menghapus...' : 'Ya, Pindahkan ke Sampah'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
