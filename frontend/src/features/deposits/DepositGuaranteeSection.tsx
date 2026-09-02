import { useState, useEffect, useCallback, useMemo } from 'react';
import { Modal } from '../../design-system/Modal';
import { useAuth } from '../auth/AuthContext';
import { getDepositGuaranteeCapabilities } from './depositCapabilities';
import {
  depositApi, identityCustodyApi,
  type Deposit, type DepositBalance, type IdentityCustodyRecord,
} from './depositApi';

const PAYMENT_METHODS = [
  { value: 'CASH', label: 'Tunai' },
  { value: 'TRANSFER', label: 'Transfer Bank' },
  { value: 'QRIS', label: 'QRIS' },
  { value: 'DEBIT_CARD', label: 'Kartu Debit' },
  { value: 'CREDIT_CARD', label: 'Kartu Kredit' },
];

const DOC_TYPES = [
  { value: 'KTP', label: 'KTP' },
  { value: 'SIM', label: 'SIM' },
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'OTHER', label: 'Lainnya' },
];

function fmtRp(v: number | string | undefined) {
  const n = Number(v || 0);
  return `Rp ${(isFinite(n) ? n : 0).toLocaleString('id-ID')}`;
}

function fmtDt(s: string | undefined | null) {
  if (!s) return '-';
  try { return new Date(s).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return s; }
}

function uid() { return `dep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function statusBadge(s: string) {
  const m: Record<string, string> = {
    RECEIVED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    PARTIALLY_USED: 'bg-amber-50 text-amber-700 border-amber-200',
    CLOSED: 'bg-stone-100 text-stone-500 border-stone-200',
    CANCELLED: 'bg-red-50 text-red-600 border-red-200',
    SUCCESS: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    FAILED: 'bg-red-50 text-red-600 border-red-200',
  };
  const l: Record<string, string> = {
    RECEIVED: 'Diterima', PARTIALLY_USED: 'Sebagian', CLOSED: 'Selesai',
    CANCELLED: 'Dibatalkan', SUCCESS: 'Berhasil', FAILED: 'Gagal',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold border ${m[s] || 'bg-stone-50 text-stone-500 border-stone-200'}`}>
      {l[s] || s}
    </span>
  );
}

function eventTypeLabel(t: string) {
  return { RECEIVED: 'Diterima', APPLY: 'Digunakan', REFUND: 'Dikembalikan', REVERSAL: 'Dibatalkan' }[t] || t;
}

function deriveStatus(d: Deposit[], c: IdentityCustodyRecord[]): string {
  const held = c.some(x => x.status === 'HELD');
  const active = d.filter(x => x.status !== 'CANCELLED');
  const hasDeposit = active.length > 0;
  if (hasDeposit && held) return 'Deposit + Identitas';
  if (hasDeposit) return 'Deposit Aktif';
  if (held) return 'Identitas Ditahan';
  return 'Belum Ada';
}

interface Props {
  reservationId: number;
  propertyId: number;
  reservationStatus: string;
  remainingBalance: number;
  compact?: boolean;
  onRefresh?: () => void;
}

