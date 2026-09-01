import React, { useState, useRef } from 'react';

export interface ExtractedIdentityData {
  full_name: string;
  identity_number: string;
  birth_place?: string;
  birth_date?: string;
  gender?: 'MALE' | 'FEMALE' | '';
  address?: string;
  rt_rw?: string;
  village_kelurahan?: string;
  district_kecamatan?: string;
  religion?: string;
  marital_status?: string;
  occupation?: string;
  citizenship?: string;
  valid_until?: string;
  confidence: number;
  recognized_fields_count?: number;
  total_fields_count?: number;
  provider: string;
  file_path: string;
  raw_lines?: string[];
}

export interface DuplicateCandidateInfo {
  guest_id: number;
  guest_code: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  match_reason: string;
}

export interface NameMismatchInfo {
  is_mismatch: boolean;
  entered_name: string;
  extracted_name: string;
  similarity?: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  guestName: string;
  guestPhone?: string;
  guestId?: number | null;
  propertyId?: number;
  onIdentityConfirmed: (data: ExtractedIdentityData, savedGuest?: any) => void;
  onSelectExistingGuest?: (candidate: DuplicateCandidateInfo) => void;
}

export default function IdentityExtractionModal({
  isOpen,
  onClose,
  guestName,
  guestPhone,
  guestId,
  propertyId = 1,
  onIdentityConfirmed,
  onSelectExistingGuest
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [extractedData, setExtractedData] = useState<ExtractedIdentityData | null>(null);
  const [duplicateCandidate, setDuplicateCandidate] = useState<DuplicateCandidateInfo | null>(null);
  const [nameMismatch, setNameMismatch] = useState<NameMismatchInfo | null>(null);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showRawDebug, setShowRawDebug] = useState(false);

  // Camera state
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  // Editable Form state (Initialized strictly empty without fake defaults)
  const [formName, setFormName] = useState('');
  const [formNik, setFormNik] = useState('');
  const [formBirthPlace, setFormBirthPlace] = useState('');
  const [formBirthDate, setFormBirthDate] = useState('');
  const [formGender, setFormGender] = useState<'MALE' | 'FEMALE' | ''>('');
  const [formAddress, setFormAddress] = useState('');
  const [formRtRw, setFormRtRw] = useState('');
  const [formKelurahan, setFormKelurahan] = useState('');
  const [formKecamatan, setFormKecamatan] = useState('');
  const [formAgama, setFormAgama] = useState('');
  const [formStatus, setFormStatus] = useState('');
  const [formPekerjaan, setFormPekerjaan] = useState('');
  const [formCitizenship, setFormCitizenship] = useState('');
  const [formValidUntil, setFormValidUntil] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Stop camera stream helper
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  };

  const startCamera = async (mode: 'environment' | 'user' = facingMode) => {
    try {
      setErrorMsg(null);
      stopCamera();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Kamera tidak didukung oleh browser ini.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      streamRef.current = stream;
      setIsCameraActive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err: any) {
      console.warn('Gagal membuka webcam:', err.message);
      setErrorMsg(err.message || 'Tidak dapat mengakses kamera.');
      // Fallback to native mobile file input capture
      cameraInputRef.current?.click();
    }
  };

  const captureCameraPhoto = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (blob) {
        const capturedFile = new File([blob], `scan-ktp-${Date.now()}.jpg`, { type: 'image/jpeg' });
        setFile(capturedFile);
        setPreviewUrl(URL.createObjectURL(blob));
        stopCamera();
        // Immediately start extraction
        processFileExtraction(capturedFile);
      }
    }, 'image/jpeg', 0.95);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setFile(selected);
      setPreviewUrl(URL.createObjectURL(selected));
      setErrorMsg(null);
      setInfoBanner(null);
      setExtractedData(null);
      setDuplicateCandidate(null);
      setNameMismatch(null);
      stopCamera();
      // Auto start extraction
      processFileExtraction(selected);
    }
  };

  // Manual 90-degree clockwise image rotation on canvas
  const handleRotateImage = () => {
    if (!previewUrl || !file) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.height;
      canvas.height = img.width;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((90 * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      canvas.toBlob(
        (blob) => {
          if (blob) {
            const rotatedFile = new File([blob], file.name, { type: file.type || 'image/jpeg' });
            setFile(rotatedFile);
            setPreviewUrl(URL.createObjectURL(blob));
          }
        },
        file.type || 'image/jpeg',
        0.95
      );
    };
    img.src = previewUrl;
  };

  const processFileExtraction = async (targetFile: File) => {
    try {
      setExtracting(true);
      setErrorMsg(null);
      setInfoBanner(null);
      setDuplicateCandidate(null);
      setNameMismatch(null);

      const formData = new FormData();
      formData.append('image', targetFile);
      formData.append('ktp', targetFile);
      if (guestName) formData.append('guest_name', guestName);
      if (guestId) formData.append('guest_id', String(guestId));
      if (propertyId) formData.append('property_id', String(propertyId));

      let res = await fetch('/api/ocr/scan-id', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        // Fallback to /api/identity/extract-ktp
        res = await fetch('/api/identity/extract-ktp', {
          method: 'POST',
          body: formData
        });
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        throw new Error(`Server mengembalikan respon tidak valid (${res.status}): ${text.slice(0, 100)}`);
      }

      const json = await res.json();

      if (!res.ok && !json.success) {
        throw new Error(json.message || 'Gagal mengekstrak identitas dari file.');
      }

      const cand = json.data || json.candidate || {};
      const status = json.status || 'REVIEW_REQUIRED';
      const provider = json.provider || 'GOOGLE_VISION';
      const filePath = json.file_path || '';
      const rawLines = json.raw_lines || [];

      // Calculate recognized fields
      const recognizedCount = cand.recognized_fields_count ?? 
        [cand.full_name || cand.nama, cand.identity_number || cand.nik, cand.birth_place || cand.tempat_lahir, cand.birth_date || cand.tanggal_lahir, cand.gender || cand.jenis_kelamin, cand.address || cand.alamat, cand.rt_rw, cand.village_kelurahan || cand.kelurahan, cand.district_kecamatan || cand.kecamatan, cand.religion || cand.agama, cand.marital_status || cand.status_perkawinan, cand.occupation || cand.pekerjaan, cand.citizenship || cand.kewarganegaraan].filter(Boolean).length;

      const rawGender = cand.gender || cand.jenis_kelamin;
      const parsedGender = (rawGender === 'FEMALE' || rawGender === 'PEREMPUAN') ? 'FEMALE' : ((rawGender === 'MALE' || rawGender === 'LAKI-LAKI') ? 'MALE' : '');

      const data: ExtractedIdentityData = {
        full_name: cand.full_name || cand.nama || '',
        identity_number: cand.identity_number || cand.nik || '',
        birth_place: cand.birth_place || cand.tempat_lahir || '',
        birth_date: cand.birth_date || cand.tanggal_lahir || '',
        gender: parsedGender,
        address: cand.address || cand.alamat || '',
        rt_rw: cand.rt_rw || '',
        village_kelurahan: cand.village_kelurahan || cand.kelurahan || '',
        district_kecamatan: cand.district_kecamatan || cand.kecamatan || '',
        religion: cand.religion || cand.agama || '',
        marital_status: cand.marital_status || cand.status_perkawinan || '',
        occupation: cand.occupation || cand.pekerjaan || '',
        citizenship: cand.citizenship || cand.kewarganegaraan || '',
        valid_until: cand.valid_until || cand.berlaku_hingga || '',
        confidence: cand.confidence ?? (recognizedCount > 0 ? 0.98 : 0.0),
        recognized_fields_count: recognizedCount,
        total_fields_count: cand.total_fields_count || 13,
        provider,
        file_path: filePath,
        raw_lines: rawLines
      };

      setExtractedData(data);

      // Auto-fill form state
      setFormName(data.full_name);
      setFormNik(data.identity_number);
      setFormBirthPlace(data.birth_place || '');
      setFormBirthDate(data.birth_date || '');
      setFormGender(data.gender || '');
      setFormAddress(data.address || '');
      setFormRtRw(data.rt_rw || '');
      setFormKelurahan(data.village_kelurahan || '');
      setFormKecamatan(data.district_kecamatan || '');
      setFormAgama(data.religion || '');
      setFormStatus(data.marital_status || '');
      setFormPekerjaan(data.occupation || '');
      setFormCitizenship(data.citizenship || '');
      setFormValidUntil(data.valid_until || '');

      // Check warnings & status
      if (json.duplicate_candidate) {
        setDuplicateCandidate(json.duplicate_candidate);
      }
      if (json.name_mismatch) {
        setNameMismatch(json.name_mismatch);
      }
      if (status === 'MANUAL_REVIEW_REQUIRED' || recognizedCount === 0) {
        setInfoBanner(json.message || 'Beberapa field tidak dapat dikenali secara otomatis. Harap periksa dan lengkapi form berikut.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan saat memindai KTP.');
    } finally {
      setExtracting(false);
    }
  };

  const handleStartExtraction = () => {
    if (!file) {
      setErrorMsg('Silakan pilih file KTP terlebih dahulu.');
      return;
    }
    processFileExtraction(file);
  };

  const handleConfirm = async () => {
    if (!formNik.trim()) {
      setErrorMsg('Nomor NIK / Identitas wajib diisi.');
      return;
    }
    if (!formName.trim()) {
      setErrorMsg('Nama lengkap KTP wajib diisi.');
      return;
    }

    try {
      setSaving(true);
      setErrorMsg(null);

      const finalData: ExtractedIdentityData = {
        full_name: formName.trim().toUpperCase(),
        identity_number: formNik.trim(),
        birth_place: formBirthPlace.trim() || undefined,
        birth_date: formBirthDate.trim() || undefined,
        gender: formGender || undefined,
        address: formAddress.trim() || undefined,
        rt_rw: formRtRw.trim() || undefined,
        village_kelurahan: formKelurahan.trim() || undefined,
        district_kecamatan: formKecamatan.trim() || undefined,
        religion: formAgama.trim() || undefined,
        marital_status: formStatus.trim() || undefined,
        occupation: formPekerjaan.trim() || undefined,
        citizenship: formCitizenship.trim() || undefined,
        valid_until: formValidUntil.trim() || undefined,
        confidence: extractedData?.confidence || 1.0,
        recognized_fields_count: extractedData?.recognized_fields_count,
        total_fields_count: 13,
        provider: extractedData?.provider || 'LOCAL_PADDLE_OCR',
        file_path: extractedData?.file_path || ''
      };

      // Persist directly to canonical CRM guests table
      const confirmPayload = {
        guest_id: guestId || null,
        property_id: propertyId || 1,
        name: finalData.full_name,
        nik: finalData.identity_number,
        phone: guestPhone || undefined,
        birth_place: finalData.birth_place || null,
        birth_date: finalData.birth_date || null,
        gender: finalData.gender || null,
        address: finalData.address || null,
        rt_rw: finalData.rt_rw || null,
        village_kelurahan: finalData.village_kelurahan || null,
        district_kecamatan: finalData.district_kecamatan || null,
        religion: finalData.religion || null,
        marital_status: finalData.marital_status || null,
        occupation: finalData.occupation || null,
        citizenship: finalData.citizenship || null,
        valid_until: finalData.valid_until || null,
        identity_path: finalData.file_path || null,
        identity_type: 'KTP',
        confidence: finalData.confidence,
        ocr_provider: finalData.provider
      };

      const res = await fetch('/api/identity/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmPayload)
      });

      const resJson = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(resJson.message || 'Gagal menyimpan data identitas ke database CRM');
      }

      const savedGuest = resJson.data || null;

      onIdentityConfirmed(finalData, savedGuest);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menyimpan identitas ke database CRM.');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-emerald-900/10 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-950 text-white flex items-center justify-between border-b border-emerald-800/40">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-800/60 rounded-xl border border-emerald-700/50 shadow-inner">
              <svg className="w-5 h-5 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold tracking-tight text-white">Unggah & Ekstraksi KTP Tamu</h2>
              <p className="text-xs text-emerald-300/80">Verifikasi identitas resmi tamu menginap (CRM Master)</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-emerald-300 hover:text-white p-2 rounded-lg hover:bg-emerald-800/40 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1 bg-stone-50/50">
          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5">
              <svg className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{errorMsg}</span>
            </div>
          )}

          {infoBanner && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-2.5">
              <svg className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{infoBanner}</span>
            </div>
          )}

          {/* Upload & Camera Area */}
          <div className="space-y-4">
            {/* Hidden native mobile camera input */}
            <input
              type="file"
              ref={cameraInputRef}
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              className="hidden"
            />
            {/* Hidden file input */}
            <input
              type="file"
              ref={fileInputRef}
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={handleFileChange}
              className="hidden"
            />

            {/* Live Camera Viewfinder Modal / Panel */}
            {isCameraActive && (
              <div className="relative rounded-2xl overflow-hidden bg-black border-2 border-emerald-500 shadow-xl flex flex-col items-center justify-center p-2">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full max-h-72 object-cover rounded-xl"
                />
                {/* Guide overlay */}
                <div className="absolute inset-6 border-2 border-dashed border-white/70 rounded-xl pointer-events-none flex flex-col justify-between p-3">
                  <div className="text-[11px] font-semibold text-white bg-black/60 px-2 py-0.5 rounded backdrop-blur-xs self-start">
                    Posisikan KTP / Paspor di dalam bingkai
                  </div>
                  <div className="text-[10px] text-white/80 bg-black/50 px-2 py-0.5 rounded self-center">
                    Pastikan pencahayaan cukup & teks terbaca
                  </div>
                </div>

                <div className="flex items-center gap-3 mt-3 mb-1 w-full justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      const nextMode = facingMode === 'environment' ? 'user' : 'environment';
                      setFacingMode(nextMode);
                      startCamera(nextMode);
                    }}
                    className="px-3 py-1.5 bg-stone-800/80 hover:bg-stone-700 text-white rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Ganti Kamera
                  </button>

                  <button
                    type="button"
                    onClick={captureCameraPhoto}
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold flex items-center gap-2 shadow-lg transition-transform active:scale-95"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Ambil Foto & Pindai
                  </button>

                  <button
                    type="button"
                    onClick={stopCamera}
                    className="px-3 py-1.5 bg-stone-700/80 hover:bg-stone-600 text-white rounded-xl text-xs font-medium transition-colors"
                  >
                    Tutup Kamera
                  </button>
                </div>
              </div>
            )}

            {!extractedData && !isCameraActive && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Option 1: Live Camera Capture */}
                <button
                  type="button"
                  onClick={() => startCamera('environment')}
                  className="border-2 border-dashed border-emerald-800/40 hover:border-emerald-700 bg-white hover:bg-emerald-50/40 rounded-2xl p-5 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-2 group shadow-2xs"
                >
                  <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-800 group-hover:scale-110 flex items-center justify-center transition-transform shadow-xs">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-stone-800 group-hover:text-emerald-900">
                      Gunakan Kamera / Webcam
                    </p>
                    <p className="text-[11px] text-stone-500">Ambil foto KTP / Paspor langsung secara live</p>
                  </div>
                </button>

                {/* Option 2: Upload Image File */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-stone-300 hover:border-emerald-700 bg-white hover:bg-stone-50 rounded-2xl p-5 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-2 group shadow-2xs"
                >
                  <div className="w-12 h-12 rounded-full bg-stone-100 text-stone-700 group-hover:bg-emerald-100 group-hover:text-emerald-800 group-hover:scale-110 flex items-center justify-center transition-transform shadow-xs">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-stone-800 group-hover:text-emerald-900">
                      Pilih File dari Perangkat
                    </p>
                    <p className="text-[11px] text-stone-500">Mendukung file JPG, PNG, atau WebP</p>
                  </div>
                </button>
              </div>
            )}

            {/* Scanning Laser / Animation State */}
            {extracting && (
              <div className="relative p-6 bg-gradient-to-br from-emerald-950 via-stone-900 to-teal-950 text-white rounded-2xl border border-emerald-500/40 shadow-xl overflow-hidden flex flex-col items-center justify-center text-center space-y-4">
                {/* Animated laser line */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-30">
                  <div className="w-full h-1 bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-bounce" style={{ animationDuration: '1.5s' }} />
                </div>

                <div className="relative">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-800/60 border border-emerald-400/50 flex items-center justify-center shadow-lg animate-pulse">
                    <svg className="w-8 h-8 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                    </svg>
                  </div>
                  <div className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-400 rounded-full animate-ping" />
                </div>

                <div>
                  <h3 className="text-sm font-bold text-emerald-200 tracking-wide">Memindai ID...</h3>
                  <p className="text-xs text-stone-300 mt-1">
                    Google Cloud Vision API sedang mengekstrak NIK, Nama, Tanggal Lahir, dan Alamat...
                  </p>
                </div>

                <div className="flex items-center gap-2 text-[11px] font-mono text-emerald-400/90 bg-emerald-950/80 px-3 py-1 rounded-full border border-emerald-700/50">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  Membaca teks dokumen & memvalidasi NIK...
                </div>
              </div>
            )}

            {previewUrl && !extracting && (
              <div className="p-3.5 bg-white rounded-xl border border-stone-200 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <div className="relative group w-14 h-10 bg-stone-100 rounded-lg overflow-hidden border border-stone-300 shrink-0 flex items-center justify-center">
                    <img src={previewUrl} alt="Preview KTP" className="w-full h-full object-cover" />
                  </div>
                  <div className="truncate">
                    <span className="text-xs font-semibold text-stone-700 block truncate">{file?.name}</span>
                    <span className="text-[11px] text-stone-400 font-mono">
                      {file ? `${(file.size / 1024).toFixed(0)} KB` : ''}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                  <button
                    type="button"
                    onClick={handleRotateImage}
                    title="Putar Foto 90 Derajat Searah Jarum Jam"
                    className="px-2.5 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg text-xs font-medium border border-stone-300 flex items-center gap-1 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Putar 90°
                  </button>

                  {!extractedData && (
                    <button
                      type="button"
                      onClick={handleStartExtraction}
                      disabled={extracting}
                      className="px-4 py-1.5 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors flex items-center gap-2"
                    >
                      Memindai ID...
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Extracted Review Form */}
          {extractedData && (
            <div className="space-y-4">
              <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between">
                <span className="font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse"></span>
                  Hasil Pembacaan Dokumen ({extractedData.provider})
                  <span className="text-[11px] font-normal text-emerald-700 bg-emerald-100/70 px-2 py-0.5 rounded-full ml-1">
                    Akurasi: {Math.round((extractedData.confidence || 0) * 100)}% • {extractedData.recognized_fields_count || 0}/{extractedData.total_fields_count || 13} data terisi
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setExtractedData(null);
                    setDuplicateCandidate(null);
                    setNameMismatch(null);
                  }}
                  className="text-stone-500 hover:text-stone-800 text-xs underline font-medium"
                >
                  Ganti Foto / Ulangi
                </button>
              </div>

              {/* Duplicate NIK Warning Card */}
              {duplicateCandidate && (
                <div className="p-4 bg-amber-50/90 rounded-xl border border-amber-300 text-amber-900 text-xs space-y-3 shadow-xs">
                  <div className="flex items-start gap-2.5">
                    <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <div>
                      <p className="font-bold text-amber-950">Identitas NIK ini sudah terdaftar pada Tamu CRM lain:</p>
                      <div className="mt-1 font-mono text-[11px] bg-white/70 p-2 rounded-lg border border-amber-200">
                        <p className="font-bold text-stone-800">{duplicateCandidate.full_name} ({duplicateCandidate.guest_code || 'GST-Tamu'})</p>
                        {duplicateCandidate.phone && <p className="text-stone-600">No. HP: {duplicateCandidate.phone}</p>}
                        {duplicateCandidate.email && <p className="text-stone-600">Email: {duplicateCandidate.email}</p>}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    {onSelectExistingGuest && (
                      <button
                        type="button"
                        onClick={() => {
                          onSelectExistingGuest(duplicateCandidate);
                          onClose();
                        }}
                        className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg shadow-xs text-xs transition-colors"
                      >
                        Gunakan Tamu Terdaftar Ini
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setDuplicateCandidate(null)}
                      className="px-3 py-1.5 bg-amber-200 hover:bg-amber-300 text-amber-900 font-semibold rounded-lg text-xs transition-colors"
                    >
                      Tetap Lanjutkan Review
                    </button>
                  </div>
                </div>
              )}

              {/* Name Difference Warning Card */}
              {nameMismatch && (
                <div className="p-3.5 bg-sky-50 rounded-xl border border-sky-200 text-sky-950 text-xs space-y-2">
                  <div className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="font-semibold">Nama di Form berbeda dengan Dokumen KTP:</p>
                      <p className="mt-0.5">Form: <strong>{nameMismatch.entered_name}</strong> ↔ KTP: <strong>{nameMismatch.extracted_name}</strong></p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setFormName(nameMismatch.extracted_name)}
                      className="px-2.5 py-1 bg-sky-600 hover:bg-sky-700 text-white rounded font-semibold text-[11px] transition-colors shadow-2xs"
                    >
                      Gunakan Nama KTP ({nameMismatch.extracted_name})
                    </button>
                    <button
                      type="button"
                      onClick={() => setNameMismatch(null)}
                      className="px-2.5 py-1 bg-sky-100 hover:bg-sky-200 text-sky-900 rounded font-semibold text-[11px] transition-colors"
                    >
                      Pertahankan & Review
                    </button>
                  </div>
                </div>
              )}

              {/* Form Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 bg-white p-4 rounded-xl border border-stone-200">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Nama Lengkap (Sesuai KTP) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Contoh: BUDI SANTOSO"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    NIK / No. Identitas (16 Digit) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={20}
                    value={formNik}
                    onChange={(e) => setFormNik(e.target.value)}
                    placeholder="Contoh: 3174..."
                    className="w-full text-xs px-3 py-2 font-mono bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Jenis Kelamin
                  </label>
                  <select
                    value={formGender}
                    onChange={(e) => setFormGender(e.target.value as 'MALE' | 'FEMALE' | '')}
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  >
                    <option value="">-- Pilih Jenis Kelamin --</option>
                    <option value="MALE">Laki-laki</option>
                    <option value="FEMALE">Perempuan</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Tempat Lahir
                  </label>
                  <input
                    type="text"
                    value={formBirthPlace}
                    onChange={(e) => setFormBirthPlace(e.target.value)}
                    placeholder="Contoh: JAKARTA"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Tanggal Lahir
                  </label>
                  <input
                    type="date"
                    value={formBirthDate}
                    onChange={(e) => setFormBirthDate(e.target.value)}
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Alamat KTP (Disimpan di CRM)
                  </label>
                  <input
                    type="text"
                    value={formAddress}
                    onChange={(e) => setFormAddress(e.target.value)}
                    placeholder="Contoh: JL SUDIRMAN NO. 45"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    RT / RW
                  </label>
                  <input
                    type="text"
                    value={formRtRw}
                    onChange={(e) => setFormRtRw(e.target.value)}
                    placeholder="Contoh: 005/002"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Kelurahan / Desa
                  </label>
                  <input
                    type="text"
                    value={formKelurahan}
                    onChange={(e) => setFormKelurahan(e.target.value)}
                    placeholder="Contoh: SENAYAN"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Kecamatan
                  </label>
                  <input
                    type="text"
                    value={formKecamatan}
                    onChange={(e) => setFormKecamatan(e.target.value)}
                    placeholder="Contoh: KEBAYORAN BARU"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Agama
                  </label>
                  <input
                    type="text"
                    value={formAgama}
                    onChange={(e) => setFormAgama(e.target.value)}
                    placeholder="Contoh: ISLAM"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Status Perkawinan
                  </label>
                  <input
                    type="text"
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value)}
                    placeholder="Contoh: KAWIN / BELUM KAWIN"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Pekerjaan
                  </label>
                  <input
                    type="text"
                    value={formPekerjaan}
                    onChange={(e) => setFormPekerjaan(e.target.value)}
                    placeholder="Contoh: KARYAWAN SWASTA"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Kewarganegaraan
                  </label>
                  <input
                    type="text"
                    value={formCitizenship}
                    onChange={(e) => setFormCitizenship(e.target.value)}
                    placeholder="Contoh: WNI"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Masa Berlaku
                  </label>
                  <input
                    type="text"
                    value={formValidUntil}
                    onChange={(e) => setFormValidUntil(e.target.value)}
                    placeholder="Contoh: SEUMUR HIDUP"
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>
              </div>

              {/* Collapsible Raw OCR Diagnostics (Dev / Staff Inspector) */}
              {extractedData.raw_lines && extractedData.raw_lines.length > 0 && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setShowRawDebug(!showRawDebug)}
                    className="text-[11px] text-stone-500 hover:text-stone-800 flex items-center gap-1 font-medium"
                  >
                    <svg
                      className={`w-3.5 h-3.5 transition-transform ${showRawDebug ? 'rotate-90' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    {showRawDebug ? 'Sembunyikan' : 'Lihat'} Teks Mentah OCR ({extractedData.raw_lines.length} baris)
                  </button>

                  {showRawDebug && (
                    <div className="mt-2 p-3 bg-stone-900 text-stone-100 rounded-lg text-[11px] font-mono overflow-x-auto max-h-48 space-y-0.5">
                      {extractedData.raw_lines.map((line, idx) => (
                        <div key={idx} className="flex gap-2">
                          <span className="text-stone-500 select-none">{String(idx + 1).padStart(2, '0')}:</span>
                          <span>{line}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-stone-100 border-t border-stone-200 flex justify-between items-center">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-stone-600 hover:text-stone-800 transition-colors"
          >
            Batal
          </button>
          {extractedData && (
            <button
              type="button"
              disabled={saving}
              onClick={handleConfirm}
              className="px-5 py-2 text-xs font-semibold text-white bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-sm transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              {saving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Menyimpan ke CRM...</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>Konfirmasi & Simpan</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
