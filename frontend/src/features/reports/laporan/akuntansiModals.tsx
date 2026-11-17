import React, { useState } from 'react';
import { IconX } from './LaporanIcons';
import { formatIdr } from './laporanUi';
import type { BankListItem, CoaAccountItem } from './laporanTypes';

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
      const res = await fetch('/api/reports/accounting/coa', {
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
      const res = await fetch('/api/reports/accounting/banks', {
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
      const res = await fetch('/api/reports/accounting/investor-transfers', {
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

export interface AddAssetModalProps {
  propertyId: number;
  defaultDate: string;
  onClose: () => void;
  onSaved: () => void;
}

export const AddAssetModal: React.FC<AddAssetModalProps> = ({
  propertyId,
  defaultDate,
  onClose,
  onSaved,
}) => {
  const [assetName, setAssetName] = useState('');
  const [category, setCategory] = useState('Peralatan');
  const [purchaseDate, setPurchaseDate] = useState(defaultDate);
  const [purchasePrice, setPurchasePrice] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [depreciationRate, setDepreciationRate] = useState('0');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assetName.trim()) {
      setError('Nama aset wajib diisi.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const priceNum = Number(purchasePrice || 0);
      const curValNum = currentValue !== '' ? Number(currentValue) : priceNum;
      const res = await fetch('/api/reports/accounting/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          asset_name: assetName.trim(),
          category,
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
      <div className="bg-[#FDFBF7] border border-emerald-900/15 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 bg-[#123524] text-white">
          <h3 className="text-base font-bold">Tambah Aset</h3>
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
            <label className="block text-xs font-semibold text-slate-700 mb-1">Nama Aset *</label>
            <input
              type="text"
              value={assetName}
              onChange={(e) => setAssetName(e.target.value)}
              placeholder="Contoh: AC Kamar, Kasur, TV, dll"
              className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Kategori</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-slate-800"
              >
                <option value="Peralatan">Peralatan</option>
                <option value="Elektronik">Elektronik</option>
                <option value="Furniture & Interior">Furniture & Interior</option>
                <option value="Kendaraan">Kendaraan</option>
                <option value="Bangunan & Renovasi">Bangunan & Renovasi</option>
              </select>
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
      const res = await fetch(endpoint, {
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
