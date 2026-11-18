import React, { useEffect, useState } from 'react';
import type { DuplicateCandidateCluster, Guest } from './guestTypes';
import { formatDateIndonesian, getVipBadgeClass } from './guestCrmHelpers';
import { authenticatedFetch } from '../../lib/authenticatedFetch';

interface GuestDuplicateModalProps {
  isOpen: boolean;
  propertyId: number | null;
  clusters: DuplicateCandidateCluster[];
  loading: boolean;
  onClose: () => void;
  onSelectGuest: (guestId: number) => void;
  onMerged?: () => void;
}

function pickRecommendedMasterId(guests: Guest[]): number {
  if (!guests.length) return 0;
  const sorted = [...guests].sort((a, b) => {
    const aKtp = a.has_valid_identity || a.identity_number ? 1 : 0;
    const bKtp = b.has_valid_identity || b.identity_number ? 1 : 0;
    if (bKtp !== aKtp) return bKtp - aKtp;
    const aVisits = Number(a.visit_count || 0);
    const bVisits = Number(b.visit_count || 0);
    if (bVisits !== aVisits) return bVisits - aVisits;
    const aNights = Number(a.room_nights || 0);
    const bNights = Number(b.room_nights || 0);
    if (bNights !== aNights) return bNights - aNights;
    return Number(a.id) - Number(b.id);
  });
  return Number(sorted[0].id);
}

