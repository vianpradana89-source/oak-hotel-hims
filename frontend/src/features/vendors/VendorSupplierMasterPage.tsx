import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type {
  Supplier,
  SupplierStatus,
  EntityTypeFilter,
  StatusFilter,
  VendorSupplierFormData,
  VendorSupplierStats
} from './vendorSupplierTypes';
import {
  fetchSuppliersApi,
  createSupplierApi,
  updateSupplierApi,
  toggleSupplierApi,
  deleteSupplierApi
} from '../transactions/transactionClient';
import { VendorSupplierTable } from './VendorSupplierTable';
import { VendorSupplierFormModal } from './VendorSupplierFormModal';
import { VendorSupplierDetailDrawer } from './VendorSupplierDetailDrawer';
import {
  STANDARD_CATEGORIES,
  getVendorSupplierCapabilities
} from './vendorSupplierHelpers';
import type { VendorSupplierCapabilities } from './vendorSupplierHelpers';
import { useAuth } from '../auth/AuthContext';

interface VendorSupplierMasterPageProps {
  propertyId: number;
  currentStaffName?: string;
}

export const VendorSupplierMasterPage: React.FC<VendorSupplierMasterPageProps> = ({
  propertyId,
  currentStaffName = 'Staff'
}) => {
  const { user } = useAuth();
  const actorName = user?.full_name || user?.username || currentStaffName;
  const capabilities: VendorSupplierCapabilities = useMemo(
    () => getVendorSupplierCapabilities(user?.role),
    [user?.role]
  );

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters State
  const [search, setSearch] = useState<string>('');
  const [entityTypeFilter, setEntityTypeFilter] = useState<EntityTypeFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  // Modals & Drawer State
  const [isFormModalOpen, setIsFormModalOpen] = useState<boolean>(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [isDetailDrawerOpen, setIsDetailDrawerOpen] = useState<boolean>(false);
  const [viewingSupplier, setViewingSupplier] = useState<Supplier | null>(null);

  // Delete Confirmation Modal State
  const [deletingSupplier, setDeletingSupplier] = useState<Supplier | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState<boolean>(false);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string | null>(null);

  const loadSuppliers = useCallback(async () => {
    if (!propertyId || !capabilities.canView) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSuppliersApi({
        property_id: propertyId,
        include_deleted: false
      });
      setSuppliers(data);
    } catch (err: any) {
      setError(err.message || 'Gagal memuat katalog vendor dan supplier.');
    } finally {
      setLoading(false);
    }
  }, [propertyId, capabilities.canView]);

  useEffect(() => {
    if (capabilities.canView) {
      loadSuppliers();
    } else {
      setLoading(false);
    }
  }, [capabilities.canView, loadSuppliers]);

  // Success message auto-dismiss
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  // Statistics calculation
  const stats: VendorSupplierStats = useMemo(() => {
    let supplierCount = 0;
    let vendorCount = 0;
    let bothCount = 0;
    let activeCount = 0;
    let inactiveCount = 0;
    let blacklistedCount = 0;

    suppliers.forEach((s) => {
      const type = String(s.entity_type || 'SUPPLIER').toUpperCase();
      if (type === 'VENDOR') vendorCount++;
      else if (type === 'BOTH') bothCount++;
      else supplierCount++;

      const st = String(s.status || (s.is_active ? 'ACTIVE' : 'INACTIVE')).toUpperCase();
      if (st === 'BLACKLISTED') blacklistedCount++;
      else if (st === 'INACTIVE' || s.is_active === false) inactiveCount++;
      else activeCount++;
    });

    return {
      total: suppliers.length,
      supplierCount,
      vendorCount,
      bothCount,
      activeCount,
      inactiveCount,
      blacklistedCount
    };
  }, [suppliers]);

  // Filtered List
  const filteredSuppliers = useMemo(() => {
    return suppliers.filter((s) => {
      // Search term
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const matchCode = s.code?.toLowerCase().includes(q);
        const matchName = s.name.toLowerCase().includes(q);
        const matchLegal = s.legal_name?.toLowerCase().includes(q);
        const matchContact = s.contact_person?.toLowerCase().includes(q);
        const matchPhone = s.phone?.toLowerCase().includes(q);
        const matchWA = s.whatsapp?.toLowerCase().includes(q);
        const matchBank = s.bank_account?.toLowerCase().includes(q);
        const matchTax = s.tax_id?.toLowerCase().includes(q);

        if (
          !matchCode &&
          !matchName &&
          !matchLegal &&
          !matchContact &&
          !matchPhone &&
          !matchWA &&
          !matchBank &&
          !matchTax
        ) {
          return false;
        }
      }

      // Entity type filter
      if (entityTypeFilter !== 'ALL') {
        const type = String(s.entity_type || 'SUPPLIER').toUpperCase();
        if (type !== entityTypeFilter) return false;
      }

      // Status filter
      if (statusFilter !== 'ALL') {
        const st = String(s.status || (s.is_active ? 'ACTIVE' : 'INACTIVE')).toUpperCase();
        if (st !== statusFilter) return false;
      }

      // Category filter
      if (categoryFilter !== 'ALL') {
        if (s.category !== categoryFilter) return false;
      }

      return true;
    });
  }, [suppliers, search, entityTypeFilter, statusFilter, categoryFilter]);

  // Handlers
  const handleOpenCreateModal = () => {
    if (!capabilities.canCreateEdit) return;
    setEditingSupplier(null);
    setIsFormModalOpen(true);
  };

  const handleOpenEditModal = (supplier: Supplier) => {
    if (!capabilities.canCreateEdit) return;
    setEditingSupplier(supplier);
    setIsFormModalOpen(true);
  };

  const handleOpenDetailDrawer = (supplier: Supplier) => {
    setViewingSupplier(supplier);
    setIsDetailDrawerOpen(true);
  };

  const handleSaveSupplier = async (data: VendorSupplierFormData) => {
    if (!capabilities.canCreateEdit) return;

    if (data.id) {
      // Update
      await updateSupplierApi(data.id, {
        property_id: propertyId,
        code: data.code,
        name: data.name,
        legal_name: data.legal_name,
        entity_type: data.entity_type,
        category: data.category,
        contact_person: data.contact_person,
        phone: data.phone,
        whatsapp: data.whatsapp,
        email: data.email,
        address: data.address,
        city: data.city,
        province: data.province,
        tax_id: data.tax_id,
        bank_name: data.bank_name,
        bank_account: data.bank_account,
        bank_holder: data.bank_holder,
        payment_terms_days: data.payment_terms_days,
        default_department_code: data.default_department_code,
        status: data.status,
        notes: data.notes,
        is_active: data.status === 'ACTIVE',
        actor_name: actorName,
        updated_by: actorName
      });
      setSuccessMessage(`Data rekanan "${data.name}" berhasil diperbarui.`);
    } else {
      // Create
      await createSupplierApi({
        property_id: propertyId,
        code: data.code,
        name: data.name,
        legal_name: data.legal_name,
        entity_type: data.entity_type,
        category: data.category,
        contact_person: data.contact_person,
        phone: data.phone,
        whatsapp: data.whatsapp,
        email: data.email,
        address: data.address,
        city: data.city,
        province: data.province,
        tax_id: data.tax_id,
        bank_name: data.bank_name,
        bank_account: data.bank_account,
        bank_holder: data.bank_holder,
        payment_terms_days: data.payment_terms_days,
        default_department_code: data.default_department_code,
        status: data.status,
        notes: data.notes,
        is_active: data.status === 'ACTIVE',
        actor_name: actorName,
        created_by: actorName
      });
      setSuccessMessage(`Rekanan baru "${data.name}" berhasil ditambahkan.`);
    }
    await loadSuppliers();
  };

  const handleToggleStatus = async (supplier: Supplier) => {
    if (!capabilities.canManageStatus || supplier.status === 'BLACKLISTED') return;

    try {
      const nextStatus = supplier.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
      await toggleSupplierApi(supplier.id, propertyId, actorName);
      setSuccessMessage(
        `Status rekanan "${supplier.name}" diubah menjadi ${nextStatus === 'ACTIVE' ? 'Aktif' : 'Nonaktif'}.`
      );
      await loadSuppliers();
    } catch (err: any) {
      setError(err.message || 'Gagal mengubah status rekanan.');
    }
  };

  const handleToggleBlacklist = async (supplier: Supplier) => {
    if (!capabilities.canManageStatus) return;

    try {
      const isCurrentlyBlacklisted = supplier.status === 'BLACKLISTED';
      const targetStatus: SupplierStatus = isCurrentlyBlacklisted ? 'ACTIVE' : 'BLACKLISTED';

      await updateSupplierApi(supplier.id, {
        property_id: propertyId,
        status: targetStatus,
        is_active: targetStatus === 'ACTIVE',
        actor_name: actorName,
        updated_by: actorName
      });

      setSuccessMessage(
        isCurrentlyBlacklisted
          ? `Rekanan "${supplier.name}" telah dipulihkan dari daftar Blacklist (Status: Aktif).`
          : `Rekanan "${supplier.name}" telah DIBLACKLIST dari pengadaan operasional.`
      );
      await loadSuppliers();
    } catch (err: any) {
      setError(err.message || 'Gagal memperbarui status blacklist rekanan.');
    }
  };

  const handleDeleteClick = (supplier: Supplier) => {
    if (!capabilities.canDelete) return;
    setDeletingSupplier(supplier);
    setDeleteErrorMessage(null);
  };

  const handleConfirmDelete = async () => {
    if (!capabilities.canDelete || !deletingSupplier) return;
    setDeleteSubmitting(true);
    setDeleteErrorMessage(null);

    try {
      await deleteSupplierApi(deletingSupplier.id, propertyId, actorName);
      setSuccessMessage(`Rekanan "${deletingSupplier.name}" berhasil dihapus.`);
      setDeletingSupplier(null);
      await loadSuppliers();
    } catch (err: any) {
      // Safe hotelier friendly error message for transaction-linked deletion
      const rawMsg = err.message || '';
      if (
        rawMsg.toLowerCase().includes('transaksi') ||
        rawMsg.toLowerCase().includes('foreign key') ||
        rawMsg.toLowerCase().includes('constraint') ||
        rawMsg.toLowerCase().includes('cannot delete')
      ) {
        setDeleteErrorMessage(
          'Supplier/Vendor ini memiliki riwayat transaksi dan tidak dapat dihapus. Gunakan opsi Nonaktif atau Blacklist agar tidak muncul pada transaksi baru.'
        );
      } else {
        setDeleteErrorMessage(rawMsg || 'Gagal menghapus rekanan.');
      }
    } finally {
      setDeleteSubmitting(false);
    }
  };

  if (!capabilities.canView) {
    return (
      <div className="bg-white rounded-2xl border border-stone-200/80 p-8 text-center shadow-xs">
        <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center mx-auto mb-3 text-stone-400">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h3 className="text-sm font-semibold text-stone-800">Akses Terbatas</h3>
        <p className="text-xs text-stone-500 mt-1 max-w-sm mx-auto">
          Anda tidak memiliki izin untuk melihat Master Vendor & Supplier.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Notifications */}
      {successMessage && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl flex items-center justify-between text-xs shadow-xs animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="text-emerald-600 font-bold text-sm">✓</span>
            <span className="font-semibold">{successMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMessage(null)}
            className="text-emerald-600 hover:text-emerald-800 font-bold text-sm"
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl flex items-center justify-between text-xs shadow-xs">
          <div className="flex items-center gap-2">
            <span className="text-rose-600 font-bold text-sm">⚠️</span>
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-rose-600 hover:text-rose-800 font-bold text-sm"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header & Primary Action */}
      <div className="bg-white p-5 rounded-2xl border border-stone-200/80 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-stone-900 flex items-center gap-2">
            <span>🏢</span> Master Rekanan (Vendor & Supplier)
          </h2>
          <p className="text-xs text-stone-500 mt-0.5">
            Kelola direktori rekanan pengadaan barang (Supplier) dan penyedia jasa (Vendor) properti OAK HIMS.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={loadSuppliers}
            disabled={loading}
            className="p-2 text-stone-600 hover:text-stone-900 hover:bg-stone-100 rounded-xl border border-stone-200 text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer"
            title="Muat Ulang Data"
          >
            <svg
              className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="hidden sm:inline">Refresh</span>
          </button>

          {capabilities.canCreateEdit && (
            <button
              type="button"
              onClick={handleOpenCreateModal}
              className="px-4 py-2 bg-[#1b4332] hover:bg-[#143427] text-white rounded-xl text-xs font-semibold shadow-xs transition-colors flex items-center gap-2 cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              <span>Tambah Rekanan</span>
            </button>
          )}
        </div>
      </div>

      {/* Metrics Summary Chips */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-white p-3.5 rounded-xl border border-stone-200/80 shadow-xs">
          <div className="text-[11px] text-stone-500 font-medium">Total Rekanan</div>
          <div className="text-xl font-bold text-stone-900 mt-0.5">{stats.total}</div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-stone-200/80 shadow-xs">
          <div className="text-[11px] text-amber-700 font-medium">Supplier (Barang)</div>
          <div className="text-xl font-bold text-amber-900 mt-0.5">{stats.supplierCount}</div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-stone-200/80 shadow-xs">
          <div className="text-[11px] text-blue-700 font-medium">Vendor (Jasa)</div>
          <div className="text-xl font-bold text-blue-900 mt-0.5">{stats.vendorCount}</div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-stone-200/80 shadow-xs">
          <div className="text-[11px] text-purple-700 font-medium">Keduanya (Barang & Jasa)</div>
          <div className="text-xl font-bold text-purple-900 mt-0.5">{stats.bothCount}</div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-stone-200/80 shadow-xs">
          <div className="text-[11px] text-emerald-700 font-medium">Status Aktif</div>
          <div className="text-xl font-bold text-emerald-800 mt-0.5">{stats.activeCount}</div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-stone-200/80 shadow-xs">
          <div className="text-[11px] text-rose-700 font-medium">Diblacklist</div>
          <div className="text-xl font-bold text-rose-800 mt-0.5">{stats.blacklistedCount}</div>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="bg-white p-4 rounded-2xl border border-stone-200/80 shadow-xs space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {/* Search Box */}
          <div className="relative md:col-span-2">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-stone-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              placeholder="Cari kode, nama rekanan, PIC, telepon, WA, rekening, atau NPWP..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-[#1b4332] focus:bg-white"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-stone-400 hover:text-stone-600"
              >
                ✕
              </button>
            )}
          </div>

          {/* Filter Tipe */}
          <div>
            <select
              value={entityTypeFilter}
              onChange={(e) => setEntityTypeFilter(e.target.value as EntityTypeFilter)}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-[#1b4332] focus:bg-white"
            >
              <option value="ALL">Semua Tipe Rekanan</option>
              <option value="SUPPLIER">Supplier (Barang)</option>
              <option value="VENDOR">Vendor (Jasa)</option>
              <option value="BOTH">Keduanya (Barang & Jasa)</option>
            </select>
          </div>

          {/* Filter Status */}
          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-[#1b4332] focus:bg-white"
            >
              <option value="ALL">Semua Status</option>
              <option value="ACTIVE">🟢 Aktif</option>
              <option value="INACTIVE">⚪ Nonaktif</option>
              <option value="BLACKLISTED">🔴 Diblacklist</option>
            </select>
          </div>
        </div>

        {/* Category Pills Filter */}
        <div className="flex items-center gap-1.5 overflow-x-auto pt-1 pb-0.5 text-xs">
          <span className="text-[11px] text-stone-400 font-semibold uppercase tracking-wider shrink-0 mr-1">
            Kategori:
          </span>
          <button
            type="button"
            onClick={() => setCategoryFilter('ALL')}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all shrink-0 cursor-pointer ${
              categoryFilter === 'ALL'
                ? 'bg-[#1b4332] text-white shadow-xs'
                : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
            }`}
          >
            Semua ({suppliers.length})
          </button>

          {STANDARD_CATEGORIES.map((cat) => {
            const count = suppliers.filter((s) => s.category === cat).length;
            if (count === 0 && categoryFilter !== cat) return null;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(categoryFilter === cat ? 'ALL' : cat)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all shrink-0 cursor-pointer ${
                  categoryFilter === cat
                    ? 'bg-[#1b4332] text-white shadow-xs'
                    : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                }`}
              >
                {cat} <span className="opacity-70 text-[10px]">({count})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Table Component */}
      <VendorSupplierTable
        suppliers={filteredSuppliers}
        loading={loading}
        capabilities={capabilities}
        onViewDetail={handleOpenDetailDrawer}
        onEdit={handleOpenEditModal}
        onToggleStatus={handleToggleStatus}
        onToggleBlacklist={handleToggleBlacklist}
        onDelete={handleDeleteClick}
      />

      {/* Form Modal (Create / Edit) */}
      <VendorSupplierFormModal
        isOpen={isFormModalOpen}
        propertyId={propertyId}
        editingSupplier={editingSupplier}
        actorName={actorName}
        onClose={() => {
          setIsFormModalOpen(false);
          setEditingSupplier(null);
        }}
        onSave={handleSaveSupplier}
      />

      {/* Detail Drawer */}
      <VendorSupplierDetailDrawer
        supplier={viewingSupplier}
        isOpen={isDetailDrawerOpen}
        capabilities={capabilities}
        onClose={() => {
          setIsDetailDrawerOpen(false);
          setViewingSupplier(null);
        }}
        onEdit={handleOpenEditModal}
      />

      {/* Delete Confirmation Modal with Friendly Invariant Guard */}
      {deletingSupplier && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-stone-200 space-y-4">
            <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>

            <div className="text-center">
              <h3 className="text-base font-bold text-stone-900">Hapus Rekanan?</h3>
              <p className="text-xs text-stone-600 mt-1">
                Anda akan menghapus data rekanan <span className="font-semibold text-stone-900">"{deletingSupplier.name}"</span> ({deletingSupplier.code || 'Tanpa Kode'}).
              </p>
            </div>

            {deleteErrorMessage && (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-900 text-xs leading-relaxed flex items-start gap-2.5">
                <span className="text-rose-600 font-bold text-sm shrink-0">🛡️</span>
                <div>
                  <div className="font-bold">Proteksi Integritas Transaksi</div>
                  <div className="mt-0.5">{deleteErrorMessage}</div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={deleteSubmitting}
                onClick={() => {
                  setDeletingSupplier(null);
                  setDeleteErrorMessage(null);
                }}
                className="px-4 py-2 text-stone-600 hover:bg-stone-100 rounded-xl text-xs font-medium cursor-pointer"
              >
                Tutup
              </button>

              {!deleteErrorMessage && (
                <button
                  type="button"
                  disabled={deleteSubmitting}
                  onClick={handleConfirmDelete}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {deleteSubmitting ? (
                    <>
                      <span className="inline-block animate-spin rounded-full h-3 w-3 border-b-2 border-white" />
                      Menghapus...
                    </>
                  ) : (
                    'Ya, Hapus'
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
