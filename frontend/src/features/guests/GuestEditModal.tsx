import React, { useEffect, useState } from 'react';
import type { Guest, VipStatus } from './guestTypes';

interface GuestEditModalProps {
  isOpen: boolean;
  guest: Guest | null;
  propertyId: number;
  onClose: () => void;
  onSaved: (savedGuest: Guest) => void;
}

export const GuestEditModal: React.FC<GuestEditModalProps> = ({
  isOpen,
  guest,
  propertyId,
  onClose,
  onSaved
}) => {
  const [fullName, setFullName] = useState<string>('');
  const [preferredName, setPreferredName] = useState<string>('');
  const [gender, setGender] = useState<string>('');
  const [birthPlace, setBirthPlace] = useState<string>('');
  const [birthDate, setBirthDate] = useState<string>('');
  const [nationality, setNationality] = useState<string>('Indonesia');
  const [phone, setPhone] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [address, setAddress] = useState<string>('');
  const [city, setCity] = useState<string>('');
  const [province, setProvince] = useState<string>('');
  const [country, setCountry] = useState<string>('Indonesia');
  const [vipStatus, setVipStatus] = useState<VipStatus>('STANDARD');
  const [notes, setNotes] = useState<string>('');

  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (guest) {
      setFullName(guest.full_name || '');
      setPreferredName(guest.preferred_name || '');
      setGender(guest.gender || '');
      setBirthPlace(guest.birth_place || '');
      setBirthDate(guest.birth_date ? guest.birth_date.slice(0, 10) : '');
      setNationality(guest.nationality || 'Indonesia');
      setPhone(guest.phone || '');
      setEmail(guest.email || '');
      setAddress(guest.address || '');
      setCity(guest.city || '');
      setProvince(guest.province || '');
      setCountry(guest.country || 'Indonesia');
      setVipStatus(guest.vip_status || 'STANDARD');
      setNotes(guest.notes || '');
    } else {
      setFullName('');
      setPreferredName('');
      setGender('');
      setBirthPlace('');
      setBirthDate('');
      setNationality('Indonesia');
      setPhone('');
      setEmail('');
      setAddress('');
      setCity('');
      setProvince('');
      setCountry('Indonesia');
      setVipStatus('STANDARD');
      setNotes('');
    }
    setError(null);
  }, [guest, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) {
      setError('Nama lengkap wajib diisi.');
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      full_name: fullName.trim(),
      preferred_name: preferredName.trim() || null,
      gender: gender || null,
      birth_place: birthPlace.trim() || null,
      birth_date: birthDate || null,
      nationality: nationality.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: address.trim() || null,
      city: city.trim() || null,
      province: province.trim() || null,
      country: country.trim() || null,
      vip_status: vipStatus,
      notes: notes.trim() || null,
      property_id: propertyId
    };

    try {
      const isEditing = Boolean(guest && guest.id);
      const url = isEditing
        ? `/api/guests/${guest?.id}?property_id=${propertyId}`
        : `/api/guests`;
      const method = isEditing ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menyimpan profil tamu');
      }

      onSaved(json.data);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Terjadi kesalahan sistem';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between bg-stone-50/50">
          <h3 className="text-base font-bold text-stone-900">
            {guest ? `Edit Profil: ${guest.full_name}` : 'Tambah Profil Tamu Baru'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-stone-400 hover:text-stone-700 rounded-md transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs">
              {error}
            </div>
          )}

          {/* Row 1: Nama Lengkap & Panggilan */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Nama Lengkap <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="cth. Budi Santoso"
                required
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Nama Panggilan
              </label>
              <input
                type="text"
                value={preferredName}
                onChange={(e) => setPreferredName(e.target.value)}
                placeholder="cth. Pak Budi"
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
          </div>

          {/* Row 2: Status VIP & Gender */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Status VIP
              </label>
              <select
                value={vipStatus}
                onChange={(e) => setVipStatus(e.target.value as VipStatus)}
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded bg-white focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              >
                <option value="STANDARD">Standard</option>
                <option value="VIP">VIP</option>
                <option value="VVIP">VVIP</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Jenis Kelamin
              </label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded bg-white focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              >
                <option value="">-- Pilih Gender --</option>
                <option value="MALE">Laki-laki (Male)</option>
                <option value="FEMALE">Perempuan (Female)</option>
                <option value="OTHER">Lainnya</option>
              </select>
            </div>
          </div>

          {/* Row 3: Kontak (Telepon & Email) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                No. Telepon / WhatsApp
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="cth. 08123456789"
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="cth. budi@domain.com"
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
          </div>

          {/* Row 4: Kelahiran & Kewarganegaraan */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Tempat Lahir
              </label>
              <input
                type="text"
                value={birthPlace}
                onChange={(e) => setBirthPlace(e.target.value)}
                placeholder="cth. Jakarta"
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Tanggal Lahir
              </label>
              <input
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Kewarganegaraan
              </label>
              <input
                type="text"
                value={nationality}
                onChange={(e) => setNationality(e.target.value)}
                placeholder="cth. Indonesia"
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
          </div>

          {/* Row 5: Alamat Lengkap */}
          <div>
            <label className="block text-xs font-semibold text-stone-700 mb-1">
              Alamat Lengkap
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="cth. Jl. Sudirman No. 123"
              className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
            />
          </div>

          {/* Row 6: Kota, Provinsi, Negara */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Kota
              </label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="cth. Surabaya"
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Provinsi
              </label>
              <input
                type="text"
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                placeholder="cth. Jawa Timur"
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Negara
              </label>
              <input
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="cth. Indonesia"
                className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
              />
            </div>
          </div>

          {/* Row 7: Catatan CRM & Preferensi */}
          <div>
            <label className="block text-xs font-semibold text-stone-700 mb-1">
              Catatan CRM & Preferensi Tamu
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="cth. Preferensi kamar lantai tinggi, bantal bulu angsa, tidak merokok..."
              className="w-full text-xs px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] focus:border-[#1E392A] outline-none"
            />
          </div>

          {/* Footer */}
          <div className="pt-4 border-t border-stone-200 flex justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold rounded transition-colors"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-semibold rounded shadow-xs transition-colors flex items-center space-x-1.5"
            >
              {saving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Menyimpan...</span>
                </>
              ) : (
                <span>Simpan Profil</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
