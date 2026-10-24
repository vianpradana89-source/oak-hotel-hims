/**
 * OAK HIMS — MP-04D Master Supplier / Vendor Section
 * Tampilan Daftar dan Form Tambah/Ubah Supplier Bahan Baku POS
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  fetchSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  type PosSupplier,
} from './posPurchaseOrderApi';

interface Props {
  propertyId: number;
  onNotifySuccess?: (msg: string) => void;
}

export default function SupplierSection({ propertyId, onNotifySuccess }: Props) {
  const [suppliers, setSuppliers] = useState<PosSupplier[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [editingSupplier, setEditingSupplier] = useState<PosSupplier | null>(null);
  const [formSubmitting, setFormSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Form Fields
  const [code, setCode] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [contactPerson, setContactPerson] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [address, setAddress] = useState<string>('');
  const [isActive, setIsActive] = useState<boolean>(true);

  // Delete State
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const activeParam =
        statusFilter === 'ALL' ? undefined : statusFilter === 'ACTIVE';
      const list = await fetchSuppliers(propertyId, {
        search: searchQuery.trim() || undefined,
        is_active: activeParam,
      });
      setSuppliers(list);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal memuat daftar supplier');
    } finally {
      setLoading(false);
    }
  }, [propertyId, statusFilter, searchQuery]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const openCreateModal = () => {
    setEditingSupplier(null);
    setCode('');
    setName('');
    setContactPerson('');
    setPhone('');
    setEmail('');
    setAddress('');
    setIsActive(true);
    setFormError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (sup: PosSupplier) => {
    setEditingSupplier(sup);
    setCode(sup.code || '');
    setName(sup.name || '');
    setContactPerson(sup.contact_person || '');
    setPhone(sup.phone || '');
    setEmail(sup.email || '');
    setAddress(sup.address || '');
    setIsActive(sup.is_active);
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Nama supplier wajib diisi');
      return;
    }

    setFormSubmitting(true);
    setFormError(null);

    try {
      if (editingSupplier) {
        await updateSupplier(propertyId, editingSupplier.id, {
          code: code.trim() || undefined,
          name: name.trim(),
          contact_person: contactPerson.trim() || null,
          phone: phone.trim() || null,
          email: email.trim() || null,
          address: address.trim() || null,
          is_active: isActive,
        });
        onNotifySuccess?.(`Supplier "${name.trim()}" berhasil diperbarui`);
      } else {
        await createSupplier({
          property_id: propertyId,
          code: code.trim(),
          name: name.trim(),
          contact_person: contactPerson.trim() || null,
          phone: phone.trim() || null,
          email: email.trim() || null,
          address: address.trim() || null,
          is_active: isActive,
        });
        onNotifySuccess?.(`Supplier "${name.trim()}" berhasil ditambahkan`);
      }
      setIsModalOpen(false);
      void loadData();
    } catch (err: any) {
      setFormError(err?.message || 'Gagal menyimpan supplier');
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleDelete = async (sup: PosSupplier) => {
    if (!window.confirm(`Yakin ingin menghapus supplier "${sup.name}"?`)) {
      return;
    }
    setDeletingId(sup.id);
    try {
      await deleteSupplier(propertyId, sup.id);
      onNotifySuccess?.(`Supplier "${sup.name}" berhasil dihapus`);
      void loadData();
    } catch (err: any) {
      alert(err?.message || 'Gagal menghapus supplier');
    } finally {
      setDeletingId(null);
    }
  };

  const filteredSuppliers = useMemo(() => {
    return suppliers.filter((s) => {
      if (statusFilter === 'ACTIVE' && !s.is_active) return false;
      if (statusFilter === 'INACTIVE' && s.is_active) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          s.name.toLowerCase().includes(q) ||
          s.code.toLowerCase().includes(q) ||
          (s.contact_person && s.contact_person.toLowerCase().includes(q)) ||
          (s.phone && s.phone.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [suppliers, statusFilter, searchQuery]);

  return (
    <div className="space-y-4">
      {/* Top Bar: Search, Filters & Action Button */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px]">
            <input
              type="text"
              placeholder="Cari kode, nama, kontak..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
            />
            <svg
              className="w-4 h-4 text-stone-400 absolute left-3 top-2.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="px-3 py-2 text-sm rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
          >
            <option value="ALL">Semua Status</option>
            <option value="ACTIVE">Hanya Aktif</option>
            <option value="INACTIVE">Nonaktif</option>
          </select>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#1b4332] text-white text-sm font-medium rounded-lg hover:bg-[#163829] transition-colors shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Tambah Supplier
        </button>
      </div>

      {errorMsg && (
        <div className="p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
          {errorMsg}
        </div>
      )}

      {/* Supplier Table */}
      <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#1b4332]/5 text-[#1b4332] font-semibold border-b border-stone-200">
              <tr>
                <th className="py-3 px-4">Kode</th>
                <th className="py-3 px-4">Nama Vendor / Supplier</th>
                <th className="py-3 px-4">Kontak Person</th>
                <th className="py-3 px-4">No. Telepon / WA</th>
                <th className="py-3 px-4">Email</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-stone-400">
                    <div className="inline-block animate-spin rounded-full h-6 w-6 border-2 border-[#1b4332] border-t-transparent mr-2"></div>
                    Memuat daftar supplier...
                  </td>
                </tr>
              ) : filteredSuppliers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-stone-400">
                    Belum ada data supplier yang sesuai filter.
                  </td>
                </tr>
              ) : (
                filteredSuppliers.map((sup) => (
                  <tr key={sup.id} className="hover:bg-stone-50 transition-colors">
                    <td className="py-3 px-4 font-mono font-medium text-stone-800">{sup.code}</td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-stone-900">{sup.name}</div>
                      {sup.address && (
                        <div className="text-xs text-stone-500 truncate max-w-[280px]">
                          {sup.address}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-stone-700">{sup.contact_person || '—'}</td>
                    <td className="py-3 px-4 text-stone-700 font-mono text-xs">
                      {sup.phone ? (
                        <a
                          href={`https://wa.me/${sup.phone.replace(/[^0-9]/g, '')}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#1b4332] hover:underline inline-flex items-center gap-1"
                        >
                          {sup.phone}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-3 px-4 text-stone-700 text-xs">{sup.email || '—'}</td>
                    <td className="py-3 px-4">
                      {sup.is_active ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                          Aktif
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-stone-200 text-stone-600">
                          Nonaktif
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openEditModal(sup)}
                          className="px-2.5 py-1 text-xs font-medium text-stone-700 bg-stone-100 hover:bg-stone-200 rounded transition-colors"
                        >
                          Ubah
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(sup)}
                          disabled={deletingId === sup.id}
                          className="px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded transition-colors disabled:opacity-50"
                        >
                          {deletingId === sup.id ? '...' : 'Hapus'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Form Tambah / Ubah Supplier */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full overflow-hidden border border-stone-200 animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 bg-[#1b4332] text-white flex items-center justify-between">
              <h3 className="font-semibold text-lg">
                {editingSupplier ? 'Ubah Supplier' : 'Tambah Supplier Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-stone-300 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitForm} className="p-6 space-y-4">
              {formError && (
                <div className="p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-200">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Kode Supplier <span className="text-stone-400 font-normal">(opsional)</span>
                  </label>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Contoh: SUP-001"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Nama Supplier <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="PT / CV / Nama Toko"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    Contact Person
                  </label>
                  <input
                    type="text"
                    value={contactPerson}
                    onChange={(e) => setContactPerson(e.target.value)}
                    placeholder="Nama PIC Sales"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-stone-700 mb-1">
                    No. Telepon / WhatsApp
                  </label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="08123456789"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="sales@vendor.com"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">Alamat</label>
                <textarea
                  rows={2}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Alamat kantor / gudang supplier..."
                  className="w-full px-3 py-2 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-[#1b4332]"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="isActiveCheck"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="rounded text-[#1b4332] focus:ring-[#1b4332] w-4 h-4 cursor-pointer"
                />
                <label
                  htmlFor="isActiveCheck"
                  className="text-sm font-medium text-stone-700 cursor-pointer select-none"
                >
                  Supplier Aktif (dapat dipilih saat membuat PO / GRN)
                </label>
              </div>

              <div className="pt-4 flex items-center justify-end gap-3 border-t border-stone-200">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-sm text-stone-700 hover:bg-stone-100 rounded-lg transition-colors"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={formSubmitting}
                  className="px-5 py-2 text-sm font-medium bg-[#1b4332] text-white rounded-lg hover:bg-[#163829] transition-colors disabled:opacity-50"
                >
                  {formSubmitting ? 'Menyimpan...' : editingSupplier ? 'Simpan Perubahan' : 'Tambah Supplier'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
