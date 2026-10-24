/**
 * OAK HIMS — MP-04B Stock Ledger Drawer
 * Kartu Stok Kronologis per Produk dan Lokasi
 */

import { useState, useEffect, useCallback } from 'react';
import { fetchStockLedger } from './posInventoryApi';
import type { StockLedgerCardData, StockMovement } from './posInventoryTypes';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  propertyId: number;
  productId: number | null;
  productName: string;
  locationId: number | null;
  locationName: string;
  baseUnitCode?: string;
}

function getDefaultDates(): { startDate: string; endDate: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${day}`;
  return { startDate, endDate };
}

function formatMovementType(type: string): { label: string; badgeClass: string } {
  switch (type) {
    case 'OPENING_BALANCE':
      return { label: 'Saldo Awal', badgeClass: 'bg-blue-50 text-blue-700 border-blue-200' };
    case 'PURCHASE_RECEIPT':
      return { label: 'Penerimaan PO', badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200' };
    case 'STOCK_ADJUSTMENT':
      return { label: 'Penyesuaian', badgeClass: 'bg-amber-50 text-amber-800 border-amber-200' };
    case 'STOCK_OPNAME':
      return { label: 'Opname Fisik', badgeClass: 'bg-purple-50 text-purple-800 border-purple-200' };
    case 'STOCK_TRANSFER_IN':
      return { label: 'Transfer Masuk', badgeClass: 'bg-teal-50 text-teal-800 border-teal-200' };
    case 'STOCK_TRANSFER_OUT':
      return { label: 'Transfer Keluar', badgeClass: 'bg-indigo-50 text-indigo-800 border-indigo-200' };
    case 'SALE':
      return { label: 'Penjualan POS', badgeClass: 'bg-rose-50 text-rose-800 border-rose-200' };
    case 'ROOM_MINIBAR_POSTING':
      return { label: 'Minibar Kamar', badgeClass: 'bg-cyan-50 text-cyan-800 border-cyan-200' };
    default:
      return { label: type, badgeClass: 'bg-gray-100 text-gray-700 border-gray-200' };
  }
}

export default function StockLedgerDrawer({
  isOpen,
  onClose,
  propertyId,
  productId,
  productName,
  locationId,
  locationName,
  baseUnitCode = 'PCS',
}: Props) {
  const defaultDates = getDefaultDates();
  const [startDate, setStartDate] = useState<string>(defaultDates.startDate);
  const [endDate, setEndDate] = useState<string>(defaultDates.endDate);
  const [ledgerData, setLedgerData] = useState<StockLedgerCardData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadLedger = useCallback(async () => {
    if (!productId || !locationId || !isOpen) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await fetchStockLedger(propertyId, {
        product_id: productId,
        location_id: locationId,
        start_date: startDate,
        end_date: endDate,
      });
      setLedgerData(data);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal memuat kartu stok');
    } finally {
      setLoading(false);
    }
  }, [propertyId, productId, locationId, startDate, endDate, isOpen]);

  useEffect(() => {
    if (isOpen) {
      void loadLedger();
    } else {
      setLedgerData(null);
      setErrorMsg(null);
    }
  }, [isOpen, loadLedger]);

  if (!isOpen) return null;

  const unit = ledgerData?.base_unit_code || baseUnitCode;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity duration-200"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer Panel */}
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-y-0 right-0 max-w-full w-full sm:w-[680px] bg-white shadow-2xl flex flex-col z-10 duration-200 border-l border-gray-200"
      >
        {/* Drawer Header */}
        <div className="px-6 py-4 bg-[#1b4332] text-white flex items-center justify-between shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wider bg-white/20 text-[#f4f1ea]">
                Kartu Stok
              </span>
              <span className="text-xs text-white/70">• {locationName}</span>
            </div>
            <h2 className="text-lg font-bold text-white mt-1">{productName}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-white/70 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
            aria-label="Tutup"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Date Filter Bar */}
        <div className="px-6 py-3 bg-[#faf9f5] border-b border-gray-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 text-xs text-gray-700">
            <span className="font-semibold text-gray-600">Periode:</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-emerald-600"
            />
            <span className="text-gray-400">s/d</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-emerald-600"
            />
            <button
              type="button"
              onClick={() => void loadLedger()}
              disabled={loading}
              className="px-3 py-1 bg-[#1b4332] text-white text-xs font-semibold rounded-lg hover:bg-[#2d6a4f] transition-colors disabled:opacity-50 cursor-pointer"
            >
              Filter
            </button>
          </div>
          <button
            type="button"
            onClick={() => void loadLedger()}
            disabled={loading}
            className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1 cursor-pointer"
            title="Muat ulang"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>

        {/* Ledger Summary Cards */}
        {ledgerData && (
          <div className="px-6 py-3 grid grid-cols-4 gap-2 bg-gray-50 border-b border-gray-200 shrink-0">
            <div className="p-2.5 bg-white rounded-xl border border-gray-200 text-center">
              <div className="text-[10px] font-bold text-gray-500 uppercase">Saldo Awal</div>
              <div className="text-sm font-extrabold text-gray-800 mt-0.5">
                {parseFloat(ledgerData.opening_balance).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-gray-400">{unit}</div>
            </div>
            <div className="p-2.5 bg-emerald-50 rounded-xl border border-emerald-200 text-center">
              <div className="text-[10px] font-bold text-emerald-800 uppercase">Total Masuk</div>
              <div className="text-sm font-extrabold text-emerald-700 mt-0.5">
                +{parseFloat(ledgerData.total_in).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-emerald-600">{unit}</div>
            </div>
            <div className="p-2.5 bg-rose-50 rounded-xl border border-rose-200 text-center">
              <div className="text-[10px] font-bold text-rose-800 uppercase">Total Keluar</div>
              <div className="text-sm font-extrabold text-rose-700 mt-0.5">
                -{parseFloat(ledgerData.total_out).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-rose-600">{unit}</div>
            </div>
            <div className="p-2.5 bg-[#1b4332]/10 rounded-xl border border-[#1b4332]/30 text-center">
              <div className="text-[10px] font-bold text-[#1b4332] uppercase">Saldo Akhir</div>
              <div className="text-sm font-black text-[#1b4332] mt-0.5">
                {parseFloat(ledgerData.closing_balance).toLocaleString('id-ID')}
              </div>
              <div className="text-[10px] text-[#1b4332]/80">{unit}</div>
            </div>
          </div>
        )}

        {/* Drawer Body: Chronological Movements Table */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between">
              <span>{errorMsg}</span>
              <button onClick={() => setErrorMsg(null)} className="font-bold hover:text-rose-900">✕</button>
            </div>
          )}

          {loading ? (
            <div className="py-16 text-center text-gray-400">
              <svg className="w-8 h-8 animate-spin mx-auto text-emerald-700 mb-2" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              <span className="text-xs">Memuat mutasi kartu stok...</span>
            </div>
          ) : !ledgerData || ledgerData.movements.length === 0 ? (
            <div className="py-16 text-center text-gray-400 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
              <svg className="w-10 h-10 mx-auto text-gray-300 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div className="text-sm font-semibold text-gray-600">Tidak ada riwayat mutasi</div>
              <div className="text-xs text-gray-400 mt-1">
                Belum ada transaksi stok untuk produk ini pada rentang tanggal yang dipilih.
              </div>
            </div>
          ) : (
            <div className="overflow-hidden border border-gray-200 rounded-xl bg-white shadow-2xs">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#faf9f5] border-b border-gray-200 text-gray-600 font-bold uppercase text-[10px]">
                  <tr>
                    <th className="px-3 py-2.5">Waktu</th>
                    <th className="px-3 py-2.5">Tipe Mutasi</th>
                    <th className="px-3 py-2.5">Referensi</th>
                    <th className="px-3 py-2.5 text-right">Mutasi</th>
                    <th className="px-3 py-2.5 text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {ledgerData.movements.map((mov: StockMovement) => {
                    const delta = parseFloat(mov.quantity_delta);
                    const isPositive = delta > 0;
                    const { label, badgeClass } = formatMovementType(mov.movement_type);
                    const dateFormatted = new Date(mov.created_at).toLocaleString('id-ID', {
                      timeZone: 'Asia/Jakarta',
                      dateStyle: 'short',
                      timeStyle: 'short',
                    });

                    return (
                      <tr key={mov.id} className="hover:bg-gray-50/80 transition-colors">
                        <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                          {dateFormatted}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${badgeClass}`}>
                            {label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-600">
                          <div className="font-medium">{mov.reference_id || '-'}</div>
                          {mov.notes && (
                            <div className="text-[10px] text-gray-400 truncate max-w-[140px]" title={mov.notes}>
                              {mov.notes}
                            </div>
                          )}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-bold whitespace-nowrap ${
                          isPositive ? 'text-emerald-700' : delta < 0 ? 'text-rose-700' : 'text-gray-500'
                        }`}>
                          {isPositive ? `+${delta.toFixed(3)}` : delta.toFixed(3)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-extrabold text-gray-900 whitespace-nowrap">
                          {parseFloat(mov.running_balance).toFixed(3)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Drawer Footer */}
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 text-xs font-semibold rounded-xl transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
