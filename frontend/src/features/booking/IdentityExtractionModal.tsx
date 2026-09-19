import React, { useState, useRef, useEffect, useCallback } from 'react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { useSecureDocumentBlob } from '../common/useSecureDocumentBlob';

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
  document_upload_id?: string | null;
  ktp_regency_id?: number | null;
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

export type IdentityModalMode = 'UPLOAD' | 'DETAIL';

/**
 * Normalizes an arbitrary date string into YYYY-MM-DD for <input type="date">.
 * Handles: YYYY-MM-DD, DD/MM/YYYY, ISO datetime (YYYY-MM-DDTHH:mm:ss...), empty/null -> ''.
 */
function normalizeDateForHtmlInput(value: string | null | undefined): string {
  if (!value) return '';
  const s = String(value).trim();
  if (!s) return '';

  // Already YYYY-MM-DD (or starts with it, e.g. ISO datetime)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch.slice(1).join('-');

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    return `${dmyMatch[3]}-${month}-${day}`;
  }

  return '';
}

export interface InitialIdentityData {
  full_name: string;
  identity_number?: string | null;
  birth_place?: string | null;
  birth_date?: string | null;
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | null;
  address?: string | null;
  rt_rw?: string | null;
  village_kelurahan?: string | null;
  district_kecamatan?: string | null;
  religion?: string | null;
  marital_status?: string | null;
  occupation?: string | null;
  citizenship?: string | null;
  valid_until?: string | null;
  identity_path?: string | null;
  ktp_regency_id?: number | null;
  ktp_ocr_confidence?: number | null;
  ktp_ocr_provider?: string | null;
}

interface Props {
   isOpen: boolean;
   onClose: () => void;
   guestName?: string;
   guestPhone?: string;
   guestId?: number | null;
   propertyId?: number;
   /** Context for identity confirm: 'CRM_EDIT' (default) or 'CHECKIN_IDENTITY_SCAN' (disables phone fallback). */
   context?: 'CRM_EDIT' | 'CHECKIN_IDENTITY_SCAN';
   onIdentityConfirmed?: (data: ExtractedIdentityData, savedGuest?: any) => void;
   onScanSuccess?: (parsedData: ExtractedIdentityData) => void;
   onSelectExistingGuest?: (candidate: DuplicateCandidateInfo) => void;
   /** 'UPLOAD' (default) shows camera/file chooser first. 'DETAIL' shows form + existing photo immediately. */
   mode?: IdentityModalMode;
   /** Pre-populate form and existing photo when mode === 'DETAIL'. */
   initialIdentityData?: InitialIdentityData | null;
 }

/** Generic Autocomplete component with full keyboard navigation */
interface AutocompleteProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (val: string) => void;
  onFocus?: () => void;
  required?: boolean;
  options: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlightedIndex: number;
  onHighlightedIndexChange: (idx: number) => void;
  onSelect: (value: string) => void;
}

