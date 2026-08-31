import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '../../design-system/Button';
import { Input } from '../../design-system/Input';

export interface PropertyItem {
  id: number;
  name: string;
  property_code: string;
  address?: string | null;
  phone?: string | null;
  timezone?: string;
  currency?: string;
  is_active: boolean;
  total_rooms?: number;
  total_room_types?: number;
  created_at?: string;
  updated_at?: string;
}

export interface PropertyManagementTabProps {
  currentPropertyId: number;
  onSelectProperty?: (propertyId: number) => void;
  onPropertiesUpdated?: () => void;
  apiBaseUrl?: string;
}

export const PropertyManagementTab: React.FC<PropertyManagementTabProps> = ({
  currentPropertyId,
  onSelectProperty,
  onPropertiesUpdated,
  apiBaseUrl = '/api'
}) => {
  const [properties, setProperties] = useState<PropertyItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Add Property Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [newProperty, setNewProperty] = useState({
    name: '',
    property_code: '',
    address: '',
    phone: '',
    timezone: 'Asia/Jakarta',
    currency: 'IDR'
  });

  // Edit Property Modal State
  const [editingProperty, setEditingProperty] = useState<PropertyItem | null>(null);
  const [isEditSaving, setIsEditSaving] = useState<boolean>(false);

  // Delete Confirmation State
  const [deletingProperty, setDeletingProperty] = useState<PropertyItem | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  // Load properties
  const loadProperties = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/properties?all=true`);
      const json = await res.json();
      if (json.status === 'OK' && Array.isArray(json.data)) {
        setProperties(json.data);
        if (json.data.length > 0 && currentPropertyId && !json.data.some((p: PropertyItem) => p.id === currentPropertyId)) {
          if (onSelectProperty) onSelectProperty(json.data[0].id);
        }
      } else {
        setError(json.message || 'Gagal memuat daftar properti.');
      }
    } catch (err: any) {
      setError(err.message || 'Gagal tersambung ke server.');
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, currentPropertyId, onSelectProperty]);

  useEffect(() => {
    loadProperties();
  }, [loadProperties]);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 4000);
  };

  // Handle Create Property
  const handleCreateProperty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProperty.name.trim()) {
      setError('Nama properti tidak boleh kosong.');
      return;
    }
    if (!newProperty.property_code.trim()) {
      setError('Kode properti tidak boleh kosong.');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/properties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newProperty.name.trim(),
          property_code: newProperty.property_code.trim().toUpperCase(),
          address: newProperty.address.trim() || null,
          phone: newProperty.phone.trim() || null,
          timezone: newProperty.timezone,
          currency: newProperty.currency
        })
      });

      const json = await res.json();
      if (res.status === 201 && json.status === 'SUCCESS') {
        showSuccess(json.message || 'Properti berhasil ditambahkan.');
        setIsAddModalOpen(false);
        setNewProperty({
          name: '',
          property_code: '',
          address: '',
          phone: '',
          timezone: 'Asia/Jakarta',
          currency: 'IDR'
        });
        await loadProperties();
        if (onPropertiesUpdated) onPropertiesUpdated();
      } else {
        setError(json.message || 'Gagal menambahkan properti.');
      }
    } catch (err: any) {
      setError(err.message || 'Terjadi kesalahan jaringan.');
    } finally {
      setIsSaving(false);
    }
  };

  // Handle Edit Property
  const handleEditProperty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProperty) return;

    setIsEditSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/properties/${editingProperty.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editingProperty.name.trim(),
          property_code: editingProperty.property_code.trim().toUpperCase(),
          address: editingProperty.address ? editingProperty.address.trim() : null,
          phone: editingProperty.phone ? editingProperty.phone.trim() : null,
          timezone: editingProperty.timezone,
          currency: editingProperty.currency,
          is_active: editingProperty.is_active
        })
      });

      const json = await res.json();
      if (res.ok && json.status === 'SUCCESS') {
        showSuccess(json.message || 'Informasi properti berhasil diperbarui.');
        setEditingProperty(null);
        await loadProperties();
        if (onPropertiesUpdated) onPropertiesUpdated();
      } else {
        setError(json.message || 'Gagal memperbarui properti.');
      }
    } catch (err: any) {
      setError(err.message || 'Terjadi kesalahan jaringan.');
    } finally {
      setIsEditSaving(false);
    }
  };

  // Handle Delete Property
  const handleDeleteProperty = async () => {
    if (!deletingProperty) return;

    setIsDeleting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/properties/${deletingProperty.id}`, {
        method: 'DELETE'
      });
      const json = await res.json();

      if (res.ok && json.status === 'SUCCESS') {
        showSuccess(json.message || 'Properti berhasil dihapus.');
        const wasSelected = deletingProperty.id === currentPropertyId;
        setDeletingProperty(null);
        await loadProperties();
        if (onPropertiesUpdated) onPropertiesUpdated();
        if (wasSelected && onSelectProperty) {
          onSelectProperty(1); // switch to OAK Lawang default
        }
      } else {
        setError(json.message || 'Gagal menghapus properti.');
      }
    } catch (err: any) {
      setError(err.message || 'Terjadi kesalahan jaringan.');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Action */}
      <div className="bg-white rounded-2xl border border-neutral-200/90 p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-[#1b4332]">Daftar Unit & Properti Hotel</h3>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
              {properties.length} Properti Terdaftar
            </span>
          </div>
          <p className="text-xs text-neutral-600 mt-1 max-w-2xl leading-relaxed">
            Kelola properti dalam ekosistem OAK HIMS. Properti aktif saat ini dapat dialihkan secara instan untuk mengoperasikan operasional Front Office, Housekeeping, dan Kamar masing-masing unit.
          </p>
        </div>

        <Button
          variant="primary"
          onClick={() => {
            setError(null);
            setIsAddModalOpen(true);
          }}
          className="font-bold px-4 py-2.5 rounded-xl shadow-xs text-xs flex items-center gap-2 shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
          </svg>
          Tambah Properti Baru
        </Button>
      </div>

      {/* Notification feedback */}
      {successMsg && (
        <div className="p-4 bg-emerald-50 border border-emerald-300 text-emerald-900 rounded-xl text-xs font-medium flex items-center gap-2 shadow-xs animate-fade-in">
          <svg className="w-4 h-4 text-emerald-600 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          {successMsg}
        </div>
      )}

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-300 text-rose-900 rounded-xl text-xs font-medium flex items-center justify-between gap-2 shadow-xs animate-fade-in">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-rose-600 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span>{error}</span>
          </div>
          <button
            onClick={() => setError(null)}
            className="text-rose-600 hover:text-rose-800 text-xs font-bold px-2 py-1 hover:bg-rose-100 rounded-lg transition-colors"
          >
            Tutup
          </button>
        </div>
      )}

      {/* Property Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isLoading ? (
          <div className="col-span-full py-12 text-center text-xs text-neutral-500 bg-white rounded-2xl border border-neutral-200">
            <div className="inline-block w-6 h-6 border-2 border-[#1b4332] border-t-transparent rounded-full animate-spin mb-2" />
            <p>Memuat data properti...</p>
          </div>
        ) : properties.length === 0 ? (
          <div className="col-span-full py-12 text-center text-xs text-neutral-500 bg-white rounded-2xl border border-neutral-200">
            Belum ada properti terdaftar.
          </div>
        ) : (
          properties.map((prop) => {
            const isSelected = prop.id === currentPropertyId;
            const isPrimary = prop.id === 1;

            return (
              <div
                key={prop.id}
                className={`bg-white rounded-2xl border transition-all duration-200 p-5 space-y-4 shadow-xs ${
                  isSelected
                    ? 'border-[#1b4332] ring-2 ring-[#1b4332]/20 bg-emerald-50/20'
                    : 'border-neutral-200/90 hover:border-neutral-300'
                }`}
              >
                {/* Header info */}
                <div className="flex items-start justify-between gap-2 pb-3 border-b border-neutral-100">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-neutral-900 text-base">{prop.name}</h4>
                      <span className="font-mono text-xs px-2 py-0.5 rounded bg-neutral-100 text-neutral-700 font-bold border border-neutral-200">
                        {prop.property_code}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      {isPrimary && (
                        <span className="px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800 border border-amber-300">
                          Properti Utama
                        </span>
                      )}
                      {isSelected ? (
                        <span className="px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
                          Sedang Aktif
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full font-medium bg-neutral-100 text-neutral-600">
                          Tersedia
                        </span>
                      )}
                      {!prop.is_active && (
                        <span className="px-2 py-0.5 rounded-full font-bold bg-rose-100 text-rose-800 border border-rose-300">
                          Nonaktif
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-xs font-mono font-bold text-neutral-400">ID: #{prop.id}</span>
                  </div>
                </div>

                {/* Details grid */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="p-2.5 bg-neutral-50 rounded-xl border border-neutral-100">
                    <div className="text-neutral-500 text-[11px]">Kapasitas Kamar</div>
                    <div className="font-bold text-neutral-900 mt-0.5">
                      {prop.total_rooms ?? 0} Kamar <span className="text-neutral-400 text-[10px]">({prop.total_room_types ?? 0} tipe)</span>
                    </div>
                  </div>

                  <div className="p-2.5 bg-neutral-50 rounded-xl border border-neutral-100">
                    <div className="text-neutral-500 text-[11px]">Zona Waktu & Kurs</div>
                    <div className="font-bold text-neutral-900 mt-0.5">
                      {prop.timezone || 'Asia/Jakarta'} <span className="text-neutral-400 text-[10px]">({prop.currency || 'IDR'})</span>
                    </div>
                  </div>

                  <div className="col-span-2 p-2.5 bg-neutral-50 rounded-xl border border-neutral-100 space-y-1">
                    <div className="flex items-center gap-1 text-neutral-500 text-[11px]">
                      <svg className="w-3.5 h-3.5 text-neutral-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      <span>Alamat:</span>
                    </div>
                    <div className="font-medium text-neutral-800 pl-4.5 truncate">
                      {prop.address || 'Belum diisi'}
                    </div>

                    <div className="flex items-center gap-1 text-neutral-500 text-[11px] pt-1">
                      <svg className="w-3.5 h-3.5 text-neutral-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                      </svg>
                      <span>Telepon:</span>
                      <span className="font-medium text-neutral-800 ml-1">{prop.phone || 'Belum diisi'}</span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between pt-2 border-t border-neutral-100 gap-2">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setError(null);
                        setEditingProperty({ ...prop });
                      }}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium"
                    >
                      Edit Info
                    </Button>

                    {!isPrimary && (
                      <Button
                        variant="danger"
                        onClick={() => {
                          setError(null);
                          setDeletingProperty(prop);
                        }}
                        className="text-xs px-3 py-1.5 rounded-lg font-medium"
                      >
                        Hapus
                      </Button>
                    )}
                  </div>

                  {!isSelected && onSelectProperty && (
                    <Button
                      variant="primary"
                      onClick={() => {
                        setError(null);
                        onSelectProperty(prop.id);
                      }}
                      className="text-xs px-3.5 py-1.5 rounded-lg font-bold shadow-xs flex items-center gap-1.5"
                    >
                      <span>Beralih ke Properti Ini</span>
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                      </svg>
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modal: Tambah Properti Baru */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border border-neutral-200 space-y-4 p-6 animate-scale-up">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <div>
                <h3 className="text-base font-bold text-neutral-900">Tambah Unit / Properti Baru</h3>
                <p className="text-xs text-neutral-500 mt-0.5">Konfigurasi cabang hotel baru dengan isolasi data relasional penuh.</p>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-600 rounded-lg p-1"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreateProperty} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="font-bold text-neutral-700">Nama Properti / Hotel <span className="text-rose-500">*</span></label>
                <Input
                  type="text"
                  placeholder="Contoh: OAK Hotel Batu"
                  value={newProperty.name}
                  onChange={(e) => setNewProperty({ ...newProperty, name: e.target.value })}
                  required
                  className="w-full"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-bold text-neutral-700">Kode Properti <span className="text-rose-500">*</span></label>
                  <Input
                    type="text"
                    placeholder="Contoh: BATU"
                    value={newProperty.property_code}
                    onChange={(e) => setNewProperty({ ...newProperty, property_code: e.target.value.toUpperCase() })}
                    required
                    maxLength={10}
                    className="w-full font-mono font-bold uppercase"
                  />
                  <div className="text-[10px] text-neutral-400">Kode unik 3-6 huruf kapital</div>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-neutral-700">No. Telepon / WhatsApp</label>
                  <Input
                    type="text"
                    placeholder="0341-591234"
                    value={newProperty.phone}
                    onChange={(e) => setNewProperty({ ...newProperty, phone: e.target.value })}
                    className="w-full"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-bold text-neutral-700">Alamat Lengkap Properti</label>
                <textarea
                  placeholder="Jl. Oro-Oro Ombo No. 9, Kota Batu, Jawa Timur"
                  value={newProperty.address}
                  onChange={(e) => setNewProperty({ ...newProperty, address: e.target.value })}
                  rows={2}
                  className="w-full border border-neutral-300 rounded-xl p-2.5 text-xs focus:ring-2 focus:ring-[#1b4332]/20 focus:border-[#1b4332] outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-bold text-neutral-700">Zona Waktu</label>
                  <select
                    value={newProperty.timezone}
                    onChange={(e) => setNewProperty({ ...newProperty, timezone: e.target.value })}
                    className="w-full border border-neutral-300 rounded-xl p-2.5 text-xs bg-white focus:ring-2 focus:ring-[#1b4332]/20 focus:border-[#1b4332] outline-hidden"
                  >
                    <option value="Asia/Jakarta">Asia/Jakarta (WIB)</option>
                    <option value="Asia/Makassar">Asia/Makassar (WITA)</option>
                    <option value="Asia/Jayapura">Asia/Jayapura (WIT)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-neutral-700">Mata Uang</label>
                  <select
                    value={newProperty.currency}
                    onChange={(e) => setNewProperty({ ...newProperty, currency: e.target.value })}
                    className="w-full border border-neutral-300 rounded-xl p-2.5 text-xs bg-white focus:ring-2 focus:ring-[#1b4332]/20 focus:border-[#1b4332] outline-hidden"
                  >
                    <option value="IDR">IDR (Rupiah Indonesia)</option>
                    <option value="USD">USD (US Dollar)</option>
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-neutral-200 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setIsAddModalOpen(false)}
                  disabled={isSaving}
                  className="text-xs px-4 py-2 font-medium"
                >
                  Batal
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={isSaving}
                  className="font-bold text-xs px-5 py-2.5 rounded-xl shadow-xs"
                >
                  {isSaving ? 'Menyimpan...' : 'Simpan Properti'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Edit Informasi Properti */}
      {editingProperty && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden border border-neutral-200 space-y-4 p-6 animate-scale-up">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <div>
                <h3 className="text-base font-bold text-neutral-900">Edit Informasi Properti</h3>
                <p className="text-xs text-neutral-500 mt-0.5">Perbarui rincian operasional dan identitas properti.</p>
              </div>
              <button
                onClick={() => setEditingProperty(null)}
                className="text-neutral-400 hover:text-neutral-600 rounded-lg p-1"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleEditProperty} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="font-bold text-neutral-700">Nama Properti <span className="text-rose-500">*</span></label>
                <Input
                  type="text"
                  value={editingProperty.name}
                  onChange={(e) => setEditingProperty({ ...editingProperty, name: e.target.value })}
                  required
                  className="w-full"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-bold text-neutral-700">Kode Properti <span className="text-rose-500">*</span></label>
                  <Input
                    type="text"
                    value={editingProperty.property_code}
                    onChange={(e) => setEditingProperty({ ...editingProperty, property_code: e.target.value.toUpperCase() })}
                    required
                    maxLength={6}
                    className="w-full font-mono font-bold uppercase"
                  />
                  <div className="text-[10px] text-neutral-400">Kode unik 2-6 huruf kapital</div>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-neutral-700">No. Telepon</label>
                  <Input
                    type="text"
                    value={editingProperty.phone || ''}
                    onChange={(e) => setEditingProperty({ ...editingProperty, phone: e.target.value })}
                    className="w-full"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-bold text-neutral-700">Alamat</label>
                <textarea
                  value={editingProperty.address || ''}
                  onChange={(e) => setEditingProperty({ ...editingProperty, address: e.target.value })}
                  rows={2}
                  className="w-full border border-neutral-300 rounded-xl p-2.5 text-xs focus:ring-2 focus:ring-[#1b4332]/20 focus:border-[#1b4332] outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-bold text-neutral-700">Zona Waktu</label>
                  <select
                    value={editingProperty.timezone || 'Asia/Jakarta'}
                    onChange={(e) => setEditingProperty({ ...editingProperty, timezone: e.target.value })}
                    className="w-full border border-neutral-300 rounded-xl p-2.5 text-xs bg-white font-medium"
                  >
                    <option value="Asia/Jakarta">Asia/Jakarta (WIB)</option>
                    <option value="Asia/Makassar">Asia/Makassar (WITA)</option>
                    <option value="Asia/Jayapura">Asia/Jayapura (WIT)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-neutral-700">Status Operasional</label>
                  <select
                    value={editingProperty.is_active ? 'active' : 'inactive'}
                    onChange={(e) => setEditingProperty({ ...editingProperty, is_active: e.target.value === 'active' })}
                    className="w-full border border-neutral-300 rounded-xl p-2.5 text-xs bg-white font-bold"
                  >
                    <option value="active">Aktif (Operasional)</option>
                    <option value="inactive">Nonaktif</option>
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-neutral-200 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditingProperty(null)}
                  disabled={isEditSaving}
                  className="text-xs px-4 py-2 font-medium"
                >
                  Batal
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={isEditSaving}
                  className="font-bold text-xs px-5 py-2.5 rounded-xl shadow-xs"
                >
                  {isEditSaving ? 'Menyimpan...' : 'Simpan Perubahan'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Konfirmasi Hapus Properti */}
      {deletingProperty && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden border border-neutral-200 space-y-4 p-6 animate-scale-up">
            <div className="flex items-center gap-3 text-rose-700 pb-3 border-b border-neutral-200">
              <div className="p-2 bg-rose-100 rounded-xl">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h3 className="text-base font-bold text-neutral-900">Hapus Properti</h3>
                <p className="text-xs text-neutral-500">Tindakan ini permanen dan tidak dapat dibatalkan.</p>
              </div>
            </div>

            <div className="text-xs text-neutral-600 space-y-2">
              <p>
                Apakah Anda yakin ingin menghapus properti <span className="font-bold text-neutral-900">{deletingProperty.name} ({deletingProperty.property_code})</span>?
              </p>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-[11px] leading-relaxed">
                <strong>Perhatian:</strong> Penghapusan hanya dapat dilakukan bila properti belum memiliki riwayat reservasi transaksi. Jika sudah ada data transaksi, nonaktifkan status operasional properti.
              </div>
            </div>

            <div className="pt-3 border-t border-neutral-200 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setDeletingProperty(null)}
                disabled={isDeleting}
                className="text-xs px-4 py-2 font-medium"
              >
                Batal
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={handleDeleteProperty}
                disabled={isDeleting}
                className="font-bold text-xs px-5 py-2.5 rounded-xl shadow-xs"
              >
                {isDeleting ? 'Menghapus...' : 'Ya, Hapus Properti'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
