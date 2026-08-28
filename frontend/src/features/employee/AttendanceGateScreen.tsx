import React, { useState, useEffect, useRef } from 'react';
import type { EmployeeAttendanceStatus } from './attendanceTypes';

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
const Clock = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const CheckCircle = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const AlertTriangle = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);
const ShieldCheck = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
  </svg>
);
const RefreshCw = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);
const UserCheck = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </svg>
);

interface AttendanceGateScreenProps {
  propertyId: number;
  employeeId?: number | null;
  employeeName: string;
  employeeDepartment?: string;
  employeeRole?: string;
  onAttendanceSuccess: () => void;
  onBypassForTesting?: () => void;
}

export const AttendanceGateScreen: React.FC<AttendanceGateScreenProps> = ({
  propertyId,
  employeeId,
  employeeName,
  employeeDepartment = 'Housekeeping',
  employeeRole = 'Staff',
  onAttendanceSuccess,
  onBypassForTesting
}) => {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [statusData, setStatusData] = useState<EmployeeAttendanceStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successRecorded, setSuccessRecorded] = useState(false);

  // Live Server / WIB Time simulation
  const [currentTimeWib, setCurrentTimeWib] = useState<string>('');

  // Location state
  const [locationState, setLocationState] = useState<{
    lat: number | null;
    lng: number | null;
    accuracy: number | null;
    loading: boolean;
    error: string | null;
  }>({
    lat: null,
    lng: null,
    accuracy: null,
    loading: true,
    error: null
  });

  // Photo state
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [usingWebcam, setUsingWebcam] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Form reason
  const [outsideReason, setOutsideReason] = useState('');

  // Live WIB clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const formatted = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta',
        weekday: 'long',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(now);
      setCurrentTimeWib(formatted + ' WIB');
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch Attendance Status
  const fetchStatus = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const url = `/api/attendance/status?property_id=${propertyId}${employeeId ? `&employee_id=${employeeId}` : ''}&role=${encodeURIComponent(employeeRole)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        setStatusData(data.data);
        if (data.data.has_checked_in) {
          setSuccessRecorded(true);
        }
      } else {
        setErrorMsg(data.message || 'Gagal memuat status absensi.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Koneksi ke server gagal.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, [propertyId, employeeId, employeeRole]);

  // Fetch Geolocation
  const requestLocation = () => {
    setLocationState(prev => ({ ...prev, loading: true, error: null }));
    if (!navigator.geolocation) {
      setLocationState({
        lat: null,
        lng: null,
        accuracy: null,
        loading: false,
        error: 'Geolocation tidak didukung oleh browser ini.'
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationState({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          loading: false,
          error: null
        });
      },
      (err) => {
        console.warn('Geolocation error:', err);
        setLocationState({
          lat: null,
          lng: null,
          accuracy: null,
          loading: false,
          error: 'Izin GPS ditolak atau sinyal lemah.'
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  };

  useEffect(() => {
    requestLocation();
  }, []);

  // Camera stream handling
  const startCamera = async () => {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
        setUsingWebcam(true);
      } else {
        fileInputRef.current?.click();
      }
    } catch (err) {
      console.warn('Camera access error, fallback to file input:', err);
      fileInputRef.current?.click();
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setUsingWebcam(false);
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth || 640;
      canvas.height = videoRef.current.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) {
            setPhotoBlob(blob);
            setPhotoPreviewUrl(URL.createObjectURL(blob));
            stopCamera();
          }
        }, 'image/jpeg', 0.85);
      }
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPhotoBlob(file);
      setPhotoPreviewUrl(URL.createObjectURL(file));
      stopCamera();
    }
  };

  const handleRetake = () => {
    setPhotoBlob(null);
    setPhotoPreviewUrl(null);
    startCamera();
  };

  // Submit Check-In
  const handleCheckIn = async () => {
    try {
      setSubmitting(true);
      setErrorMsg(null);

      const settings = statusData?.settings;
      if (settings?.require_checkin_photo && !photoBlob) {
        setErrorMsg('Foto selfie wajah wajib diambil sebelum melakukan absensi masuk.');
        setSubmitting(false);
        return;
      }

      const formData = new FormData();
      formData.append('property_id', String(propertyId));
      if (employeeId) formData.append('employee_id', String(employeeId));
      formData.append('employee_name', employeeName);
      formData.append('department', employeeDepartment);
      formData.append('attendance_type', 'CHECK_IN');

      if (locationState.lat !== null && locationState.lng !== null) {
        formData.append('latitude', String(locationState.lat));
        formData.append('longitude', String(locationState.lng));
      }
      if (locationState.accuracy !== null) {
        formData.append('location_accuracy_meters', String(locationState.accuracy));
      }
      if (outsideReason.trim()) {
        formData.append('reason', outsideReason.trim());
      }
      if (photoBlob) {
        formData.append('photo', photoBlob, 'selfie_attendance.jpg');
      }

      const res = await fetch('/api/attendance/check-in', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        setSuccessRecorded(true);
        setTimeout(() => {
          onAttendanceSuccess();
        }, 1200);
      } else {
        setErrorMsg(data.message || 'Gagal mengirim absensi.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan jaringan.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1b4332] text-[#fcfbf7] flex flex-col items-center justify-center p-6">
        <RefreshCw className="w-10 h-10 animate-spin text-[#d4af37] mb-4" />
        <p className="font-serif text-lg tracking-wide">Memverifikasi Gerbang Absensi...</p>
      </div>
    );
  }

  // Already checked in or success
  if (successRecorded) {
    return (
      <div className="min-h-screen bg-[#1b4332] text-[#fcfbf7] flex flex-col items-center justify-center p-6 text-center">
        <div className="w-20 h-20 rounded-full bg-emerald-500/20 border-2 border-emerald-400 flex items-center justify-center mb-6 animate-bounce">
          <CheckCircle className="w-12 h-12 text-emerald-400" />
        </div>
        <h2 className="text-2xl font-serif font-bold text-[#d4af37] mb-2">Absensi Masuk Diterima</h2>
        <p className="text-[#fcfbf7]/90 text-sm max-w-sm mb-6">
          Selamat bertugas, <span className="font-semibold text-white">{employeeName}</span>!<br />
          Departemen: <span className="text-[#d4af37]">{employeeDepartment}</span>
        </p>
        <button
          onClick={onAttendanceSuccess}
          className="w-full max-w-xs py-3.5 px-6 rounded-xl font-bold bg-[#d4af37] text-[#1b4332] hover:bg-[#c49f2f] shadow-lg transition-all active:scale-95"
        >
          Masuk ke Dashboard Tugas
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#112d22] text-[#fcfbf7] flex flex-col justify-between p-4 sm:p-6 max-w-lg mx-auto">
      {/* Header */}
      <div className="text-center pt-2 pb-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#1b4332] border border-[#d4af37]/30 text-xs text-[#d4af37] mb-3">
          <ShieldCheck className="w-4 h-4" />
          <span>OAK HIMS Employee Mobile Portal</span>
        </div>
        <h1 className="text-2xl font-serif font-bold tracking-tight text-white mb-1">Gerbang Absensi Masuk</h1>
        <p className="text-xs text-[#fcfbf7]/70">Verifikasi kehadiran resmi sebelum memulai operasional harian</p>
      </div>

      {/* Main Card */}
      <div className="bg-[#1b4332] border border-white/10 rounded-2xl p-5 shadow-2xl space-y-4">
        {/* Employee Info & Clock */}
        <div className="flex items-center justify-between pb-3 border-b border-white/10 text-xs">
          <div>
            <p className="text-white font-semibold text-sm">{employeeName}</p>
            <p className="text-[#d4af37]">{employeeDepartment} &bull; {employeeRole}</p>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-1.5 text-emerald-400 font-mono text-xs justify-end">
              <Clock className="w-3.5 h-3.5" />
              <span>{currentTimeWib || 'WIB'}</span>
            </div>
            <p className="text-[10px] text-white/50">Waktu Resmi Server Hotel</p>
          </div>
        </div>

        {/* Location Status */}
        <div className="bg-[#112d22]/60 rounded-xl p-3 border border-white/5 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 text-white/90">
              <MapPin className="w-4 h-4 text-[#d4af37]" />
              <span>Status Lokasi GPS</span>
            </div>
            <button
              type="button"
              onClick={requestLocation}
              className="text-[11px] text-[#d4af37] hover:underline flex items-center gap-1"
            >
              <RefreshCw className={`w-3 h-3 ${locationState.loading ? 'animate-spin' : ''}`} />
              Perbarui
            </button>
          </div>
          {locationState.loading ? (
            <p className="text-[11px] text-white/60">Mencari koordinat lokasi saat ini...</p>
          ) : locationState.error ? (
            <p className="text-[11px] text-amber-300 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {locationState.error}
            </p>
          ) : (
            <div className="flex items-center justify-between text-[11px] text-emerald-300">
              <span>Akurasi GPS: ~{locationState.accuracy} meter</span>
              <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-medium">GPS Terkunci</span>
            </div>
          )}
        </div>

        {/* Camera / Selfie Section */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-white/90">
            Foto Selfie Wajah {statusData?.settings.require_checkin_photo ? '(Wajib)' : '(Opsional)'}
          </label>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            onChange={handleFileInputChange}
          />

          <div className="relative aspect-4/3 w-full rounded-xl overflow-hidden bg-black/40 border border-white/10 flex flex-col items-center justify-center">
            {photoPreviewUrl ? (
              <>
                <img src={photoPreviewUrl} alt="Selfie preview" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={handleRetake}
                  className="absolute bottom-3 right-3 py-1.5 px-3 rounded-lg text-xs font-semibold bg-black/70 hover:bg-black text-white backdrop-blur-sm shadow"
                >
                  Foto Ulang
                </button>
              </>
            ) : usingWebcam ? (
              <>
                <video ref={videoRef} playsInline autoPlay muted className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={capturePhoto}
                  className="absolute bottom-3 py-2 px-6 rounded-full font-bold bg-[#d4af37] text-[#1b4332] shadow-xl hover:bg-white active:scale-95 transition"
                >
                  Ambil Foto
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center p-6 text-center space-y-3">
                <div className="w-14 h-14 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-[#d4af37]">
                  <Camera className="w-7 h-7" />
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-white/80">Nyalakan kamera untuk mengambil foto kehadiran</p>
                  <p className="text-[10px] text-white/50">Pastikan wajah terlihat jelas di tempat terang</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={startCamera}
                    className="py-2 px-4 rounded-xl text-xs font-semibold bg-[#d4af37] text-[#1b4332] hover:bg-[#c49f2f] shadow transition"
                  >
                    Buka Kamera
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="py-2 px-4 rounded-xl text-xs font-semibold bg-white/10 text-white hover:bg-white/20 transition"
                  >
                    Pilih File
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Reason field if geofence policy allows outside with reason */}
        <div className="space-y-1">
          <label className="block text-xs text-white/70">Catatan / Alasan (Opsional):</label>
          <input
            type="text"
            value={outsideReason}
            onChange={(e) => setOutsideReason(e.target.value)}
            placeholder="Contoh: Tugas luar kota / Sinyal GPS redup"
            className="w-full py-2 px-3 rounded-xl bg-[#112d22] border border-white/10 text-white text-xs placeholder:text-white/30 focus:outline-none focus:border-[#d4af37]"
          />
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-3 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="py-4 space-y-2">
        <button
          type="button"
          onClick={handleCheckIn}
          disabled={submitting || (statusData?.settings.require_checkin_photo && !photoBlob)}
          className={`w-full py-3.5 px-6 rounded-xl font-serif font-bold text-sm tracking-wide shadow-xl transition-all flex items-center justify-center gap-2 ${
            submitting || (statusData?.settings.require_checkin_photo && !photoBlob)
              ? 'bg-white/20 text-white/50 cursor-not-allowed'
              : 'bg-[#d4af37] text-[#1b4332] hover:bg-[#c49f2f] active:scale-[0.98]'
          }`}
        >
          {submitting ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>Memproses Absensi...</span>
            </>
          ) : (
            <>
              <UserCheck className="w-5 h-5" />
              <span>KIRIM ABSENSI MASUK</span>
            </>
          )}
        </button>

        {onBypassForTesting && (
          <button
            type="button"
            onClick={onBypassForTesting}
            className="w-full py-2 text-[11px] text-white/40 hover:text-white/70 transition"
          >
            Mode Pengujian Cepat &rarr; Lewati Gerbang
          </button>
        )}
      </div>
    </div>
  );
};
