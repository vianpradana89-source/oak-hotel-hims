import React, { useEffect, useState } from 'react';
import type { GuestDetail } from './guestTypes';
import {
  formatDateIndonesian,
  formatStayPeriodDisplay,
  getIdentityVerifiedBadgeClass,
  getRelationFidelityBadgeClass,
  getRoleBadgeClass,
  getVipBadgeClass
} from './guestCrmHelpers';

interface GuestProfileModalProps {
  guestId: number | null;
  propertyId: number;
  isOpen: boolean;
  onClose: () => void;
  onEditGuest: (guest: GuestDetail) => void;
  onGuestUpdated?: () => void;
}

export const GuestProfileModal: React.FC<GuestProfileModalProps> = ({
  guestId,
  propertyId,
  isOpen,
  onClose,
  onEditGuest,
  onGuestUpdated
}) => {
  const [guest, setGuest] = useState<GuestDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [isKtpPreviewOpen, setIsKtpPreviewOpen] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen || !guestId) {
      setGuest(null);
      setActionMsg(null);
      setIsKtpPreviewOpen(false);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);
    setActionMsg(null);

    fetch(`/api/guests/${guestId}?property_id=${propertyId}`)
      .then(async (res) => {
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.message || `Gagal memuat detail tamu (${res.status})`);
        }
        return res.json();
      })
      .then((json) => {
        if (isMounted) {
          setGuest(json.data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err.message || 'Terjadi kesalahan sistem');
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, guestId, propertyId]);

  if (!isOpen) return null;

  const vipBadge = guest ? getVipBadgeClass(guest.vip_status) : null;

  const handleArchiveToggle = async () => {
    if (!guest) return;
    const isArchiving = !guest.is_archived;
    const confirmText = isArchiving
      ? `Arsipkan tamu "${guest.full_name}"? Tamu tidak akan muncul di pencarian cepat.`
      : `Aktifkan kembali tamu "${guest.full_name}"?`;
    if (!window.confirm(confirmText)) return;

    try {
      const endpoint = isArchiving ? `/api/guests/${guest.id}/archive` : `/api/guests/${guest.id}/restore`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mengubah status arsip');

      setActionMsg(isArchiving ? 'Tamu berhasil diarsipkan.' : 'Tamu berhasil diaktifkan kembali.');
      setGuest({ ...guest, is_archived: isArchiving, is_active: !isArchiving });
      if (onGuestUpdated) onGuestUpdated();
    } catch (err: any) {
      setError(err.message || 'Gagal mengubah status arsip');
    }
  };

  const handleDelete = async () => {
    if (!guest) return;
    if (!window.confirm(`Yakin ingin menghapus permanen data tamu "${guest.full_name}"?\nTindakan ini tidak dapat dibatalkan.`)) return;

    try {
      const res = await fetch(`/api/guests/${guest.id}?property_id=${propertyId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Gagal menghapus data tamu.');
      }

      alert('Data tamu berhasil dihapus permanen.');
      if (onGuestUpdated) onGuestUpdated();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menghapus tamu');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-150">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between bg-stone-50/50">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-full bg-[#1E392A] text-white flex items-center justify-center font-bold text-lg">
              {guest ? guest.full_name.charAt(0).toUpperCase() : '?'}
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-lg font-bold text-stone-900">
                  {guest?.full_name || 'Profil Tamu'}
                </h3>
                {guest?.guest_code && (
                  <span className="text-xs px-2 py-0.5 rounded bg-stone-100 text-stone-700 font-mono font-bold border border-stone-200">
                    {guest.guest_code}
                  </span>
                )}
                {vipBadge && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                  >
                    {vipBadge.label}
                  </span>
                )}
                {guest?.is_archived && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-stone-200 text-stone-600 font-semibold">
                    Diarsipkan
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-stone-500 mt-0.5">
                {guest?.preferred_name && (
                  <span>Panggilan: &ldquo;{guest.preferred_name}&rdquo;</span>
                )}
                <span className="px-1.5 py-0.2 bg-emerald-50 text-emerald-800 rounded border border-emerald-200 text-[10px] font-medium">
                  Segment: {guest?.guest_segment || 'Reguler'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {guest && (
              <>
                <button
                  onClick={() => onEditGuest(guest)}
                  className="px-3 py-1.5 bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-semibold rounded shadow-xs transition-colors"
                >
                  ✏️ Edit Profil
                </button>
                <button
                  onClick={handleArchiveToggle}
                  className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold rounded transition-colors"
                >
                  {guest.is_archived ? '🔓 Aktifkan' : '📁 Arsipkan'}
                </button>
                <button
                  onClick={handleDelete}
                  className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold rounded border border-rose-200 transition-colors"
                  title="Hapus data tamu (jika belum pernah menginap)"
                >
                  🗑️ Hapus
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-md transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {actionMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs">
              ✓ {actionMsg}
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-12 text-stone-500">
              <div className="w-6 h-6 border-2 border-[#1E392A] border-t-transparent rounded-full animate-spin mr-3" />
              <span>Memuat data tamu...</span>
            </div>
          )}

          {error && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs">
              <span className="font-bold block mb-0.5">Pemberitahuan:</span>
              {error}
            </div>
          )}

          {guest && !loading && (
            <>
              {/* Stay Statistics Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-stone-50 p-3 rounded-lg border border-stone-200">
                <div className="text-center p-2 bg-white rounded border border-stone-100 shadow-xs">
                  <div className="text-[11px] font-medium text-stone-500 uppercase">Kunjungan Selesai</div>
                  <div className="text-xl font-bold text-stone-900 mt-1">
                    {guest.visit_count ?? 0}
                  </div>
                </div>
                <div className="text-center p-2 bg-white rounded border border-stone-100 shadow-xs">
                  <div className="text-[11px] font-medium text-stone-500 uppercase">Malam Menginap</div>
                  <div className="text-xl font-bold text-[#1E392A] mt-1">
                    {guest.room_nights ?? 0}
                  </div>
                </div>
                <div className="text-center p-2 bg-white rounded border border-stone-100 shadow-xs">
                  <div className="text-[11px] font-medium text-stone-500 uppercase">Kunjungan Perdana</div>
                  <div className="text-xs font-semibold text-stone-800 mt-2">
                    {formatDateIndonesian(guest.first_stay)}
                  </div>
                </div>
                <div className="text-center p-2 bg-white rounded border border-stone-100 shadow-xs">
                  <div className="text-[11px] font-medium text-stone-500 uppercase">Kunjungan Terakhir</div>
                  <div className="text-xs font-semibold text-stone-800 mt-2">
                    {formatDateIndonesian(guest.last_stay)}
                  </div>
                </div>
              </div>

              {/* Guest Information Details Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Contact & Identity */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-stone-400 uppercase tracking-wider">
                    Kontak & Identitas
                  </h4>
                  <div className="bg-stone-50/50 rounded-lg p-3 border border-stone-200/60 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-stone-500">Telepon:</span>
                      <span className="font-medium text-stone-800 font-mono">{guest.phone || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-stone-500">Email:</span>
                      <span className="font-medium text-stone-800">{guest.email || '—'}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-stone-500">Identitas / NIK:</span>
                      <div className="flex items-center gap-1.5 font-medium text-stone-800 font-mono flex-wrap justify-end">
                        <span>
                          {guest.identity_number ? `${guest.identity_type || 'KTP'}: ${guest.identity_number}` : '—'}
                        </span>
                        {guest.has_valid_identity && (
                          <span className="text-[10px] text-emerald-700 font-semibold bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                            ✓ Terverifikasi
                          </span>
                        )}
                        {guest.identity_path && (
                          <button
                            type="button"
                            onClick={() => setIsKtpPreviewOpen(true)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-sans font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 hover:text-emerald-950 border border-emerald-300 rounded shadow-2xs transition-colors cursor-pointer"
                            title="Klik untuk melihat foto KTP yang diunggah"
                          >
                            <svg className="w-3.5 h-3.5 text-emerald-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                            <span className="text-[10px]">Foto KTP</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-stone-500">Gender:</span>
                      <span className="font-medium text-stone-800">
                        {guest.gender === 'MALE'
                          ? 'Laki-laki'
                          : guest.gender === 'FEMALE'
                          ? 'Perempuan'
                          : guest.gender || '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-stone-500">Tgl Lahir:</span>
                      <span className="font-medium text-stone-800">
                        {guest.birth_place ? `${guest.birth_place}, ` : ''}
                        {formatDateIndonesian(guest.birth_date)}
                      </span>
                    </div>
                    {guest.religion && (
                      <div className="flex justify-between">
                        <span className="text-stone-500">Agama:</span>
                        <span className="font-medium text-stone-800">{guest.religion}</span>
                      </div>
                    )}
                    {guest.marital_status && (
                      <div className="flex justify-between">
                        <span className="text-stone-500">Status Perkawinan:</span>
                        <span className="font-medium text-stone-800">{guest.marital_status}</span>
                      </div>
                    )}
                    {guest.occupation && (
                      <div className="flex justify-between">
                        <span className="text-stone-500">Pekerjaan:</span>
                        <span className="font-medium text-stone-800">{guest.occupation}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-stone-500">Kewarganegaraan:</span>
                      <span className="font-medium text-stone-800">{guest.citizenship || guest.nationality || '—'}</span>
                    </div>
                    {guest.valid_until && (
                      <div className="flex justify-between">
                        <span className="text-stone-500">Masa Berlaku KTP:</span>
                        <span className="font-medium text-stone-800">{guest.valid_until}</span>
                      </div>
                    )}
                    {guest.ktp_ocr_confidence !== undefined && guest.ktp_ocr_confidence !== null && (
                      <div className="flex justify-between text-xs text-stone-400 pt-1 border-t border-stone-200/40">
                        <span>Akurasi OCR:</span>
                        <span className="font-mono text-emerald-700">{Math.round(Number(guest.ktp_ocr_confidence) * 100)}% ({guest.ktp_ocr_provider || 'OCR'})</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Address & Preferences */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-stone-400 uppercase tracking-wider">
                    Alamat, Preferensi & Catatan CRM
                  </h4>
                  <div className="bg-stone-50/50 rounded-lg p-3 border border-stone-200/60 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-stone-500">Alamat KTP:</span>
                      <span className="font-medium text-stone-800 text-right max-w-[65%]">
                        {[
                          guest.address,
                          guest.rt_rw ? `RT/RW ${guest.rt_rw}` : null,
                          guest.village_kelurahan ? `Kel. ${guest.village_kelurahan}` : null,
                          guest.district_kecamatan ? `Kec. ${guest.district_kecamatan}` : null,
                          guest.city,
                          guest.province,
                          guest.country
                        ]
                          .filter(Boolean)
                          .join(', ') || '—'}
                      </span>
                    </div>
                    <div className="pt-2 border-t border-stone-200/60">
                      <span className="text-stone-500 block mb-1">Preferensi Tamu:</span>
                      <p className="text-stone-700 text-xs bg-emerald-50/30 p-2 rounded border border-emerald-100 min-h-8">
                        {guest.preferences || 'Belum ada preferensi khusus (lantai, bantal, diet).'}
                      </p>
                    </div>
                    <div className="pt-2 border-t border-stone-200/60">
                      <span className="text-stone-500 block mb-1">Catatan Internal:</span>
                      <p className="text-stone-700 italic text-xs bg-white p-2 rounded border border-stone-200 min-h-8">
                        {guest.notes || 'Belum ada catatan khusus untuk tamu ini.'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Property-Scoped Stay History */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-stone-400 uppercase tracking-wider">
                    Riwayat Menginap di Properti Ini ({guest.stays?.length || 0})
                  </h4>
                  <span className="text-[11px] text-stone-400">
                    Data diisolasi per properti
                  </span>
                </div>

                {guest.stays && guest.stays.length > 0 ? (
                  <div className="border border-stone-200 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-stone-100 text-stone-600 font-semibold uppercase tracking-wider">
                        <tr>
                          <th className="py-2.5 px-3">No. Booking</th>
                          <th className="py-2.5 px-3">Periode Stay</th>
                          <th className="py-2.5 px-3">Kamar / Tipe</th>
                          <th className="py-2.5 px-3">Peran</th>
                          <th className="py-2.5 px-3">Status</th>
                          <th className="py-2.5 px-3 text-right">Relasi / Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100 text-stone-800">
                        {guest.stays.map((stay) => {
                          const roleBadge = getRoleBadgeClass(stay.role);
                          const fidelityBadge = getRelationFidelityBadgeClass(stay.is_legacy_inferred);
                          const identityBadge = getIdentityVerifiedBadgeClass(stay.identity_verified);

                          return (
                            <tr key={stay.reservation_id} className="hover:bg-stone-50">
                              <td className="py-2.5 px-3 font-mono font-medium text-stone-700">
                                {stay.bid}
                              </td>
                              <td className="py-2.5 px-3">
                                {formatStayPeriodDisplay(stay.check_in, stay.check_out)}
                              </td>
                              <td className="py-2.5 px-3">
                                <span className="font-semibold">{stay.room_type_name || 'Standard'}</span>
                                {stay.room_number && (
                                  <span className="ml-1 text-stone-500 font-mono">
                                    ({stay.room_number})
                                  </span>
                                )}
                              </td>
                              <td className="py-2.5 px-3">
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded border ${roleBadge.bg} ${roleBadge.border} ${roleBadge.text}`}
                                >
                                  {roleBadge.label}
                                </span>
                              </td>
                              <td className="py-2.5 px-3">
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                    stay.status === 'CHECKED_OUT'
                                      ? 'bg-stone-100 text-stone-700'
                                      : stay.status === 'CHECKED_IN'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : stay.status === 'CANCELLED'
                                      ? 'bg-rose-100 text-rose-800'
                                      : 'bg-blue-100 text-blue-800'
                                  }`}
                                >
                                  {stay.status}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-right space-x-1">
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded border ${fidelityBadge.bg} ${fidelityBadge.border} ${fidelityBadge.text}`}
                                >
                                  {fidelityBadge.label}
                                </span>
                                {identityBadge && (
                                  <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded border ${identityBadge.bg} ${identityBadge.border} ${identityBadge.text}`}
                                  >
                                    {identityBadge.label}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-6 bg-stone-50 rounded-lg border border-stone-200 text-xs text-stone-400">
                    Belum ada riwayat menginap yang tercatat untuk tamu ini pada properti ini.
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-stone-200 flex justify-end bg-stone-50/50">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-stone-200 hover:bg-stone-300 text-stone-700 text-xs font-semibold rounded transition-colors"
          >
            Tutup
          </button>
        </div>
      </div>

      {/* KTP Photo Preview Lightbox Modal */}
      {isKtpPreviewOpen && guest?.identity_path && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={() => setIsKtpPreviewOpen(false)}
        >
          <div
            className="relative max-w-2xl w-full bg-white rounded-xl shadow-2xl overflow-hidden border border-stone-200 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 bg-stone-900 text-white">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-emerald-950 border border-emerald-700/60 flex items-center justify-center text-emerald-400">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-bold tracking-wide">
                    Foto KTP Tamu — {guest.full_name}
                  </h3>
                  <p className="text-[11px] text-stone-400 font-mono">
                    NIK: {guest.identity_number || '—'} {guest.guest_code ? `• ${guest.guest_code}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={guest.identity_path}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2.5 py-1 text-stone-300 hover:text-white hover:bg-stone-800 rounded text-xs flex items-center gap-1.5 font-sans border border-stone-700 transition-colors"
                  title="Buka di tab baru"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  <span>Buka Tab Baru</span>
                </a>
                <button
                  type="button"
                  onClick={() => setIsKtpPreviewOpen(false)}
                  className="p-1.5 text-stone-400 hover:text-white hover:bg-stone-800 rounded-lg transition-colors cursor-pointer"
                  title="Tutup (ESC)"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Image Preview Body */}
            <div className="p-4 bg-stone-950 flex flex-col items-center justify-center min-h-[280px] max-h-[68vh] overflow-auto">
              <img
                src={guest.identity_path}
                alt={`KTP ${guest.full_name}`}
                className="max-h-[60vh] max-w-full object-contain rounded-lg shadow-xl border border-stone-800 bg-stone-900"
                onError={(e) => {
                  const target = e.currentTarget;
                  target.style.display = 'none';
                  const parent = target.parentElement;
                  if (parent && !parent.querySelector('.ktp-img-err')) {
                    const errBox = document.createElement('div');
                    errBox.className = 'ktp-img-err text-center p-8 text-stone-400 text-xs';
                    errBox.innerHTML = '<div class="text-2xl mb-2">⚠️</div><p class="font-bold text-rose-400 mb-1">File Foto KTP Tidak Dapat Dimuat</p><p class="text-stone-500 text-[11px]">File mungkin telah dipindahkan atau tautan dokumen tidak lagi valid.</p>';
                    parent.appendChild(errBox);
                  }
                }}
              />
            </div>

            {/* Footer Metadata */}
            <div className="px-5 py-2.5 bg-stone-100 border-t border-stone-200 flex flex-wrap items-center justify-between text-xs text-stone-600 gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-stone-700">Hasil Ekstraksi OCR:</span>
                {guest.ktp_ocr_confidence !== undefined && guest.ktp_ocr_confidence !== null ? (
                  <span className="font-mono font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded text-[11px]">
                    {Math.round(Number(guest.ktp_ocr_confidence) * 100)}% ({guest.ktp_ocr_provider || 'OCR'})
                  </span>
                ) : (
                  <span className="text-stone-400">Manual Entry</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setIsKtpPreviewOpen(false)}
                className="px-4 py-1.5 bg-stone-200 hover:bg-stone-300 text-stone-800 rounded font-semibold text-xs transition-colors cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
