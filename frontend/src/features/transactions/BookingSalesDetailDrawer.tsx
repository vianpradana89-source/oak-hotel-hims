import React, { useEffect, useState } from 'react';
import type { BookingSalesDetail, BookingSaleSourceCategory } from './transactionDomainTypes';
import { formatReservationStayType } from './transactionDomainTypes';
import { fetchBookingSalesDetailApi, settleTransactionPaymentApi } from './transactionClient';
import { depositApi } from '../deposits/depositApi';
import { formatReservationSourceLabel } from '../calendar/reservationContextMetadata';
import { formatStayShortDate, paymentStatusBadgeClass } from './penjualanBidGrouping';

interface BookingSalesDetailDrawerProps {
  isOpen: boolean;
  bookingId: number | string | null;
  propertyId: number;
  currentStaffName?: string;
  onTransactionUpdated?: () => void;
  onClose: () => void;
}

const SOURCE_LABELS: Record<BookingSaleSourceCategory, string> = {
  ROOM: 'Kamar',
  STAY_EXTRA: 'Biaya menginap',
  LAUNDRY: 'Laundry',
  POS: 'POS',
  PENALTY: 'Denda',
  OTHER_OUTLET: 'Outlet lain',
  OTHER: 'Lainnya'
};

function formatIdr(val: number | undefined | string) {
  const num = Number(val) || 0;
  const isNeg = num < 0;
  return (isNeg ? '- Rp ' : 'Rp ') + Math.abs(num).toLocaleString('id-ID');
}

