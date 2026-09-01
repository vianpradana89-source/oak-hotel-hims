import React, { useState, useEffect } from 'react';
import type { Supplier, SupplierEntityType } from './transactionDomainTypes';
import { fetchSuppliersApi, createSupplierApi } from './transactionClient';

interface SupplierSelectorModalProps {
  isOpen: boolean;
  propertyId: number;
  actorName?: string;
  selectedSupplierId?: string | number | null;
  onSelect: (supplier: Supplier) => void;
  onClose: () => void;
}

export const SupplierSelectorModal: React.FC<SupplierSelectorModalProps> = ({
  isOpen,
  propertyId,
  actorName = 'Staff',
  selectedSupplierId,
  onSelect,
  onClose
}) => {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Form State for new supplier
  const [newEntityType, setNewEntityType] = useState<SupplierEntityType>('SUPPLIER');
  const [newName, setNewName] = useState('');
  const [newContactPerson, setNewContactPerson] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newBankName, setNewBankName] = useState('');
  const [newBankAccount, setNewBankAccount] = useState('');
  const [newBankHolder, setNewBankHolder] = useState('');
  const [newTaxId, setNewTaxId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadSuppliers();
      setShowCreateForm(false);
      setError(null);
    }
  }, [isOpen, propertyId]);

  const loadSuppliers = async () => {
    setLoading(true);
    try {
      const data = await fetchSuppliersApi({
        property_id: propertyId,
        is_active: true
      });
      // Explicitly guard: Exclude BLACKLISTED and INACTIVE suppliers from transaction selector
      const activeOnly = data.filter(
        (s) => s.status !== 'BLACKLISTED' && s.is_active !== false
      );
      setSuppliers(activeOnly);
    } catch (err: any) {
      setError(err.message || 'Gagal memuat daftar rekanan supplier');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const filteredSuppliers = suppliers.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      (s.code && s.code.toLowerCase().includes(q)) ||
      (s.legal_name && s.legal_name.toLowerCase().includes(q)) ||
      (s.contact_person && s.contact_person.toLowerCase().includes(q)) ||
      (s.phone && s.phone.toLowerCase().includes(q)) ||
      (s.whatsapp && s.whatsapp.toLowerCase().includes(q)) ||
      (s.bank_account && s.bank_account.toLowerCase().includes(q))
    );
  });

  const handleCreateSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    // Check client-side duplicate name
    const existing = suppliers.find(
      (s) => s.name.trim().toLowerCase() === newName.trim().toLowerCase()
    );
    if (existing) {
      setError(`Supplier dengan nama "${existing.name}" sudah ada.`);
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const created = await createSupplierApi({
        property_id: propertyId,
        entity_type: newEntityType,
        name: newName.trim(),
        contact_person: newContactPerson.trim() || undefined,
        phone: newPhone.trim() || undefined,
        whatsapp: newPhone.trim() || undefined,
        email: newEmail.trim() || undefined,
        address: newAddress.trim() || undefined,
        bank_name: newBankName.trim() || undefined,
        bank_account: newBankAccount.trim() || undefined,
        bank_holder: newBankHolder.trim() || undefined,
        tax_id: newTaxId.trim() || undefined,
        status: 'ACTIVE',
        is_active: true,
        actor_name: actorName,
        created_by: actorName
      });

      onSelect(created);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal membuat data supplier');
    } finally {
      setCreating(false);
    }
  };

  const getEntityBadge = (type?: SupplierEntityType | string | null) => {
    const t = String(type || 'SUPPLIER').toUpperCase();
    if (t === 'VENDOR') return <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.2 rounded font-medium">Vendor</span>;
    if (t === 'BOTH') return <span className="text-[10px] bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.2 rounded font-medium">Barang & Jasa</span>;
    return <span className="text-[10px] bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.2 rounded font-medium">Supplier</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/80">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">Pilih Rekanan (Supplier / Vendor)</h3>
              <p className="text-[11px] text-slate-500">Cari vendor aktif atau tambahkan rekanan baru</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200/60 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0 text-rose-600" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {!showCreateForm ? (
            <>
              {/* Search & Add New Toggle */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <svg className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input
                    type="text"
                    placeholder="Cari kode, nama supplier, PIC, telepon, rekening..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateForm(true);
                    setNewName(search);
                  }}
                  className="px-3.5 py-2 bg-[#1b4332] hover:bg-[#143427] text-white text-xs font-bold rounded-xl flex items-center gap-1.5 shadow-xs transition-colors shrink-0 cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  <span>Tambah</span>
                </button>
              </div>

              {/* List of Suppliers */}
              <div className="space-y-2 mt-3">
                {loading ? (
                  <div className="py-8 text-center text-xs text-slate-400">Memuat data vendor...</div>
                ) : filteredSuppliers.length === 0 ? (
                  <div className="py-8 text-center space-y-2 bg-slate-50/60 rounded-xl border border-dashed border-slate-200 p-4">
                    <p className="text-xs text-slate-500 font-medium">
                      Tidak ditemukan supplier dengan kata kunci "{search}"
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setShowCreateForm(true);
                        setNewName(search);
                      }}
                      className="text-xs text-emerald-700 font-bold hover:underline inline-flex items-center gap-1 cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                      </svg>
                      Daftarkan "{search}" sebagai supplier baru
                    </button>
                  </div>
                ) : (
                  filteredSuppliers.map((sup) => {
                    const isSelected = selectedSupplierId === sup.id;
                    return (
                      <div
                        key={sup.id}
                        onClick={() => {
                          onSelect(sup);
                          onClose();
                        }}
                        className={`p-3 rounded-xl border text-xs cursor-pointer transition-all flex items-center justify-between ${
                          isSelected
                            ? 'bg-emerald-50/60 border-emerald-500 ring-1 ring-emerald-500'
                            : 'bg-white border-slate-200 hover:border-emerald-300 hover:bg-slate-50'
                        }`}
                      >
                        <div className="space-y-0.5 min-w-0 pr-2">
                          <div className="font-bold text-slate-800 text-xs flex items-center gap-2 flex-wrap">
                            {sup.code && (
                              <span className="font-mono text-[11px] bg-stone-100 text-stone-700 px-1.5 py-0.2 rounded border border-stone-200">
                                {sup.code}
                              </span>
                            )}
                            <span className="truncate">{sup.name}</span>
                            {getEntityBadge(sup.entity_type)}
                          </div>

                          <div className="flex items-center gap-2 text-[11px] text-slate-500 flex-wrap">
                            {sup.contact_person && (
                              <span>PIC: {sup.contact_person}</span>
                            )}
                            {(sup.whatsapp || sup.phone) && (
                              <span>• {sup.whatsapp || sup.phone}</span>
                            )}
                            {sup.city && (
                              <span>• {sup.city}</span>
                            )}
                          </div>

                          {(sup.bank_name || sup.bank_account) && (
                            <div className="text-[10px] text-slate-400">
                              Rek: {sup.bank_name} {sup.bank_account} {sup.bank_holder ? `(a/n ${sup.bank_holder})` : ''}
                            </div>
                          )}
                        </div>

                        {isSelected && (
                          <span className="text-emerald-700 font-bold text-xs shrink-0">Terpilih</span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            /* Create Form */
            <form onSubmit={handleCreateSupplier} className="space-y-3 text-xs">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-xs font-bold text-slate-700">Daftarkan Rekanan Baru</span>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="text-xs text-slate-500 hover:text-slate-800 font-semibold cursor-pointer"
                >
                  Kembali ke Daftar
                </button>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Tipe Rekanan</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'SUPPLIER', label: 'Supplier (Barang)' },
                    { value: 'VENDOR', label: 'Vendor (Jasa)' },
                    { value: 'BOTH', label: 'Keduanya' }
                  ].map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setNewEntityType(t.value as SupplierEntityType)}
                      className={`py-1.5 px-2 rounded-lg border text-center text-[11px] transition-all cursor-pointer ${
                        newEntityType === t.value
                          ? 'border-[#1b4332] bg-[#1b4332]/5 text-[#1b4332] font-bold'
                          : 'border-slate-200 text-slate-600 bg-slate-50'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Nama Perusahaan / Toko / Vendor <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Contoh: CV Berkah Pangan Mandiri"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Nama PIC / Kontak</label>
                  <input
                    type="text"
                    placeholder="Budi Santoso"
                    value={newContactPerson}
                    onChange={(e) => setNewContactPerson(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">No. WhatsApp / Telepon</label>
                  <input
                    type="text"
                    placeholder="081234567890"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Nama Bank</label>
                  <input
                    type="text"
                    placeholder="BCA / Mandiri / BRI"
                    value={newBankName}
                    onChange={(e) => setNewBankName(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">No. Rekening</label>
                  <input
                    type="text"
                    placeholder="1234567890"
                    value={newBankAccount}
                    onChange={(e) => setNewBankAccount(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Atas Nama Rekening</label>
                  <input
                    type="text"
                    placeholder="a/n Pemilik"
                    value={newBankHolder}
                    onChange={(e) => setNewBankHolder(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                  />
                </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Email Tagihan (Opsional)</label>
                  <input
                    type="email"
                    placeholder="tagihan@vendor.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">NPWP / Tax ID (Opsional)</label>
                  <input
                    type="text"
                    placeholder="01.234.567.8-123.000"
                    value={newTaxId}
                    onChange={(e) => setNewTaxId(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Alamat Singkat</label>
                <input
                  type="text"
                  placeholder="Kota / Jalan"
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-[#1b4332] outline-none"
                />
              </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-5 py-2 bg-[#1b4332] hover:bg-[#143427] disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                  {creating ? 'Menyimpan...' : 'Simpan & Pilih Vendor'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
