import React, { useEffect, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Trash2, Upload } from 'lucide-react';
import { authenticatedFetch } from '../../../lib/authenticatedFetch';
import { IconX } from './LaporanIcons';
import { formatIdr } from './laporanUi';
import type {
  AccountingPayableItem,
  AccountingReceivableItem,
  BankListItem,
  CoaAccountItem,
  FixedAssetItem,
} from './laporanTypes';

function formatRibuanInput(val: string | number): string {
  const digits = String(val ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return Number(digits).toLocaleString('id-ID');
}

function parseRibuanInput(val: string): number {
  const digits = String(val ?? '').replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}

async function compressImageBlobToDataUrl(blob: Blob, maxDim = 720, quality = 0.78): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w >= h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w);
        canvas.height = Math.max(1, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result || ''));
          return;
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Gagal memproses file gambar'));
      img.src = String(reader.result || '');
    };
    reader.onerror = () => reject(new Error('Gagal membaca file gambar'));
    reader.readAsDataURL(blob);
  });
}

export interface CoaModalProps {
  propertyId: number;
  initial?: CoaAccountItem | null;
  onClose: () => void;
  onSaved: () => void;
}

export const CoaAccountModal: React.FC<CoaModalProps> = ({
  propertyId,
  initial,
  onClose,
  onSaved,
}) => {
  const [accountNumber, setAccountNumber] = useState(initial?.account_number || '');
  const [accountName, setAccountName] = useState(initial?.account_name || '');
  const [classification, setClassification] = useState(initial?.classification || 'Kas & Bank');
  const [openingBalance, setOpeningBalance] = useState(String(initial?.opening_balance ?? 0));
  const [openingDate, setOpeningDate] = useState(initial?.opening_date || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountNumber.trim() || !accountName.trim()) {
      setError('Nomor Akun dan Nama Akun wajib diisi.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/reports/accounting/coa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          account_number: accountNumber.trim(),
          account_name: accountName.trim(),
          classification,
          opening_balance: Number(openingBalance || 0),
          opening_date: openingDate || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menyimpan akun');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan akun');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 bg-[#123524] text-white">
          <h3 className="text-base font-bold">{initial ? 'Edit Akun COA' : 'Tambah Akun'}</h3>
          <button onClick={onClose} className="text-white/75 hover:text-white">
            <IconX className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Nomor Akun</label>
            <input
              type="text"
              value={accountNumber}
              disabled={Boolean(initial?.is_system)}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder="contoh: 11101"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-700 disabled:bg-slate-100"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Akun</label>
            <input
              type="text"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="contoh: Kas Operasional"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-700"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Klasifikasi</label>
            <select
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-700"
            >
              <option value="Kas & Bank">Kas & Bank</option>
              <option value="Investasi jangka pendek">Investasi jangka pendek</option>
              <option value="Piutang">Piutang</option>
              <option value="Persediaan">Persediaan</option>
              <option value="Peralatan">Peralatan</option>
              <option value="Kewajiban Lancar">Kewajiban Lancar</option>
              <option value="Ekuitas">Ekuitas</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Saldo Awal (Rp)</label>
            <input
              type="number"
              value={openingBalance}
              onChange={(e) => setOpeningBalance(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-700"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Tanggal Saldo Awal</label>
            <input
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-emerald-700"
            />
          </div>
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-100"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-[#123524] hover:bg-emerald-900 text-[#E6C786] font-bold shadow-xs disabled:opacity-50"
            >
              {saving ? 'Menyimpan...' : 'Simpan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export interface AddBankModalProps {
  propertyId: number;
  onClose: () => void;
  onSaved: () => void;
}

export const AddBankModal: React.FC<AddBankModalProps> = ({ propertyId, onClose, onSaved }) => {
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [balance, setBalance] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bankName.trim()) {
      setError('Nama Bank wajib diisi.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/reports/accounting/banks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          bank_name: bankName.trim(),
          account_number: accountNumber.trim() || '-',
          account_holder: accountHolder.trim() || '-',
          balance: Number(balance || 0),
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menambah bank');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menambah bank');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 bg-[#123524] text-white">
          <h3 className="text-base font-bold">+ Tambah Rekening Bank</h3>
          <button onClick={onClose} className="text-white/75 hover:text-white">
            <IconX className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Bank / Kas</label>
            <input
              type="text"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="Contoh: BCA Corporate / Mandiri"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">No. Rekening</label>
            <input
              type="text"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder="Contoh: 0123456789"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Atas Nama</label>
            <input
              type="text"
              value={accountHolder}
              onChange={(e) => setAccountHolder(e.target.value)}
              placeholder="Contoh: PT OAK Lawang"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Saldo Saat Ini (Rp)</label>
            <input
              type="number"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-100"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-[#123524] hover:bg-emerald-900 text-[#E6C786] font-bold shadow-xs disabled:opacity-50"
            >
              {saving ? 'Menyimpan...' : 'Simpan Bank'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export interface InvestorTransferModalProps {
  propertyId: number;
  banks: BankListItem[];
  defaultDate: string;
  onClose: () => void;
  onSaved: () => void;
}

export const InvestorTransferModal: React.FC<InvestorTransferModalProps> = ({
  propertyId,
  banks,
  defaultDate,
  onClose,
  onSaved,
}) => {
  const selectableBanks = banks.filter((b) => b.method_code !== 'AR');
  const [sourceAccount, setSourceAccount] = useState(
    selectableBanks[0]?.method_code || selectableBanks[0]?.bank_name || 'CASH'
  );
  const [investorName, setInvestorName] = useState('');
  const [amount, setAmount] = useState('');
  const [transferDate, setTransferDate] = useState(defaultDate);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceAccount || !investorName.trim() || !(Number(amount) > 0)) {
      setError('Pilih akun sumber, isi nama investor, dan masukkan jumlah > 0.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/reports/accounting/investor-transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          source_account: sourceAccount,
          investor_name: investorName.trim(),
          amount: Number(amount),
          transfer_date: transferDate,
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal mencatat transfer investor');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal mencatat transfer investor');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 bg-[#123524] text-white">
          <div>
            <h3 className="text-base font-bold">Transfer ke Investor</h3>
            <p className="text-[11px] text-emerald-100/80 mt-0.5">
              Tarik saldo dari akun Kas & Bank untuk ditransfer ke investor. Saldo akun akan berkurang.
            </p>
          </div>
          <button onClick={onClose} className="text-white/75 hover:text-white">
            <IconX className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Dari Akun</label>
            <select
              value={sourceAccount}
              onChange={(e) => setSourceAccount(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            >
              {selectableBanks.map((b) => {
                const val = b.method_code || b.bank_name;
                return (
                  <option key={b.id} value={val}>
                    {b.bank_name} — Saldo: {formatIdr(b.balance)}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Investor</label>
            <input
              type="text"
              value={investorName}
              onChange={(e) => setInvestorName(e.target.value)}
              placeholder="Contoh: Pak Ahmad"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Jumlah (Rp)</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Tanggal</label>
            <input
              type="date"
              value={transferDate}
              onChange={(e) => setTransferDate(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Keterangan (opsional)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Contoh: Bagi hasil bulan ini"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-100"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-[#123524] hover:bg-emerald-900 text-[#E6C786] font-bold shadow-xs disabled:opacity-50"
            >
              {saving ? 'Memproses...' : 'Transfer ke Investor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// ADD / EDIT ASSET MODAL + FOTO (UPLOAD & KAMERA) + MEREK & NO SERI
// ============================================================================

export interface AddAssetModalProps {
  propertyId: number;
  defaultDate: string;
  initialAsset?: FixedAssetItem | null;
  categories?: Array<{ id: number; category_name: string; is_system: boolean }>;
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_CATEGORIES = [
  'PERALATAN',
  'ELEKTRONIK',
  'FURNITURE & INTERIOR',
  'KENDARAAN',
  'BANGUNAN & RENOVASI',
];

const DEFAULT_STORAGE_LOCATIONS = [
  'LOBBY & RESEPSIONIS',
  'KANTOR FRONT OFFICE',
  'GUDANG HOUSEKEEPING',
  'DAPUR / RESTORAN',
  'KAMAR TAMU',
  'RUANG SERVER / BACK OFFICE',
  'AREA PARKIR / OUTDOOR',
];

export const AddAssetModal: React.FC<AddAssetModalProps> = ({
  propertyId,
  defaultDate,
  initialAsset,
  categories,
  onClose,
  onSaved,
}) => {
  const isEdit = Boolean(initialAsset && initialAsset.id);
  const categoryList =
    categories && categories.length > 0
      ? categories
      : DEFAULT_CATEGORIES.map((c, idx) => ({ id: -(idx + 1), category_name: c, is_system: true }));

  const [assetCode, setAssetCode] = useState(initialAsset?.asset_code || '');
  const [assetName, setAssetName] = useState(initialAsset?.asset_name || '');
  const [brand, setBrand] = useState(
    initialAsset?.brand && initialAsset.brand !== '-' ? initialAsset.brand : ''
  );
  const [serialNumber, setSerialNumber] = useState(
    initialAsset?.serial_number && initialAsset.serial_number !== '-'
      ? initialAsset.serial_number
      : ''
  );
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(
    initialAsset?.photo_data_url || null
  );
  const [category, setCategory] = useState(
    initialAsset?.category || categoryList[0]?.category_name || 'PERALATAN'
  );
  const [storageLocation, setStorageLocation] = useState(
    initialAsset?.storage_location && initialAsset.storage_location !== '-'
      ? initialAsset.storage_location
      : ''
  );
  const [purchaseDate, setPurchaseDate] = useState(
    initialAsset?.purchase_date ? String(initialAsset.purchase_date).slice(0, 10) : defaultDate
  );
  const [purchasePriceText, setPurchasePriceText] = useState(
    initialAsset?.purchase_price ? formatRibuanInput(initialAsset.purchase_price) : ''
  );
  const [currentValueText, setCurrentValueText] = useState(
    initialAsset?.current_value !== undefined && initialAsset?.current_value !== null
      ? formatRibuanInput(initialAsset.current_value)
      : ''
  );
  const [depreciationRate, setDepreciationRate] = useState(
    String(initialAsset?.depreciation_rate ?? 0)
  );
  const [notes, setNotes] = useState(initialAsset?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Photo upload & live camera refs/states
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraFallbackInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
  };

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setError(null);
      const dataUrl = await compressImageBlobToDataUrl(file);
      setPhotoDataUrl(dataUrl);
    } catch (err: any) {
      setError(err.message || 'Gagal memuat foto aset');
    }
  };

  const handleOpenCamera = async () => {
    setError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFallbackInputRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 60);
    } catch {
      cameraFallbackInputRef.current?.click();
    }
  };

  const handleCaptureCameraFrame = () => {
    const video = videoRef.current;
    if (!video) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const maxDim = 720;
    let w = vw;
    let h = vh;
    if (w > maxDim || h > maxDim) {
      if (w >= h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      setPhotoDataUrl(dataUrl);
    }
    stopCameraStream();
  };

  // Kelola Kategori state
  const [showManageCategory, setShowManageCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [catBusy, setCatBusy] = useState(false);

  const handleAddCategory = async () => {
    const trimmed = newCategoryName.trim().toUpperCase();
    if (!trimmed) return;
    setCatBusy(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/reports/accounting/asset-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, category_name: trimmed }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menambah kategori');
      }
      setCategory(trimmed);
      setNewCategoryName('');
      onSaved();
    } catch (err: any) {
      setError(err.message || 'Gagal menambah kategori');
    } finally {
      setCatBusy(false);
    }
  };

  const handleDeleteCategory = async (id: number, name: string) => {
    setCatBusy(true);
    setError(null);
    try {
      const targetId = id > 0 ? id : 0;
      const res = await authenticatedFetch(
        `/api/reports/accounting/asset-categories/${targetId}?name=${encodeURIComponent(name)}`,
        {
          method: 'DELETE',
        }
      );
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menghapus kategori');
      }
      if (category === name) {
        const remaining = categoryList.filter((c) => c.category_name !== name);
        setCategory(remaining[0]?.category_name || 'PERALATAN');
      }
      onSaved();
    } catch (err: any) {
      setError(err.message || 'Gagal menghapus kategori');
    } finally {
      setCatBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assetName.trim()) {
      setError('Nama barang wajib diisi.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const priceNum = parseRibuanInput(purchasePriceText);
      const curValNum = currentValueText.trim() !== '' ? parseRibuanInput(currentValueText) : priceNum;
      const endpoint = isEdit
        ? `/api/reports/accounting/assets/${initialAsset!.id}`
        : '/api/reports/accounting/assets';
      const method = isEdit ? 'PUT' : 'POST';

      const res = await authenticatedFetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          asset_code: assetCode.trim().toUpperCase() || null,
          asset_name: assetName.trim().toUpperCase(),
          brand: brand.trim().toUpperCase() || '-',
          serial_number: serialNumber.trim().toUpperCase() || '-',
          photo_data_url: photoDataUrl,
          category: category.trim().toUpperCase(),
          storage_location: storageLocation.trim().toUpperCase() || '-',
          purchase_date: purchaseDate,
          purchase_price: priceNum,
          current_value: curValNum,
          depreciation_rate: Number(depreciationRate || 0),
          status: 'ACTIVE',
          notes: notes.trim().toUpperCase() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menyimpan aset');
      }
      stopCameraStream();
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan aset');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 bg-[#123524] text-white shrink-0">
          <h3 className="text-base font-bold">{isEdit ? 'Edit Aset Tetap' : 'Tambah Aset'}</h3>
          <button
            type="button"
            onClick={() => {
              stopCameraStream();
              onClose();
            }}
            className="text-white/75 hover:text-white cursor-pointer"
          >
            <IconX className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm overflow-y-auto">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}

          {/* 0. Foto / Gambar Aset (Ikon Kotak seperti Gambar 2 + Upload & Kamera) */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Foto / Gambar Aset
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <input
              ref={cameraFallbackInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              className="hidden"
            />

            {cameraOpen ? (
              <div className="p-3 rounded-xl border border-emerald-300 bg-slate-900 text-white space-y-2.5">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full max-h-56 object-contain rounded-lg bg-black"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={stopCameraStream}
                    className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold cursor-pointer"
                  >
                    Batal Kamera
                  </button>
                  <button
                    type="button"
                    onClick={handleCaptureCameraFrame}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    Ambil Foto
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3.5 p-3 rounded-xl border border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Klik untuk pilih foto aset"
                  className="w-16 h-16 rounded-2xl border-2 border-dashed border-slate-300 hover:border-emerald-700 bg-slate-50/70 flex items-center justify-center overflow-hidden shrink-0 transition cursor-pointer group"
                >
                  {photoDataUrl ? (
                    <img
                      src={photoDataUrl}
                      alt="Foto Aset"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="w-7 h-7 text-slate-400 group-hover:text-emerald-800 transition" />
                  )}
                </button>
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold transition cursor-pointer"
                    >
                      <Upload className="w-3.5 h-3.5 text-emerald-800" />
                      Upload Foto
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenCamera}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-800/30 bg-emerald-50/70 hover:bg-emerald-100 text-[#123524] text-xs font-bold transition cursor-pointer"
                    >
                      <Camera className="w-3.5 h-3.5 text-emerald-800" />
                      Buka Kamera
                    </button>
                    {photoDataUrl && (
                      <button
                        type="button"
                        onClick={() => setPhotoDataUrl(null)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold transition cursor-pointer"
                        title="Hapus Foto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Bisa unggah file gambar (JPG/PNG) atau ambil foto langsung dari kamera perangkat.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 1. Kode Aset & Tanggal Beli */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Kode Aset</label>
              <input
                type="text"
                value={assetCode}
                onChange={(e) => setAssetCode(e.target.value.toUpperCase())}
                placeholder="Contoh: AST-001 (kosongkan = otomatis)"
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 uppercase"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Tanggal Beli</label>
              <input
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
              />
            </div>
          </div>

          {/* 2. Kategori + Kelola Kategori */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Kategori</label>
            <div className="flex items-center gap-2">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="flex-1 min-w-0 px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
              >
                {categoryList.map((cat) => (
                  <option key={cat.category_name} value={cat.category_name}>
                    {cat.category_name}
                  </option>
                ))}
              </select>
              {/* Ikon Kelola Kategori (Sliders Horizontal button) */}
              <button
                type="button"
                onClick={() => setShowManageCategory((v) => !v)}
                title="Kelola Kategori Aset"
                className={`w-9 h-9 rounded-xl border flex items-center justify-center transition shrink-0 cursor-pointer ${
                  showManageCategory
                    ? 'bg-[#123524] text-[#E6C786] border-[#123524]'
                    : 'bg-cyan-50/90 hover:bg-cyan-100 text-slate-800 border-cyan-200'
                }`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-4 h-4"
                >
                  <line x1="4" x2="10" y1="8" y2="8" />
                  <line x1="14" x2="20" y1="8" y2="8" />
                  <circle cx="12" cy="8" r="2" />
                  <line x1="4" x2="12" y1="16" y2="16" />
                  <line x1="16" x2="20" y1="16" y2="16" />
                  <circle cx="14" cy="16" r="2" />
                </svg>
              </button>
            </div>
          </div>

          {/* Panel Kelola Kategori Aset */}
          {showManageCategory && (
            <div className="p-3.5 rounded-xl bg-emerald-50/60 border border-emerald-200 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#123524]">Kelola Kategori Aset</span>
                <button
                  type="button"
                  onClick={() => setShowManageCategory(false)}
                  className="text-[11px] text-slate-500 hover:text-slate-800 font-semibold"
                >
                  Tutup
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value.toUpperCase())}
                  placeholder="Nama kategori baru (misal: LINEN & BEDDING)..."
                  className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-800 uppercase"
                />
                <button
                  type="button"
                  disabled={catBusy || !newCategoryName.trim()}
                  onClick={handleAddCategory}
                  className="px-3 py-1.5 rounded-lg bg-[#123524] text-[#E6C786] text-xs font-bold disabled:opacity-50"
                >
                  + Tambah
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {categoryList.map((cat) => (
                  <span
                    key={cat.category_name}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-emerald-200 text-xs font-semibold text-slate-700"
                  >
                    <span>{cat.category_name}</span>
                    <button
                      type="button"
                      disabled={catBusy}
                      onClick={() => handleDeleteCategory(cat.id, cat.category_name)}
                      className="text-rose-500 hover:text-rose-700 font-bold leading-none cursor-pointer"
                      title={`Hapus kategori ${cat.category_name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 3. Nama Barang */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Barang *</label>
            <input
              type="text"
              value={assetName}
              onChange={(e) => setAssetName(e.target.value.toUpperCase())}
              placeholder="Contoh: AC KAMAR, KASUR, TV, DLL"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 uppercase"
            />
          </div>

          {/* 4. Merek & No. Seri */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Merek</label>
              <input
                type="text"
                value={brand}
                onChange={(e) => setBrand(e.target.value.toUpperCase())}
                placeholder="Contoh: DAIKIN, SAMSUNG, KING KOIL..."
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 uppercase"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">No. Seri</label>
              <input
                type="text"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value.toUpperCase())}
                placeholder="Contoh: SN-9928371..."
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 uppercase"
              />
            </div>
          </div>

          {/* 5. Lokasi Penyimpanan */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Lokasi Penyimpanan
            </label>
            <input
              type="text"
              list="oak-asset-storage-locations"
              value={storageLocation}
              onChange={(e) => setStorageLocation(e.target.value.toUpperCase())}
              placeholder="Contoh: KAMAR 101, LOBBY, GUDANG HK, DAPUR..."
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 uppercase"
            />
            <datalist id="oak-asset-storage-locations">
              {DEFAULT_STORAGE_LOCATIONS.map((loc) => (
                <option key={loc} value={loc} />
              ))}
            </datalist>
          </div>

          {/* 6 & 7. Harga Beli & Nilai Saat Ini (Format Titik Ribuan 1.000 / 100.000) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Harga Beli (Rp)</label>
              <input
                type="text"
                inputMode="numeric"
                value={purchasePriceText}
                onChange={(e) => {
                  const formatted = formatRibuanInput(e.target.value);
                  setPurchasePriceText(formatted);
                  if (currentValueText === '') setCurrentValueText(formatted);
                }}
                placeholder="Contoh: 1.500.000"
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 font-semibold"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Nilai Saat Ini (Rp)</label>
              <input
                type="text"
                inputMode="numeric"
                value={currentValueText}
                onChange={(e) => setCurrentValueText(formatRibuanInput(e.target.value))}
                placeholder="Kosongkan = harga beli"
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 font-semibold"
              />
            </div>
          </div>

          {/* 8. Depresiasi */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Depresiasi (%/tahun)</label>
            <input
              type="number"
              step="0.1"
              value={depreciationRate}
              onChange={(e) => setDepreciationRate(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>

          {/* 9. Catatan */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Catatan</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value.toUpperCase())}
              placeholder="Catatan tambahan..."
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 uppercase"
            />
          </div>
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                stopCameraStream();
                onClose();
              }}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-100 cursor-pointer"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-[#123524] hover:bg-emerald-900 text-[#E6C786] font-bold shadow-xs disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Menyimpan...' : isEdit ? 'Simpan Perubahan' : 'Simpan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// QUICK ASSET PHOTO UPLOAD / CAMERA MODAL (KLIK LANGSUNG DARI TABEL ASET)
// ============================================================================

export interface AssetPhotoQuickModalProps {
  propertyId: number;
  asset: FixedAssetItem;
  onClose: () => void;
  onSaved: () => void;
}

export const AssetPhotoQuickModal: React.FC<AssetPhotoQuickModalProps> = ({
  propertyId,
  asset,
  onClose,
  onSaved,
}) => {
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(asset.photo_data_url || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraFallbackInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraOpen(false);
  };

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, []);

  const savePhotoToServer = async (nextDataUrl: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const res = await authenticatedFetch(`/api/reports/accounting/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          photo_data_url: nextDataUrl,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menyimpan foto aset');
      }
      setPhotoDataUrl(nextDataUrl);
      stopCameraStream();
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan foto aset');
    } finally {
      setSaving(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setError(null);
      const dataUrl = await compressImageBlobToDataUrl(file);
      await savePhotoToServer(dataUrl);
    } catch (err: any) {
      setError(err.message || 'Gagal memproses foto');
    }
  };

  const handleOpenCamera = async () => {
    setError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFallbackInputRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 60);
    } catch {
      cameraFallbackInputRef.current?.click();
    }
  };

  const handleCaptureAndSave = async () => {
    const video = videoRef.current;
    if (!video) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const maxDim = 720;
    let w = vw;
    let h = vh;
    if (w > maxDim || h > maxDim) {
      if (w >= h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      stopCameraStream();
      await savePhotoToServer(dataUrl);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 bg-[#123524] text-white">
          <div>
            <h3 className="text-sm font-bold">Foto / Gambar Aset</h3>
            <p className="text-[11px] text-[#E6C786] font-semibold">
              {asset.asset_code || `AST-${String(asset.id).padStart(4, '0')}`} · {asset.asset_name}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCameraStream();
              onClose();
            }}
            className="text-white/75 hover:text-white cursor-pointer"
          >
            <IconX className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-sm">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
          <input
            ref={cameraFallbackInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />

          {cameraOpen ? (
            <div className="p-3 rounded-xl border border-emerald-300 bg-slate-900 text-white space-y-3">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full max-h-64 object-contain rounded-lg bg-black"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={stopCameraStream}
                  className="px-3.5 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleCaptureAndSave}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  <Camera className="w-4 h-4" />
                  {saving ? 'Menyimpan...' : 'Ambil & Simpan Foto'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-56 rounded-2xl border-2 border-dashed border-slate-300 hover:border-emerald-700 bg-white flex flex-col items-center justify-center overflow-hidden cursor-pointer transition group"
              >
                {photoDataUrl ? (
                  <img
                    src={photoDataUrl}
                    alt={asset.asset_name}
                    className="w-full h-full object-contain bg-slate-950/5"
                  />
                ) : (
                  <div className="text-center space-y-2 p-4">
                    <div className="w-14 h-14 rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-center mx-auto group-hover:border-emerald-600 transition">
                      <ImageIcon className="w-7 h-7 text-slate-400 group-hover:text-emerald-800" />
                    </div>
                    <div className="text-xs font-bold text-slate-700">
                      Belum ada foto untuk aset ini
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Klik di sini untuk upload gambar atau gunakan tombol kamera di bawah
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-bold shadow-2xs transition cursor-pointer disabled:opacity-50"
                >
                  <Upload className="w-4 h-4 text-emerald-800" />
                  {photoDataUrl ? 'Ganti Foto (Upload)' : 'Upload Foto'}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleOpenCamera}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-2xs transition cursor-pointer disabled:opacity-50"
                >
                  <Camera className="w-4 h-4" />
                  Buka Kamera
                </button>
                {photoDataUrl && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => savePhotoToServer(null)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold transition cursor-pointer disabled:opacity-50"
                    title="Hapus Foto Aset"
                  >
                    <Trash2 className="w-4 h-4" />
                    Hapus Foto
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export interface AddPayableOrReceivableModalProps {
  mode: 'PAYABLE' | 'RECEIVABLE';
  propertyId: number;
  onClose: () => void;
  onSaved: () => void;
}

export const AddPayableOrReceivableModal: React.FC<AddPayableOrReceivableModalProps> = ({
  mode,
  propertyId,
  onClose,
  onSaved,
}) => {
  const isPayable = mode === 'PAYABLE';
  const [partyName, setPartyName] = useState('');
  const [transactionNo, setTransactionNo] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [paidAmount, setPaidAmount] = useState('0');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partyName.trim() || !(Number(totalAmount) > 0)) {
      setError(`${isPayable ? 'Nama Supplier' : 'Nama Pelanggan'} dan Total Tagihan (> 0) wajib diisi.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const endpoint = isPayable
        ? '/api/reports/accounting/payables'
        : '/api/reports/accounting/receivables';
      const payload = isPayable
        ? {
            property_id: propertyId,
            supplier_name: partyName.trim(),
            transaction_no: transactionNo.trim(),
            total_amount: Number(totalAmount),
            paid_amount: Number(paidAmount || 0),
            due_date: dueDate || null,
            notes: notes.trim() || null,
          }
        : {
            property_id: propertyId,
            customer_name: partyName.trim(),
            transaction_no: transactionNo.trim(),
            total_amount: Number(totalAmount),
            paid_amount: Number(paidAmount || 0),
            due_date: dueDate || null,
            notes: notes.trim() || null,
          };
      const res = await authenticatedFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menyimpan data');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan data');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 bg-[#123524] text-white">
          <h3 className="text-base font-bold">
            {isPayable ? '+ Tambah Hutang Usaha' : '+ Tambah Piutang Manual'}
          </h3>
          <button onClick={onClose} className="text-white/75 hover:text-white">
            <IconX className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {isPayable ? 'Nama Supplier / Kreditur *' : 'Nama Pelanggan / Debitur *'}
            </label>
            <input
              type="text"
              value={partyName}
              onChange={(e) => setPartyName(e.target.value)}
              placeholder={isPayable ? 'Contoh: CV Sumber Makmur' : 'Contoh: PT Mitra Karya'}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              No. Transaksi / Referensi (opsional)
            </label>
            <input
              type="text"
              value={transactionNo}
              onChange={(e) => setTransactionNo(e.target.value)}
              placeholder="Otomatis jika dikosongkan"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Total Tagihan (Rp) *</label>
              <input
                type="number"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                placeholder="0"
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                {isPayable ? 'Sudah Dibayar (Rp)' : 'Sudah Diterima (Rp)'}
              </label>
              <input
                type="number"
                value={paidAmount}
                onChange={(e) => setPaidAmount(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Jatuh Tempo</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Catatan</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Keterangan tambahan..."
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-100"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-[#123524] hover:bg-emerald-900 text-[#E6C786] font-bold shadow-xs disabled:opacity-50"
            >
              {saving ? 'Menyimpan...' : 'Simpan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// POPUP MODAL BAYAR HUTANG / TERIMA PIUTANG (SESUAI REFERENSI GAMBAR 2 ANKA)
// ============================================================================

export interface SettlePaymentModalProps {
  mode: 'PAYABLE' | 'RECEIVABLE';
  propertyId: number;
  item: AccountingPayableItem | AccountingReceivableItem;
  onClose: () => void;
  onSaved: () => void;
}

export const SettlePaymentModal: React.FC<SettlePaymentModalProps> = ({
  mode,
  propertyId,
  item,
  onClose,
  onSaved,
}) => {
  const isPayable = mode === 'PAYABLE';
  const partyName = isPayable
    ? (item as AccountingPayableItem).supplier_name
    : (item as AccountingReceivableItem).customer_name;
  const remaining = Math.max(0, Number(item.remaining_amount || 0));
  const [payAmount, setPayAmount] = useState(String(remaining));
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [proofFile, setProofFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const numAmt = Math.round(Number(payAmount || 0));
    if (!(numAmt > 0)) {
      setError('Jumlah pembayaran harus lebih besar dari Rp 0.');
      return;
    }
    if (numAmt > remaining) {
      setError(`Jumlah pembayaran tidak boleh melebihi sisa tagihan (${formatIdr(remaining)}).`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const endpoint = isPayable
        ? `/api/reports/accounting/payables/${encodeURIComponent(item.id)}/settle`
        : `/api/reports/accounting/receivables/${encodeURIComponent(item.id)}/settle`;
      let res: Response;
      if (proofFile) {
        const formData = new FormData();
        formData.append('property_id', String(propertyId));
        formData.append('amount', String(numAmt));
        formData.append('payment_method', paymentMethod);
        formData.append('file', proofFile);
        res = await authenticatedFetch(endpoint, {
          method: 'POST',
          body: formData,
        });
      } else {
        res = await authenticatedFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            amount: numAmt,
            payment_method: paymentMethod,
          }),
        });
      }
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal memproses pembayaran');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal memproses pembayaran');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <div>
            <h3 className="text-base font-extrabold text-slate-900">
              {isPayable ? `Bayar Hutang – ${partyName}` : `Terima Piutang – ${partyName}`}
            </h3>
            <div className="text-xs font-semibold text-slate-500 mt-1">
              Sisa:{' '}
              <span className="text-rose-600 font-extrabold">
                {formatIdr(remaining)}
              </span>{' '}
              <span className="text-slate-400">({item.transaction_no})</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 rounded-lg"
          >
            <IconX className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6 pt-3 space-y-4 text-sm">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Jumlah Pembayaran
            </label>
            <input
              type="number"
              autoFocus
              min={1}
              max={remaining}
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder={String(remaining)}
              className="w-full px-3.5 py-2.5 rounded-xl border-2 border-emerald-700/70 bg-white text-slate-900 font-bold focus:outline-hidden focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Metode Pembayaran
            </label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-800 font-medium"
            >
              <option value="CASH">Cash / Tunai</option>
              <option value="TRANSFER">Transfer Bank</option>
              <option value="QRIS">QRIS</option>
            </select>
          </div>

          {/* Upload Bukti Pembayaran / Kwitansi */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Upload Bukti Bayar <span className="text-slate-400 font-normal">(Opsional - Foto / PDF)</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0] || null;
                setProofFile(file);
              }}
              className="hidden"
              id="settle-proof-file"
            />
            {proofFile ? (
              <div className="flex items-center justify-between p-2.5 bg-emerald-50 border border-emerald-300 rounded-xl text-xs">
                <div className="flex items-center gap-2 truncate text-emerald-900 font-semibold">
                  <span className="shrink-0 font-bold text-emerald-700">✓</span>
                  <span className="truncate">{proofFile.name}</span>
                  <span className="shrink-0 text-[10px] text-emerald-600 font-normal">
                    ({(proofFile.size / 1024).toFixed(0)} KB)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setProofFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  className="shrink-0 ml-2 text-rose-600 hover:text-rose-800 text-[11px] font-bold cursor-pointer"
                >
                  Hapus
                </button>
              </div>
            ) : (
              <label
                htmlFor="settle-proof-file"
                className="flex items-center justify-center gap-2 px-3.5 py-3 rounded-xl border-2 border-dashed border-emerald-800/25 bg-emerald-50/30 hover:bg-emerald-50/60 text-slate-700 text-xs font-semibold cursor-pointer transition-colors"
              >
                <Upload className="w-4 h-4 text-emerald-800" />
                <span>Pilih file bukti transfer / kwitansi</span>
              </label>
            )}
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 rounded-xl bg-[#123524] hover:bg-emerald-900 text-[#E6C786] font-extrabold text-sm shadow-sm transition disabled:opacity-50 cursor-pointer"
          >
            {saving ? 'Memproses Pembayaran...' : 'Konfirmasi Pembayaran'}
          </button>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// POPUP MODAL KONFIRMASI HAPUS (MENGGANTIKAN WINDOW.CONFIRM)
// ============================================================================

export interface ConfirmDeleteModalProps {
  title: string;
  description: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ConfirmDeleteModal: React.FC<ConfirmDeleteModalProps> = ({
  title,
  description,
  busy,
  onCancel,
  onConfirm,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-extrabold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-700"
          >
            <IconX className="w-5 h-5" />
          </button>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">{description}</p>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-100"
          >
            Batal
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-xs disabled:opacity-50"
          >
            {busy ? 'Menghapus...' : 'Ya, Hapus'}
          </button>
        </div>
      </div>
    </div>
  );
};