function Autocomplete({
  label, placeholder, value, onChange, onFocus, required,
  options, open, onOpenChange, highlightedIndex, onHighlightedIndexChange, onSelect
}: AutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || options.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        onHighlightedIndexChange(highlightedIndex < options.length - 1 ? highlightedIndex + 1 : 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        onHighlightedIndexChange(highlightedIndex > 0 ? highlightedIndex - 1 : options.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          onSelect(options[highlightedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onOpenChange(false);
        break;
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onOpenChange]);

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-xs font-semibold text-stone-700 mb-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { onFocus?.(); onOpenChange(true); }}
        onBlur={() => setTimeout(() => onOpenChange(false), 200)}
        placeholder={placeholder}
        className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
      />
      {open && options.length > 0 && (
        <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-stone-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {options.map((opt, idx) => (
            <li
              key={`${label}-${opt}`}
              className={`px-3 py-2 text-xs cursor-pointer transition-colors ${
                idx === highlightedIndex
                  ? 'bg-emerald-100 text-emerald-900 font-semibold'
                  : 'text-stone-700 hover:bg-emerald-50'
              }`}
              onMouseDown={() => onSelect(opt)}
              onMouseEnter={() => onHighlightedIndexChange(idx)}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Region autocomplete: searches nationally, shows "NAME — PROVINCE" */
interface RegionAutocompleteProps {
  id: string;
  label: string;
  placeholder: string;
  /** When truthy, input shows canonical name (read-only visual); editing clears it. */
  selectedId: number | null;
  onIdChange: (id: number | null) => void;
  provinceMap: Record<string, string>;
  required?: boolean;
}

function RegionAutocomplete({
  label, placeholder, selectedId, onIdChange, provinceMap, required
}: RegionAutocompleteProps) {
  const [filter, setFilter] = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ id: number; name: string; province_bps_code: string; bps_code: string }>>([]);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate suggestions when selectedId is set but not yet present (e.g. DETAIL mode from CRM).
  // Runs every time selectedId changes; safe — only fetches when the ID is missing from suggestions.
  useEffect(() => {
    if (!selectedId) return;
    const existing = suggestions.find(s => s.id === selectedId);
    if (existing) {
      setFilter(prev => (prev === '' ? existing.name : prev));
      return;
    }
    authenticatedFetch(`/api/regions/regencies/${selectedId}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.data) {
          const reg = data.data;
          setFilter(reg.name);
          setSuggestions(prev =>
            prev.some(s => s.id === selectedId) ? prev : [...prev, {
              id: reg.id,
              name: reg.name,
              province_bps_code: reg.province_bps_code,
              bps_code: reg.bps_code
            }]
          );
        }
      })
      .catch(() => {});
  }, [selectedId]);

  // Display: show canonical name if selected, else filter text
  const displayValue = selectedId ? suggestions.find(s => s.id === selectedId)?.name || '' : filter;

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    try {
      const res = await authenticatedFetch(`/api/regions/regencies/search?q=${encodeURIComponent(q)}&limit=10`);
      const data = await res.json();
      if (data.success) setSuggestions(data.data || []);
      else setSuggestions([]);
    } catch { setSuggestions([]); }
  }, []);

  const handleInputChange = (val: string) => {
    setFilter(val);
    // Editing after selection clears canonical ID
    if (selectedId !== null) {
      onIdChange(null);
    }
    setOpen(true);
    setHighlightedIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(val), 250);
  };

  const handleSelect = (s: { id: number; name: string; province_bps_code: string }) => {
    setFilter(s.name);
    setHighlightedIndex(-1);
    setOpen(false);
    onIdChange(s.id);
  };

  // Keyboard nav for suggestion list
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(i => i < suggestions.length - 1 ? i + 1 : 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(i => i > 0 ? i - 1 : suggestions.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
          handleSelect(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
    }
  };

  // Refocus input after selecting from mouse to keep keyboard working
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="relative">
      <label className="block text-xs font-semibold text-stone-700 mb-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </label>
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder={placeholder}
        className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
      />
      {/* Helper text showing province when selected */}
      {selectedId && (
        <div className="mt-0.5 text-[10px] text-emerald-700 font-medium">
          {provinceMap[suggestions.find(s => s.id === selectedId)?.province_bps_code || ''] || ''}
        </div>
      )}
      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-stone-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {suggestions.map((s, idx) => {
            const provName = provinceMap[s.province_bps_code] || '';
            return (
              <li
                key={s.id}
                className={`px-3 py-2 text-xs cursor-pointer transition-colors flex items-center justify-between gap-2 ${
                  idx === highlightedIndex
                    ? 'bg-emerald-100 text-emerald-900 font-semibold'
                    : 'text-stone-700 hover:bg-emerald-50'
                }`}
                onMouseDown={() => handleSelect(s)}
                onMouseEnter={() => setHighlightedIndex(idx)}
              >
                <span>{s.name}</span>
                <span className="text-[10px] text-stone-400 shrink-0">{provName}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function IdentityExtractionModal({
   isOpen,
   onClose,
     guestName: _guestName = '',
     guestPhone,
     guestId,
     propertyId = 1,
     context = 'CRM_EDIT',
     onIdentityConfirmed,
     onScanSuccess: _onScanSuccess,
     onSelectExistingGuest,
     mode = 'UPLOAD',
     initialIdentityData = null
  }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [extractedData, setExtractedData] = useState<ExtractedIdentityData | null>(null);
  const [scanSuccessBanner, setScanSuccessBanner] = useState<string | null>(null);
  const [duplicateCandidate, setDuplicateCandidate] = useState<DuplicateCandidateInfo | null>(null);
  const [nameMismatch, setNameMismatch] = useState<NameMismatchInfo | null>(null);
  const [infoBanner, setInfoBanner] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Province map for display
  const [provinces, setProvinces] = useState<Array<{ id: number; name: string; bps_code: string }>>([]);

  // Camera state
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  // KTP image rotation (0, 90, 180, 270)
  const [ktpRotation, setKtpRotation] = useState(0);

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
  const [formKtpRegencyId, setFormKtpRegencyId] = useState<number | null>(null);

  // Secure existing KTP photo in DETAIL mode
  const existingPhotoPath = (mode === 'DETAIL' && initialIdentityData?.identity_path) || null;
  const { blobUrl: secureExistingBlobUrl } = useSecureDocumentBlob(
    existingPhotoPath,
    mode === 'DETAIL' && Boolean(existingPhotoPath)
  );

  // Effective preview: new upload takes priority over secure existing blob
  const effectivePreviewUrl = previewUrl || secureExistingBlobUrl;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  previewUrlRef.current = previewUrl;

  // Stop camera stream helper
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  };

  const resetModalState = useCallback(() => {
    stopCamera();
    if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
      try { URL.revokeObjectURL(previewUrlRef.current); } catch {}
    }
    setFile(null);
    setPreviewUrl(null);
    setExtracting(false);
    setSaving(false);
    setExtractedData(null);
    setScanSuccessBanner(null);
    setDuplicateCandidate(null);
    setNameMismatch(null);
    setInfoBanner(null);
    setErrorMsg(null);
    setFormName('');
    setFormNik('');
    setFormBirthPlace('');
    setFormBirthDate('');
    setFormGender('');
    setFormAddress('');
    setFormRtRw('');
    setFormKelurahan('');
    setFormKecamatan('');
    setFormAgama('');
    setFormStatus('');
    setFormPekerjaan('');
    setFormCitizenship('');
    setFormValidUntil('');
    setFormKtpRegencyId(null);
    setKtpRotation(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  }, []);

  useEffect(() => {
    if (isOpen) {
      resetModalState();

      // Fetch provinces on open
      authenticatedFetch('/api/regions/provinces')
        .then(r => r.json())
        .then(data => {
          if (data.success && Array.isArray(data.data)) {
            setProvinces(data.data);
          }
        })
        .catch(() => {});

      // DETAIL mode: pre-populate form from existing identity data
      if (mode === 'DETAIL' && initialIdentityData) {
        const d = initialIdentityData;
        setFormName(d.full_name || '');
        setFormNik(d.identity_number || '');
        setFormBirthPlace(d.birth_place || '');
        setFormBirthDate(normalizeDateForHtmlInput(d.birth_date));
        setFormGender((d.gender === 'MALE' || d.gender === 'FEMALE') ? d.gender : '');
        setFormAddress(d.address || '');
        setFormRtRw(d.rt_rw || '');
        setFormKelurahan(d.village_kelurahan || '');
        setFormKecamatan(d.district_kecamatan || '');
        setFormAgama(d.religion || '');
        setFormStatus(d.marital_status || '');
        setFormPekerjaan(d.occupation || '');
        setFormCitizenship(d.citizenship || '');
        setFormValidUntil(d.valid_until || '');
        setFormKtpRegencyId(d.ktp_regency_id || null);

        setExtractedData({
          full_name: d.full_name || '',
          identity_number: d.identity_number || '',
          birth_place: d.birth_place || undefined,
          birth_date: d.birth_date || undefined,
          gender: (d.gender === 'MALE' || d.gender === 'FEMALE') ? d.gender : undefined,
          address: d.address || undefined,
          rt_rw: d.rt_rw || undefined,
          village_kelurahan: d.village_kelurahan || undefined,
          district_kecamatan: d.district_kecamatan || undefined,
          religion: d.religion || undefined,
          marital_status: d.marital_status || undefined,
          occupation: d.occupation || undefined,
          citizenship: d.citizenship || undefined,
          valid_until: d.valid_until || undefined,
          confidence: (d.ktp_ocr_confidence ?? 1.0) as number,
          recognized_fields_count: 0,
          total_fields_count: 13,
          provider: d.ktp_ocr_provider || 'MANUAL',
          file_path: d.identity_path || '',
          document_upload_id: null,
          ktp_regency_id: d.ktp_regency_id || null,
          raw_lines: []
        });
      }
    } else {
      resetModalState();
    }
  }, [isOpen, resetModalState, mode, initialIdentityData]);

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
        processFileExtraction(capturedFile);
      }
    }, 'image/jpeg', 0.95);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      // If manual form is already visible, replace photo in-place without resetting form values.
      if (extractedData) {
        processReplacementUpload(selected);
        return;
      }
      setFile(selected);
      setPreviewUrl(URL.createObjectURL(selected));
      setErrorMsg(null);
      setInfoBanner(null);
      setDuplicateCandidate(null);
      setNameMismatch(null);
      stopCamera();
      processFileExtraction(selected);
    }
  };

  // Uploads a replacement KTP image without touching form values.
  const processReplacementUpload = async (targetFile: File) => {
    try {
      setExtracting(true);
      setErrorMsg(null);
      setInfoBanner(null);
      setDuplicateCandidate(null);
      setNameMismatch(null);

      const uploadPayload = new FormData();
      uploadPayload.append('image', targetFile);
      uploadPayload.append('ktp', targetFile);
      if (_guestName) uploadPayload.append('guest_name', _guestName);
      if (propertyId) uploadPayload.append('property_id', String(propertyId));

      const uploadRes = await authenticatedFetch('/api/identity/upload-identity', {
        method: 'POST',
        body: uploadPayload
      });

      if (!uploadRes.ok) {
        throw new Error('Gagal menyimpan dokumen KTP ke server. Silakan coba lagi.');
      }

      const contentType = uploadRes.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await uploadRes.text();
        throw new Error(`Server mengembalikan respon tidak valid (${uploadRes.status}): ${text.slice(0, 100)}`);
      }

      const uploadJson = await uploadRes.json();
      if (!uploadJson.success) {
        throw new Error(uploadJson.message || 'Gagal menyimpan dokumen KTP.');
      }

      const newDocumentUploadId = uploadJson.document_upload_id || null;
      const newFilePath = uploadJson.file_path || '';

      if (!newDocumentUploadId) {
        throw new Error('ID dokumen tidak diterima dari server. Ganti foto gagal.');
      }

      const nextPreviewUrl = URL.createObjectURL(targetFile);
      if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
        try { URL.revokeObjectURL(previewUrlRef.current); } catch {}
      }
      setFile(targetFile);
      setPreviewUrl(nextPreviewUrl);
      previewUrlRef.current = nextPreviewUrl;

      setExtractedData((prev) =>
        prev
          ? {
              ...prev,
              document_upload_id: newDocumentUploadId,
              file_path: newFilePath,
              provider: 'MANUAL',
            }
          : prev
      );
      setScanSuccessBanner(null);
      setInfoBanner(
        `Foto KTP berhasil diperbarui (ID baru: ${newDocumentUploadId.slice(0, 8)}…).`
      );
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal mengganti foto KTP.');
    } finally {
      setExtracting(false);
    }
  };

  const processFileExtraction = async (targetFile: File) => {
    try {
      setExtracting(true);
      setErrorMsg(null);
      setInfoBanner(null);
      setDuplicateCandidate(null);
      setNameMismatch(null);

      const uploadPayload = new FormData();
      uploadPayload.append('image', targetFile);
      uploadPayload.append('ktp', targetFile);
      if (_guestName) uploadPayload.append('guest_name', _guestName);
      if (propertyId) uploadPayload.append('property_id', String(propertyId));

      const uploadRes = await authenticatedFetch('/api/identity/upload-identity', {
        method: 'POST',
        body: uploadPayload
      });

      if (!uploadRes.ok) {
        throw new Error('Gagal menyimpan dokumen KTP ke server. Silakan coba lagi.');
      }

      const contentType = uploadRes.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await uploadRes.text();
        throw new Error(`Server mengembalikan respon tidak valid (${uploadRes.status}): ${text.slice(0, 100)}`);
      }

      const uploadJson = await uploadRes.json();
      if (!uploadJson.success) {
        throw new Error(uploadJson.message || 'Gagal menyimpan dokumen KTP.');
      }

      const documentUploadId = uploadJson.document_upload_id || null;
      const filePath = uploadJson.file_path || '';

      if (!documentUploadId) {
        throw new Error('ID dokumen tidak diterima dari server. Konfirmasi identitas tidak dapat dilanjutkan.');
      }

      const manualData: ExtractedIdentityData = {
        full_name: '',
        identity_number: '',
        birth_place: undefined,
        birth_date: undefined,
        gender: undefined,
        address: undefined,
        rt_rw: undefined,
        village_kelurahan: undefined,
        district_kecamatan: undefined,
        religion: undefined,
        marital_status: undefined,
        occupation: undefined,
        citizenship: undefined,
        valid_until: undefined,
        confidence: 0,
        recognized_fields_count: 0,
        total_fields_count: 13,
        provider: 'MANUAL',
        file_path: filePath,
        document_upload_id: documentUploadId,
        raw_lines: []
      };

      setExtractedData(manualData);
      setScanSuccessBanner(null);
      setInfoBanner(
        'Mode entry manual — data identitas akan diisi secara manual. ' +
        `Dokumen KTP telah tersimpan (ID: ${documentUploadId.slice(0, 8)}…).`
      );
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan saat memproses KTP.');
    } finally {
      setExtracting(false);
    }
  };

  const getFinalData = (): ExtractedIdentityData => {
    return {
      full_name: formName.trim().toUpperCase() || extractedData?.full_name || '',
      identity_number: formNik.trim() || extractedData?.identity_number || '',
      birth_place: formBirthPlace.trim() || extractedData?.birth_place || undefined,
      birth_date: formBirthDate.trim() || extractedData?.birth_date || undefined,
      gender: formGender || extractedData?.gender || undefined,
      address: formAddress.trim() || extractedData?.address || undefined,
      rt_rw: formRtRw.trim() || extractedData?.rt_rw || undefined,
      village_kelurahan: formKelurahan.trim() || extractedData?.village_kelurahan || undefined,
      district_kecamatan: formKecamatan.trim() || extractedData?.district_kecamatan || undefined,
      religion: formAgama.trim() || extractedData?.religion || undefined,
      marital_status: formStatus.trim() || extractedData?.marital_status || undefined,
      occupation: formPekerjaan.trim() || extractedData?.occupation || undefined,
      citizenship: formCitizenship.trim() || extractedData?.citizenship || undefined,
       valid_until: formValidUntil.trim() || extractedData?.valid_until || undefined,
      confidence: extractedData?.confidence || 1.0,
      recognized_fields_count: extractedData?.recognized_fields_count,
      total_fields_count: 13,
      provider: extractedData?.provider || 'GOOGLE_VISION',
      file_path: extractedData?.file_path || '',
      document_upload_id: extractedData?.document_upload_id || null,
      ktp_regency_id: formKtpRegencyId,
      raw_lines: extractedData?.raw_lines || []
    };
  };

  const handleConfirm = async () => {
    const finalData = getFinalData();

    if (!finalData.full_name) {
      setErrorMsg('Nama lengkap KTP wajib diisi.');
      return;
    }
    if (!finalData.birth_date) {
      setErrorMsg('Tanggal lahir KTP wajib diisi.');
      return;
    }
    const normalizedCitizenship = finalData.citizenship ? finalData.citizenship.trim().toUpperCase() : '';
    const isIndonesian = normalizedCitizenship === 'WNI' || normalizedCitizenship === 'INDONESIA' || normalizedCitizenship === 'INDONESIAN';

    if (!finalData.citizenship || !finalData.citizenship.trim()) {
      setErrorMsg('Kewarganegaraan wajib diisi.');
      return;
    }
    if (isIndonesian && !formKtpRegencyId) {
      setErrorMsg('Kota/Kabupaten KTP wajib dipilih untuk WNI.');
      return;
    }

    try {
      setSaving(true);
      setErrorMsg(null);

      // DETAIL mode without new photo: use PATCH /api/guests/:id
      if (mode === 'DETAIL' && guestId && !finalData.document_upload_id) {
        const patchPayload = {
          property_id: propertyId || 1,
          full_name: finalData.full_name,
          identity_type: 'KTP',
          identity_number: finalData.identity_number || null,
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
          valid_until: finalData.valid_until || undefined,
          ktp_regency_id: isIndonesian ? formKtpRegencyId : null
        };

        const res = await authenticatedFetch(`/api/guests/${guestId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchPayload)
        });

        const resJson = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(resJson.message || 'Gagal memperbarui data identitas tamu.');
        }

        const savedGuest = resJson.data || null;
        if (onIdentityConfirmed) {
          onIdentityConfirmed(finalData, savedGuest);
        }
        onClose();
        return;
      }

      // Default path (UPLOAD mode or DETAIL with new photo): use POST /api/identity/confirm
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
          valid_until: finalData.valid_until || undefined,
       document_upload_id: finalData.document_upload_id || null,
       identity_type: 'KTP',
       confidence: finalData.confidence,
       ocr_provider: finalData.provider,
       context: context,
       ktp_regency_id: isIndonesian ? formKtpRegencyId : null
      };

      const res = await authenticatedFetch('/api/identity/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmPayload)
      });

      const resJson = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(resJson.message || 'Gagal menyimpan data identitas ke database CRM');
      }

       const savedGuest = resJson.data || null;

       if (onIdentityConfirmed) {
         onIdentityConfirmed(finalData, savedGuest);
       }
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menyimpan identitas ke database CRM.');
    } finally {
      setSaving(false);
    }
  };

  // Build province map once
  const provinceMap: Record<string, string> = {};
  provinces.forEach(p => { provinceMap[p.bps_code] = p.name; });

  // Agama options
  const AGAMA_OPTIONS = ['ISLAM', 'KRISTEN', 'KATOLIK', 'HINDU', 'BUDDHA', 'KONGHUCU'];
  const [agamaOpen, setAgamaOpen] = useState(false);
  const [agamaHighlighted, setAgamaHighlighted] = useState(-1);
  const filteredAgama = AGAMA_OPTIONS.filter(
    (a) => formAgama && a.toLowerCase().includes(formAgama.toLowerCase())
  );

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
               <h2 className="text-base font-bold tracking-tight text-white">{mode === 'DETAIL' ? 'Detail Identitas Tamu' : 'Unggah & Ekstraksi KTP Tamu'}</h2>
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
        <div className="p-6 overflow-x-hidden overflow-y-auto space-y-5 flex-1 bg-stone-50/50">
          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5">
              <svg className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{errorMsg}</span>
            </div>
          )}

          {scanSuccessBanner && (extractedData?.recognized_fields_count || 0) > 0 && (
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs flex items-center justify-between animate-in fade-in slide-in-from-top-1 shadow-2xs">
              <div className="flex items-center gap-2.5">
                <div className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <p className="font-bold text-emerald-900">{scanSuccessBanner}</p>
                  <p className="text-[11px] text-emerald-700">Data identitas telah diekstrak dan otomatis dimasukkan ke formulir input.</p>
                </div>
              </div>
              {extractedData?.confidence !== undefined && (
                <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded font-mono text-[10px] font-bold border border-emerald-300">
                  {Math.round((extractedData.confidence || 0.98) * 100)}% Match
                </span>
              )}
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
                    Ambil Foto
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

            {!file && !extractedData && !isCameraActive && mode === 'UPLOAD' && (
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

             {/* KTP Preview with toolbar */}
            {effectivePreviewUrl && !extracting && (
              <div className="flex flex-col items-center gap-2 p-3.5 bg-white rounded-xl border border-stone-200 shadow-xs">
                {/* Compact KTP preview — constrained to modal width, rotation-safe overflow */}
                <div className="relative w-full max-w-md flex justify-center overflow-hidden" style={{ maxHeight: 300 }}>
                  <img
                    src={effectivePreviewUrl}
                    alt="Preview KTP"
                    className="max-w-full h-auto object-contain rounded-lg border border-stone-300 bg-stone-50"
                    style={{ transform: `rotate(${ktpRotation}deg)` }}
                  />
                </div>
                {/* Toolbar: Putar 90° and Ganti Foto compact, same row */}
                <div className="flex items-center gap-2 w-full justify-center">
                  <button
                    type="button"
                    onClick={() => setKtpRotation(r => (r + 90) % 360)}
                    title="Putar 90° searah jarum jam"
                    className="px-2.5 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 rounded-lg text-xs font-medium border border-emerald-300 flex items-center gap-1 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Putar 90°
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    title="Ganti Foto KTP"
                    className="px-2.5 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg text-xs font-medium border border-stone-300 flex items-center gap-1 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Ganti Foto
                  </button>
                </div>
                <div className="text-[10px] text-stone-400 font-mono truncate w-full text-center">
                  {file ? (file?.name + ' · ' + (file?.size ? (file.size / 1024).toFixed(0) : '—') + ' KB') : (mode === 'DETAIL' ? 'Foto KTP Existing' : '')}
                </div>
              </div>
            )}
          </div>

          {/* Extracted Review Form */}
          {extractedData && (
            <div className="space-y-4">
              <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between">
                <span className="font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                  Form Entry Manual KTP
                  <span className="text-[11px] font-normal text-amber-700 bg-amber-100/70 px-2 py-0.5 rounded-full ml-1">
                    OCR sementara dinonaktifkan
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => { fileInputRef.current?.click(); }}
                  className="text-stone-500 hover:text-stone-800 text-xs underline font-medium"
                >
                  Ganti Foto
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

                {/* Tempat Lahir with keyboard autocomplete */}
                <div className="relative">
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Tempat Lahir
                  </label>
                  <TempatLahirAutocomplete
                    value={formBirthPlace}
                    onChange={(v) => setFormBirthPlace(v)}
                    provinceMap={provinceMap}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Tanggal Lahir <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={formBirthDate}
                    onChange={(e) => setFormBirthDate(e.target.value)}
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  />
                </div>

                {/* Kota/Kabupaten KTP - REQUIRED for WNI only */}
                <div className="sm:col-span-2">
                  <RegionAutocomplete
                    id="ktp-regency"
                    label="Kota/Kabupaten KTP"
                    placeholder="Ketik nama kota/kabupaten..."
                    selectedId={formKtpRegencyId}
                    onIdChange={(id) => setFormKtpRegencyId(id)}
                    provinceMap={provinceMap}
                    required={(() => {
                      const c = (formCitizenship.trim() || extractedData?.citizenship || '').trim().toUpperCase();
                      return c === 'WNI' || c === 'INDONESIA' || c === 'INDONESIAN';
                    })()}
                  />
                </div>

                {/* Agama with keyboard autocomplete */}
                <div className="relative">
                  <Autocomplete
                    label="Agama"
                    placeholder="Contoh: ISLAM"
                    value={formAgama}
                    onChange={(v) => setFormAgama(v)}
                    required={false}
                    options={filteredAgama}
                    open={agamaOpen}
                    onOpenChange={setAgamaOpen}
                    highlightedIndex={agamaHighlighted}
                    onHighlightedIndexChange={setAgamaHighlighted}
                    onSelect={(v) => { setFormAgama(v); setAgamaOpen(false); setAgamaHighlighted(-1); }}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Status Perkawinan
                  </label>
                  <select
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value)}
                    className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
                  >
                    <option value="">Pilih status</option>
                    <option value="BELUM KAWIN">Belum Kawin</option>
                    <option value="KAWIN">Kawin</option>
                  </select>
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
              </div>

            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-stone-100 border-t border-stone-200 flex justify-between items-center">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-stone-600 hover:text-stone-800 transition-colors cursor-pointer"
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

/** Tempat Lahir autocomplete with keyboard navigation and debounce */
function TempatLahirAutocomplete({
  value, onChange, provinceMap
}: {
  value: string;
  onChange: (v: string) => void;
  provinceMap: Record<string, string>;
}) {
  const [suggestions, setSuggestions] = useState<Array<{ id: number; name: string; province_bps_code: string; bps_code: string }>>([]);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    try {
      const res = await authenticatedFetch(`/api/regions/regencies/search?q=${encodeURIComponent(q)}&limit=10`);
      const data = await res.json();
      if (data.success) setSuggestions(data.data || []);
      else setSuggestions([]);
    } catch { setSuggestions([]); }
  }, []);

  const handleChange = (val: string) => {
    onChange(val);
    setOpen(true);
    setHighlightedIndex(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(val), 250);
  };

  const handleSelect = (s: { id: number; name: string; province_bps_code: string }) => {
    onChange(s.name);
    setOpen(false);
    setHighlightedIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(i => i < suggestions.length - 1 ? i + 1 : 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(i => i > 0 ? i - 1 : suggestions.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
          handleSelect(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
    }
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder="Contoh: JAKARTA atau ketik nama kota"
        className="w-full text-xs px-3 py-2 bg-stone-50 border border-stone-300 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:bg-white outline-none"
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-stone-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {suggestions.map((s, idx) => {
            const provName = provinceMap[s.province_bps_code] || '';
            return (
              <li
                key={s.id}
                className={`px-3 py-2 text-xs cursor-pointer transition-colors flex items-center justify-between gap-2 ${
                  idx === highlightedIndex
                    ? 'bg-emerald-100 text-emerald-900 font-semibold'
                    : 'text-stone-700 hover:bg-emerald-50'
                }`}
                onMouseDown={() => handleSelect(s)}
                onMouseEnter={() => setHighlightedIndex(idx)}
              >
                <span>{s.name}</span>
                <span className="text-[10px] text-stone-400 shrink-0">{provName}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
