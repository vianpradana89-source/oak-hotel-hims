import React, { useState, useEffect } from 'react';
import type { Supplier, SupplierEntityType, SupplierStatus, VendorSupplierFormData } from './vendorSupplierTypes';
import { STANDARD_CATEGORIES, STANDARD_DEPARTMENTS } from './vendorSupplierHelpers';

interface VendorSupplierFormModalProps {
  isOpen: boolean;
  propertyId: number;
  editingSupplier?: Supplier | null;
  actorName?: string;
  onClose: () => void;
  onSave: (data: VendorSupplierFormData) => Promise<void>;
}

export const VendorSupplierFormModal: React.FC<VendorSupplierFormModalProps> = ({
  isOpen,
  propertyId,
  editingSupplier,
  actorName = 'Staff',
  onClose,
  onSave
}) => {
  const isEdit = Boolean(editingSupplier && editingSupplier.id);

  const [formData, setFormData] = useState<VendorSupplierFormData>({
    property_id: propertyId,
    entity_type: 'SUPPLIER',
    code: '',
    name: '',
    legal_name: '',
    category: 'Food & Beverage',
    contact_person: '',
    phone: '',
    whatsapp: '',
    email: '',
    address: '',
    city: '',
    province: '',
    tax_id: '',
    bank_name: '',
    bank_account: '',
    bank_holder: '',
    payment_terms_days: 0,
    default_department_code: 'FNB',
    status: 'ACTIVE',
    notes: ''
  });

  const [customCategory, setCustomCategory] = useState<string>('');
  const [isCustomCategory, setIsCustomCategory] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (editingSupplier) {
        const cat = editingSupplier.category || '';
        const isCustom = cat !== '' && !STANDARD_CATEGORIES.includes(cat);
        setIsCustomCategory(isCustom);
        setCustomCategory(isCustom ? cat : '');

        setFormData({
          id: editingSupplier.id,
          property_id: propertyId,
          entity_type: (editingSupplier.entity_type as SupplierEntityType) || 'SUPPLIER',
          code: editingSupplier.code || '',
          name: editingSupplier.name || '',
          legal_name: editingSupplier.legal_name || '',
          category: isCustom ? 'Lain-lain' : cat || 'Food & Beverage',
          contact_person: editingSupplier.contact_person || '',
          phone: editingSupplier.phone || '',
          whatsapp: editingSupplier.whatsapp || '',
          email: editingSupplier.email || '',
          address: editingSupplier.address || '',
          city: editingSupplier.city || '',
          province: editingSupplier.province || '',
          tax_id: editingSupplier.tax_id || '',
          bank_name: editingSupplier.bank_name || '',
          bank_account: editingSupplier.bank_account || '',
          bank_holder: editingSupplier.bank_holder || '',
          payment_terms_days: editingSupplier.payment_terms_days ?? 0,
          default_department_code: editingSupplier.default_department_code || 'FNB',
          status: (editingSupplier.status as SupplierStatus) || (editingSupplier.is_active === false ? 'INACTIVE' : 'ACTIVE'),
          notes: editingSupplier.notes || ''
        });
      } else {
        setIsCustomCategory(false);
        setCustomCategory('');
        setFormData({
          property_id: propertyId,
          entity_type: 'SUPPLIER',
          code: '',
          name: '',
          legal_name: '',
          category: 'Food & Beverage',
          contact_person: '',
          phone: '',
          whatsapp: '',
          email: '',
          address: '',
          city: '',
          province: '',
          tax_id: '',
          bank_name: '',
          bank_account: '',
          bank_holder: '',
          payment_terms_days: 0,
          default_department_code: 'FNB',
          status: 'ACTIVE',
          notes: ''
        });
      }
      setError(null);
    }
  }, [isOpen, editingSupplier, propertyId]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setError('Nama Rekanan wajib diisi.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const finalCategory = isCustomCategory ? customCategory.trim() : formData.category;
      await onSave({
        ...formData,
        name: formData.name.trim(),
        legal_name: formData.legal_name?.trim() || undefined,
        code: formData.code?.trim() || undefined,
        category: finalCategory || undefined,
        contact_person: formData.contact_person?.trim() || undefined,
        phone: formData.phone?.trim() || undefined,
        whatsapp: formData.whatsapp?.trim() || undefined,
        email: formData.email?.trim() || undefined,
        address: formData.address?.trim() || undefined,
        city: formData.city?.trim() || undefined,
        province: formData.province?.trim() || undefined,
        tax_id: formData.tax_id?.trim() || undefined,
        bank_name: formData.bank_name?.trim() || undefined,
        bank_account: formData.bank_account?.trim() || undefined,
        bank_holder: formData.bank_holder?.trim() || undefined,
        payment_terms_days: Number(formData.payment_terms_days) || 0,
        default_department_code: formData.default_department_code || undefined,
        notes: formData.notes?.trim() || undefined
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan data rekanan.');
    } finally {
      setSubmitting(false);
    }
  };

  const getAutoCodePlaceholder = () => {
    switch (formData.entity_type) {
      case 'VENDOR':
        return 'Otomatis dibuat (contoh: VND-0001)';
      case 'BOTH':
        return 'Otomatis dibuat (contoh: BTH-0001)';
      case 'SUPPLIER':
      default:
        return 'Otomatis dibuat (contoh: SUP-0001)';
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full overflow-hidden shadow-2xl border border-stone-200 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-stone-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-bold text-stone-100 flex items-center gap-2">
              <span className="text-lg">{isEdit ? '✏️' : '🏢'}</span>
              {isEdit ? 'Edit Rekanan Vendor / Supplier' : 'Tambah Rekanan Baru'}
            </h2>
            <p className="text-xs text-stone-400 mt-0.5">
              {isEdit
                ? `Memperbarui profil master "${editingSupplier?.name}"`
                : 'Daftarkan vendor atau supplier baru ke dalam direktori master properti.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-stone-400 hover:text-white p-1 rounded-lg hover:bg-stone-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl flex items-start gap-2">
              <span className="text-rose-600 font-bold text-sm shrink-0">⚠️</span>
              <div className="flex-1">{error}</div>
            </div>
          )}

          {/* 1. SEKSI IDENTITAS */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-stone-200 pb-1.5">
              <span className="w-2 h-2 rounded-full bg-[#1b4332]" />
              <h3 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">1. Identitas Rekanan</h3>
            </div>

            {/* Entity Type Radio Pills */}
            <div>
              <label className="block font-semibold text-stone-700 mb-1.5">Tipe Entitas Rekanan *</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { value: 'SUPPLIER', label: 'Supplier (Barang)', desc: 'Pengadaan bahan baku & produk' },
                  { value: 'VENDOR', label: 'Vendor (Jasa)', desc: 'Penyedia servis & pemeliharaan' },
                  { value: 'BOTH', label: 'Keduanya', desc: 'Barang sekaligus penyedia jasa' }
                ].map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setFormData({ ...formData, entity_type: t.value as SupplierEntityType })}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      formData.entity_type === t.value
                        ? 'border-[#1b4332] bg-[#1b4332]/5 text-[#1b4332] font-semibold ring-1 ring-[#1b4332]'
                        : 'border-stone-200 hover:border-stone-300 text-stone-700 bg-stone-50/50'
                    }`}
                  >
                    <div className="text-xs">{t.label}</div>
                    <div className="text-[10px] text-stone-500 font-normal mt-0.5">{t.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nama Usaha / Toko / Brand *</label>
                <input
                  type="text"
                  required
                  placeholder="Contoh: Warung Sayur Segar"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332] focus:border-[#1b4332]"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nama Badan Hukum / Faktur</label>
                <input
                  type="text"
                  placeholder="Contoh: PT SAYUR SEGAR NUSANTARA"
                  value={formData.legal_name || ''}
                  onChange={(e) => setFormData({ ...formData, legal_name: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332] focus:border-[#1b4332]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Kode Rekanan <span className="text-stone-400 font-normal">(Opsional)</span>
                </label>
                <input
                  type="text"
                  placeholder={getAutoCodePlaceholder()}
                  value={formData.code || ''}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-[#1b4332] focus:border-[#1b4332]"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Kategori Pengadaan</label>
                <select
                  value={isCustomCategory ? 'Lain-lain' : formData.category}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'Lain-lain') {
                      setIsCustomCategory(true);
                      setFormData({ ...formData, category: 'Lain-lain' });
                    } else {
                      setIsCustomCategory(false);
                      setFormData({ ...formData, category: val });
                    }
                  }}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332] focus:border-[#1b4332]"
                >
                  {STANDARD_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>

                {isCustomCategory && (
                  <input
                    type="text"
                    placeholder="Ketik kategori kustom..."
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value)}
                    className="w-full mt-2 px-3 py-1.5 bg-stone-50 border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                )}
              </div>
            </div>
          </div>

          {/* 2. SEKSI KONTAK */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-stone-200 pb-1.5">
              <span className="w-2 h-2 rounded-full bg-[#1b4332]" />
              <h3 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">2. Kontak & Komunikasi</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nama PIC / Penanggung Jawab</label>
                <input
                  type="text"
                  placeholder="Contoh: Budi Santoso"
                  value={formData.contact_person || ''}
                  onChange={(e) => setFormData({ ...formData, contact_person: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nomor WhatsApp PIC</label>
                <input
                  type="text"
                  placeholder="Contoh: 08123456789"
                  value={formData.whatsapp || ''}
                  onChange={(e) => setFormData({ ...formData, whatsapp: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nomor Telepon Kantor / Toko</label>
                <input
                  type="text"
                  placeholder="Contoh: (0341) 591234"
                  value={formData.phone || ''}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Email Tagihan / Faktur</label>
                <input
                  type="email"
                  placeholder="Contoh: invoice@vendor.com"
                  value={formData.email || ''}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>
            </div>
          </div>

          {/* 3. SEKSI ALAMAT & PAJAK */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-stone-200 pb-1.5">
              <span className="w-2 h-2 rounded-full bg-[#1b4332]" />
              <h3 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">3. Alamat & Perpajakan</h3>
            </div>

            <div>
              <label className="block font-semibold text-stone-700 mb-1">Alamat Kantor / Gudang</label>
              <textarea
                rows={2}
                placeholder="Jl. Raya No. 123..."
                value={formData.address || ''}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Kota / Kabupaten</label>
                <input
                  type="text"
                  placeholder="Contoh: Kota Batu"
                  value={formData.city || ''}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Provinsi</label>
                <input
                  type="text"
                  placeholder="Contoh: Jawa Timur"
                  value={formData.province || ''}
                  onChange={(e) => setFormData({ ...formData, province: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">NPWP / Tax ID</label>
                <input
                  type="text"
                  placeholder="Contoh: 01.234.567.8-123.000"
                  value={formData.tax_id || ''}
                  onChange={(e) => setFormData({ ...formData, tax_id: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>
            </div>
          </div>

          {/* 4. SEKSI BANK & KOMERSIAL */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-stone-200 pb-1.5">
              <span className="w-2 h-2 rounded-full bg-[#1b4332]" />
              <h3 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">4. Finansial & Pembayaran</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nama Bank</label>
                <input
                  type="text"
                  placeholder="Contoh: BCA / Mandiri / BRI"
                  value={formData.bank_name || ''}
                  onChange={(e) => setFormData({ ...formData, bank_name: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Nomor Rekening</label>
                <input
                  type="text"
                  placeholder="Nomor rekening transfer..."
                  value={formData.bank_account || ''}
                  onChange={(e) => setFormData({ ...formData, bank_account: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Atas Nama Rekening</label>
                <input
                  type="text"
                  placeholder="Nama pemilik rekening..."
                  value={formData.bank_holder || ''}
                  onChange={(e) => setFormData({ ...formData, bank_holder: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">
                  Termin Pembayaran (Hari)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={formData.payment_terms_days}
                    onChange={(e) => setFormData({ ...formData, payment_terms_days: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                    className="w-24 px-3 py-2 bg-white border border-stone-300 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                  <span className="text-stone-500">
                    {Number(formData.payment_terms_days) === 0 ? 'Hari (Cash / Langsung)' : 'Hari (Tempo / TOP)'}
                  </span>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Departemen Terkait</label>
                <select
                  value={formData.default_department_code || 'FNB'}
                  onChange={(e) => setFormData({ ...formData, default_department_code: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                >
                  {STANDARD_DEPARTMENTS.map((dept) => (
                    <option key={dept.code} value={dept.code}>{dept.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* 5. SEKSI STATUS & CATATAN */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-stone-200 pb-1.5">
              <span className="w-2 h-2 rounded-full bg-[#1b4332]" />
              <h3 className="font-bold text-stone-800 uppercase tracking-wider text-[11px]">5. Status & Catatan Operasional</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-stone-700 mb-1">Status Rekanan *</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value as SupplierStatus })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg font-semibold focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                >
                  <option value="ACTIVE">🟢 Aktif (Dapat dipilih di transaksi)</option>
                  <option value="INACTIVE">⚪ Nonaktif (Diistirahatkan sementara)</option>
                  <option value="BLACKLISTED">🔴 Diblacklist (Dilarang untuk transaksi baru)</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-stone-700 mb-1">Catatan Internal</label>
                <input
                  type="text"
                  placeholder="Catatan SLA, jadwal pengiriman, atau preferensi..."
                  value={formData.notes || ''}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                />
              </div>
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-stone-50 border-t border-stone-200 flex items-center justify-between shrink-0">
          <div className="text-[11px] text-stone-500">
            Disimpan oleh staf: <span className="font-semibold text-stone-700">{actorName}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="px-4 py-2 text-stone-700 hover:bg-stone-200 rounded-lg font-medium transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={handleSubmit}
              className="px-5 py-2 bg-[#1b4332] hover:bg-[#143427] text-white rounded-lg font-semibold shadow-xs transition-colors disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
            >
              {submitting ? (
                <>
                  <span className="inline-block animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
                  Menyimpan...
                </>
              ) : (
                'Simpan Rekanan'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