export const GuestDuplicateModal: React.FC<GuestDuplicateModalProps> = ({
  isOpen,
  propertyId,
  clusters,
  loading,
  onClose,
  onSelectGuest,
  onMerged
}) => {
  const [selectedMasters, setSelectedMasters] = useState<Record<string, number>>({});
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [mergingAll, setMergingAll] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const defaults: Record<string, number> = {};
    clusters.forEach((c, idx) => {
      const clusterKey = `${c.match_reason}:${c.match_key}:${idx}`;
      defaults[clusterKey] = pickRecommendedMasterId(c.guests);
    });
    setSelectedMasters(defaults);
    setFeedback(null);
  }, [isOpen, clusters]);

  if (!isOpen) return null;

  const handleMergeCluster = async (cluster: DuplicateCandidateCluster, idx: number) => {
    if (!propertyId) return;
    const clusterKey = `${cluster.match_reason}:${cluster.match_key}:${idx}`;
    const primaryId = selectedMasters[clusterKey] || pickRecommendedMasterId(cluster.guests);
    const duplicateIds = cluster.guests
      .map((g) => Number(g.id))
      .filter((id) => id !== primaryId);

    if (!primaryId || duplicateIds.length === 0) return;

    setMergingKey(clusterKey);
    setFeedback(null);
    try {
      const res = await authenticatedFetch('/api/guests/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          primary_guest_id: primaryId,
          duplicate_guest_ids: duplicateIds
        })
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menggabungkan profil tamu.');
      }
      const data = json.data;
      setFeedback({
        type: 'success',
        message: `Berhasil menggabungkan ${duplicateIds.length} profil duplikat ke Master #${primaryId} (${data?.relinked_reservations || 0} reservasi & ${data?.relinked_transactions || 0} transaksi ditautkan).`
      });
      if (onMerged) onMerged();
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err?.message || 'Gagal menggabungkan profil tamu.'
      });
    } finally {
      setMergingKey(null);
    }
  };

  const handleMergeAllClusters = async () => {
    if (!propertyId || clusters.length === 0) return;
    if (!window.confirm(`Apakah Anda yakin ingin menggabungkan seluruh ${clusters.length} kluster duplikat ke masing-masing Profil Utama (Master) yang terpilih?`)) {
      return;
    }
    setMergingAll(true);
    setFeedback(null);
    let mergedCount = 0;
    const consumedGuestIds = new Set<number>();

    try {
      for (let idx = 0; idx < clusters.length; idx++) {
        const cluster = clusters[idx];
        const clusterKey = `${cluster.match_reason}:${cluster.match_key}:${idx}`;
        const availableGuests = cluster.guests.filter((g) => !consumedGuestIds.has(Number(g.id)));
        if (availableGuests.length < 2) continue;

        const chosenMaster = selectedMasters[clusterKey];
        const primaryId = availableGuests.some((g) => Number(g.id) === chosenMaster)
          ? chosenMaster
          : pickRecommendedMasterId(availableGuests);
        const duplicateIds = availableGuests
          .map((g) => Number(g.id))
          .filter((id) => id !== primaryId);

        if (!primaryId || duplicateIds.length === 0) continue;

        const res = await authenticatedFetch('/api/guests/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            primary_guest_id: primaryId,
            duplicate_guest_ids: duplicateIds
          })
        });
        if (res.ok) {
          duplicateIds.forEach((id) => consumedGuestIds.add(id));
          mergedCount++;
        }
      }

      setFeedback({
        type: 'success',
        message: `Berhasil menggabungkan ${mergedCount} kluster profil tamu duplikat secara aman.`
      });
      if (onMerged) onMerged();
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err?.message || 'Terjadi kesalahan saat menggabungkan seluruh kluster.'
      });
    } finally {
      setMergingAll(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between bg-stone-50/50">
          <div className="flex items-center space-x-3">
            <span className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 text-amber-800 font-bold text-sm">
              👥
            </span>
            <div>
              <h3 className="text-base font-bold text-stone-900">
                Review & Merger Data Customer Duplikat ({clusters.length} Kluster)
              </h3>
              <p className="text-xs text-stone-500">
                Pilih 1 Profil Utama (Master) pada setiap kluster untuk menggabungkan riwayat menginap, transaksi, dan poin loyalitas tanpa kehilangan data.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            {clusters.length > 1 && (
              <button
                onClick={handleMergeAllClusters}
                disabled={mergingAll || Boolean(mergingKey)}
                className="px-3 py-1.5 bg-amber-800 hover:bg-amber-900 disabled:opacity-50 text-white text-xs font-semibold rounded-md shadow-xs transition-colors"
              >
                {mergingAll ? 'Menggabungkan...' : `⚡ Gabungkan Semua Kluster (${clusters.length})`}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-stone-400 hover:text-stone-700 rounded-md transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Informational Safety Banner */}
        <div className="bg-emerald-50/70 border-b border-emerald-200 px-6 py-2.5 text-xs text-emerald-900 flex items-start space-x-2">
          <span className="font-bold text-sm">🛡️</span>
          <div>
            <strong>Zero Data Loss Merger:</strong> Saat digabungkan, data kosong pada <strong>Profil Utama (Master)</strong> otomatis dilengkapi dari profil duplikat, seluruh riwayat reservasi kamar & transaksi dipindahkan ke Master, dan profil duplikat diarsipkan ke Audit Log.
          </div>
        </div>

        {feedback && (
          <div
            className={`px-6 py-2.5 text-xs font-medium flex items-center justify-between border-b ${
              feedback.type === 'success'
                ? 'bg-emerald-100/80 text-emerald-900 border-emerald-300'
                : 'bg-red-50 text-red-800 border-red-200'
            }`}
          >
            <span>{feedback.message}</span>
            <button onClick={() => setFeedback(null)} className="text-xs underline ml-4">
              Tutup
            </button>
          </div>
        )}

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
                Seluruh profil tamu aktif pada properti ini memiliki identitas kontak yang unik.
              </p>
            </div>
          )}

          {!loading &&
            clusters.map((cluster, idx) => {
              const clusterKey = `${cluster.match_reason}:${cluster.match_key}:${idx}`;
              const masterId = selectedMasters[clusterKey] || pickRecommendedMasterId(cluster.guests);
              const isMergingThis = mergingKey === clusterKey;

              return (
                <div
                  key={clusterKey}
                  className="border border-stone-200 rounded-lg overflow-hidden shadow-xs bg-white"
                >
                  {/* Cluster Header */}
                  <div className="bg-stone-100/80 px-4 py-2.5 border-b border-stone-200 flex flex-wrap items-center justify-between gap-2">
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
                      <span className="text-xs text-stone-500">
                        • {cluster.guests.length} Profil Terkait
                      </span>
                    </div>

                    <button
                      onClick={() => handleMergeCluster(cluster, idx)}
                      disabled={isMergingThis || mergingAll}
                      className="px-3 py-1.5 bg-[#1E392A] hover:bg-[#162a1f] disabled:opacity-50 text-white text-xs font-semibold rounded shadow-xs transition-colors flex items-center space-x-1.5"
                    >
                      <span>🔗</span>
                      <span>
                        {isMergingThis
                          ? 'Menggabungkan...'
                          : `Gabungkan ke Master #${masterId}`}
                      </span>
                    </button>
                  </div>

                  {/* Side-by-Side Candidates Grid */}
                  <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                    {cluster.guests.map((g) => {
                      const vipBadge = getVipBadgeClass(g.vip_status);
                      const isMaster = Number(g.id) === Number(masterId);
                      return (
                        <div
                          key={g.id}
                          onClick={() =>
                            setSelectedMasters((prev) => ({
                              ...prev,
                              [clusterKey]: Number(g.id)
                            }))
                          }
                          className={`border rounded-lg p-3 space-y-2 flex flex-col justify-between cursor-pointer transition-all ${
                            isMaster
                              ? 'border-[#1E392A] bg-emerald-50/40 ring-1 ring-[#1E392A]'
                              : 'border-stone-200 bg-stone-50/50 hover:border-stone-300'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                                <input
                                  type="radio"
                                  checked={isMaster}
                                  onChange={() =>
                                    setSelectedMasters((prev) => ({
                                      ...prev,
                                      [clusterKey]: Number(g.id)
                                    }))
                                  }
                                  className="accent-[#1E392A]"
                                />
                                <span className="font-bold text-sm text-stone-900">
                                  {g.full_name}
                                </span>
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                                >
                                  {vipBadge.label}
                                </span>
                                {isMaster ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1E392A] text-white font-semibold">
                                    ★ Profil Utama (Master)
                                  </span>
                                ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
                                    Akan Digabung ke Master
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] text-stone-400 font-mono">
                                ID: #{g.id}
                              </span>
                            </div>

                            <div className="space-y-1 text-xs text-stone-600 pl-5">
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
                                <span className="text-stone-400">NIK / KTP:</span>{' '}
                                <span className="font-medium text-stone-800">
                                  {g.identity_number || (g.has_valid_identity ? 'Terverifikasi' : '—')}
                                </span>
                              </div>
                              <div>
                                <span className="text-stone-400">Tgl Lahir:</span>{' '}
                                <span className="font-medium text-stone-800">
                                  {formatDateIndonesian(g.birth_date)}
                                </span>
                              </div>
                              <div className="pt-1 text-[11px] text-stone-600 font-medium">
                                🏨 Menginap: {g.visit_count ?? 0} kali ({g.room_nights ?? 0} malam)
                                {g.last_stay && (
                                  <span> • Terakhir: {formatDateIndonesian(g.last_stay)}</span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="pt-2 border-t border-stone-200/60 flex items-center justify-between pl-5">
                            <span className="text-[11px] text-stone-500">
                              {isMaster
                                ? 'Klik kartu lain jika ingin mengganti Master'
                                : 'Klik kartu ini untuk jadikan Master'}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectGuest(g.id);
                                onClose();
                              }}
                              className="px-2.5 py-1 text-xs bg-white hover:bg-stone-100 text-stone-700 border border-stone-300 font-medium rounded transition-colors"
                            >
                              Buka Profil
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
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