export default function DepositGuaranteeSection({
  reservationId, propertyId, reservationStatus, remainingBalance, compact, onRefresh,
}: Props) {
  const { user } = useAuth();
  const capabilities = useMemo(() => getDepositGuaranteeCapabilities(user?.role), [user?.role]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [custody, setCustody] = useState<IdentityCustodyRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [dep, cust] = await Promise.all([
        depositApi.list(reservationId, propertyId).catch(() => []),
        identityCustodyApi.list(reservationId, propertyId).catch(() => []),
      ]);
      setDeposits(dep);
      setCustody(cust);
    } finally { setLoading(false); }
  }, [reservationId, propertyId]);

  useEffect(() => { loadData(); }, [loadData]);

  const balance: DepositBalance = deposits.find(d => d.status !== 'CANCELLED')?.balance
    || { effective_received: 0, applied: 0, refunded: 0, reversed_received: 0, remaining: 0, status: 'RECEIVED' };
  const guaranteeStatus = deriveStatus(deposits, custody);
  const heldIdentity = custody.find(c => c.status === 'HELD');
  const returnedCustody = custody.filter(c => c.status === 'RETURNED');
  const isClosed = ['CHECKED_OUT', 'CANCELLED'].includes(reservationStatus);

  const [showReceive, setShowReceive] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [showRefund, setShowRefund] = useState(false);
  const [showReverse, setShowReverse] = useState(false);
  const [showHoldId, setShowHoldId] = useState(false);
  const [showReturnId, setShowReturnId] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAll = async () => { await loadData(); onRefresh?.(); };

  if (loading) {
    return (
      <div className={`bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden ${compact ? 'p-3' : 'p-4'}`}>
        <div className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-2">Deposit & Jaminan</div>
        <div className="text-sm text-stone-400">Memuat...</div>
      </div>
    );
  }

  if (!capabilities.canViewSummary) return null;

  /* ───── COMPACT MODE: Summary + Held Warning only ───── */
  if (compact) {
    return (
      <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden">
        <div className="p-3 flex items-center justify-between">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-stone-400">Deposit & Jaminan</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${guaranteeStatus === 'Belum Ada' ? 'bg-stone-300' : 'bg-emerald-500'}`} />
              <span className="text-xs font-semibold text-stone-800">{guaranteeStatus}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-stone-400">Saldo</div>
            <div className={`text-xs font-semibold ${balance.remaining > 0 ? 'text-emerald-600' : 'text-stone-400'}`}>
              {fmtRp(balance.remaining)}
            </div>
          </div>
        </div>
        {heldIdentity && (
          <div className="mx-3 mb-3 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-amber-800">Identitas Ditahan:</span>
            <span className="text-[10px] text-amber-700">{heldIdentity.document_type}</span>
            {heldIdentity.document_number_masked && (
              <span className="text-[10px] text-amber-600 font-mono">{heldIdentity.document_number_masked}</span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-stone-200 shadow-xs overflow-hidden">
      {/* Header */}
      <div className="p-4 pb-3 border-b border-stone-100 flex items-center justify-between">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-stone-400">Deposit & Jaminan</div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${guaranteeStatus === 'Belum Ada' ? 'bg-stone-300' : 'bg-emerald-500'}`} />
            <span className="text-sm font-semibold text-stone-800">{guaranteeStatus}</span>
          </div>
        </div>
      </div>

      {/* Financial Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-stone-100">
        {[
          { label: 'Total Diterima', value: fmtRp(balance.effective_received), color: 'text-stone-900' },
          { label: 'Digunakan', value: fmtRp(balance.applied), color: 'text-emerald-700' },
          { label: 'Dikembalikan', value: fmtRp(balance.refunded), color: 'text-amber-700' },
          { label: 'Saldo Tersedia', value: fmtRp(balance.remaining), color: balance.remaining > 0 ? 'text-emerald-600 font-bold' : 'text-stone-400' },
        ].map((item, i) => (
          <div key={i} className="bg-white p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-stone-400">{item.label}</div>
            <div className={`text-sm mt-0.5 font-semibold ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* Deposit History */}
      {deposits.length > 0 && (
        <div className="px-4 py-3 border-t border-stone-100">
          <div className="text-[10px] font-bold uppercase tracking-wider text-stone-400 mb-2">Riwayat Deposit</div>
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {deposits.filter(d => d.status !== 'CANCELLED').flatMap(d =>
              (d.events || []).map(ev => (
                <div key={ev.id} className="flex items-center justify-between text-xs py-1 px-2 bg-stone-50 rounded-lg">
                  <div className="flex items-center gap-2">
                    {statusBadge(ev.event_type)}
                    <span className="text-stone-600">{eventTypeLabel(ev.event_type)}</span>
                  </div>
                  <div className="text-right">
                    <span className={`font-semibold ${ev.event_type === 'APPLY' ? 'text-emerald-700' : ev.event_type === 'REFUND' ? 'text-amber-700' : 'text-stone-900'}`}>
                      {ev.event_type === 'APPLY' ? '-' : '+'}{fmtRp(ev.amount)}
                    </span>
                    <span className="text-stone-400 ml-1.5">{fmtDt(ev.created_at)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      {!isClosed && capabilities.canReceiveDeposit && (
        <div className="px-4 py-3 border-t border-stone-100 flex flex-wrap gap-2">
          <button onClick={() => { setError(null); setShowReceive(true); }}
            className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 transition">
            + Terima Deposit
          </button>
          {capabilities.canApplyDeposit && balance.remaining > 0 && remainingBalance > 0 && (
            <button onClick={() => { setError(null); setShowApply(true); }}
              className="px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition">
              Gunakan ke Tagihan
            </button>
          )}
          {capabilities.canRefundDeposit && balance.remaining > 0 && (
            <button onClick={() => { setError(null); setShowRefund(true); }}
              className="px-3 py-1.5 bg-amber-500 text-white text-xs font-semibold rounded-lg hover:bg-amber-600 transition">
              Refund Deposit
            </button>
          )}
          {capabilities.canReverseDeposit && deposits.some(d => d.status === 'RECEIVED' && d.events?.length === 1 && d.events[0]?.event_type === 'RECEIVED') && (
            <button onClick={() => { setError(null); setShowReverse(true); }}
              className="px-3 py-1.5 bg-red-50 text-red-600 text-xs font-semibold rounded-lg hover:bg-red-100 border border-red-200 transition">
              Batalkan Penerimaan
            </button>
          )}
        </div>
      )}

      {/* Identity Section */}
      <div className="px-4 py-3 border-t border-stone-100">
        <div className="text-[10px] font-bold uppercase tracking-wider text-stone-400 mb-2">Jaminan Identitas</div>
        {heldIdentity ? (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-amber-800">Ditahan</span>
                <span className="text-xs text-amber-700 ml-2">{heldIdentity.document_type}</span>
                {heldIdentity.document_number_masked && (
                  <span className="text-xs text-amber-600 ml-1.5 font-mono">{heldIdentity.document_number_masked}</span>
                )}
              </div>
              {!isClosed && capabilities.canReturnIdentity && (
                <button onClick={() => { setError(null); setShowReturnId(true); }}
                  className="px-2.5 py-1 bg-white text-amber-700 text-xs font-semibold rounded-lg border border-amber-300 hover:bg-amber-100 transition">
                  Kembalikan
                </button>
              )}
            </div>
            <div className="text-[10px] text-amber-600 mt-1.5">
              Diterima: {fmtDt(heldIdentity.created_at)} • Oleh: {heldIdentity.received_by}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-xs text-stone-400">Tidak ada identitas ditahan</span>
            {!isClosed && capabilities.canHoldIdentity && (
              <button onClick={() => { setError(null); setShowHoldId(true); }}
                className="px-2.5 py-1 bg-stone-100 text-stone-700 text-xs font-semibold rounded-lg hover:bg-stone-200 border border-stone-200 transition">
                + Terima Identitas
              </button>
            )}
          </div>
        )}
        {/* Identity Custody History */}
        {returnedCustody.length > 0 && (
          <div className="mt-2 space-y-1">
            {returnedCustody.map(c => (
              <div key={c.id} className="flex items-center justify-between text-[11px] py-1 px-2 bg-stone-50 rounded-lg">
                <div className="flex items-center gap-1.5">
                  <span className="text-stone-400">Dikembalikan</span>
                  <span className="font-semibold text-stone-600">{c.document_type}</span>
                  {c.document_number_masked && (
                    <span className="text-stone-400 font-mono">{c.document_number_masked}</span>
                  )}
                </div>
                <div className="text-right text-stone-400">
                  {c.returned_at && fmtDt(c.returned_at)}
                  {c.returned_by && <span className="ml-1">• {c.returned_by}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Error */}
      {error && <div className="px-4 py-2 bg-red-50 border-t border-red-100 text-xs text-red-600">{error}</div>}

      {/* === MODALS === */}

      {/* Receive Deposit Modal */}
      <ReceiveDepositModal isOpen={showReceive} onClose={() => setShowReceive(false)}
        reservationId={reservationId} propertyId={propertyId}
        onSuccess={refreshAll} />

      {/* Apply Deposit Modal */}
      <ApplyDepositModal isOpen={showApply} onClose={() => setShowApply(false)}
        reservationId={reservationId} propertyId={propertyId}
        onSuccess={refreshAll} deposits={deposits} remainingBalance={remainingBalance} />

      {/* Refund Deposit Modal */}
      <RefundDepositModal isOpen={showRefund} onClose={() => setShowRefund(false)}
        reservationId={reservationId} propertyId={propertyId}
        onSuccess={refreshAll} deposits={deposits} />

      {/* Reverse Deposit Confirmation */}
      {showReverse && (
        <Modal isOpen title="Batalkan Penerimaan Deposit" onClose={() => { setShowReverse(false); setError(null); }}>
          <p className="text-sm text-stone-600 mb-4">
            Membatalkan penerimaan deposit akan mengembalikan seluruh nominal ke status awal.
            Tindakan ini hanya dapat dilakukan jika deposit belum pernah digunakan atau dikembalikan.
          </p>
          <div className="mb-3">
            <label className="block text-xs font-semibold text-stone-600 mb-1">Alasan Pembatalan *</label>
            <textarea className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm" rows={2}
              onChange={e => (window as any).__reverseReason = e.target.value}
              placeholder="Masukkan alasan..." />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowReverse(false); setError(null); }}
              className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg">Batal</button>
            <button disabled={busy} onClick={async () => {
              const reason = (window as any).__reverseReason;
              if (!reason?.trim()) { setError('Alasan wajib diisi'); return; }
              setBusy(true); setError(null);
              try {
                const unreversed = deposits.find(d => d.status === 'RECEIVED' && d.events?.length === 1 && d.events[0]?.event_type === 'RECEIVED');
                if (!unreversed) throw new Error('Deposit tidak memenuhi syarat pembatalan');
                await depositApi.reverse(unreversed.id, {
                  property_id: propertyId, reservation_id: reservationId,
                  idempotency_key: uid(), reason: reason.trim(),
                });
                setShowReverse(false); await refreshAll();
              } catch (e: any) { setError(e.message || 'Gagal membatalkan'); }
              finally { setBusy(false); }
            }}
              className="px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 transition">
              {busy ? 'Memproses...' : 'Batalkan Penerimaan'}
            </button>
          </div>
        </Modal>
      )}

      {/* Hold Identity Modal */}
      <Modal isOpen={showHoldId} onClose={() => { setShowHoldId(false); setError(null); }}
        title="Terima Identitas Fisik" size="sm">
        <HoldIdentityForm propertyId={propertyId} reservationId={reservationId}
          onSuccess={() => { setShowHoldId(false); refreshAll(); }} onError={setError} />
      </Modal>

      {/* Return Identity Confirmation */}
      {showReturnId && heldIdentity && (
        <Modal isOpen title="Kembalikan Identitas" onClose={() => { setShowReturnId(false); setError(null); }} size="sm">
          <p className="text-sm text-stone-600 mb-4">
            Mengembalikan {heldIdentity.document_type} milik {heldIdentity.document_holder_name}.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowReturnId(false); setError(null); }}
              className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg">Batal</button>
            <button disabled={busy} onClick={async () => {
              setBusy(true); setError(null);
              try {
                await identityCustodyApi.returnDoc(heldIdentity.id, propertyId);
                setShowReturnId(false); await refreshAll();
              } catch (e: any) { setError(e.message || 'Gagal mengembalikan'); }
              finally { setBusy(false); }
            }}
              className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition">
              {busy ? 'Memproses...' : 'Kembalikan'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ────────── Receive Deposit Sub-Modal ────────── */

function ReceiveDepositModal({ isOpen, onClose, reservationId, propertyId, onSuccess }: {
  isOpen: boolean; onClose: () => void; reservationId: number; propertyId: number;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const raw = parseInt(String(amount).replace(/\D/g, ''), 10);
    if (!raw || raw <= 0) { setError('Nominal harus lebih dari 0'); return; }
    setBusy(true); setError(null);
    try {
      await depositApi.receive({
        property_id: propertyId, reservation_id: reservationId,
        amount: raw, payment_method: method, idempotency_key: uid(),
        notes: notes.trim() || undefined, file: file || undefined,
      });
      onSuccess(); onClose();
    } catch (e: any) { setError(e.message || 'Gagal menerima deposit'); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Terima Deposit" size="sm">
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1">Nominal (IDR) *</label>
          <input type="text" inputMode="numeric" value={amount}
            onChange={e => { setAmount(e.target.value.replace(/[^\d]/g, '')); setError(null); }}
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm font-semibold"
            placeholder="0" autoFocus />
          {amount && <div className="text-xs text-stone-400 mt-0.5">{fmtRp(parseInt(amount.replace(/\D/g, ''), 10) || 0)}</div>}
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1">Metode Pembayaran *</label>
          <select value={method} onChange={e => setMethod(e.target.value)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm">
            {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1">Catatan</label>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm" placeholder="Opsional" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1">Bukti Pembayaran</label>
          <input type="file" onChange={e => setFile(e.target.files?.[0] || null)}
            className="w-full text-sm text-stone-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-stone-100 file:text-stone-700 hover:file:bg-stone-200" />
        </div>
        {error && <div className="text-xs text-red-600 bg-red-50 p-2 rounded-lg">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg">Batal</button>
          <button disabled={busy || !amount} onClick={submit}
            className="px-4 py-1.5 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition">
            {busy ? 'Memproses...' : 'Terima Deposit'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ────────── Apply Deposit Sub-Modal ────────── */

function ApplyDepositModal({ isOpen, onClose, reservationId, propertyId, onSuccess, deposits, remainingBalance }: {
  isOpen: boolean; onClose: () => void; reservationId: number; propertyId: number;
  onSuccess: () => void; deposits: Deposit[];
  remainingBalance: number;
}) {
  const available = deposits.find(d => d.status !== 'CANCELLED')?.balance?.remaining || 0;
  const maxApply = Math.min(available, remainingBalance);
  const [amount, setAmount] = useState(String(maxApply || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (isOpen) setAmount(String(maxApply || '')); }, [isOpen, maxApply]);

  const submit = async () => {
    const raw = parseInt(String(amount).replace(/\D/g, ''), 10);
    if (!raw || raw <= 0) { setError('Nominal harus lebih dari 0'); return; }
    if (raw > available) { setError('Melebihi saldo deposit tersedia'); return; }
    if (raw > remainingBalance) { setError('Melebihi sisa tagihan'); return; }
    const dep = deposits.find(d => d.status !== 'CANCELLED');
    if (!dep) { setError('Tidak ada deposit aktif'); return; }
    setBusy(true); setError(null);
    try {
      await depositApi.apply(dep.id, {
        property_id: propertyId, reservation_id: reservationId,
        amount: raw, idempotency_key: uid(),
      });
      onSuccess(); onClose();
    } catch (e: any) { setError(e.message || 'Gagal menerapkan deposit'); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Gunakan Deposit ke Tagihan" size="sm">
      <div className="space-y-3">
        <div className="bg-stone-50 rounded-lg p-3 grid grid-cols-2 gap-3 text-xs">
          <div><span className="text-stone-400 block">Deposit Tersedia</span><span className="font-semibold text-stone-800">{fmtRp(available)}</span></div>
          <div><span className="text-stone-400 block">Sisa Tagihan</span><span className="font-semibold text-stone-800">{fmtRp(remainingBalance)}</span></div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1">Nominal Digunakan *</label>
          <input type="text" inputMode="numeric" value={amount}
            onChange={e => { setAmount(e.target.value.replace(/[^\d]/g, '')); setError(null); }}
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm font-semibold" placeholder="0" />
          {amount && <div className="text-xs text-stone-400 mt-0.5">{fmtRp(parseInt(amount.replace(/\D/g, ''), 10) || 0)}</div>}
        </div>
        {error && <div className="text-xs text-red-600 bg-red-50 p-2 rounded-lg">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg">Batal</button>
          <button disabled={busy || !amount} onClick={submit}
            className="px-4 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
            {busy ? 'Memproses...' : 'Gunakan ke Tagihan'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ────────── Refund Deposit Sub-Modal ────────── */

function RefundDepositModal({ isOpen, onClose, reservationId, propertyId, onSuccess, deposits }: {
  isOpen: boolean; onClose: () => void; reservationId: number; propertyId: number;
  onSuccess: () => void; deposits: Deposit[];
}) {
  const available = deposits.find(d => d.status !== 'CANCELLED')?.balance?.remaining || 0;
  const [amount, setAmount] = useState(String(available || ''));
  const [method, setMethod] = useState('CASH');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (isOpen) setAmount(String(available || '')); }, [isOpen, available]);

  const submit = async () => {
    const raw = parseInt(String(amount).replace(/\D/g, ''), 10);
    if (!raw || raw <= 0) { setError('Nominal harus lebih dari 0'); return; }
    if (raw > available) { setError('Melebihi saldo deposit tersedia'); return; }
    const dep = deposits.find(d => d.status !== 'CANCELLED');
    if (!dep) { setError('Tidak ada deposit aktif'); return; }
    setBusy(true); setError(null);
    try {
      await depositApi.refund(dep.id, {
        property_id: propertyId, reservation_id: reservationId,
        amount: raw, payment_method: method, idempotency_key: uid(),
        notes: notes.trim() || undefined,
      });
      onSuccess(); onClose();
    } catch (e: any) { setError(e.message || 'Gagal refund deposit'); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Refund Deposit" size="sm">
      <div className="space-y-3">
        <div className="bg-stone-50 rounded-lg p-3 text-xs">
          <span className="text-stone-400">Saldo Deposit Tersedia</span>
          <span className="font-semibold text-stone-800 ml-2">{fmtRp(available)}</span>
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1">Nominal Refund *</label>
          <input type="text" inputMode="numeric" value={amount}
            onChange={e => { setAmount(e.target.value.replace(/[^\d]/g, '')); setError(null); }}
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm font-semibold" placeholder="0" />
          {amount && <div className="text-xs text-stone-400 mt-0.5">{fmtRp(parseInt(amount.replace(/\D/g, ''), 10) || 0)}</div>}
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1">Metode Pengembalian *</label>
          <select value={method} onChange={e => setMethod(e.target.value)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm">
            {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-stone-600 mb-1">Catatan</label>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm" placeholder="Opsional" />
        </div>
        {error && <div className="text-xs text-red-600 bg-red-50 p-2 rounded-lg">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg">Batal</button>
          <button disabled={busy || !amount} onClick={submit}
            className="px-4 py-1.5 bg-amber-500 text-white text-xs font-semibold rounded-lg hover:bg-amber-600 disabled:opacity-50 transition">
            {busy ? 'Memproses...' : 'Refund Deposit'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ────────── Hold Identity Form ────────── */

function HoldIdentityForm({ propertyId, reservationId, onSuccess, onError }: {
  propertyId: number; reservationId: number;
  onSuccess: () => void; onError: (msg: string | null) => void;
}) {
  const [docType, setDocType] = useState('KTP');
  const [holderName, setHolderName] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!holderName.trim()) { onError('Nama pemegang wajib diisi'); return; }
    setBusy(true); onError(null);
    try {
      await identityCustodyApi.hold({
        property_id: propertyId, reservation_id: reservationId,
        document_type: docType as any, document_holder_name: holderName.trim(),
        storage_location: location.trim() || undefined, notes: notes.trim() || undefined,
      });
      onSuccess();
    } catch (e: any) { onError(e.message || 'Gagal menyimpan'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-semibold text-stone-600 mb-1">Jenis Dokumen *</label>
        <select value={docType} onChange={e => setDocType(e.target.value)}
          className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm">
          {DOC_TYPES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-semibold text-stone-600 mb-1">Nama Pemegang *</label>
        <input type="text" value={holderName} onChange={e => { setHolderName(e.target.value); onError(null); }}
          className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm" placeholder="Nama pada dokumen" autoFocus />
      </div>
      <div>
        <label className="block text-xs font-semibold text-stone-600 mb-1">Lokasi Penyimpanan</label>
        <input type="text" value={location} onChange={e => setLocation(e.target.value)}
          className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm" placeholder="Opsional" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-stone-600 mb-1">Catatan</label>
        <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
          className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm" placeholder="Opsional" />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onSuccess}
          className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:bg-stone-100 rounded-lg">Batal</button>
        <button disabled={busy} onClick={submit}
          className="px-4 py-1.5 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition">
          {busy ? 'Menyimpan...' : 'Simpan'}
        </button>
      </div>
    </div>
  );
}
