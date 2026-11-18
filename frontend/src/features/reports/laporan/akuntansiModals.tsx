import React, { useState } from 'react';
import { authenticatedFetch } from '../../../lib/authenticatedFetch';
import { IconX } from './LaporanIcons';
import { formatIdr } from './laporanUi';
import type {
  AccountingPayableItem,
  AccountingReceivableItem,
  BankListItem,
  CoaAccountItem,
} from './laporanTypes';

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
// ADD ASSET MODAL + KELOLA KATEGORI (WITH SLIDERS ICON) + LOKASI PENYIMPANAN
// ============================================================================

export interface AddAssetModalProps {
  propertyId: number;
  defaultDate: string;
  categories?: Array<{ id: number; category_name: string; is_system: boolean }>;
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_CATEGORIES = [
  'Peralatan',
  'Elektronik',
  'Furniture & Interior',
  'Kendaraan',
  'Bangunan & Renovasi',
];

const DEFAULT_STORAGE_LOCATIONS = [
  'Lobby & Resepsionis',
  'Kantor Front Office',
  'Gudang Housekeeping',
  'Dapur / Restoran',
  'Kamar Tamu',
  'Ruang Server / Back Office',
  'Area Parkir / Outdoor',
];

export const AddAssetModal: React.FC<AddAssetModalProps> = ({
  propertyId,
  defaultDate,
  categories,
  onClose,
  onSaved,
}) => {
  const categoryList =
    categories && categories.length > 0
      ? categories
      : DEFAULT_CATEGORIES.map((c, idx) => ({ id: -(idx + 1), category_name: c, is_system: true }));

  const [assetCode, setAssetCode] = useState('');
  const [assetName, setAssetName] = useState('');
  const [category, setCategory] = useState(categoryList[0]?.category_name || 'Peralatan');
  const [storageLocation, setStorageLocation] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(defaultDate);
  const [purchasePrice, setPurchasePrice] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [depreciationRate, setDepreciationRate] = useState('0');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Kelola Kategori state
  const [showManageCategory, setShowManageCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [catBusy, setCatBusy] = useState(false);

  const handleAddCategory = async () => {
    const trimmed = newCategoryName.trim();
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
        setCategory(remaining[0]?.category_name || 'Peralatan');
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
      const priceNum = Number(purchasePrice || 0);
      const curValNum = currentValue !== '' ? Number(currentValue) : priceNum;
      const res = await authenticatedFetch('/api/reports/accounting/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          asset_code: assetCode.trim() || null,
          asset_name: assetName.trim(),
          category,
          storage_location: storageLocation.trim() || '-',
          purchase_date: purchaseDate,
          purchase_price: priceNum,
          current_value: curValNum,
          depreciation_rate: Number(depreciationRate || 0),
          status: 'ACTIVE',
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal menambah aset');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menambah aset');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 bg-[#123524] text-white shrink-0">
          <h3 className="text-base font-bold">Tambah Aset</h3>
          <button onClick={onClose} className="text-white/75 hover:text-white">
            <IconX className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm overflow-y-auto">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}

          {/* 1. Kode Aset & Tanggal Beli */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Kode Aset</label>
              <input
                type="text"
                value={assetCode}
                onChange={(e) => setAssetCode(e.target.value)}
                placeholder="Contoh: AST-001 (kosongkan = otomatis)"
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
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
              {/* Ikon Kelola Kategori (Gambar 2 — Sliders Horizontal button) */}
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

          {/* Panel Kelola Kategori Aset (Semua kategori punya ikon x untuk hapus) */}
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
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="Nama kategori baru (misal: Linen & Bedding)..."
                  className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-800"
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
              onChange={(e) => setAssetName(e.target.value)}
              placeholder="Contoh: AC Kamar, Kasur, TV, dll"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>

          {/* 4. Lokasi Penyimpanan */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Lokasi Penyimpanan
            </label>
            <input
              type="text"
              list="oak-asset-storage-locations"
              value={storageLocation}
              onChange={(e) => setStorageLocation(e.target.value)}
              placeholder="Contoh: Kamar 101, Lobby, Gudang HK, Dapur..."
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
            <datalist id="oak-asset-storage-locations">
              {DEFAULT_STORAGE_LOCATIONS.map((loc) => (
                <option key={loc} value={loc} />
              ))}
            </datalist>
          </div>

          {/* 5 & 6. Harga Beli & Nilai Saat Ini */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Harga Beli (Rp)</label>
              <input
                type="number"
                value={purchasePrice}
                onChange={(e) => {
                  setPurchasePrice(e.target.value);
                  if (currentValue === '') setCurrentValue(e.target.value);
                }}
                placeholder="0"
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Nilai Saat Ini (Rp)</label>
              <input
                type="number"
                value={currentValue}
                onChange={(e) => setCurrentValue(e.target.value)}
                placeholder="Kosongkan = harga beli"
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
              />
            </div>
          </div>

          {/* 7. Depresiasi */}
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

          {/* 8. Catatan */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Catatan</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Catatan tambahan..."
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
      const res = await authenticatedFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          amount: numAmt,
          payment_method: paymentMethod,
        }),
      });
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
