import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthContext';

export const OnboardingWorkspace: React.FC = () => {
  const { user, authFetch, logout, updateSessionToken } = useAuth();

  const [step, setStep] = useState<'PASSWORD' | 'FACE'>('PASSWORD');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Check onboarding status on mount
  useEffect(() => {
    let isMounted = true;
    const fetchStatus = async () => {
      try {
        const res = await authFetch('/api/auth/onboarding-status');
        if (res.ok) {
          const json = await res.json();
          if (isMounted && json.data) {
            if (json.data.account_status === 'FACE_ENROLLMENT_REQUIRED' || json.data.next_step === 'ENROLL_FACE') {
              setStep('FACE');
            } else {
              setStep('PASSWORD');
            }
          }
        }
      } catch (e) {
        console.warn('Failed to fetch onboarding status:', e);
      }
    };
    fetchStatus();
    return () => {
      isMounted = false;
    };
  }, [authFetch]);

  // Validation rules
  const hasMinLength = newPassword.length >= 8;
  const hasUpper = /[A-Z]/.test(newPassword);
  const hasLower = /[a-z]/.test(newPassword);
  const hasNumber = /[0-9]/.test(newPassword);
  const hasSpecial = /[^A-Za-z0-9]/.test(newPassword);
  const isMatch = newPassword.length > 0 && newPassword === confirmPassword;

  const isFormValid = hasMinLength && hasUpper && hasLower && hasNumber && hasSpecial && isMatch;

  const handleSubmitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!isFormValid) {
      setErrorMessage('Harap penuhi semua kriteria keamanan password.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await authFetch('/api/auth/complete-initial-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_password: newPassword,
          confirm_password: confirmPassword,
        }),
      });

      const json = await res.json();

      if (res.ok && json.status === 'OK') {
        if (json.data?.token) {
          updateSessionToken(json.data.token, {
            account_status: json.data.account_status,
            must_change_password: false,
            scope: 'ONBOARDING',
          });
        }
        setSuccessMessage('Password berhasil disimpan.');
        setStep('FACE');
      } else {
        setErrorMessage(json.message || 'Gagal menyimpan password baru.');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan jaringan.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7] text-[#1B2A26] flex flex-col justify-between font-sans selection:bg-[#2C4A3E] selection:text-white">
      {/* Top Navigation */}
      <header className="border-b border-stone-200 bg-white/80 backdrop-blur sticky top-0 z-10 px-4 sm:px-6 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-[#2C4A3E] flex items-center justify-center text-white font-serif font-bold text-lg shadow-sm">
            O
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-stone-900 uppercase">
              OAK Hotel Management
            </h1>
            <p className="text-[11px] text-stone-500">Aktivasi & Orientasi Akun Karyawan</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <div className="text-right hidden sm:block">
            <p className="text-xs font-semibold text-stone-800">{user?.full_name || 'Karyawan'}</p>
            <p className="text-[10px] text-stone-500">{user?.role || 'Staff'}</p>
          </div>
          <button
            onClick={logout}
            className="text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 px-3 py-1.5 rounded-lg transition-colors flex items-center space-x-1"
          >
            <span>Keluar</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-md bg-white border border-stone-200 rounded-2xl shadow-xl overflow-hidden">
          {/* Progress Banner */}
          <div className="bg-[#2C4A3E] text-white px-6 py-5">
            <div className="flex items-center justify-between mb-3 text-xs tracking-wider uppercase font-medium text-stone-200">
              <span>Langkah {step === 'PASSWORD' ? '1 dari 2' : '2 dari 2'}</span>
              <span className="bg-amber-400/20 text-amber-200 text-[10px] font-bold px-2 py-0.5 rounded border border-amber-300/30">
                ONBOARDING
              </span>
            </div>
            <h2 className="text-xl font-serif font-bold">
              {step === 'PASSWORD' ? 'Amankan Akun Anda' : 'Daftarkan Wajah'}
            </h2>
            <p className="text-xs text-stone-300 mt-1">
              {step === 'PASSWORD'
                ? 'Password sementara hanya digunakan untuk login pertama.'
                : 'Verifikasi biometrik wajah untuk presensi hotel.'}
            </p>
          </div>

          {/* Stepper Dots */}
          <div className="grid grid-cols-2 bg-stone-100 border-b border-stone-200 text-[11px] font-medium text-stone-600">
            <div
              className={`py-2 px-3 text-center border-r border-stone-200 flex items-center justify-center space-x-1.5 ${
                step === 'PASSWORD' ? 'bg-white text-[#2C4A3E] font-bold border-b-2 border-b-[#2C4A3E]' : 'text-emerald-700'
              }`}
            >
              <span>1. Buat Password</span>
              {step === 'FACE' && <span className="text-emerald-600">✓</span>}
            </div>
            <div
              className={`py-2 px-3 text-center flex items-center justify-center space-x-1.5 ${
                step === 'FACE' ? 'bg-white text-[#2C4A3E] font-bold border-b-2 border-b-[#2C4A3E]' : 'text-stone-400'
              }`}
            >
              <span>2. Foto Wajah</span>
            </div>
          </div>

          {/* Step 1: PASSWORD FORM */}
          {step === 'PASSWORD' && (
            <form onSubmit={handleSubmitPassword} className="p-6 space-y-4">
              {errorMessage && (
                <div className="p-3 text-xs rounded-lg bg-rose-50 border border-rose-200 text-rose-800">
                  {errorMessage}
                </div>
              )}
              {successMessage && (
                <div className="p-3 text-xs rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800">
                  {successMessage}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Password Pribadi Baru <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Masukkan password baru"
                    className="w-full text-sm px-3 py-2 border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2C4A3E] focus:border-transparent bg-stone-50/50"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-stone-500 hover:text-stone-800 select-none"
                  >
                    {showPassword ? 'Sembunyikan' : 'Lihat'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Konfirmasi Password Baru <span className="text-rose-500">*</span>
                </label>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Ketik ulang password baru"
                  className="w-full text-sm px-3 py-2 border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2C4A3E] focus:border-transparent bg-stone-50/50"
                  required
                />
              </div>

              {/* Password Requirement Checklist */}
              <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 text-[11px] space-y-1 text-stone-600">
                <p className="font-semibold text-stone-700 mb-1">Ketentuan Keamanan Password:</p>
                <div className={`flex items-center space-x-1.5 ${hasMinLength ? 'text-emerald-700 font-medium' : ''}`}>
                  <span>{hasMinLength ? '✓' : '○'}</span>
                  <span>Minimal 8 karakter</span>
                </div>
                <div className={`flex items-center space-x-1.5 ${hasUpper && hasLower ? 'text-emerald-700 font-medium' : ''}`}>
                  <span>{hasUpper && hasLower ? '✓' : '○'}</span>
                  <span>Kombinasi huruf besar (A-Z) dan kecil (a-z)</span>
                </div>
                <div className={`flex items-center space-x-1.5 ${hasNumber ? 'text-emerald-700 font-medium' : ''}`}>
                  <span>{hasNumber ? '✓' : '○'}</span>
                  <span>Minimal 1 digit angka (0-9)</span>
                </div>
                <div className={`flex items-center space-x-1.5 ${hasSpecial ? 'text-emerald-700 font-medium' : ''}`}>
                  <span>{hasSpecial ? '✓' : '○'}</span>
                  <span>Minimal 1 simbol / karakter khusus (!@#$%...)</span>
                </div>
                <div className={`flex items-center space-x-1.5 ${isMatch ? 'text-emerald-700 font-medium' : ''}`}>
                  <span>{isMatch ? '✓' : '○'}</span>
                  <span>Konfirmasi password sesuai</span>
                </div>
              </div>

              <button
                type="submit"
                disabled={!isFormValid || isLoading}
                className="w-full py-2.5 px-4 bg-[#2C4A3E] hover:bg-[#233b32] text-white font-medium text-sm rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
              >
                {isLoading ? (
                  <span>Menyimpan Password...</span>
                ) : (
                  <span>Simpan Password Baru</span>
                )}
              </button>
            </form>
          )}

          {/* Step 2: FACE ENROLLMENT PLACEHOLDER (AUTH-HR-2B) */}
          {step === 'FACE' && (
            <div className="p-6 space-y-5 text-center">
              <div className="w-16 h-16 mx-auto rounded-full bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center text-2xl font-bold">
                ✓
              </div>

              <div className="space-y-2">
                <h3 className="text-base font-bold text-stone-900">
                  Password Anda Berhasil Dibuat
                </h3>
                <p className="text-xs text-stone-600 leading-relaxed">
                  Langkah berikutnya adalah mendaftarkan foto wajah untuk verifikasi absensi.
                </p>
              </div>

              <div className="bg-amber-50 border border-amber-200/80 rounded-xl p-4 text-left">
                <div className="flex items-start space-x-2.5">
                  <span className="text-amber-700 text-lg">ⓘ</span>
                  <div className="text-xs text-amber-900 space-y-1">
                    <p className="font-semibold">Tahap Pendaftaran Wajah (AUTH-HR-2C)</p>
                    <p className="text-amber-800/90 leading-relaxed">
                      Fitur pendaftaran wajah akan dilanjutkan pada tahap berikutnya. Akun Anda saat ini tetap dalam mode onboarding terbatas dan belum dapat membuka dashboard operasional PMS.
                    </p>
                  </div>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={logout}
                  className="w-full py-2.5 px-4 bg-stone-100 hover:bg-stone-200 text-stone-700 font-medium text-xs rounded-lg transition-colors border border-stone-300"
                >
                  Selesai & Keluar dari Sesi
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-4 text-center text-[11px] text-stone-400 border-t border-stone-200">
        OAK Hotel Integrated Management System &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
};