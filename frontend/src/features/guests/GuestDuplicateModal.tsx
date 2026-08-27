import React from 'react';
import type { DuplicateCandidateCluster } from './guestTypes';
import { formatDateIndonesian, getVipBadgeClass } from './guestCrmHelpers';

interface GuestDuplicateModalProps {
  isOpen: boolean;
  clusters: DuplicateCandidateCluster[];
  loading: boolean;
  onClose: () => void;
  onSelectGuest: (guestId: number) => void;
}

export const GuestDuplicateModal: React.FC<GuestDuplicateModalProps> = ({
  isOpen,
  clusters,
  loading,
  onClose,
  onSelectGuest
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between bg-stone-50/50">
          <div className="flex items-center space-x-3">
            <span className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 text-amber-800 font-bold text-sm">
              👥
            </span>
            <div>
              <h3 className="text-base font-bold text-stone-900">
                Review Kandidat Duplikat Tamu
              </h3>
              <p className="text-xs text-stone-500">
                Perbandingan profil dengan kesamaan identitas (Non-destructive review)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-stone-400 hover:text-stone-700 rounded-md transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Informational Safety Banner */}
        <div className="bg-stone-50 border-b border-stone-200 px-6 py-3 text-xs text-stone-600 flex items-start space-x-2">
          <span className="text-stone-400 font-bold text-sm">ℹ️</span>
          <div>
            <strong className="text-stone-800">Kebijakan Keamanan Data CRM:</strong> Penggabungan profil otomatis (auto-merge) dinonaktifkan untuk melindungi integritas riwayat reservasi dan audit trail. Anda dapat membuka profil masing-masing tamu untuk melakukan verifikasi atau penyesuaian data.
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading && (
            <div className="flex items-center justify-center py-12 text-stone-500">
              <div className="w-5 h-5 border-2 border-[#1E392A] border-t-transparent rounded-full animate-spin mr-3" />
              <span>Menganalisis kandidat duplikat...</span>
            </div>
          )}

          {!loading && clusters.length === 0 && (
            <div className="text-center py-12 text-stone-400">
              <span className="text-3xl block mb-2">✨</span>
              <p className="text-sm font-semibold text-stone-600">Tidak ada duplikat terdeteksi</p>
              <p className="text-xs text-stone-400 mt-1">
                Seluruh profil tamu pada properti ini memiliki identitas kontak yang unik.
              </p>
            </div>
          )}

          {!loading &&
            clusters.map((cluster, idx) => (
              <div
                key={idx}
                className="border border-stone-200 rounded-lg overflow-hidden shadow-xs bg-white"
              >
                {/* Cluster Header */}
                <div className="bg-stone-100/70 px-4 py-2.5 border-b border-stone-200 flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="text-xs font-bold text-stone-700 uppercase">
                      Kluster #{idx + 1}:
                    </span>
                    <span className="text-xs font-semibold text-amber-900 bg-amber-100 px-2 py-0.5 rounded border border-amber-200">
                      {cluster.match_reason === 'PHONE'
                        ? `Kesamaan No. Telepon (${cluster.match_key})`
                        : cluster.match_reason === 'EMAIL'
                        ? `Kesamaan Email (${cluster.match_key})`
                        : `Kesamaan Nama & Tgl Lahir (${cluster.match_key})`}
                    </span>
                  </div>
                  <span className="text-xs text-stone-500">
                    {cluster.guests.length} Profil Terkait
                  </span>
                </div>

                {/* Side-by-Side Candidates Grid */}
                <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {cluster.guests.map((g) => {
                    const vipBadge = getVipBadgeClass(g.vip_status);
                    return (
                      <div
                        key={g.id}
                        className="border border-stone-200 rounded-lg p-3 bg-stone-50/50 space-y-2 flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center space-x-2">
                              <span className="font-bold text-sm text-stone-900">
                                {g.full_name}
                              </span>
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                              >
                                {vipBadge.label}
                              </span>
                            </div>
                            <span className="text-[10px] text-stone-400 font-mono">
                              ID: #{g.id}
                            </span>
                          </div>

                          <div className="space-y-1 text-xs text-stone-600">
                            <div>
                              <span className="text-stone-400">Telepon:</span>{' '}
                              <span className="font-medium text-stone-800">
                                {g.phone || '—'}
                              </span>
                            </div>
                            <div>
                              <span className="text-stone-400">Email:</span>{' '}
                              <span className="font-medium text-stone-800">
                                {g.email || '—'}
                              </span>
                            </div>
                            <div>
                              <span className="text-stone-400">Tgl Lahir:</span>{' '}
                              <span className="font-medium text-stone-800">
                                {formatDateIndonesian(g.birth_date)}
                              </span>
                            </div>
                            <div className="pt-1 text-[11px] text-stone-500">
                              Menginap: {g.visit_count ?? 0} kali ({g.room_nights ?? 0} malam)
                              {g.last_stay && (
                                <span> • Terakhir: {formatDateIndonesian(g.last_stay)}</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="pt-2 border-t border-stone-200/60 flex justify-end">
                          <button
                            onClick={() => {
                              onSelectGuest(g.id);
                              onClose();
                            }}
                            className="px-2.5 py-1 text-xs bg-[#1E392A] hover:bg-[#162a1f] text-white font-medium rounded transition-colors"
                          >
                            Buka Profil Tamu
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-stone-200 flex justify-end bg-stone-50/50">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-700 text-xs font-semibold rounded transition-colors"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
};
