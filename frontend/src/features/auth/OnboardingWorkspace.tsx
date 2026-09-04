import React, { useState, useEffect, useRef } from 'react';
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

          {/* Step 2: FACE ENROLLMENT (AUTH-HR-2C) */}
          {step === 'FACE' && (
            <FaceEnrollmentStep
              authFetch={authFetch}
              logout={logout}
              updateSessionToken={updateSessionToken}
            />
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

interface FaceEnrollmentStepProps {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  logout: () => void;
  updateSessionToken: (newToken: string, updatedUserPartial?: any) => void;
}

const FaceEnrollmentStep: React.FC<FaceEnrollmentStepProps> = ({
  authFetch,
  logout,
  updateSessionToken
}) => {
  const [cameraState, setCameraState] = useState<
    'IDLE' | 'REQUESTING' | 'READY' | 'CAPTURED' | 'UPLOADING' | 'SUCCESS' | 'ERROR'
  >('IDLE');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [capturedPreviewUrl, setCapturedPreviewUrl] = useState<string | null>(null);
  const [isVideoReady, setIsVideoReady] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const cameraRequestIdRef = useRef<number>(0);

  const stopCamera = () => {
    cameraRequestIdRef.current++;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {
          // ignore
        }
      });
      mediaStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsVideoReady(false);
  };

  const cancelCamera = () => {
    stopCamera();
    setErrorMessage(null);
    setCameraState('IDLE');
  };

  const startCamera = async () => {
    stopCamera();
    setErrorMessage(null);
    setCameraState('REQUESTING');
    const requestId = ++cameraRequestIdRef.current;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('UNSUPPORTED_BROWSER');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 640 }
        },
        audio: false
      });

      // Guard against superseded request or cancellation while awaiting permission
      if (cameraRequestIdRef.current !== requestId) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (e) {
            // ignore
          }
        });
        return;
      }

      mediaStreamRef.current = stream;
      setCameraState('READY');
    } catch (err: any) {
      stopCamera();
      let msg = 'Gagal mengakses kamera perangkat.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = 'Izin kamera ditolak. Silakan izinkan akses kamera di pengaturan browser Anda.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        msg = 'Kamera tidak ditemukan pada perangkat Anda.';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        msg = 'Kamera sedang digunakan oleh aplikasi lain.';
      } else if (err.message === 'UNSUPPORTED_BROWSER') {
        msg = 'Browser Anda tidak mendukung akses kamera langsung.';
      }
      setErrorMessage(msg);
      setCameraState('ERROR');
    }
  };

  // Post-render stream attachment & mobile playback
  useEffect(() => {
    if (cameraState !== 'READY') return;

    let isSubscribed = true;
    const video = videoRef.current;
    const stream = mediaStreamRef.current;

    if (!video || !stream) return;

    video.srcObject = stream;

    const startPlayback = async () => {
      try {
        await video.play();
        if (isSubscribed && video.videoWidth > 0 && video.videoHeight > 0) {
          setIsVideoReady(true);
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return;
        if (!isSubscribed) return;
        console.warn('Video play failed:', err);
        stopCamera();
        setCameraState('ERROR');
        setErrorMessage('Gagal memutar pratinjau video kamera. Silakan periksa izin browser atau coba lagi.');
      }
    };

    startPlayback();

    return () => {
      isSubscribed = false;
    };
  }, [cameraState]);

  const handleVideoCanPlay = () => {
    if (videoRef.current && videoRef.current.videoWidth > 0 && videoRef.current.videoHeight > 0) {
      setIsVideoReady(true);
    }
  };

  const captureFrame = () => {
    if (!videoRef.current || !isVideoReady) {
      setErrorMessage('Kamera belum siap mengambil gambar. Pastikan pratinjau wajah telah tampil jelas.');
      return;
    }
    const video = videoRef.current;
    const width = video.videoWidth;
    const height = video.videoHeight;

    if (!width || !height) {
      setErrorMessage('Dimensi gambar kamera tidak valid. Silakan tunggu beberapa saat.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setErrorMessage('Gagal memproses gambar pada perangkat Anda.');
      return;
    }

    // Mirror horizontally so saved image matches selfie preview
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, width, height);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          setCapturedBlob(blob);
          const url = URL.createObjectURL(blob);
          setCapturedPreviewUrl(url);
          stopCamera();
          setCameraState('CAPTURED');
        } else {
          setErrorMessage('Gagal menghasilkan file foto wajah. Silakan coba kembali.');
        }
      },
      'image/jpeg',
      0.85
    );
  };

  const retakePhoto = () => {
    if (capturedPreviewUrl) {
      URL.revokeObjectURL(capturedPreviewUrl);
      setCapturedPreviewUrl(null);
    }
    setCapturedBlob(null);
    startCamera();
  };

  const submitPhoto = async () => {
    if (!capturedBlob) return;
    setCameraState('UPLOADING');
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append('photo', capturedBlob, 'face-reference.jpg');

      const res = await authFetch('/api/auth/face-enrollment', {
        method: 'POST',
        body: formData
      });

      const json = await res.json();
      if (res.ok && json.status === 'OK') {
        setSuccessMessage('Foto wajah berhasil didaftarkan. Akun Anda sekarang siap digunakan.');
        setCameraState('SUCCESS');
        if (json.data?.token) {
          setTimeout(() => {
            updateSessionToken(json.data.token, {
              account_status: 'READY',
              scope: 'FULL'
            });
          }, 1200);
        }
      } else {
        setErrorMessage(json.message || 'Gagal mendaftarkan foto wajah.');
        setCameraState('CAPTURED');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Terjadi kesalahan jaringan saat mengunggah foto.');
      setCameraState('CAPTURED');
    }
  };

  // Component unmount cleanup for camera stream
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  // Object URL cleanup when capturedPreviewUrl changes or unmounts
  useEffect(() => {
    return () => {
      if (capturedPreviewUrl) {
        URL.revokeObjectURL(capturedPreviewUrl);
      }
    };
  }, [capturedPreviewUrl]);

  return (
    <div className="p-6 space-y-4">
      {errorMessage && (
        <div className="p-3 text-xs rounded-lg bg-rose-50 border border-rose-200 text-rose-800 flex items-start space-x-2">
          <span className="text-rose-600 font-bold">!</span>
          <span className="flex-1">{errorMessage}</span>
        </div>
      )}

      {successMessage && (
        <div className="p-3 text-xs rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-start space-x-2">
          <span className="text-emerald-600 font-bold">✓</span>
          <span className="flex-1">{successMessage}</span>
        </div>
      )}

      {/* STATE: IDLE */}
      {cameraState === 'IDLE' && (
        <div className="space-y-4 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center text-2xl font-bold shadow-sm">
            📷
          </div>

          <div className="space-y-1.5">
            <h3 className="text-base font-bold text-stone-900">
              Pendaftaran Foto Wajah (Master Face)
            </h3>
            <p className="text-xs text-stone-600 leading-relaxed max-w-sm mx-auto">
              Foto wajah ini akan digunakan sebagai foto referensi utama untuk validasi presensi harian Anda.
            </p>
          </div>

          <div className="bg-stone-50 border border-stone-200 rounded-xl p-3.5 text-left text-xs text-stone-600 space-y-2">
            <p className="font-semibold text-stone-800">Petunjuk Pengambilan Foto:</p>
            <ul className="space-y-1.5 text-[11px] list-disc list-inside text-stone-600">
              <li>Posisikan wajah Anda tegak menghadap kamera</li>
              <li>Pastikan pencahayaan cukup dan wajah terlihat jelas</li>
              <li>Lepaskan masker dan kacamata hitam</li>
              <li>Hanya satu orang dalam bingkai kamera</li>
            </ul>
          </div>

          <button
            type="button"
            onClick={startCamera}
            className="w-full py-2.5 px-4 bg-[#2C4A3E] hover:bg-[#233b32] text-white font-medium text-sm rounded-lg shadow-sm transition-all flex items-center justify-center space-x-2"
          >
            <span>Buka Kamera & Mulai</span>
          </button>
        </div>
      )}

      {/* STATE: REQUESTING */}
      {cameraState === 'REQUESTING' && (
        <div className="py-12 text-center space-y-3">
          <div className="w-10 h-10 border-3 border-emerald-700/20 border-t-emerald-700 rounded-full animate-spin mx-auto" />
          <p className="text-xs font-medium text-stone-600">
            Menghubungkan ke kamera perangkat...
          </p>
        </div>
      )}

      {/* STATE: READY (Live Preview) */}
      {cameraState === 'READY' && (
        <div className="space-y-4">
          <div className="relative w-full aspect-square max-w-[280px] mx-auto bg-black rounded-2xl overflow-hidden shadow-inner border-2 border-[#2C4A3E]">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={handleVideoCanPlay}
              onCanPlay={handleVideoCanPlay}
              className="w-full h-full object-cover transform -scale-x-100"
            />
            {/* Face Oval Overlay Guide */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="w-48 h-60 rounded-[50%] border-2 border-dashed border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
            <div className="absolute bottom-2 inset-x-0 text-center">
              <span className="text-[10px] font-medium text-white/90 bg-black/60 px-2.5 py-1 rounded-full backdrop-blur-sm">
                Posisikan wajah di dalam lingkaran
              </span>
            </div>
          </div>

          <div className="flex space-x-2">
            <button
              type="button"
              onClick={cancelCamera}
              className="flex-1 py-2 px-3 border border-stone-300 text-stone-700 hover:bg-stone-50 rounded-lg text-xs font-medium transition-colors"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={!isVideoReady}
              onClick={captureFrame}
              className="flex-2 py-2.5 px-4 bg-[#2C4A3E] hover:bg-[#233b32] text-white font-medium text-sm rounded-lg shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-1.5"
            >
              <span>{isVideoReady ? 'Ambil Foto' : 'Menyiapkan Kamera...'}</span>
            </button>
          </div>
        </div>
      )}

      {/* STATE: CAPTURED (Preview Captured Frame) */}
      {cameraState === 'CAPTURED' && capturedPreviewUrl && (
        <div className="space-y-4">
          <div className="relative w-full aspect-square max-w-[280px] mx-auto rounded-2xl overflow-hidden shadow-md border-2 border-emerald-600">
            <img
              src={capturedPreviewUrl}
              alt="Pratinjau Foto Wajah"
              className="w-full h-full object-cover"
            />
          </div>

          <div className="text-center text-xs text-stone-600">
            Apakah foto wajah Anda sudah jelas dan menghadap lurus?
          </div>

          <div className="flex space-x-2">
            <button
              type="button"
              onClick={retakePhoto}
              className="flex-1 py-2 px-3 border border-stone-300 text-stone-700 hover:bg-stone-50 rounded-lg text-xs font-medium transition-colors"
            >
              Foto Ulang
            </button>
            <button
              type="button"
              onClick={submitPhoto}
              className="flex-2 py-2.5 px-4 bg-[#2C4A3E] hover:bg-[#233b32] text-white font-medium text-sm rounded-lg shadow-sm transition-all flex items-center justify-center space-x-1.5"
            >
              <span>Gunakan & Selesaikan</span>
            </button>
          </div>
        </div>
      )}

      {/* STATE: UPLOADING */}
      {cameraState === 'UPLOADING' && (
        <div className="py-10 text-center space-y-3">
          <div className="w-10 h-10 border-3 border-emerald-700/20 border-t-emerald-700 rounded-full animate-spin mx-auto" />
          <p className="text-xs font-medium text-stone-700">
            Menyimpan master foto wajah dan memverifikasi akun...
          </p>
          <p className="text-[11px] text-stone-400">Mohon jangan menutup halaman ini.</p>
        </div>
      )}

      {/* STATE: SUCCESS */}
      {cameraState === 'SUCCESS' && (
        <div className="py-8 text-center space-y-3">
          <div className="w-14 h-14 mx-auto rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center text-2xl font-bold shadow-sm">
            ✓
          </div>
          <h3 className="text-base font-bold text-stone-900">
            Pendaftaran Berhasil!
          </h3>
          <p className="text-xs text-stone-600 max-w-xs mx-auto">
            Foto wajah Anda telah terdaftar sebagai master foto referensi. Mengalihkan ke sistem...
          </p>
        </div>
      )}

      {/* STATE: ERROR */}
      {cameraState === 'ERROR' && (
        <div className="space-y-4 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center text-2xl font-bold">
            !
          </div>
          <p className="text-xs text-stone-600">
            Tidak dapat melanjutkan tanpa foto wajah. Silakan coba kembali atau periksa izin browser.
          </p>
          <div className="flex space-x-2">
            <button
              type="button"
              onClick={cancelCamera}
              className="flex-1 py-2 px-3 border border-stone-300 text-stone-700 hover:bg-stone-50 rounded-lg text-xs font-medium transition-colors"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={startCamera}
              className="flex-1 py-2 px-3 bg-[#2C4A3E] hover:bg-[#233b32] text-white font-medium text-xs rounded-lg transition-colors"
            >
              Coba Lagi
            </button>
            <button
              type="button"
              onClick={logout}
              className="py-2 px-3 border border-rose-200 text-rose-700 hover:bg-rose-50 rounded-lg text-xs font-medium transition-colors"
            >
              Keluar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};