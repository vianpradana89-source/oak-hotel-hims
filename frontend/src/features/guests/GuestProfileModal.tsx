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
}

export const GuestProfileModal: React.FC<GuestProfileModalProps> = ({
  guestId,
  propertyId,
  isOpen,
  onClose,
  onEditGuest
}) => {
  const [guest, setGuest] = useState<GuestDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !guestId) {
      setGuest(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

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
                {vipBadge && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full border ${vipBadge.bg} ${vipBadge.border} ${vipBadge.text}`}
                  >
                    {vipBadge.label}
                  </span>
                )}
              </div>
              {guest?.preferred_name && (
                <p className="text-xs text-stone-500">
                  Panggilan: &ldquo;{guest.preferred_name}&rdquo;
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {guest && (
              <button
                onClick={() => onEditGuest(guest)}
                className="px-3 py-1.5 bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-semibold rounded shadow-xs transition-colors"
              >
                ✏️ Edit Profil
              </button>
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
          {loading && (
            <div className="flex items-center justify-center py-12 text-stone-500">
              <div className="w-6 h-6 border-2 border-[#1E392A] border-t-transparent rounded-full animate-spin mr-3" />
              <span>Memuat data tamu...</span>
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
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
                      <span className="font-medium text-stone-800">{guest.phone || '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-stone-500">Email:</span>
                      <span className="font-medium text-stone-800">{guest.email || '—'}</span>
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
                    <div className="flex justify-between">
                      <span className="text-stone-500">Kewarganegaraan:</span>
                      <span className="font-medium text-stone-800">{guest.nationality || '—'}</span>
                    </div>
                  </div>
                </div>

                {/* Address & Notes */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-stone-400 uppercase tracking-wider">
                    Alamat & Catatan CRM
                  </h4>
                  <div className="bg-stone-50/50 rounded-lg p-3 border border-stone-200/60 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-stone-500">Alamat:</span>
                      <span className="font-medium text-stone-800 text-right max-w-[65%]">
                        {[guest.address, guest.city, guest.province, guest.country]
                          .filter(Boolean)
                          .join(', ') || '—'}
                      </span>
                    </div>
                    <div className="pt-2 border-t border-stone-200/60">
                      <span className="text-stone-500 block mb-1">Catatan Tamu:</span>
                      <p className="text-stone-700 italic text-xs bg-white p-2 rounded border border-stone-200 min-h-12">
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
    </div>
  );
};
