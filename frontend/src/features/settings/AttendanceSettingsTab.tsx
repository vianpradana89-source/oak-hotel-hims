import React, { useState, useEffect } from 'react';
import type { PropertyAttendanceSettings, OutsideGeofencePolicy } from '../employee/attendanceTypes';

const ShieldCheck = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
  </svg>
);
const Camera = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);
const MapPin = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);
const Save = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
  </svg>
);
const RefreshCw = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);
const CheckCircle2 = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const AlertTriangle = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);
const Users = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
  </svg>
);

interface AttendanceSettingsTabProps {
  propertyId: number;
}

export const AttendanceSettingsTab: React.FC<AttendanceSettingsTabProps> = ({ propertyId }) => {
  const [settings, setSettings] = useState<PropertyAttendanceSettings>({
    property_id: propertyId,
    attendance_enabled: true,
    require_employee_attendance: true,
    require_checkin_photo: true,
    require_checkout_photo: false,
    geofence_enabled: false,
    geofence_latitude: -6.2088,
    geofence_longitude: 106.8456,
    geofence_radius_meters: 100,
    outside_geofence_policy: 'ALLOW_WITH_REASON',
    exempt_roles: ['Owner', 'General Manager']
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Available roles for exemption
  const availableRoles = ['Owner', 'General Manager', 'Supervisor', 'Administrator', 'Front Desk Agent', 'Room Attendant'];

  // Fetch Attendance Settings
  const fetchSettings = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await fetch(`/api/attendance/settings?property_id=${propertyId}`);
      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        setSettings(data.data);
      } else {
        setErrorMsg(data.message || 'Gagal memuat pengaturan absensi');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Koneksi gagal');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, [propertyId]);

  // Save Settings
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      setErrorMsg(null);
      setSaveSuccess(false);

      const res = await fetch('/api/attendance/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settings,
          property_id: propertyId
        })
      });

      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        setSettings(data.data);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      } else {
        setErrorMsg(data.message || 'Gagal menyimpan pengaturan absensi');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Koneksi gagal saat menyimpan pengaturan');
    } finally {
      setSaving(false);
    }
  };

  // Get current device coordinates as helper
  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert('Geolocation tidak didukung browser ini.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setSettings(prev => ({
          ...prev,
          geofence_latitude: Number(pos.coords.latitude.toFixed(6)),
          geofence_longitude: Number(pos.coords.longitude.toFixed(6))
        }));
      },
      (err) => {
        alert('Gagal mengambil lokasi: ' + err.message);
      },
      { enableHighAccuracy: true }
    );
  };

  const toggleRoleExemption = (role: string) => {
    setSettings(prev => {
      const exists = prev.exempt_roles.includes(role);
      return {
        ...prev,
        exempt_roles: exists
          ? prev.exempt_roles.filter(r => r !== role)
          : [...prev.exempt_roles, role]
      };
    });
  };

  if (loading) {
    return (
      <div className="p-8 text-center text-stone-500">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-[#1b4332]" />
        <span>Memuat Pengaturan HRD & Absensi...</span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-stone-200">
        <div>
          <h2 className="font-serif font-bold text-lg text-[#1b4332]">Pengaturan HRD & Absensi Karyawan</h2>
          <p className="text-xs text-stone-500">
            Kelola gerbang kehadiran mobile, validasi radius lokasi (geofence), dan selfie wajah karyawan.
          </p>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-xl font-medium text-xs bg-[#1b4332] text-white hover:bg-[#143225] shadow flex items-center gap-1.5 transition active:scale-95"
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>{saving ? 'Menyimpan...' : 'Simpan Pengaturan'}</span>
        </button>
      </div>

      {/* Alerts */}
      {saveSuccess && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>Pengaturan absensi berhasil disimpan dan langsung berlaku di portal mobile karyawan.</span>
        </div>
      )}
      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* 1. Gerbang Kehadiran & Kebijakan Dasar */}
      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-stone-100">
          <ShieldCheck className="w-5 h-5 text-[#1b4332]" />
          <h3 className="font-serif font-bold text-sm text-stone-800">Gerbang Kehadiran (Attendance Gate)</h3>
        </div>

        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.attendance_enabled}
              onChange={(e) => setSettings(prev => ({ ...prev, attendance_enabled: e.target.checked }))}
              className="mt-1 w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332]"
            />
            <div>
              <span className="text-xs font-semibold text-stone-800">Aktifkan Modul Absensi HRD</span>
              <p className="text-[11px] text-stone-500">
                Mengaktifkan pencatatan kehadiran karyawan dan API absensi untuk properti ini.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.require_employee_attendance}
              onChange={(e) => setSettings(prev => ({ ...prev, require_employee_attendance: e.target.checked }))}
              className="mt-1 w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332]"
            />
            <div>
              <span className="text-xs font-semibold text-stone-800">Wajibkan Absen Masuk Sebelum Buka Tugas (Gate)</span>
              <p className="text-[11px] text-stone-500">
                Karyawan non-exempt wajib melakukan absen masuk di portal mobile sebelum dapat melihat dan mengerjakan tugas kamar.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* 2. Verifikasi Foto Selfie */}
      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-stone-100">
          <Camera className="w-5 h-5 text-[#1b4332]" />
          <h3 className="font-serif font-bold text-sm text-stone-800">Verifikasi Foto Wajah (Selfie Camera)</h3>
        </div>

        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.require_checkin_photo}
              onChange={(e) => setSettings(prev => ({ ...prev, require_checkin_photo: e.target.checked }))}
              className="mt-1 w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332]"
            />
            <div>
              <span className="text-xs font-semibold text-stone-800">Wajibkan Foto Selfie Saat Absen Masuk</span>
              <p className="text-[11px] text-stone-500">
                Karyawan harus mengambil foto selfie live sebelum tombol absen masuk dapat dikirim.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.require_checkout_photo}
              onChange={(e) => setSettings(prev => ({ ...prev, require_checkout_photo: e.target.checked }))}
              className="mt-1 w-4 h-4 rounded text-[#1b4332] focus:ring-[#1b4332]"
            />
            <div>
              <span className="text-xs font-semibold text-stone-800">Wajibkan Foto Saat Absen Pulang (Clock-Out)</span>
              <p className="text-[11px] text-stone-500">
                Meminta foto bukti saat karyawan mengakhiri shift harian.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* 3. Validasi Geofence & Lokasi GPS Properti */}
      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-stone-100">
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-[#1b4332]" />
            <h3 className="font-serif font-bold text-sm text-stone-800">Radius Lokasi Hotel (Geofence GPS)</h3>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={settings.geofence_enabled}
              onChange={(e) => setSettings(prev => ({ ...prev, geofence_enabled: e.target.checked }))}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#1b4332]" />
          </label>
        </div>

        {settings.geofence_enabled && (
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Latitude Hotel:</label>
                <input
                  type="number"
                  step="0.000001"
                  value={settings.geofence_latitude ?? ''}
                  onChange={(e) => setSettings(prev => ({ ...prev, geofence_latitude: e.target.value ? Number(e.target.value) : null }))}
                  placeholder="-6.2088"
                  className="w-full py-2 px-3 rounded-xl border border-stone-300 text-xs focus:ring-[#1b4332] focus:border-[#1b4332]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Longitude Hotel:</label>
                <input
                  type="number"
                  step="0.000001"
                  value={settings.geofence_longitude ?? ''}
                  onChange={(e) => setSettings(prev => ({ ...prev, geofence_longitude: e.target.value ? Number(e.target.value) : null }))}
                  placeholder="106.8456"
                  className="w-full py-2 px-3 rounded-xl border border-stone-300 text-xs focus:ring-[#1b4332] focus:border-[#1b4332]"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={handleUseCurrentLocation}
                className="text-xs text-[#1b4332] hover:underline font-medium flex items-center gap-1"
              >
                <MapPin className="w-3.5 h-3.5" />
                Gunakan Koordinat Perangkat Ini
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Radius Izin (Meter):</label>
                <select
                  value={settings.geofence_radius_meters}
                  onChange={(e) => setSettings(prev => ({ ...prev, geofence_radius_meters: Number(e.target.value) }))}
                  className="w-full py-2 px-3 rounded-xl border border-stone-300 text-xs focus:ring-[#1b4332] focus:border-[#1b4332]"
                >
                  <option value={50}>50 meter (Sangat Ketat)</option>
                  <option value={100}>100 meter (Standar Hotel)</option>
                  <option value={200}>200 meter (Area Luas / Resort)</option>
                  <option value={500}>500 meter (Kompleks Besar)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">Kebijakan di Luar Radius:</label>
                <select
                  value={settings.outside_geofence_policy}
                  onChange={(e) => setSettings(prev => ({ ...prev, outside_geofence_policy: e.target.value as OutsideGeofencePolicy }))}
                  className="w-full py-2 px-3 rounded-xl border border-stone-300 text-xs focus:ring-[#1b4332] focus:border-[#1b4332]"
                >
                  <option value="ALLOW_WITH_REASON">Izinkan dengan Alasan (Rekomendasi)</option>
                  <option value="BLOCK">Tolak / Kunci Absensi (Block)</option>
                  <option value="REQUIRE_APPROVAL">Tandai Memerlukan Persetujuan Manajer</option>
                </select>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 4. Peran Dikecualikan (Exempt Roles) */}
      <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-stone-100">
          <Users className="w-5 h-5 text-[#1b4332]" />
          <h3 className="font-serif font-bold text-sm text-stone-800">Peran Bebas Gerbang (Exempt Roles)</h3>
        </div>

        <p className="text-xs text-stone-500">
          Peran-peran berikut dapat langsung membuka dashboard operasional tanpa diwajibkan melewati gerbang absensi:
        </p>

        <div className="flex flex-wrap gap-2">
          {availableRoles.map(role => {
            const isExempt = settings.exempt_roles.includes(role);
            return (
              <button
                key={role}
                type="button"
                onClick={() => toggleRoleExemption(role)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                  isExempt
                    ? 'bg-[#1b4332] text-white shadow-sm'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                {role} {isExempt ? '✓ Bebas' : '+ Wajib'}
              </button>
            );
          })}
        </div>
      </div>
    </form>
  );
};
