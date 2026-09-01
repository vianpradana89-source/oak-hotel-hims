import React, { useEffect, useState } from 'react';
import type { Guest, VipStatus } from './guestTypes';
import IdentityExtractionModal, { type ExtractedIdentityData } from '../booking/IdentityExtractionModal';
import { useSecureDocumentBlob } from '../common/useSecureDocumentBlob';

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
  const [identityType, setIdentityType] = useState<string>('KTP');
  const [identityNumber, setIdentityNumber] = useState<string>('');
  const [rtRw, setRtRw] = useState<string>('');
  const [villageKelurahan, setVillageKelurahan] = useState<string>('');
  const [districtKecamatan, setDistrictKecamatan] = useState<string>('');
  const [religion, setReligion] = useState<string>('');
  const [maritalStatus, setMaritalStatus] = useState<string>('');
  const [occupation, setOccupation] = useState<string>('');
  const [citizenship, setCitizenship] = useState<string>('WNI');
  const [validUntil, setValidUntil] = useState<string>('SEUMUR HIDUP');
  const [address, setAddress] = useState<string>('');
  const [city, setCity] = useState<string>('');
  const [province, setProvince] = useState<string>('');
  const [country, setCountry] = useState<string>('Indonesia');
  const [guestSegment, setGuestSegment] = useState<string>('Reguler');
  const [vipStatus, setVipStatus] = useState<VipStatus>('STANDARD');
  const [preferences, setPreferences] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [scanToast, setScanToast] = useState<string | null>(null);
  const [isKtpPreviewOpen, setIsKtpPreviewOpen] = useState<boolean>(false);
  const [isOcrModalOpen, setIsOcrModalOpen] = useState<boolean>(false);

  const { blobUrl: ktpBlobUrl, loading: ktpLoading, error: ktpError } = useSecureDocumentBlob(guest?.identity_path, isKtpPreviewOpen);

  const handleIdentityConfirmed = (data: ExtractedIdentityData | any) => {
    if (!data) return;

    const fn = data.full_name || data.nama || '';
    const nik = data.identity_number || data.nik || '';
    const bp = data.birth_place || data.tempat_lahir || '';
    const bd = data.birth_date || data.tanggal_lahir || '';
    const rawGender = data.gender || data.jenis_kelamin || '';
    const addr = data.address || data.alamat || '';
    const rtrw = data.rt_rw || '';
    const kel = data.village_kelurahan || data.kelurahan || '';
    const kec = data.district_kecamatan || data.kecamatan || '';
    const rel = data.religion || data.agama || '';
    const stat = data.marital_status || data.status_perkawinan || '';
    const occ = data.occupation || data.pekerjaan || '';
    const cit = data.citizenship || data.kewarganegaraan || 'WNI';
    const vu = data.valid_until || data.berlaku_hingga || 'SEUMUR HIDUP';

    if (fn) setFullName(fn);
    if (nik) setIdentityNumber(nik);
    if (bp) setBirthPlace(bp);
    if (bd) {
      // Normalize to YYYY-MM-DD
      const cleanBd = String(bd).split('T')[0].trim();
      setBirthDate(cleanBd.slice(0, 10));
    }
    if (rawGender) {
      const gUpper = String(rawGender).toUpperCase();
      if (gUpper === 'MALE' || gUpper === 'LAKI-LAKI' || gUpper === 'L') {
        setGender('MALE');
      } else if (gUpper === 'FEMALE' || gUpper === 'PEREMPUAN' || gUpper === 'P') {
        setGender('FEMALE');
      } else {
        setGender(rawGender);
      }
    }
    if (addr) setAddress(addr);
    if (rtrw) setRtRw(rtrw);
    if (kel) setVillageKelurahan(kel);
    if (kec) setDistrictKecamatan(kec);
    if (rel) setReligion(rel);
    if (stat) setMaritalStatus(stat);
    if (occ) setOccupation(occ);
    if (cit) setCitizenship(cit);
    if (vu) setValidUntil(vu);
    setIdentityType('KTP');

    setIsOcrModalOpen(false);
    setScanToast('Data KTP berhasil dipindai! NIK, Nama Lengkap, Tanggal Lahir, Jenis Kelamin, dan Alamat telah diisi otomatis.');
    setTimeout(() => {
      setScanToast(null);
    }, 5000);
  };

  useEffect(() => {
    setIsKtpPreviewOpen(false);
    if (guest) {
      setFullName(guest.full_name || '');
      setPreferredName(guest.preferred_name || '');
      setGender(guest.gender || '');
      setBirthPlace(guest.birth_place || '');
      setBirthDate(guest.birth_date ? guest.birth_date.slice(0, 10) : '');
      setNationality(guest.nationality || 'Indonesia');
      setPhone(guest.phone || '');
      setEmail(guest.email || '');
      setIdentityType(guest.identity_type || 'KTP');
      setIdentityNumber(guest.identity_number || '');
      setRtRw(guest.rt_rw || '');
      setVillageKelurahan(guest.village_kelurahan || '');
      setDistrictKecamatan(guest.district_kecamatan || '');
      setReligion(guest.religion || '');
      setMaritalStatus(guest.marital_status || '');
      setOccupation(guest.occupation || '');
      setCitizenship(guest.citizenship || 'WNI');
      setValidUntil(guest.valid_until || 'SEUMUR HIDUP');
      setAddress(guest.address || '');
      setCity(guest.city || '');
      setProvince(guest.province || '');
      setCountry(guest.country || 'Indonesia');
      setGuestSegment(guest.guest_segment || 'Reguler');
      setVipStatus(guest.vip_status || 'STANDARD');
      setPreferences(guest.preferences || '');
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
      setIdentityType('KTP');
      setIdentityNumber('');
      setRtRw('');
      setVillageKelurahan('');
      setDistrictKecamatan('');
      setReligion('');
      setMaritalStatus('');
      setOccupation('');
      setCitizenship('WNI');
      setValidUntil('SEUMUR HIDUP');
      setAddress('');
      setCity('');
      setProvince('');
      setCountry('Indonesia');
      setGuestSegment('Reguler');
      setVipStatus('STANDARD');
      setPreferences('');
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
      identity_type: identityType || 'KTP',
      identity_number: identityNumber.trim() || null,
      rt_rw: rtRw.trim() || null,
      village_kelurahan: villageKelurahan.trim() || null,
      district_kecamatan: districtKecamatan.trim() || null,
      religion: religion.trim() || null,
      marital_status: maritalStatus.trim() || null,
      occupation: occupation.trim() || null,
      citizenship: citizenship.trim() || null,
      valid_until: validUntil.trim() || null,
      address: address.trim() || null,
      city: city.trim() || null,
      province: province.trim() || null,
      country: country.trim() || null,
      guest_segment: guestSegment || 'Reguler',
      vip_status: vipStatus,
      preferences: preferences.trim() || null,
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
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-stone-900">
              {guest ? `Edit Profil: ${guest.full_name}` : 'Tambah Profil Tamu Baru'}
            </h3>
            {guest?.guest_code && (
              <span className="text-xs px-2 py-0.5 rounded bg-stone-100 text-stone-700 font-mono font-bold border border-stone-200">
                {guest.guest_code}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 text-stone-400 hover:text-stone-700 rounded-md transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4 text-xs">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700">
              {error}
            </div>
          )}

          {scanToast && (
            <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-lg text-emerald-900 flex items-center justify-between shadow-xs animate-in fade-in duration-150">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="font-semibold text-xs">{scanToast}</span>
              </div>
              <button
                type="button"
                onClick={() => setScanToast(null)}
                className="text-emerald-700 hover:text-emerald-900 p-1 text-xs cursor-pointer font-bold"
              >
                ✕
              </button>
            </div>
          )}

          {/* Section: Identitas Utama */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-stone-400 uppercase tracking-wider text-[11px]">
                Identitas Tamu
              </h4>
              <button
                type="button"
                onClick={() => setIsOcrModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-lg text-xs font-semibold shadow-2xs transition-all hover:scale-[1.02] cursor-pointer"
                title="Pindai foto KTP / Paspor menggunakan OCR & Kamera"
              >
                <svg className="w-4 h-4 text-emerald-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span>Scan KTP / Paspor</span>
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Nama Lengkap <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Budi Santoso"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Nama Panggilan (Preferred Name)
                </label>
                <input
                  type="text"
                  value={preferredName}
                  onChange={(e) => setPreferredName(e.target.value)}
                  placeholder="e.g. Pak Budi"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Gender</label>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none bg-white"
                >
                  <option value="">-- Pilih --</option>
                  <option value="MALE">Laki-laki</option>
                  <option value="FEMALE">Perempuan</option>
                  <option value="OTHER">Lainnya</option>
                </select>
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Tempat Lahir</label>
                <input
                  type="text"
                  value={birthPlace}
                  onChange={(e) => setBirthPlace(e.target.value)}
                  placeholder="Kota kelahiran"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Tanggal Lahir</label>
                <input
                  type="date"
                  value={birthDate}
                  onChange={(e) => setBirthDate(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Jenis Identitas</label>
                <select
                  value={identityType}
                  onChange={(e) => setIdentityType(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none bg-white"
                >
                  <option value="KTP">KTP</option>
                  <option value="PASSPORT">Paspor</option>
                  <option value="SIM">SIM</option>
                </select>
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="block font-semibold text-stone-700">Nomor Identitas (NIK / Paspor)</label>
                  {guest?.identity_path && (
                    <button
                      type="button"
                      onClick={() => setIsKtpPreviewOpen(true)}
                      className="inline-flex items-center gap-1 text-[11px] text-emerald-700 hover:text-emerald-900 font-medium cursor-pointer"
                      title="Lihat Foto KTP yang Diunggah"
                    >
                      <svg className="w-3.5 h-3.5 text-emerald-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      <span>Foto KTP</span>
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={identityNumber}
                  onChange={(e) => setIdentityNumber(e.target.value)}
                  placeholder="16 digit NIK atau nomor paspor"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Masa Berlaku KTP</label>
                <input
                  type="text"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                  placeholder="SEUMUR HIDUP / YYYY-MM-DD"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Agama</label>
                <input
                  type="text"
                  value={religion}
                  onChange={(e) => setReligion(e.target.value)}
                  placeholder="e.g. ISLAM / KRISTEN"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Status Perkawinan</label>
                <input
                  type="text"
                  value={maritalStatus}
                  onChange={(e) => setMaritalStatus(e.target.value)}
                  placeholder="e.g. KAWIN / BELUM KAWIN"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Pekerjaan</label>
                <input
                  type="text"
                  value={occupation}
                  onChange={(e) => setOccupation(e.target.value)}
                  placeholder="e.g. Karyawan Swasta"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Kewarganegaraan</label>
                <input
                  type="text"
                  value={citizenship}
                  onChange={(e) => setCitizenship(e.target.value)}
                  placeholder="WNI / WNA"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section: Kontak */}
          <div className="space-y-3 pt-3 border-t border-stone-200">
            <h4 className="font-bold text-stone-400 uppercase tracking-wider text-[11px]">
              Kontak
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nomor Telepon</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 08123456789"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. tamu@example.com"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section: Alamat */}
          <div className="space-y-3 pt-3 border-t border-stone-200">
            <h4 className="font-bold text-stone-400 uppercase tracking-wider text-[11px]">
              Alamat Lengkap KTP
            </h4>
            <div>
              <label className="block font-semibold text-stone-700 mb-1">Alamat Jalan</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Jl. Nama Jalan No. XX"
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">RT / RW</label>
                <input
                  type="text"
                  value={rtRw}
                  onChange={(e) => setRtRw(e.target.value)}
                  placeholder="001/002"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Kelurahan / Desa</label>
                <input
                  type="text"
                  value={villageKelurahan}
                  onChange={(e) => setVillageKelurahan(e.target.value)}
                  placeholder="Kelurahan"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Kecamatan</label>
                <input
                  type="text"
                  value={districtKecamatan}
                  onChange={(e) => setDistrictKecamatan(e.target.value)}
                  placeholder="Kecamatan"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Kota / Kab</label>
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Kota"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Provinsi</label>
                <input
                  type="text"
                  value={province}
                  onChange={(e) => setProvince(e.target.value)}
                  placeholder="Provinsi"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Negara</label>
                <input
                  type="text"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="Negara"
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section: Segmentasi & Preferensi CRM */}
          <div className="space-y-3 pt-3 border-t border-stone-200">
            <h4 className="font-bold text-stone-400 uppercase tracking-wider text-[11px]">
              Klasifikasi & Preferensi CRM
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Status VIP</label>
                <select
                  value={vipStatus}
                  onChange={(e) => setVipStatus(e.target.value as VipStatus)}
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none bg-white"
                >
                  <option value="STANDARD">STANDARD</option>
                  <option value="VIP">VIP</option>
                  <option value="VVIP">VVIP</option>
                </select>
              </div>
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Segmentasi Tamu</label>
                <select
                  value={guestSegment}
                  onChange={(e) => setGuestSegment(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none bg-white"
                >
                  <option value="Reguler">Reguler</option>
                  <option value="Walk-in">Walk-in</option>
                  <option value="Corporate">Corporate</option>
                  <option value="Group">Group</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Preferensi Tamu (Preferences)
              </label>
              <textarea
                rows={2}
                value={preferences}
                onChange={(e) => setPreferences(e.target.value)}
                placeholder="Preferensi kamar, bantal ekstra, lantai atas, non-smoking, alergi, dsb..."
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
              />
            </div>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Catatan Khusus (CRM Notes)
              </label>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Catatan internal tim hotel mengenai tamu..."
                className="w-full px-3 py-2 border border-stone-300 rounded focus:ring-1 focus:ring-[#1E392A] outline-none"
              />
            </div>
          </div>

          {/* Footer Actions */}
          <div className="pt-4 border-t border-stone-200 flex justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold rounded transition-colors"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 bg-[#1E392A] hover:bg-[#162a1f] text-white font-semibold rounded shadow-xs transition-colors flex items-center space-x-1.5"
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
                {ktpBlobUrl && (
                  <button
                    type="button"
                    onClick={() => window.open(ktpBlobUrl, '_blank')}
                    className="px-2.5 py-1 text-stone-300 hover:text-white hover:bg-stone-800 rounded text-xs flex items-center gap-1.5 font-sans border border-stone-700 transition-colors cursor-pointer"
                    title="Buka di tab baru"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    <span>Buka Tab Baru</span>
                  </button>
                )}
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
              {ktpLoading ? (
                <div className="flex flex-col items-center justify-center py-12 text-stone-400 text-xs gap-2">
                  <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                  <span>Mengunduh dokumen aman...</span>
                </div>
              ) : ktpError ? (
                <div className="text-center p-8 text-rose-400 text-xs space-y-1">
                  <div className="text-2xl">⚠️</div>
                  <p className="font-bold">{ktpError}</p>
                  <p className="text-stone-500 text-[11px]">Pastikan Anda memiliki izin akses ke dokumen properti ini.</p>
                </div>
              ) : ktpBlobUrl ? (
                <img
                  src={ktpBlobUrl}
                  alt={`KTP ${guest.full_name}`}
                  className="max-h-[60vh] max-w-full object-contain rounded-lg shadow-xl border border-stone-800 bg-stone-900"
                />
              ) : null}
            </div>

            {/* Footer */}
            <div className="px-5 py-2.5 bg-stone-100 border-t border-stone-200 flex items-center justify-end">
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

      {/* OCR KTP / Paspor Extraction Modal */}
      <IdentityExtractionModal
        isOpen={isOcrModalOpen}
        onClose={() => setIsOcrModalOpen(false)}
        guestName={fullName}
        guestPhone={phone}
        guestId={guest?.id}
        propertyId={propertyId}
        onScanSuccess={handleIdentityConfirmed}
        onIdentityConfirmed={handleIdentityConfirmed}
      />
    </div>
  );
};
