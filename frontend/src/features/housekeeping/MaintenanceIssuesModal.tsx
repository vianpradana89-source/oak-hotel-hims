import React, { useState, useEffect, useCallback } from 'react';
import type { HousekeepingTaskFinding } from './housekeepingTypes';

interface MaintenanceIssuesModalProps {
  isOpen: boolean;
  onClose: () => void;
  propertyId: number;
  apiBaseUrl?: string;
  onRefreshParent?: () => void;
  initialRoomId?: number;
}

export const MaintenanceIssuesModal: React.FC<MaintenanceIssuesModalProps> = ({
  isOpen,
  onClose,
  propertyId,
  apiBaseUrl = '/api',
  onRefreshParent,
  initialRoomId
}) => {
  const [findings, setFindings] = useState<HousekeepingTaskFinding[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tabFilter, setTabFilter] = useState<'OPEN' | 'ALL'>('OPEN');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedRoomId, setSelectedRoomId] = useState<number | undefined>(initialRoomId);

  // Active Resolving Finding State
  const [resolvingFindingId, setResolvingFindingId] = useState<number | null>(null);
  const [resolutionNote, setResolutionNote] = useState<string>('');
  const [targetRoomStatus, setTargetRoomStatus] = useState<'VACANT_CLEAN' | 'VACANT_DIRTY' | 'KEEP'>('VACANT_CLEAN');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Photo viewer lightbox
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    setSelectedRoomId(initialRoomId);
  }, [initialRoomId, isOpen]);

  const fetchFindings = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const url = `${apiBaseUrl}/housekeeping/findings?property_id=${propertyId}${
        tabFilter === 'OPEN' ? '&status=OPEN' : ''
      }`;
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal memuat daftar kendala');
      }
      const json = await res.json();
      setFindings(json.data || []);
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan sistem');
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, propertyId, tabFilter]);

  useEffect(() => {
    if (isOpen) {
      fetchFindings();
    }
  }, [isOpen, fetchFindings]);

  const handleStartResolve = (finding: HousekeepingTaskFinding) => {
    setResolvingFindingId(finding.id);
    setResolutionNote(`Kendala ${finding.finding_type_label} telah diselesaikan.`);
    setTargetRoomStatus('VACANT_CLEAN');
  };

  const handleCancelResolve = () => {
    setResolvingFindingId(null);
    setResolutionNote('');
    setTargetRoomStatus('VACANT_CLEAN');
  };

  const handleSubmitResolve = async (finding: HousekeepingTaskFinding) => {
    if (!resolutionNote.trim()) {
      alert('Catatan penyelesaian kendala wajib diisi.');
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: any = {
        property_id: propertyId,
        resolution_note: resolutionNote.trim(),
        actor_name: 'Receptionist / Front Desk',
        actor_role: 'Front Office'
      };

      if (targetRoomStatus === 'VACANT_CLEAN') {
        payload.ready_room = true;
        payload.target_room_status = 'VACANT_CLEAN';
      } else if (targetRoomStatus === 'VACANT_DIRTY') {
        payload.target_room_status = 'VACANT_DIRTY';
      }

      const res = await fetch(`${apiBaseUrl}/housekeeping/findings/${finding.id}/resolve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal menyelesaikan kendala');
      }

      setSuccessToast(`Kendala Kamar ${finding.room_number || ''} berhasil diselesaikan${targetRoomStatus === 'VACANT_CLEAN' ? ' dan kamar telah di-Readykan (Siap Huni)!' : '!'}`);
      setTimeout(() => setSuccessToast(null), 4000);

      setResolvingFindingId(null);
      setResolutionNote('');
      await fetchFindings();
      if (onRefreshParent) {
        onRefreshParent();
      }
    } catch (err: any) {
      alert(err.message || 'Koneksi error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredFindings = findings.filter((f) => {
    if (selectedRoomId && Number(f.room_id) !== Number(selectedRoomId)) {
      // If scoped to a specific room
      return false;
    }
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      (f.room_number && String(f.room_number).toLowerCase().includes(q)) ||
      (f.finding_type_label && f.finding_type_label.toLowerCase().includes(q)) ||
      (f.notes && f.notes.toLowerCase().includes(q)) ||
      (f.reported_by_name && f.reported_by_name.toLowerCase().includes(q)) ||
      (f.room_type_name && f.room_type_name.toLowerCase().includes(q))
    );
  });

  const openCount = findings.filter((f) => f.status === 'OPEN').length;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 animate-in fade-in duration-150">
      <div className="relative w-full max-w-4xl bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-5 bg-gradient-to-r from-stone-900 via-amber-950 to-stone-900 text-white flex items-center justify-between border-b border-amber-800/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-400/40 flex items-center justify-center text-amber-300 text-xl shadow-inner">
              🔧
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Daftar Kendala & Maintenance Kamar
                {openCount > 0 && (
                  <span className="px-2 py-0.5 text-xs font-bold bg-rose-600 text-white rounded-full animate-pulse">
                    {openCount} Aktif
                  </span>
                )}
              </h2>
              <p className="text-xs text-amber-200/80 mt-0.5">
                Monitoring kerusakan & kendala operasional yang diinput Housekeeping Mobile untuk di-readykan kembali
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 text-stone-400 hover:text-white rounded-xl hover:bg-white/10 transition-colors cursor-pointer"
            title="Tutup Modal"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Success Toast Banner */}
        {successToast && (
          <div className="p-3 bg-emerald-700 text-white text-xs font-bold flex items-center justify-between px-5 animate-in slide-in-from-top duration-200">
            <div className="flex items-center gap-2">
              <span className="text-sm">✓</span>
              <span>{successToast}</span>
            </div>
            <button
              type="button"
              onClick={() => setSuccessToast(null)}
              className="text-emerald-200 hover:text-white"
            >
              ✕
            </button>
          </div>
        )}

        {/* Filters and Search Bar */}
        <div className="p-4 bg-stone-50 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setTabFilter('OPEN')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors cursor-pointer flex items-center gap-1.5 ${
                tabFilter === 'OPEN'
                  ? 'bg-amber-700 text-white shadow-xs'
                  : 'bg-white text-stone-700 border border-stone-300 hover:bg-stone-100'
              }`}
            >
              <span>🚨 Kendala Aktif (Open)</span>
              {openCount > 0 && (
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${tabFilter === 'OPEN' ? 'bg-amber-900 text-white' : 'bg-rose-100 text-rose-700 font-bold'}`}>
                  {openCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setTabFilter('ALL')}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                tabFilter === 'ALL'
                  ? 'bg-amber-700 text-white shadow-xs'
                  : 'bg-white text-stone-700 border border-stone-300 hover:bg-stone-100'
              }`}
            >
              Semua & Riwayat Selesai
            </button>

            {selectedRoomId && (
              <div className="flex items-center gap-1 px-2.5 py-1 bg-amber-100 text-amber-900 border border-amber-300 rounded-lg text-xs font-semibold">
                <span>Filter Kamar ID: <strong>{selectedRoomId}</strong></span>
                <button
                  type="button"
                  onClick={() => setSelectedRoomId(undefined)}
                  className="text-amber-800 hover:text-rose-700 font-bold ml-1 cursor-pointer"
                  title="Lihat semua kamar"
                >
                  ✕ Tampilkan Semua
                </button>
              </div>
            )}
          </div>

          <div className="relative flex-1 max-w-xs min-w-[200px]">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari kamar, jenis kendala, catatan..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-amber-500"
            />
            <svg className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* Content List Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 bg-stone-100/50">
          {loading && (
            <div className="p-8 text-center text-xs text-stone-500 font-medium">
              <div className="inline-block w-6 h-6 border-2 border-amber-600 border-t-transparent rounded-full animate-spin mb-2" />
              <p>Memuat daftar kendala kamar...</p>
            </div>
          )}

          {errorMsg && (
            <div className="p-4 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs flex items-center justify-between">
              <span>⚠️ {errorMsg}</span>
              <button
                type="button"
                onClick={fetchFindings}
                className="px-2.5 py-1 bg-rose-700 text-white rounded font-bold hover:bg-rose-800"
              >
                Coba Lagi
              </button>
            </div>
          )}

          {!loading && !errorMsg && filteredFindings.length === 0 && (
            <div className="p-10 text-center bg-white rounded-xl border border-stone-200 shadow-xs space-y-2">
              <div className="w-12 h-12 mx-auto rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xl font-bold">
                ✓
              </div>
              <h3 className="text-sm font-bold text-stone-800">
                {tabFilter === 'OPEN' ? 'Tidak Ada Kendala Aktif' : 'Tidak Ada Data Kendala'}
              </h3>
              <p className="text-xs text-stone-500 max-w-md mx-auto">
                {tabFilter === 'OPEN'
                  ? 'Semua kamar dalam kondisi aman dan siap digunakan untuk operasional tamu.'
                  : 'Belum ada catatan kendala atau riwayat temuan yang tercatat.'}
              </p>
            </div>
          )}

          {!loading && filteredFindings.map((finding) => {
            const isOpenStatus = finding.status === 'OPEN';
            const isResolving = resolvingFindingId === finding.id;

            return (
              <div
                key={finding.id}
                className={`bg-white rounded-xl border transition-all shadow-xs overflow-hidden ${
                  isOpenStatus
                    ? finding.block_room_ready
                      ? 'border-rose-300 ring-1 ring-rose-200'
                      : 'border-amber-300 ring-1 ring-amber-100'
                    : 'border-stone-200 opacity-80'
                }`}
              >
                {/* Item Header */}
                <div className="p-4 pb-3 flex items-start justify-between gap-3 border-b border-stone-100 flex-wrap bg-stone-50/50">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <div className="px-2.5 py-1 bg-stone-900 text-white rounded-lg font-mono font-bold text-xs tracking-wider flex items-center gap-1.5">
                      <span>🚪 {finding.room_number ? `Kamar ${finding.room_number}` : 'Kamar Belum Ditentukan'}</span>
                    </div>

                    {finding.room_type_name && (
                      <span className="text-xs text-stone-600 font-semibold bg-stone-200/70 px-2 py-0.5 rounded">
                        {finding.room_type_name}
                      </span>
                    )}

                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                        finding.severity === 'CRITICAL'
                          ? 'bg-rose-700 text-white'
                          : finding.severity === 'HIGH'
                          ? 'bg-red-600 text-white'
                          : finding.severity === 'MEDIUM'
                          ? 'bg-amber-600 text-white'
                          : 'bg-stone-500 text-white'
                      }`}
                    >
                      {finding.severity}
                    </span>

                    {finding.block_room_ready && isOpenStatus && (
                      <span className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-md flex items-center gap-1">
                        <span>🚨</span> Memblokir Siap Huni (Check-in Blocked)
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                        isOpenStatus
                          ? 'bg-amber-100 text-amber-800 border border-amber-300'
                          : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      }`}
                    >
                      {finding.status === 'OPEN' ? '⏳ Aktif (Open)' : '✓ Selesai (Resolved)'}
                    </span>
                    <span className="text-[11px] text-stone-400 font-mono">
                      #{finding.id}
                    </span>
                  </div>
                </div>

                {/* Item Body */}
                <div className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 flex-1">
                      <div className="text-xs font-bold text-stone-900 flex items-center gap-1.5">
                        <span className="text-amber-700">🏷️ {finding.finding_type_label}</span>
                      </div>
                      <p className="text-xs text-stone-700 bg-stone-50 p-2.5 rounded-lg border border-stone-200 font-medium">
                        "{finding.notes || 'Tidak ada deskripsi detail'}"
                      </p>
                    </div>

                    {/* Photo Thumbnail if available */}
                    {finding.photo_storage_key && (
                      <div className="shrink-0">
                        <button
                          type="button"
                          onClick={() => setPreviewPhotoUrl(finding.photo_storage_key || null)}
                          className="group relative block w-16 h-16 rounded-lg overflow-hidden border border-stone-300 hover:border-amber-500 shadow-2xs transition-all cursor-pointer"
                          title="Klik untuk melihat foto"
                        >
                          <img
                            src={finding.photo_storage_key.startsWith('http') ? finding.photo_storage_key : `${apiBaseUrl.replace('/api', '')}${finding.photo_storage_key}`}
                            alt="Foto Kendala"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                            }}
                          />
                          <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-xs font-bold transition-opacity">
                            👁️
                          </div>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Metadata: Reported by & Timestamp */}
                  <div className="flex items-center justify-between text-[11px] text-stone-500 flex-wrap gap-2 pt-1 border-t border-stone-100">
                    <div>
                      <span>Dilaporkan oleh: </span>
                      <strong className="text-stone-800">{finding.reported_by_name || 'Housekeeping Crew'}</strong>
                      {finding.reported_by_role && (
                        <span className="text-stone-400"> ({finding.reported_by_role})</span>
                      )}
                      <span> pada {finding.reported_at ? new Date(finding.reported_at).toLocaleString('id-ID') : '—'}</span>
                    </div>

                    {finding.estimated_charge && finding.estimated_charge > 0 ? (
                      <div className="font-mono text-rose-700 font-semibold">
                        Estimasi Denda: Rp {Number(finding.estimated_charge).toLocaleString('id-ID')}
                      </div>
                    ) : null}
                  </div>

                  {/* Resolution History if resolved */}
                  {!isOpenStatus && finding.resolution_note && (
                    <div className="p-3 bg-emerald-50/80 border border-emerald-200 rounded-lg text-xs space-y-1 text-emerald-950">
                      <div className="font-bold flex items-center justify-between">
                        <span>✓ Catatan Penyelesaian:</span>
                        <span className="text-[10px] font-normal text-emerald-700">
                          {finding.resolved_at ? new Date(finding.resolved_at).toLocaleString('id-ID') : ''}
                        </span>
                      </div>
                      <p className="text-emerald-900 italic">"{finding.resolution_note}"</p>
                      <div className="text-[10px] text-emerald-700">
                        Diselesaikan oleh: <strong>{finding.resolved_by_name || 'Staff'}</strong> ({finding.resolved_by_role || 'Front Desk'})
                      </div>
                    </div>
                  )}

                  {/* Resolving Form Inline */}
                  {isOpenStatus && isResolving && (
                    <div className="p-4 bg-amber-50/90 border border-amber-300 rounded-xl space-y-3 animate-in fade-in duration-150">
                      <div className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                        <span>✏️ Form Penyelesaian Kendala Kamar {finding.room_number}</span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-stone-700 mb-1">
                          Catatan Perbaikan / Penyelesaian: <span className="text-rose-600">*</span>
                        </label>
                        <textarea
                          rows={2}
                          value={resolutionNote}
                          onChange={(e) => setResolutionNote(e.target.value)}
                          placeholder="Tuliskan tindakan perbaikan yang telah dilakukan (contoh: TV telah diganti unit baru dan berfungsi normal)..."
                          className="w-full text-xs p-2.5 bg-white border border-stone-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:outline-hidden"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-stone-700 mb-1.5">
                          Status Kamar Setelah Kendala Selesai:
                        </label>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                          <label
                            className={`p-2.5 rounded-lg border flex items-center gap-2 cursor-pointer transition-all ${
                              targetRoomStatus === 'VACANT_CLEAN'
                                ? 'bg-emerald-50 border-emerald-500 ring-1 ring-emerald-400 font-bold text-emerald-950'
                                : 'bg-white border-stone-200 text-stone-700 hover:bg-stone-50'
                            }`}
                          >
                            <input
                              type="radio"
                              name={`target_status_${finding.id}`}
                              checked={targetRoomStatus === 'VACANT_CLEAN'}
                              onChange={() => setTargetRoomStatus('VACANT_CLEAN')}
                              className="text-emerald-600"
                            />
                            <div>
                              <div className="font-bold text-[11px]">🟢 Readykan Kamar</div>
                              <div className="text-[10px] text-emerald-700 font-normal">Siap Huni / Check-in Tamu</div>
                            </div>
                          </label>

                          <label
                            className={`p-2.5 rounded-lg border flex items-center gap-2 cursor-pointer transition-all ${
                              targetRoomStatus === 'VACANT_DIRTY'
                                ? 'bg-amber-50 border-amber-500 ring-1 ring-amber-400 font-bold text-amber-950'
                                : 'bg-white border-stone-200 text-stone-700 hover:bg-stone-50'
                            }`}
                          >
                            <input
                              type="radio"
                              name={`target_status_${finding.id}`}
                              checked={targetRoomStatus === 'VACANT_DIRTY'}
                              onChange={() => setTargetRoomStatus('VACANT_DIRTY')}
                              className="text-amber-600"
                            />
                            <div>
                              <div className="font-bold text-[11px]">🧹 Kamar Kotor</div>
                              <div className="text-[10px] text-amber-700 font-normal">Perlu Pembersihan Ulang</div>
                            </div>
                          </label>

                          <label
                            className={`p-2.5 rounded-lg border flex items-center gap-2 cursor-pointer transition-all ${
                              targetRoomStatus === 'KEEP'
                                ? 'bg-stone-100 border-stone-400 ring-1 ring-stone-300 font-bold text-stone-900'
                                : 'bg-white border-stone-200 text-stone-700 hover:bg-stone-50'
                            }`}
                          >
                            <input
                              type="radio"
                              name={`target_status_${finding.id}`}
                              checked={targetRoomStatus === 'KEEP'}
                              onChange={() => setTargetRoomStatus('KEEP')}
                              className="text-stone-600"
                            />
                            <div>
                              <div className="font-bold text-[11px]">⚪ Status Tetap</div>
                              <div className="text-[10px] text-stone-500 font-normal">Hanya selesaikan tiket</div>
                            </div>
                          </label>
                        </div>
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-2 border-t border-amber-200">
                        <button
                          type="button"
                          onClick={handleCancelResolve}
                          className="px-3 py-1.5 text-xs font-semibold text-stone-600 hover:text-stone-900 bg-white hover:bg-stone-100 rounded-lg border border-stone-300 transition-colors cursor-pointer"
                        >
                          Batal
                        </button>
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => handleSubmitResolve(finding)}
                          className="px-4 py-1.5 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
                        >
                          {isSubmitting ? (
                            <>
                              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                              <span>Menyimpan...</span>
                            </>
                          ) : (
                            <>
                              <span>✓</span>
                              <span>Konfirmasi Selesai & Readykan Kamar</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Action Button to Open Resolution Form */}
                  {isOpenStatus && !isResolving && (
                    <div className="pt-2 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => handleStartResolve(finding)}
                        className="px-3.5 py-1.5 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors cursor-pointer flex items-center gap-1.5 shadow-xs"
                      >
                        <span>🔧 Selesaikan Kendala & Readykan Kamar</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-4 bg-white border-t border-stone-200 flex items-center justify-between gap-3">
          <div className="text-xs text-stone-500">
            Total Temuan: <strong className="text-stone-800">{filteredFindings.length}</strong>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-stone-700 bg-stone-100 hover:bg-stone-200 rounded-xl transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>

      {/* Photo Preview Lightbox Modal */}
      {previewPhotoUrl && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="relative max-w-2xl max-h-[85vh] bg-black rounded-xl overflow-hidden shadow-2xl flex flex-col items-center">
            <button
              type="button"
              onClick={() => setPreviewPhotoUrl(null)}
              className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black"
            >
              ✕
            </button>
            <img
              src={previewPhotoUrl.startsWith('http') ? previewPhotoUrl : `${apiBaseUrl.replace('/api', '')}${previewPhotoUrl}`}
              alt="Foto Kendala Full"
              className="max-w-full max-h-[80vh] object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
};