function formatPaidAt(value: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export const BookingSalesDetailDrawer: React.FC<BookingSalesDetailDrawerProps> = ({
  isOpen,
  bookingId,
  propertyId,
  currentStaffName = 'Staff Front Desk',
  onTransactionUpdated,
  onClose
}) => {
  const [data, setData] = useState<BookingSalesDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [applyingDepositResId, setApplyingDepositResId] = useState<number | null>(null);
  const [settleTargetChild, setSettleTargetChild] = useState<BookingSalesDetail['children'][number] | null>(null);
  const [settleAmount, setSettleAmount] = useState<string>('');
  const [settleMethod, setSettleMethod] = useState<string>('TRANSFER');
  const [settleNotes, setSettleNotes] = useState<string>('');
  const [isSettling, setIsSettling] = useState(false);

  const reloadDetail = async () => {
    if (bookingId == null || bookingId === '') return;
    const detail = await fetchBookingSalesDetailApi(bookingId, propertyId);
    setData(detail);
  };

  useEffect(() => {
    if (!isOpen || bookingId == null || bookingId === '') {
      setData(null);
      setError(null);
      setActionMessage(null);
      setSettleTargetChild(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setActionMessage(null);
    setSettleTargetChild(null);
    fetchBookingSalesDetailApi(bookingId, propertyId)
      .then((detail) => {
        if (!cancelled) setData(detail);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || 'Gagal memuat detail penjualan booking');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, bookingId, propertyId]);

  const handleApplyDeposit = async (child: BookingSalesDetail['children'][number]) => {
    if (!child.active_advance_deposit_id || !child.unapplied_advance_deposit || child.remaining <= 0) return;
    const applyAmount = Math.min(child.unapplied_advance_deposit, child.remaining);
    setApplyingDepositResId(child.reservation_id);
    setError(null);
    setActionMessage(null);
    try {
      await depositApi.apply(child.active_advance_deposit_id, {
        property_id: propertyId,
        reservation_id: child.reservation_id,
        amount: applyAmount,
        idempotency_key: `piutang-dp-apply-${child.active_advance_deposit_id}-${Date.now()}`,
        notes: `Apply DP dari Detail Penjualan Booking (${currentStaffName})`,
      });
      await reloadDetail();
      setActionMessage(`DP sebesar ${formatIdr(applyAmount)} berhasil di-apply ke kamar ${child.room_number || '#' + child.reservation_id}.`);
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      setError(err.message || 'Gagal meng-apply Uang Muka (DP)');
    } finally {
      setApplyingDepositResId(null);
    }
  };

  const handleOpenSettleForm = (child: BookingSalesDetail['children'][number]) => {
    setSettleTargetChild(child);
    setSettleAmount(String(child.remaining || 0));
    setSettleMethod('TRANSFER');
    setSettleNotes('');
    setError(null);
    setActionMessage(null);
  };

  const handleSubmitSettlement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settleTargetChild || !settleTargetChild.primary_transaction_id) return;
    const numAmt = Math.round(Number(settleAmount) || 0);
    if (numAmt <= 0) {
      setError('Nominal pelunasan harus lebih dari Rp 0');
      return;
    }
    setIsSettling(true);
    setError(null);
    setActionMessage(null);
    try {
      await settleTransactionPaymentApi(settleTargetChild.primary_transaction_id, propertyId, {
        amount: numAmt,
        payment_method: settleMethod,
        notes: settleNotes.trim() || undefined,
        actor_name: currentStaffName,
      });
      const settledRoom = settleTargetChild.room_number || `#${settleTargetChild.reservation_id}`;
      setSettleTargetChild(null);
      setSettleAmount('');
      setSettleNotes('');
      await reloadDetail();
      setActionMessage(`Pelunasan sebesar ${formatIdr(numAmt)} berhasil dicatat untuk kamar ${settledRoom}.`);
      if (onTransactionUpdated) onTransactionUpdated();
    } catch (err: any) {
      setError(err.message || 'Gagal mencatat pelunasan');
    } finally {
      setIsSettling(false);
    }
  };

  if (!isOpen) return null;

  const booking = data?.booking;
  const financial = data?.financial;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-xs">
      <div className="w-full max-w-2xl bg-[#F7F4EC] h-full shadow-2xl flex flex-col border-l border-[#C9B896] overflow-hidden">
        <div className="p-5 border-b border-[#E4D9C4] bg-[#F1EBDD] flex items-start justify-between shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-[#1F3D2B]">
                {booking?.bid || 'Detail Penjualan Booking'}
              </h3>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border bg-[#E8F0EA] text-[#1F3D2B] border-[#C5D6C8]">
                Seluruh Booking
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-1">
              Ringkasan seluruh booking — tidak dibatasi filter periode daftar.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 rounded-lg hover:bg-white/70 cursor-pointer"
            aria-label="Tutup"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {isLoading && (
            <div className="text-sm text-slate-500">Memuat ringkasan seluruh booking...</div>
          )}
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 font-semibold">
              {error}
            </div>
          )}
          {actionMessage && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 font-semibold">
              {actionMessage}
            </div>
          )}
          {data && booking && financial && (
            <>
              <section className="bg-white rounded-xl border border-[#E4D9C4] p-4 space-y-2">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#8A7A5A]">Booking</h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <div>
                    <div className="text-slate-400">BID</div>
                    <div className="font-mono font-semibold text-slate-800">{booking.bid}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Status</div>
                    <div className="font-semibold text-slate-800">{booking.booking_status || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Tamu</div>
                    <div className="font-semibold text-slate-800">{booking.guest_name}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Pemesan</div>
                    <div className="font-semibold text-slate-800">{booking.booker_name || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">Sumber / Channel</div>
                    <div className="font-semibold text-slate-800">
                      {formatReservationSourceLabel(booking)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Menginap</div>
                    <div className="font-semibold text-slate-800">
                      {formatStayShortDate(booking.check_in)} – {formatStayShortDate(booking.check_out)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400">Jumlah kamar</div>
                    <div className="font-semibold text-slate-800">{booking.room_count}</div>
                  </div>
                </div>
              </section>

              <section className="bg-white rounded-xl border border-[#E4D9C4] p-4">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#8A7A5A] mb-2">Ringkasan keuangan</h4>
                <div className="grid grid-cols-5 gap-2 text-center">
                  {[
                    ['Gross', financial.gross, 'text-slate-700'],
                    ['Diskon', financial.discount, 'text-slate-500'],
                    ['Net', financial.net, 'text-emerald-800'],
                    ['Dibayar', financial.paid, 'text-slate-700'],
                    ['Sisa', financial.remaining, 'text-slate-700']
                  ].map(([label, value, klass]) => (
                    <div key={String(label)}>
                      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
                      <div className={`text-xs font-mono font-bold ${klass}`}>{formatIdr(value as number)}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="bg-white rounded-xl border border-[#E4D9C4] overflow-hidden">
                <div className="px-4 py-2 border-b border-[#E4D9C4]">
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#8A7A5A]">Sumber penjualan</h4>
                </div>
                {data.source_breakdown.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-slate-400">Belum ada penjualan pada booking ini.</div>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <tr>
                        <th className="py-1.5 px-3 text-left">Kategori</th>
                        <th className="py-1.5 px-3 text-left">Sumber</th>
                        <th className="py-1.5 px-3 text-right">Gross</th>
                        <th className="py-1.5 px-3 text-right">Diskon</th>
                        <th className="py-1.5 px-3 text-right">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.source_breakdown.map((row) => (
                        <tr key={`${row.category}:${row.source_type}`} className="border-t border-slate-100">
                          <td className="py-1.5 px-3 font-semibold text-slate-800">{SOURCE_LABELS[row.category] || row.category}</td>
                          <td className="py-1.5 px-3 font-mono text-slate-600">{row.source_type}</td>
                          <td className="py-1.5 px-3 text-right font-mono">{formatIdr(row.gross)}</td>
                          <td className="py-1.5 px-3 text-right font-mono text-slate-500">{formatIdr(row.discount)}</td>
                          <td className="py-1.5 px-3 text-right font-mono font-semibold">{formatIdr(row.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="bg-white rounded-xl border border-[#E4D9C4] overflow-hidden">
                <div className="px-4 py-2 border-b border-[#E4D9C4]">
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#8A7A5A]">Kamar yang dipesan</h4>
                </div>
                {data.children.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-slate-400">Tidak ada kamar pada booking ini.</div>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <tr>
                        <th className="py-1.5 px-3 text-left">Kamar</th>
                        <th className="py-1.5 px-3 text-left">Tipe</th>
                        <th className="py-1.5 px-3 text-right">Net</th>
                        <th className="py-1.5 px-3 text-right">Dibayar</th>
                        <th className="py-1.5 px-3 text-right">Sisa</th>
                        <th className="py-1.5 px-3 text-center">Status</th>
                        <th className="py-1.5 px-3 text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.children.map((child) => {
                        const hasUnappliedDp = (child.unapplied_advance_deposit ?? 0) > 0 && Boolean(child.active_advance_deposit_id);
                        const canSettle = child.remaining > 0 && Boolean(child.primary_transaction_id);
                        return (
                          <tr key={child.reservation_id} className="border-t border-slate-100">
                            <td className="py-1.5 px-3 font-semibold text-slate-800">
                              {child.room_number || '-'}
                              <div className="text-[10px] font-normal text-slate-400">
                                {formatReservationStayType(child.stay_type || '')}
                              </div>
                            </td>
                            <td className="py-1.5 px-3 text-slate-700">{child.room_type_name || '-'}</td>
                            <td className="py-1.5 px-3 text-right font-mono font-semibold">{formatIdr(child.net)}</td>
                            <td className="py-1.5 px-3 text-right font-mono">{formatIdr(child.paid)}</td>
                            <td className="py-1.5 px-3 text-right font-mono">{formatIdr(child.remaining)}</td>
                            <td className="py-1.5 px-3 text-center">
                              <div className="flex flex-col items-center gap-0.5">
                                <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${paymentStatusBadgeClass(child.payment_status)}`}>
                                  {child.payment_status}
                                </span>
                                {child.payment_responsibility === 'OTA_COLLECT' && (
                                  <span className="inline-flex items-center text-[9px] font-bold px-1.5 py-0.3 rounded border border-amber-300 bg-amber-50 text-amber-800">
                                    DITANGGUNG OTA
                                  </span>
                                )}
                                {(child.unapplied_advance_deposit ?? 0) > 0 && (
                                  <span className="inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded border border-indigo-200 bg-indigo-50 text-indigo-700">
                                    DP Custody: {formatIdr(child.unapplied_advance_deposit)}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-1.5 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center justify-end gap-1">
                                {hasUnappliedDp && child.remaining > 0 && (
                                  <button
                                    type="button"
                                    disabled={applyingDepositResId === child.reservation_id}
                                    onClick={() => handleApplyDeposit(child)}
                                    className="px-2 py-1 text-[10px] font-bold text-indigo-800 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-md cursor-pointer disabled:opacity-50"
                                  >
                                    {applyingDepositResId === child.reservation_id ? 'Memproses...' : 'Gunakan DP'}
                                  </button>
                                )}
                                {canSettle && (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenSettleForm(child)}
                                    className="px-2 py-1 text-[10px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md cursor-pointer"
                                  >
                                    + Catat Pelunasan
                                  </button>
                                )}
                                {!hasUnappliedDp && !canSettle && (
                                  <span className="text-[10px] text-slate-300">—</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {settleTargetChild && (
                  <form onSubmit={handleSubmitSettlement} className="p-3 bg-emerald-50/60 border-t border-emerald-200 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-emerald-900">
                        Catat Pelunasan — Kamar {settleTargetChild.room_number || `#${settleTargetChild.reservation_id}`} (Sisa: {formatIdr(settleTargetChild.remaining)})
                      </span>
                      <button
                        type="button"
                        onClick={() => setSettleTargetChild(null)}
                        className="text-[11px] font-semibold text-slate-500 hover:text-slate-700 cursor-pointer"
                      >
                        Batal
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-slate-500 mb-0.5">Nominal (Rp)</label>
                        <input
                          type="number"
                          min={1}
                          max={settleTargetChild.remaining}
                          value={settleAmount}
                          onChange={(e) => setSettleAmount(e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg font-mono font-bold text-slate-800"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-slate-500 mb-0.5">Metode</label>
                        <select
                          value={settleMethod}
                          onChange={(e) => setSettleMethod(e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg font-semibold text-slate-800"
                        >
                          <option value="TRANSFER">Transfer Bank</option>
                          <option value="CASH">Tunai (Cash)</option>
                          <option value="QRIS">QRIS</option>
                          <option value="CARD">Kartu Debit/Kredit</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-slate-500 mb-0.5">Catatan</label>
                        <input
                          type="text"
                          value={settleNotes}
                          onChange={(e) => setSettleNotes(e.target.value)}
                          placeholder="Ref / keterangan..."
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-800"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        type="submit"
                        disabled={isSettling}
                        className="px-3 py-1.5 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer disabled:opacity-50"
                      >
                        {isSettling ? 'Menyimpan...' : 'Simpan Pelunasan'}
                      </button>
                    </div>
                  </form>
                )}
              </section>

              <section className="bg-white rounded-xl border border-[#E4D9C4] overflow-hidden">
                <div className="px-4 py-2 border-b border-[#E4D9C4]">
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#8A7A5A]">Pembayaran</h4>
                </div>
                {data.payments.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-slate-400">Belum ada pembayaran.</div>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <tr>
                        <th className="py-1.5 px-3 text-left">Waktu</th>
                        <th className="py-1.5 px-3 text-left">Metode</th>
                        <th className="py-1.5 px-3 text-right">Nominal</th>
                        <th className="py-1.5 px-3 text-left">Ref</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.payments.map((payment) => (
                        <tr key={payment.payment_id} className="border-t border-slate-100">
                          <td className="py-1.5 px-3 text-slate-700 whitespace-nowrap">{formatPaidAt(payment.paid_at)}</td>
                          <td className="py-1.5 px-3 font-semibold text-slate-800">
                            {payment.method || '-'}
                            <div className="text-[10px] font-normal text-slate-400">{payment.status}</div>
                          </td>
                          <td className="py-1.5 px-3 text-right font-mono font-semibold">{formatIdr(payment.amount)}</td>
                          <td className="py-1.5 px-3 text-slate-600">
                            {payment.reference || '-'}
                            {payment.evidence_reference && (
                              <div className="text-[10px] text-slate-400 truncate">{payment.evidence_reference}</div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BookingSalesDetailDrawer;
