import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  GitMerge,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import {
  buildXlsxBytes,
  parseSpreadsheetBuffer,
  triggerBrowserDownload,
} from '../products/productExcelUtils';

interface GuestImportModalProps {
  propertyId: number;
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
}

interface PreviewRowItem {
  row_number: number;
  status: 'NEW' | 'DUPLICATE' | 'INVALID';
  recommended_action: 'CREATE' | 'MERGE' | 'SKIP';
  action: 'CREATE' | 'MERGE' | 'SKIP';
  match_reason: string | null;
  matched_guest: {
    id: number;
    guest_code: string;
    full_name: string;
    phone: string | null;
    email: string | null;
    identity_number: string | null;
    city: string | null;
    birth_date: string | null;
    citizenship: string | null;
    visit_count?: number;
    total_spend?: number;
  } | null;
  row_data: {
    full_name: string;
    phone: string | null;
    email: string | null;
    identity_type: string;
    identity_number: string | null;
    gender: string | null;
    birth_place: string | null;
    birth_date: string | null;
    citizenship: string;
    city: string | null;
    address: string | null;
    notes: string | null;
  };
}

export const GuestImportModal: React.FC<GuestImportModalProps> = ({
  propertyId,
  isOpen,
  onClose,
  onImported,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [loadingPreview, setLoadingPreview] = useState<boolean>(false);
  const [committing, setCommitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [previewItems, setPreviewItems] = useState<PreviewRowItem[]>([]);
  const [commitSummary, setCommitSummary] = useState<{
    created_count: number;
    merged_count: number;
    skipped_count: number;
    error_count: number;
  } | null>(null);

  if (!isOpen) return null;

  const handleDownloadTemplate = () => {
    const headers = [
      'Nama Lengkap',
      'No. Telepon / WhatsApp',
      'Email',
      'Jenis Identitas',
      'No. Identitas (NIK/Paspor)',
      'Jenis Kelamin (L/P)',
      'Tempat Lahir',
      'Tanggal Lahir (YYYY-MM-DD)',
      'Kewarganegaraan (WNI/WNA)',
      'Kota / Kabupaten',
      'Alamat Lengkap',
      'Catatan',
    ];
    const sampleRows = [
      [
        'BUDI SANTOSO',
        '081234567890',
        'budi@email.com',
        'KTP',
        '3578010101900001',
        'L',
        'SURABAYA',
        '1990-01-15',
        'WNI',
        'KOTA SURABAYA',
        'JL. RAYA DARMO NO. 10 SURABAYA',
        'TAMU REGULER',
      ],
      [
        'SITI AMINAH',
        '081398765432',
        '',
        'KTP',
        '3573020202920002',
        'P',
        'MALANG',
        '1992-05-20',
        'WNI',
        'KOTA MALANG',
        'JL. IJEN NO. 25 MALANG',
        '',
      ],
    ];
    const bytes = buildXlsxBytes('Template Import Pelanggan', [headers, ...sampleRows]);
    triggerBrowserDownload(
      'Template_Import_Pelanggan_CRM.xlsx',
      bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  };

  const normalizeExcelDateString = (raw: string): string | null => {
    const val = String(raw || '').trim();
    if (!val || val === '-') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    const dmy = val.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) {
      return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    const serial = Number(val);
    if (Number.isFinite(serial) && serial > 10000 && serial < 65000) {
      const utcDays = Math.floor(serial - 25569);
      const d = new Date(utcDays * 86400 * 1000);
      if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
    }
    return null;
  };

  const extractRowObjectsFromMatrix = (matrix: string[][]) => {
    if (!matrix || matrix.length < 2) return [];

    // Find header row among first 10 rows
    let headerRowIndex = 0;
    const headerKeywords = [
      'nama',
      'pelanggan',
      'tamu',
      'fullname',
      'name',
      'telepon',
      'whatsapp',
      'phone',
      'nik',
      'ktp',
    ];
    for (let i = 0; i < Math.min(10, matrix.length); i++) {
      const rowClean = (matrix[i] || []).map((c) =>
        String(c || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      );
      if (rowClean.some((cell) => headerKeywords.some((kw) => cell.includes(kw)))) {
        headerRowIndex = i;
        break;
      }
    }

    const rawHeaders = (matrix[headerRowIndex] || []).map((h) =>
      String(h || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
    );

    const findColIndex = (candidates: string[]): number => {
      for (const c of candidates) {
        const exactIdx = rawHeaders.findIndex((h) => h === c);
        if (exactIdx >= 0) return exactIdx;
      }
      for (const c of candidates) {
        const idx = rawHeaders.findIndex((h) => h.includes(c));
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const idxName = findColIndex(['namalengkap', 'namatamu', 'pelanggan', 'nama', 'fullname', 'name', 'guestname']);
    const idxPhone = findColIndex(['notelepon', 'nowhatsapp', 'telepon', 'whatsapp', 'nohp', 'hp', 'phone', 'telp', 'wa']);
    const idxEmail = findColIndex(['email', 'surel']);
    const idxIdType = findColIndex(['jenisidentitas', 'tipeidentitas', 'identitytype']);
    const idxIdNum = findColIndex(['noidentitas', 'nik', 'ktp', 'paspor', 'identitynumber']);
    const idxGender = findColIndex(['jeniskelamin', 'gender', 'kelamin', 'lp']);
    const idxBirthPlace = findColIndex(['tempatlahir', 'birthplace', 'kotalahir']);
    const idxBirthDate = findColIndex(['tanggallahir', 'tgllahir', 'birthdate', 'dob']);
    const idxCit = findColIndex(['kewarganegaraan', 'citizenship', 'wniwna', 'nationality']);
    const idxCity = findColIndex(['kotaasal', 'kotakabupaten', 'kota', 'kabupaten', 'city', 'daerah', 'asal']);
    const idxAddr = findColIndex(['alamat', 'address']);
    const idxNotes = findColIndex(['catatan', 'notes', 'keterangan']);

    const rows = [];
    for (let r = headerRowIndex + 1; r < matrix.length; r++) {
      const line = matrix[r];
      if (!line || line.every((cell) => !String(cell || '').trim())) continue;
      const getVal = (colIdx: number) => (colIdx >= 0 && colIdx < line.length ? String(line[colIdx] || '').trim() : '');
      const fullName = idxName >= 0 ? getVal(idxName) : String(line[0] || '').trim();
      if (!fullName || fullName.toLowerCase() === 'nama' || fullName.toLowerCase() === 'nama lengkap') continue;

      rows.push({
        row_number: r + 1,
        full_name: fullName.toUpperCase(),
        phone: getVal(idxPhone) || null,
        email: getVal(idxEmail) || null,
        identity_type: (getVal(idxIdType) || 'KTP').toUpperCase(),
        identity_number: getVal(idxIdNum) || null,
        gender: getVal(idxGender) || null,
        birth_place: getVal(idxBirthPlace).toUpperCase() || null,
        birth_date: normalizeExcelDateString(getVal(idxBirthDate)),
        citizenship: (getVal(idxCit) || 'WNI').toUpperCase(),
        city: getVal(idxCity).toUpperCase() || null,
        address: getVal(idxAddr).toUpperCase() || null,
        notes: getVal(idxNotes).toUpperCase() || null,
      });
    }
    return rows;
  };

  const safeParseJsonResponse = async (res: Response, fallbackMsg: string) => {
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        res.status === 413
          ? 'Ukuran data terlalu besar untuk dikirim sekaligus.'
          : `${fallbackMsg} (HTTP ${res.status})`
      );
    }
    if (!res.ok) {
      throw new Error(json?.message || `${fallbackMsg} (HTTP ${res.status})`);
    }
    return json;
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setCommitSummary(null);
    setLoadingPreview(true);

    try {
      const buffer = await file.arrayBuffer();
      const matrix = await parseSpreadsheetBuffer(buffer, file.name);
      const extractedRows = extractRowObjectsFromMatrix(matrix);
      if (extractedRows.length === 0) {
        throw new Error('Tidak ditemukan baris data pelanggan yang valid pada file tersebut.');
      }

      // Send in chunks of 400 rows if file is very large so payload is always fast and lightweight
      const CHUNK_SIZE = 400;
      const allPreviewItems: PreviewRowItem[] = [];
      for (let i = 0; i < extractedRows.length; i += CHUNK_SIZE) {
        const chunk = extractedRows.slice(i, i + CHUNK_SIZE);
        const res = await authenticatedFetch('/api/guests/bulk-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            mode: 'preview',
            rows: chunk,
          }),
        });
        const json = await safeParseJsonResponse(res, 'Gagal memindai data import pelanggan');
        if (Array.isArray(json?.data?.items)) {
          allPreviewItems.push(...json.data.items);
        }
      }
      setPreviewItems(allPreviewItems);
    } catch (err: any) {
      setError(err?.message || 'Gagal membaca file Excel/CSV.');
      setPreviewItems([]);
    } finally {
      setLoadingPreview(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const updateRowAction = (rowNumber: number, nextAction: 'CREATE' | 'MERGE' | 'SKIP') => {
    setPreviewItems((prev) =>
      prev.map((item) => (item.row_number === rowNumber ? { ...item, action: nextAction } : item))
    );
  };

  const setAllDuplicatesAction = (nextAction: 'CREATE' | 'MERGE' | 'SKIP') => {
    setPreviewItems((prev) =>
      prev.map((item) => (item.status === 'DUPLICATE' ? { ...item, action: nextAction } : item))
    );
  };

  const handleCommitImport = async () => {
    if (previewItems.length === 0) return;
    setCommitting(true);
    setError(null);

    try {
      const payloadRows = previewItems.map((it) => ({
        row_number: it.row_number,
        ...it.row_data,
        action: it.action,
        target_guest_id: it.matched_guest?.id ?? null,
      }));

      const CHUNK_SIZE = 300;
      let totalCreated = 0;
      let totalMerged = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      for (let i = 0; i < payloadRows.length; i += CHUNK_SIZE) {
        const chunk = payloadRows.slice(i, i + CHUNK_SIZE);
        const res = await authenticatedFetch('/api/guests/bulk-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            mode: 'commit',
            rows: chunk,
          }),
        });
        const json = await safeParseJsonResponse(res, 'Gagal menyimpan hasil import pelanggan');
        totalCreated += Number(json?.data?.created_count || 0);
        totalMerged += Number(json?.data?.merged_count || 0);
        totalSkipped += Number(json?.data?.skipped_count || 0);
        totalErrors += Number(json?.data?.error_count || 0);
      }

      setCommitSummary({
        created_count: totalCreated,
        merged_count: totalMerged,
        skipped_count: totalSkipped,
        error_count: totalErrors,
      });
      onImported();
    } catch (err: any) {
      setError(err?.message || 'Gagal mengeksekusi import pelanggan.');
    } finally {
      setCommitting(false);
    }
  };

  const newCount = previewItems.filter((i) => i.status === 'NEW').length;
  const dupCount = previewItems.filter((i) => i.status === 'DUPLICATE').length;
  const mergeSelectedCount = previewItems.filter((i) => i.action === 'MERGE').length;
  const createSelectedCount = previewItems.filter((i) => i.action === 'CREATE').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-stone-200 w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-[#1E392A] text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5 text-emerald-300" />
            </div>
            <div>
              <h3 className="text-sm font-bold">
                Import Data Pelanggan (.XLSX / .CSV) & Deteksi Merger Duplikat
              </h3>
              <p className="text-[11px] text-stone-300">
                Otomatis mendeteksi pelanggan yang sudah ada di CRM berdasarkan NIK, No. WA, atau Nama dan merekomendasikan penggabungan (Merger).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-300 hover:text-white hover:bg-white/10 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1 text-xs">
          {/* Step 1: Upload & Template Toolbar */}
          <div className="p-4 rounded-2xl border border-stone-200 bg-[#FAF8F3] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="font-bold text-stone-900 text-xs">
                1. Siapkan File Excel (.xlsx) atau CSV Data Pelanggan
              </p>
              <p className="text-[11px] text-stone-500 mt-0.5">
                Seluruh teks nama, kota, dan alamat akan otomatis dikonversi menjadi <strong>HURUF BESAR (UPPERCASE)</strong>.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="px-3.5 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Unduh Template XLSX</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                type="button"
                disabled={loadingPreview}
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-xl bg-[#1E392A] hover:bg-[#162a1f] text-white font-semibold flex items-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{loadingPreview ? 'Memindai File...' : 'Pilih File XLSX / CSV'}</span>
              </button>
            </div>
          </div>

          {error && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {commitSummary && (
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 space-y-2">
              <div className="flex items-center gap-2 font-bold text-sm">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <span>Proses Import & Merger Pelanggan Selesai!</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                <div className="p-2.5 rounded-xl bg-white border border-emerald-200">
                  <span className="text-[10px] uppercase font-bold text-stone-400">Pelanggan Baru</span>
                  <p className="text-lg font-bold text-emerald-800">{commitSummary.created_count}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-white border border-amber-200">
                  <span className="text-[10px] uppercase font-bold text-stone-400">Digabung (Merger)</span>
                  <p className="text-lg font-bold text-amber-800">{commitSummary.merged_count}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-white border border-stone-200">
                  <span className="text-[10px] uppercase font-bold text-stone-400">Dilewati (Skip)</span>
                  <p className="text-lg font-bold text-stone-700">{commitSummary.skipped_count}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-white border border-stone-200">
                  <span className="text-[10px] uppercase font-bold text-stone-400">Gagal</span>
                  <p className="text-lg font-bold text-red-600">{commitSummary.error_count}</p>
                </div>
              </div>
            </div>
          )}

          {/* Preview Table */}
          {previewItems.length > 0 && !commitSummary && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-stone-50 border border-stone-200">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-bold text-stone-800">
                    File: <span className="text-[#1E392A]">{fileName}</span> ({previewItems.length} baris)
                  </span>
                  <span className="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[11px]">
                    {newCount} Data Baru
                  </span>
                  <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-900 font-bold text-[11px]">
                    {dupCount} Terdeteksi Sama / Duplikat (Rekomendasi Merger)
                  </span>
                </div>

                {dupCount > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-stone-500 mr-1">Aksi massal duplikat:</span>
                    <button
                      type="button"
                      onClick={() => setAllDuplicatesAction('MERGE')}
                      className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold text-[11px] cursor-pointer"
                    >
                      Merger Semua ({dupCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllDuplicatesAction('SKIP')}
                      className="px-2.5 py-1 rounded-lg bg-stone-200 hover:bg-stone-300 text-stone-700 font-semibold text-[11px] cursor-pointer"
                    >
                      Lewati Semua
                    </button>
                  </div>
                )}
              </div>

              <div className="border border-stone-200 rounded-xl overflow-hidden max-h-[380px] overflow-y-auto">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10 bg-stone-100 border-b border-stone-200 text-[10px] font-bold uppercase text-stone-600">
                    <tr>
                      <th className="py-2.5 px-3">Baris</th>
                      <th className="py-2.5 px-3">Data dari File Import (HURUF BESAR)</th>
                      <th className="py-2.5 px-3">Status Deteksi & Data di CRM</th>
                      <th className="py-2.5 px-3 text-right">Keputusan / Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {previewItems.map((item) => (
                      <tr
                        key={item.row_number}
                        className={
                          item.status === 'DUPLICATE'
                            ? 'bg-amber-50/40 hover:bg-amber-50/70'
                            : 'hover:bg-stone-50'
                        }
                      >
                        <td className="py-2.5 px-3 font-mono text-stone-500">#{item.row_number}</td>
                        <td className="py-2.5 px-3">
                          <div className="font-bold text-stone-900">{item.row_data.full_name}</div>
                          <div className="text-[11px] text-stone-500">
                            {item.row_data.phone || 'Tanpa No. HP'}
                            {item.row_data.identity_number ? ` · NIK: ${item.row_data.identity_number}` : ''}
                            {item.row_data.city ? ` · ${item.row_data.city}` : ''}
                            {item.row_data.citizenship ? ` · ${item.row_data.citizenship}` : ''}
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          {item.status === 'DUPLICATE' && item.matched_guest ? (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-bold text-[10px]">
                                <GitMerge className="w-3 h-3" />
                                {item.match_reason} — Rekomendasi Merger
                              </span>
                              <div className="text-[11px] text-stone-700 font-semibold">
                                CRM: {item.matched_guest.full_name} ({item.matched_guest.guest_code})
                              </div>
                              <div className="text-[10px] text-stone-500">
                                {item.matched_guest.phone || '-'}
                                {item.matched_guest.city ? ` · ${item.matched_guest.city}` : ''}
                                {item.matched_guest.visit_count ? ` · ${item.matched_guest.visit_count} stay` : ''}
                              </div>
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                              <UserPlus className="w-3 h-3" />
                              Pelanggan Baru (Aman Ditambahkan)
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {item.status === 'DUPLICATE' ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => updateRowAction(item.row_number, 'MERGE')}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer ${
                                  item.action === 'MERGE'
                                    ? 'bg-amber-600 text-white shadow-2xs'
                                    : 'bg-white border border-stone-200 text-stone-600 hover:bg-stone-50'
                                }`}
                              >
                                Merger (Rekomendasi)
                              </button>
                              <button
                                type="button"
                                onClick={() => updateRowAction(item.row_number, 'SKIP')}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer ${
                                  item.action === 'SKIP'
                                    ? 'bg-stone-700 text-white'
                                    : 'bg-white border border-stone-200 text-stone-600 hover:bg-stone-50'
                                }`}
                              >
                                Lewati
                              </button>
                              <button
                                type="button"
                                onClick={() => updateRowAction(item.row_number, 'CREATE')}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer ${
                                  item.action === 'CREATE'
                                    ? 'bg-[#1E392A] text-white'
                                    : 'bg-white border border-stone-200 text-stone-600 hover:bg-stone-50'
                                }`}
                              >
                                Buat Baru
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => updateRowAction(item.row_number, 'CREATE')}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer ${
                                  item.action === 'CREATE'
                                    ? 'bg-[#1E392A] text-white'
                                    : 'bg-white border border-stone-200 text-stone-600'
                                }`}
                              >
                                Tambahkan Baru
                              </button>
                              <button
                                type="button"
                                onClick={() => updateRowAction(item.row_number, 'SKIP')}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer ${
                                  item.action === 'SKIP'
                                    ? 'bg-stone-700 text-white'
                                    : 'bg-white border border-stone-200 text-stone-600'
                                }`}
                              >
                                Lewati
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-stone-50 border-t border-stone-200 flex items-center justify-between">
          <div className="text-xs text-stone-500">
            {previewItems.length > 0 && !commitSummary ? (
              <span>
                Siap diproses: <strong>{createSelectedCount} pelanggan baru</strong> dan{' '}
                <strong>{mergeSelectedCount} penggabungan (merger)</strong>.
              </span>
            ) : (
              <span>Unggah file .xlsx atau .csv untuk memulai pemindaian pelanggan.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-100 text-xs font-semibold text-stone-700 cursor-pointer"
            >
              Tutup
            </button>
            {previewItems.length > 0 && !commitSummary && (
              <button
                type="button"
                disabled={committing || (createSelectedCount === 0 && mergeSelectedCount === 0)}
                onClick={handleCommitImport}
                className="px-5 py-2 rounded-xl bg-[#1E392A] hover:bg-[#162a1f] text-white text-xs font-bold shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {committing
                  ? 'Memproses Import & Merger...'
                  : `Proses Import (${createSelectedCount} Baru, ${mergeSelectedCount} Merger)`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
