import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchPurchaseOrders,
  fetchPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderStatus,
  fetchSuppliers,
  fetchRawMaterialCandidates,
  fetchProductPackagingsForGrn,
  type PosPurchaseOrder,
  type PosSupplier,
  type RawMaterialCandidate,
  type ProductPackagingOption,
} from '../posInventory/posPurchaseOrderApi';
import { fetchStockLocations } from '../posInventory/posInventoryApi';
import type { StockLocation } from '../posInventory/posInventoryTypes';

interface ProcurementPoSectionProps {
  propertyId: number;
  currentStaffName?: string;
  currentUserId?: string | number | null;
  searchQuery?: string;
  refreshTrigger?: number;
  showCreateModalExternal?: boolean;
  onClearShowCreateModalExternal?: () => void;
  onOpenReceiveGoodsForPo: (po: PosPurchaseOrder) => void;
  onOpenViewReceiptsForPo: (po: PosPurchaseOrder) => void;
  onOpenCreateInvoiceForPo: (po: PosPurchaseOrder) => void;
  onOpenInvoiceDetailDrawer: (transactionId: number | string) => void;
  onOpenVendorSupplierMaster?: () => void;
  onRefreshParentTransactions?: () => void;
}

interface PoFormLineItem {
  id?: number | null;
  product_id: string;
  packaging_id: string;
  ordered_unit: string;
  conversion_factor: number;
  ordered_qty: string;
  received_qty: number;
  unit_cost: string;
  notes: string;
}

function formatIDR(value: number | string | null | undefined): string {
  const num = typeof value === 'string' ? parseFloat(value) || 0 : Number(value || 0);
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

function formatQty(val: number | string | null | undefined): string {
  const num = typeof val === 'string' ? parseFloat(val) || 0 : Number(val || 0);
  return num.toLocaleString('id-ID', { maximumFractionDigits: 3 });
}

function isPoEligibleForOperationalActions(po: PosPurchaseOrder | null | undefined): boolean {
  if (!po) return false;
  const st = String(po.status || '').toUpperCase();
  if (st === 'CANCELLED' || st === 'REJECTED' || st === 'DRAFT' || st === 'PENDING_APPROVAL') {
    return false;
  }
  const app = String(po.approval_status || '').toUpperCase();
  if (app) {
    return app === 'APPROVED';
  }
  return ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'COMPLETED'].includes(st);
}

function getJakartaDateToday(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function formatDateId(val?: string | null): string {
  if (!val) return '-';
  const raw = String(val).trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return raw;
  const [, y, m, d] = match;
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

export const ProcurementPoSection: React.FC<ProcurementPoSectionProps> = ({
  propertyId,
  currentStaffName = 'Staff Purchasing',
  currentUserId = null,
  searchQuery = '',
  refreshTrigger = 0,
  showCreateModalExternal = false,
  onClearShowCreateModalExternal,
  onOpenReceiveGoodsForPo,
  onOpenViewReceiptsForPo,
  onOpenCreateInvoiceForPo,
  onOpenInvoiceDetailDrawer,
  onOpenVendorSupplierMaster,
  onRefreshParentTransactions,
}) => {
  const [orders, setOrders] = useState<PosPurchaseOrder[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [includeArchived, setIncludeArchived] = useState<boolean>(false);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  // Detail Drawer state
  const [selectedPo, setSelectedPo] = useState<PosPurchaseOrder | null>(null);
  const [_detailLoading, setDetailLoading] = useState<boolean>(false);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);

  // Create / Edit Modal state
  const [showFormModal, setShowFormModal] = useState<boolean>(false);
  const [editingPo, setEditingPo] = useState<PosPurchaseOrder | null>(null);
  const [suppliers, setSuppliers] = useState<PosSupplier[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterialCandidate[]>([]);
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [packagingsByProduct, setPackagingsByProduct] = useState<Record<number, ProductPackagingOption[]>>({});

  const [formSupplierId, setFormSupplierId] = useState<string>('');
  const [formOrderDate, setFormOrderDate] = useState<string>(() => getJakartaDateToday());
  const [formExpectedDate, setFormExpectedDate] = useState<string>('');
  const [formLocationId, setFormLocationId] = useState<string>('');
  const [formNotes, setFormNotes] = useState<string>('');
  const [formItems, setFormItems] = useState<PoFormLineItem[]>([
    {
      id: null,
      product_id: '',
      packaging_id: '',
      ordered_unit: 'PCS',
      conversion_factor: 1,
      ordered_qty: '1',
      received_qty: 0,
      unit_cost: '0',
      notes: '',
    },
  ]);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmittingForm, setIsSubmittingForm] = useState<boolean>(false);

  // Searchable Product Combobox State per PO Form Row
  const [openSearchRowIdx, setOpenSearchRowIdx] = useState<number | null>(null);
  const [rowSearchQueryByIdx, setRowSearchQueryByIdx] = useState<Record<number, string>>({});
  const [highlightedOptionIdx, setHighlightedOptionIdx] = useState<number>(0);

  // Filter hanya produk yang sudah di-checklist Lacak Inventory (track_stock & track_inventory)
  const trackedInventoryProducts = useMemo(() => {
    return rawMaterials.filter((m) => m.track_stock !== false && m.track_inventory !== false);
  }, [rawMaterials]);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetchPurchaseOrders(propertyId, {
        status: statusFilter !== 'ALL' ? statusFilter : undefined,
        search: searchQuery.trim() || undefined,
        include_archived: includeArchived,
      });
      setOrders(res.orders || []);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal memuat daftar Purchase Order (PO)');
    } finally {
      setLoading(false);
    }
  }, [propertyId, statusFilter, searchQuery, includeArchived]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    if (!refreshTrigger) return;
    void loadOrders();
    if (selectedPo?.id) {
      fetchPurchaseOrderById(propertyId, selectedPo.id)
        .then((freshPo) => {
          setSelectedPo((prev) => (prev && prev.id === freshPo.id ? freshPo : prev));
        })
        .catch(() => {
          // ignore
        });
    }
  }, [refreshTrigger, loadOrders, propertyId, selectedPo?.id]);

  const ensurePackagingsLoaded = useCallback(
    async (prodId: number): Promise<ProductPackagingOption[]> => {
      if (!prodId || prodId <= 0) return [];
      if (packagingsByProduct[prodId]) return packagingsByProduct[prodId];
      try {
        const list = await fetchProductPackagingsForGrn(propertyId, prodId);
        setPackagingsByProduct((prev) => ({ ...prev, [prodId]: list }));
        return list;
      } catch {
        return [];
      }
    },
    [propertyId, packagingsByProduct]
  );

  const preloadFormReferenceData = useCallback(async () => {
    try {
      const [supRes, rawRes, locRes] = await Promise.all([
        fetchSuppliers(propertyId, { is_active: true }),
        fetchRawMaterialCandidates(propertyId),
        fetchStockLocations(propertyId).catch(() => [] as StockLocation[]),
      ]);
      setSuppliers(supRes || []);
      setRawMaterials(rawRes || []);
      setLocations(locRes || []);
      return { supRes: supRes || [], rawRes: rawRes || [], locRes: locRes || [] };
    } catch (err) {
      console.error('Failed to preload PO reference data:', err);
      return { supRes: [], rawRes: [], locRes: [] };
    }
  }, [propertyId]);

  const openCreatePoModal = useCallback(async () => {
    setEditingPo(null);
    setFormError(null);
    setOpenSearchRowIdx(null);
    setRowSearchQueryByIdx({});
    setHighlightedOptionIdx(0);
    setFormOrderDate(getJakartaDateToday());
    setFormExpectedDate('');
    setFormNotes('');
    setFormItems([
      {
        id: null,
        product_id: '',
        packaging_id: '',
        ordered_unit: 'PCS',
        conversion_factor: 1,
        ordered_qty: '1',
        received_qty: 0,
        unit_cost: '0',
        notes: '',
      },
    ]);
    setShowFormModal(true);
    const { supRes, locRes } = await preloadFormReferenceData();
    if (supRes.length > 0) {
      setFormSupplierId(String(supRes[0].id));
    } else {
      setFormSupplierId('');
    }
    const gudang1 = locRes.find((l) => l.code === 'WH_MAIN' || l.location_type === 'WAREHOUSE') || locRes[0];
    setFormLocationId(gudang1 ? String(gudang1.id) : '');
  }, [preloadFormReferenceData]);

  useEffect(() => {
    if (showCreateModalExternal) {
      void openCreatePoModal();
      if (onClearShowCreateModalExternal) {
        onClearShowCreateModalExternal();
      }
    }
  }, [showCreateModalExternal, openCreatePoModal, onClearShowCreateModalExternal]);

  const openEditPoModal = async (poSummary: PosPurchaseOrder) => {
    setFormError(null);
    setOpenSearchRowIdx(null);
    setRowSearchQueryByIdx({});
    setHighlightedOptionIdx(0);
    setDetailLoading(true);
    try {
      const [detail, refData] = await Promise.all([
        fetchPurchaseOrderById(propertyId, poSummary.id),
        preloadFormReferenceData(),
      ]);
      setEditingPo(detail);
      setFormSupplierId(String(detail.canonical_supplier_id || detail.supplier_id || ''));
      setFormOrderDate((detail.order_date || getJakartaDateToday()).slice(0, 10));
      setFormExpectedDate(detail.expected_date ? String(detail.expected_date).slice(0, 10) : '');
      setFormLocationId(detail.destination_location_id ? String(detail.destination_location_id) : '');
      setFormNotes(detail.notes || '');

      const items = Array.isArray(detail.items) ? detail.items : [];
      for (const it of items) {
        if (it.product_id) {
          await ensurePackagingsLoaded(Number(it.product_id));
        }
      }
      if (items.length > 0) {
        const initQueries: Record<number, string> = {};
        items.forEach((it, idx) => {
          const foundRm = refData.rawRes.find((m) => Number(m.id) === Number(it.product_id));
          initQueries[idx] = foundRm?.name || it.product_name || '';
        });
        setRowSearchQueryByIdx(initQueries);
        setFormItems(
          items.map((it) => ({
            id: it.id ? Number(it.id) : null,
            product_id: String(it.product_id || ''),
            packaging_id: it.packaging_id ? String(it.packaging_id) : '',
            ordered_unit: String(it.ordered_unit || it.packaging_code || it.base_unit || 'PCS'),
            conversion_factor: Number(it.conversion_factor || 1),
            ordered_qty: String(Number(it.ordered_qty || 0)),
            received_qty: Number(it.received_qty || 0),
            unit_cost: String(Number(it.unit_cost || 0)),
            notes: it.notes || '',
          }))
        );
      }
      setShowFormModal(true);
    } catch (err: any) {
      alert(err?.message || 'Gagal membuka PO untuk diedit');
    } finally {
      setDetailLoading(false);
    }
  };

  const openPoDetailDrawer = async (poId: number) => {
    setDetailLoading(true);
    try {
      const detail = await fetchPurchaseOrderById(propertyId, poId);
      setSelectedPo(detail);
    } catch (err: any) {
      alert(err?.message || 'Gagal memuat detail PO');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleAddFormLine = () => {
    setFormItems((prev) => [
      ...prev,
      {
        id: null,
        product_id: '',
        packaging_id: '',
        ordered_unit: 'PCS',
        conversion_factor: 1,
        ordered_qty: '1',
        received_qty: 0,
        unit_cost: '0',
        notes: '',
      },
    ]);
  };

  const handleRemoveFormLine = (index: number) => {
    if (formItems.length <= 1) return;
    const target = formItems[index];
    if (target.received_qty > 0) {
      alert('Baris PO yang sudah memiliki penerimaan barang (GRN Posted) tidak dapat dihapus.');
      return;
    }
    setOpenSearchRowIdx(null);
    setRowSearchQueryByIdx((prev) => {
      const next: Record<number, string> = {};
      Object.keys(prev).forEach((k) => {
        const numK = Number(k);
        if (numK < index) next[numK] = prev[numK];
        else if (numK > index) next[numK - 1] = prev[numK];
      });
      return next;
    });
    setFormItems((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleFormProductChange = async (index: number, prodIdStr: string) => {
    const prodId = Number(prodIdStr);
    const rm = rawMaterials.find((m) => Number(m.id) === prodId);
    const baseUnit = rm?.canonical_base_unit_code || rm?.base_unit || 'PCS';
    const baseCost =
      rm?.last_cost && Number(rm.last_cost) > 0
        ? Number(rm.last_cost)
        : rm?.average_cost && Number(rm.average_cost) > 0
        ? Number(rm.average_cost)
        : 0;

    setRowSearchQueryByIdx((prev) => ({
      ...prev,
      [index]: rm ? rm.name : '',
    }));
    setOpenSearchRowIdx(null);

    const pkgList = prodId > 0 ? await ensurePackagingsLoaded(prodId) : [];
    const defaultPkg = pkgList.find((p) => p.is_default_purchase && p.is_active !== false);

    setFormItems((prev) => {
      const copy = [...prev];
      if (defaultPkg) {
        const factor = Number(defaultPkg.to_base_factor || 1);
        copy[index] = {
          ...copy[index],
          product_id: prodIdStr,
          packaging_id: String(defaultPkg.id),
          ordered_unit: defaultPkg.packaging_code,
          conversion_factor: factor,
          unit_cost: baseCost > 0 ? String(Math.round(baseCost * factor)) : copy[index].unit_cost,
        };
      } else {
        copy[index] = {
          ...copy[index],
          product_id: prodIdStr,
          packaging_id: '',
          ordered_unit: baseUnit,
          conversion_factor: 1,
          unit_cost: baseCost > 0 ? String(Math.round(baseCost)) : copy[index].unit_cost,
        };
      }
      return copy;
    });
  };

  const handleFormPackagingChange = (index: number, pkgIdStr: string) => {
    setFormItems((prev) => {
      const copy = [...prev];
      const line = copy[index];
      const prodId = Number(line.product_id);
      const rm = rawMaterials.find((m) => Number(m.id) === prodId);
      const baseUnit = rm?.canonical_base_unit_code || rm?.base_unit || 'PCS';
      const baseCost =
        rm?.last_cost && Number(rm.last_cost) > 0
          ? Number(rm.last_cost)
          : rm?.average_cost && Number(rm.average_cost) > 0
          ? Number(rm.average_cost)
          : 0;

      if (!pkgIdStr) {
        copy[index] = {
          ...line,
          packaging_id: '',
          ordered_unit: baseUnit,
          conversion_factor: 1,
          unit_cost: baseCost > 0 ? String(Math.round(baseCost)) : line.unit_cost,
        };
      } else {
        const pkgs = packagingsByProduct[prodId] || [];
        const found = pkgs.find((p) => String(p.id) === pkgIdStr);
        if (found) {
          const factor = Number(found.to_base_factor || 1);
          copy[index] = {
            ...line,
            packaging_id: String(found.id),
            ordered_unit: found.packaging_code,
            conversion_factor: factor,
            unit_cost: baseCost > 0 ? String(Math.round(baseCost * factor)) : line.unit_cost,
          };
        }
      }
      return copy;
    });
  };

  const handleFormLineFieldChange = (index: number, field: keyof PoFormLineItem, value: string) => {
    setFormItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  const calculatedPoTotal = useMemo(() => {
    return formItems.reduce((acc, it) => {
      const q = parseFloat(it.ordered_qty) || 0;
      const c = parseFloat(it.unit_cost) || 0;
      return acc + q * c;
    }, 0);
  }, [formItems]);

  const handleSubmitPoForm = async (submitForApproval: boolean) => {
    setFormError(null);
    if (!formSupplierId) {
      setFormError('Pilih pemasok (Supplier) dari Master Rekanan terlebih dahulu.');
      return;
    }

    const cleanedItems = formItems.map((it) => ({
      id: it.id || null,
      product_id: Number(it.product_id),
      packaging_id: it.packaging_id ? Number(it.packaging_id) : null,
      ordered_unit: it.ordered_unit || 'PCS',
      ordered_qty: parseFloat(it.ordered_qty),
      unit_cost: parseFloat(it.unit_cost || '0'),
      notes: it.notes.trim() || null,
    }));

    if (
      cleanedItems.length === 0 ||
      cleanedItems.some((it) => !it.product_id || Number.isNaN(it.ordered_qty) || it.ordered_qty <= 0)
    ) {
      setFormError('Setiap baris PO wajib memilih produk stok dan jumlah pesan > 0.');
      return;
    }

    const nonStockLine = cleanedItems.find((it) => {
      const rm = rawMaterials.find((m) => Number(m.id) === Number(it.product_id));
      return rm && (rm.track_stock === false || rm.track_inventory === false);
    });
    if (nonStockLine) {
      const rm = rawMaterials.find((m) => Number(m.id) === Number(nonStockLine.product_id));
      setFormError(
        `Produk "${rm?.name || `#${nonStockLine.product_id}`}" belum diaktifkan sebagai item terlacak stok (track_stock/track_inventory = false). Aktifkan opsi "Lacak Stok & Penerimaan Gudang (GRN)" pada Master Barang & Produk terlebih dahulu.`
      );
      return;
    }

    setIsSubmittingForm(true);
    try {
      if (editingPo) {
        const updated = await updatePurchaseOrder(propertyId, editingPo.id, {
          supplier_id: Number(formSupplierId),
          order_date: formOrderDate || undefined,
          expected_date: formExpectedDate || null,
          destination_location_id: formLocationId ? Number(formLocationId) : null,
          notes: formNotes.trim() || null,
          submit_for_approval: submitForApproval,
          updated_by: currentUserId || currentStaffName,
          actor_name_snapshot: currentStaffName,
          items: cleanedItems,
        });
        setShowFormModal(false);
        setEditingPo(null);
        setBannerSuccess(
          `PO #${updated.po_number} berhasil diperbarui (${
            updated.approval_status === 'PENDING_APPROVAL'
              ? 'Menunggu Persetujuan Ulang'
              : updated.approval_status || updated.status
          }).`
        );
        await loadOrders();
        if (selectedPo && selectedPo.id === updated.id) {
          const fresh = await fetchPurchaseOrderById(propertyId, updated.id);
          setSelectedPo(fresh);
        }
      } else {
        const created = await createPurchaseOrder({
          property_id: propertyId,
          supplier_id: Number(formSupplierId),
          order_date: formOrderDate || undefined,
          expected_date: formExpectedDate || null,
          destination_location_id: formLocationId ? Number(formLocationId) : null,
          notes: formNotes.trim() || null,
          submit_for_approval: submitForApproval,
          initial_status: submitForApproval ? 'PENDING_APPROVAL' : 'DRAFT',
          created_by: currentUserId || currentStaffName,
          actor_name_snapshot: currentStaffName,
          items: cleanedItems,
        });
        setShowFormModal(false);
        setBannerSuccess(
          `PO #${created.po_number} berhasil dibuat (${
            submitForApproval ? 'Menunggu Persetujuan' : 'Draft'
          }).`
        );
        await loadOrders();
      }
      if (onRefreshParentTransactions) onRefreshParentTransactions();
    } catch (err: any) {
      setFormError(err?.message || 'Gagal menyimpan Purchase Order');
    } finally {
      setIsSubmittingForm(false);
    }
  };

  const handlePoStatusAction = async (
    po: PosPurchaseOrder,
    action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'ARCHIVE' | 'UNARCHIVE' | 'CANCELLED'
  ) => {
    let reason: string | null = null;
    if (action === 'REJECT') {
      const input = window.prompt(`Masukkan alasan penolakan PO #${po.po_number}:`, 'Harga / kuantitas perlu direvisi');
      if (input === null) return;
      reason = input.trim() || 'Ditolak oleh pejabat berwenang';
    } else if (action === 'ARCHIVE') {
      reason = 'Diarsipkan dari halaman Pengadaan Terpadu';
    }

    setActionBusyId(po.id);
    setErrorMsg(null);
    try {
      await updatePurchaseOrderStatus(propertyId, po.id, action, currentStaffName, {
        reason,
        actor_name_snapshot: currentStaffName,
      });
      const labelMap: Record<string, string> = {
        SUBMIT: 'diajukan untuk persetujuan',
        APPROVE: 'disetujui (APPROVED)',
        REJECT: 'ditolak (REJECTED)',
        ARCHIVE: 'diarsipkan',
        UNARCHIVE: 'dipulihkan dari arsip',
        CANCELLED: 'dibatalkan',
      };
      setBannerSuccess(`PO #${po.po_number} berhasil ${labelMap[action] || 'diperbarui'}.`);
      await loadOrders();
      if (selectedPo && selectedPo.id === po.id) {
        const refreshed = await fetchPurchaseOrderById(propertyId, po.id);
        setSelectedPo(refreshed);
      }
      if (onRefreshParentTransactions) onRefreshParentTransactions();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal memperbarui status PO');
    } finally {
      setActionBusyId(null);
    }
  };

  const renderPoApprovalBadge = (po: PosPurchaseOrder) => {
    const app = po.approval_status || (po.status === 'DRAFT' ? 'DRAFT' : po.status === 'REJECTED' ? 'REJECTED' : 'APPROVED');
    if (po.status === 'CANCELLED') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-300">
          Dibatalkan
        </span>
      );
    }
    if (app === 'APPROVED') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
          Disetujui
        </span>
      );
    }
    if (app === 'PENDING_APPROVAL') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          Menunggu Persetujuan
        </span>
      );
    }
    if (app === 'REJECTED') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-50 text-rose-800 border border-rose-200">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-600" />
          Ditolak
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
        Draft PO
      </span>
    );
  };

  const renderPoReceivingBadge = (po: PosPurchaseOrder) => {
    const rcv = po.receiving_status || 'BELUM_DITERIMA';
    const progress = po.receiving_progress_text;
    if (rcv === 'DITERIMA_LENGKAP' || po.status === 'COMPLETED') {
      return (
        <div className="inline-flex flex-col items-center gap-0.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
            Diterima Lengkap
          </span>
          {progress && <span className="text-[10px] font-mono text-emerald-700 font-semibold">{progress}</span>}
        </div>
      );
    }
    if (rcv === 'DITERIMA_SEBAGIAN' || po.status === 'PARTIALLY_RECEIVED') {
      return (
        <div className="inline-flex flex-col items-center gap-0.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
            Diterima Sebagian
          </span>
          {progress && <span className="text-[10px] font-mono text-amber-700 font-semibold">{progress}</span>}
        </div>
      );
    }
    return (
      <div className="inline-flex flex-col items-center gap-0.5">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
          Belum Diterima
        </span>
        {progress && <span className="text-[10px] font-mono text-slate-500">{progress}</span>}
      </div>
    );
  };

  const renderPoPaymentSettlementBadge = (po: PosPurchaseOrder) => {
    const st = po.payment_settlement_status || (Number(po.invoice_count || 0) === 0 ? 'BELUM_ADA_TAGIHAN' : 'BELUM_DIBAYAR');
    if (st === 'BELUM_ADA_TAGIHAN') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
          Belum Ada Tagihan
        </span>
      );
    }
    if (st === 'LUNAS') {
      return (
        <div className="inline-flex flex-col items-center gap-0.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
            Lunas
          </span>
          {po.has_po_variance && (
            <span className="text-[9px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.2 rounded">
              Selisih PO
            </span>
          )}
        </div>
      );
    }
    if (st === 'DIBAYAR_SEBAGIAN') {
      return (
        <div className="inline-flex flex-col items-center gap-0.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-50 text-blue-800 border border-blue-200">
            Dibayar Sebagian
          </span>
          {po.has_po_variance && (
            <span className="text-[9px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.2 rounded">
              Selisih PO
            </span>
          )}
        </div>
      );
    }
    return (
      <div className="inline-flex flex-col items-center gap-0.5">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
          Belum Dibayar
        </span>
        {po.has_po_variance && (
          <span className="text-[9px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.2 rounded">
            Selisih PO
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="bg-white border border-slate-200/90 rounded-2xl shadow-sm overflow-hidden">
      {/* Header Bar */}
      <div className="px-5 py-4 bg-gradient-to-r from-[#1b4332]/5 via-amber-50/30 to-white border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#1b4332] text-[#d4af37] rounded-md">
              Tahap 1A • Pengadaan Terpadu
            </span>
            <h2 className="text-sm font-bold text-slate-900">
              Daftar Purchase Order (PO) &amp; Otorisasi Pengadaan
            </h2>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Pengadaan baru wajib dimulai dari PO yang disetujui. Penerimaan barang (GRN) dan pencatatan tagihan/nota berjalan pada batas kuantitas kumulatif yang sama.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Status filter pills */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200 text-[11px]">
            {[
              { key: 'ALL', label: 'Semua PO' },
              { key: 'DRAFT', label: 'Draft' },
              { key: 'PENDING_APPROVAL', label: 'Menunggu' },
              { key: 'APPROVED', label: 'Disetujui' },
              { key: 'REJECTED', label: 'Ditolak' },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setStatusFilter(f.key)}
                className={`px-2.5 py-1 rounded-lg font-semibold transition-colors cursor-pointer ${
                  statusFilter === f.key
                    ? 'bg-[#1b4332] text-white shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-white'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 font-medium cursor-pointer px-2 py-1 rounded-lg hover:bg-slate-100">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="rounded border-slate-300 text-emerald-700 focus:ring-emerald-500"
            />
            <span>Tampilkan Arsip</span>
          </label>

          <button
            type="button"
            onClick={() => void openCreatePoModal()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#1b4332] hover:bg-[#143427] text-white text-xs font-bold shadow-sm transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5 text-[#d4af37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M12 4v16m8-8H4" />
            </svg>
            <span>+ Buat PO</span>
          </button>
        </div>
      </div>

      {bannerSuccess && (
        <div className="px-5 py-2.5 bg-emerald-50 border-b border-emerald-200 text-emerald-800 text-xs font-medium flex items-center justify-between">
          <span>{bannerSuccess}</span>
          <button
            type="button"
            onClick={() => setBannerSuccess(null)}
            className="text-emerald-700 hover:text-emerald-900 font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="px-5 py-2.5 bg-rose-50 border-b border-rose-200 text-rose-700 text-xs font-medium flex items-center justify-between">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => void loadOrders()}
            className="underline font-bold cursor-pointer"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {/* PO Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-slate-700" style={{ tableLayout: 'auto' }}>
          <thead className="bg-slate-50/90 text-slate-500 font-bold uppercase tracking-wider text-[10px] border-b border-slate-200">
            <tr>
              <th className="py-2.5 px-4">No. PO &amp; Tanggal</th>
              <th className="py-2.5 px-3">Supplier (Master Rekanan)</th>
              <th className="py-2.5 px-3 text-right">Nilai PO</th>
              <th className="py-2.5 px-3 text-center">Otorisasi PO</th>
              <th className="py-2.5 px-3 text-center">Penerimaan Barang</th>
              <th className="py-2.5 px-3 text-center">Tagihan &amp; Pelunasan</th>
              <th className="py-2.5 px-4 text-center">Aksi Pengadaan</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400">
                  Memuat daftar Purchase Order...
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400">
                  Belum ada Purchase Order (PO) pada filter ini. Klik <strong>+ Buat PO</strong> untuk memulai pengadaan baru.
                </td>
              </tr>
            ) : (
              orders.map((po) => {
                const isApproved = isPoEligibleForOperationalActions(po);
                const isFullyReceived =
                  po.receiving_status === 'DITERIMA_LENGKAP' || po.status === 'COMPLETED';
                const hasAnyGrn = Number(po.grn_posted_count || 0) > 0 || Number(po.grn_draft_count || 0) > 0;

                return (
                  <tr
                    key={po.id}
                    onClick={() => void openPoDetailDrawer(po.id)}
                    className={`hover:bg-slate-50/80 transition-colors cursor-pointer ${
                      po.archived_at ? 'opacity-65 bg-slate-50/40' : ''
                    }`}
                  >
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openPoDetailDrawer(po.id);
                          }}
                          className="font-mono font-bold text-emerald-800 hover:text-emerald-950 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-1 rounded-xs cursor-pointer text-left"
                          title={`Buka detail ${po.po_number}`}
                        >
                          {po.po_number}
                        </button>
                        {Number(po.source_revision || 1) > 1 && (
                          <span className="px-1.5 py-0.2 text-[9px] font-bold bg-blue-50 text-blue-700 border border-blue-200 rounded">
                            Rev.{po.source_revision}
                          </span>
                        )}
                        {po.archived_at && (
                          <span className="px-1.5 py-0.2 text-[9px] font-bold bg-slate-200 text-slate-700 rounded">
                            Arsip
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Tgl: {formatDateId(po.order_date)}
                        {po.expected_date ? ` • Est: ${formatDateId(po.expected_date)}` : ''}
                      </div>
                    </td>

                    <td className="py-2.5 px-3">
                      <div className="font-semibold text-slate-800">{po.supplier_name || '-'}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{po.supplier_code || ''}</div>
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900 whitespace-nowrap">
                      <div>{formatIDR(po.total_amount ?? po.total_estimated_amount)}</div>
                      {Number(po.invoice_count || 0) > 0 && (
                        <div className="text-[10px] font-normal text-slate-500">
                          Tagihan: {formatIDR(po.invoiced_total_amount || 0)}
                        </div>
                      )}
                    </td>

                    <td className="py-2.5 px-3 text-center whitespace-nowrap">
                      {renderPoApprovalBadge(po)}
                      {po.approved_by_name_snapshot && isApproved && (
                        <div className="text-[9px] text-slate-400 mt-0.5">
                          oleh {po.approved_by_name_snapshot}
                        </div>
                      )}
                    </td>

                    <td className="py-2.5 px-3 text-center whitespace-nowrap">
                      {renderPoReceivingBadge(po)}
                    </td>

                    <td className="py-2.5 px-3 text-center whitespace-nowrap">
                      {renderPoPaymentSettlementBadge(po)}
                    </td>

                    <td className="py-2.5 px-4 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-center gap-1 flex-wrap">
                        {/* Draft / Rejected -> Submit or Approve */}
                        {(po.approval_status === 'DRAFT' || po.status === 'DRAFT' || po.approval_status === 'REJECTED') && (
                          <>
                            <button
                              type="button"
                              disabled={actionBusyId === po.id}
                              onClick={() => void handlePoStatusAction(po, 'SUBMIT')}
                              className="px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 cursor-pointer"
                            >
                              Ajukan
                            </button>
                            <button
                              type="button"
                              disabled={actionBusyId === po.id}
                              onClick={() => void handlePoStatusAction(po, 'APPROVE')}
                              className="px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-700 hover:bg-emerald-800 text-white cursor-pointer"
                            >
                              Setujui PO
                            </button>
                          </>
                        )}

                        {po.approval_status === 'PENDING_APPROVAL' && (
                          <>
                            <button
                              type="button"
                              disabled={actionBusyId === po.id}
                              onClick={() => void handlePoStatusAction(po, 'APPROVE')}
                              className="px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-700 hover:bg-emerald-800 text-white cursor-pointer"
                            >
                              Setujui PO
                            </button>
                            <button
                              type="button"
                              disabled={actionBusyId === po.id}
                              onClick={() => void handlePoStatusAction(po, 'REJECT')}
                              className="px-2 py-1 rounded-lg text-[10px] font-bold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 cursor-pointer"
                            >
                              Tolak
                            </button>
                          </>
                        )}

                        {/* Approved PO Operational Actions */}
                        {isApproved && !isFullyReceived && (
                          <button
                            type="button"
                            onClick={() => onOpenReceiveGoodsForPo(po)}
                            className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-[#1b4332] hover:bg-[#143427] text-white cursor-pointer"
                            title="Terima barang fisik (GRN) langsung dari PO ini"
                          >
                            Terima Barang
                          </button>
                        )}

                        {(isFullyReceived || hasAnyGrn) && (
                          <button
                            type="button"
                            onClick={() => onOpenViewReceiptsForPo(po)}
                            className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 cursor-pointer"
                            title="Lihat dokumen Penerimaan Barang (GRN) terkait PO ini"
                          >
                            Lihat Penerimaan
                          </button>
                        )}

                        {isApproved && (
                          <button
                            type="button"
                            onClick={() => onOpenCreateInvoiceForPo(po)}
                            className="px-2.5 py-1 rounded-lg text-[10px] font-bold bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
                            title="Catat Tagihan / Nota Supplier berdasarkan PO ini"
                          >
                            Catat Tagihan/Nota
                          </button>
                        )}

                        {!isFullyReceived && po.status !== 'CANCELLED' && (
                          <button
                            type="button"
                            onClick={() => void openEditPoModal(po)}
                            className="px-2 py-1 rounded-lg text-[10px] font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 cursor-pointer"
                          >
                            Edit/Revisi
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* PO Detail Modal / Drawer */}
      {selectedPo && (
        <div className="fixed inset-0 z-50 flex items-center justify-end bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white w-full max-w-3xl h-full overflow-y-auto shadow-2xl border-l border-slate-200 flex flex-col">
            <div className="p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between sticky top-0 z-10">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base font-bold text-slate-900">
                    {selectedPo.po_number}
                  </span>
                  {renderPoApprovalBadge(selectedPo)}
                  {renderPoReceivingBadge(selectedPo)}
                  {renderPoPaymentSettlementBadge(selectedPo)}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Supplier: <strong>{selectedPo.supplier_name}</strong> ({selectedPo.supplier_code}) • Tanggal PO: {formatDateId(selectedPo.order_date)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPo(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-5 flex-1 text-xs">
              {/* Quick Unified Procurement Actions */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] font-semibold text-slate-700">
                  Aksi Dokumen Pengadaan Terpadu:
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {(selectedPo.approval_status === 'DRAFT' ||
                    selectedPo.status === 'DRAFT' ||
                    selectedPo.approval_status === 'REJECTED') && (
                    <>
                      <button
                        type="button"
                        disabled={actionBusyId === selectedPo.id}
                        onClick={() => void handlePoStatusAction(selectedPo, 'SUBMIT')}
                        className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer"
                      >
                        Ajukan Persetujuan
                      </button>
                      <button
                        type="button"
                        disabled={actionBusyId === selectedPo.id}
                        onClick={() => void handlePoStatusAction(selectedPo, 'APPROVE')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold cursor-pointer"
                      >
                        Setujui PO
                      </button>
                    </>
                  )}

                  {selectedPo.approval_status === 'PENDING_APPROVAL' && (
                    <>
                      <button
                        type="button"
                        disabled={actionBusyId === selectedPo.id}
                        onClick={() => void handlePoStatusAction(selectedPo, 'APPROVE')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold cursor-pointer"
                      >
                        Setujui PO
                      </button>
                      <button
                        type="button"
                        disabled={actionBusyId === selectedPo.id}
                        onClick={() => void handlePoStatusAction(selectedPo, 'REJECT')}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold cursor-pointer"
                      >
                        Tolak PO
                      </button>
                    </>
                  )}

                  {isPoEligibleForOperationalActions(selectedPo) && (
                    <>
                      {selectedPo.receiving_status !== 'DITERIMA_LENGKAP' && (
                        <button
                          type="button"
                          onClick={() => {
                            const poRef = selectedPo;
                            setSelectedPo(null);
                            onOpenReceiveGoodsForPo(poRef);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-[#1b4332] hover:bg-[#143427] text-white font-bold cursor-pointer"
                        >
                          Terima Barang (GRN)
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const poRef = selectedPo;
                          setSelectedPo(null);
                          onOpenViewReceiptsForPo(poRef);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold cursor-pointer"
                      >
                        Lihat Penerimaan
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const poRef = selectedPo;
                          setSelectedPo(null);
                          onOpenCreateInvoiceForPo(poRef);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white font-bold cursor-pointer"
                      >
                        Catat Tagihan / Nota
                      </button>
                      {Array.isArray(selectedPo.linked_invoices) && selectedPo.linked_invoices.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            const unpaidInv =
                              selectedPo.linked_invoices?.find((inv: any) => inv.payment_status !== 'PAID') ||
                              selectedPo.linked_invoices?.[0];
                            if (unpaidInv) {
                              setSelectedPo(null);
                              onOpenInvoiceDetailDrawer(unpaidInv.id);
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold cursor-pointer"
                        >
                          Catat Pembayaran
                        </button>
                      )}
                    </>
                  )}

                  {selectedPo.receiving_status !== 'DITERIMA_LENGKAP' && (
                    <button
                      type="button"
                      onClick={() => {
                        const poRef = selectedPo;
                        setSelectedPo(null);
                        void openEditPoModal(poRef);
                      }}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-semibold cursor-pointer"
                    >
                      Edit / Revisi PO
                    </button>
                  )}

                  {selectedPo.archived_at ? (
                    <button
                      type="button"
                      onClick={() => void handlePoStatusAction(selectedPo, 'UNARCHIVE')}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-semibold cursor-pointer"
                    >
                      Buka Arsip
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handlePoStatusAction(selectedPo, 'ARCHIVE')}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-600 font-semibold cursor-pointer"
                    >
                      Arsipkan
                    </button>
                  )}
                </div>
              </div>

              {/* Audit & Otorisasi Info */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-white border border-slate-200 rounded-xl p-3.5">
                <div>
                  <div className="text-[10px] font-bold uppercase text-slate-400">Status Persetujuan</div>
                  <div className="mt-1 font-semibold text-slate-800">
                    {selectedPo.approval_status || selectedPo.status}
                  </div>
                  {selectedPo.approved_by_name_snapshot && (
                    <div className="text-[11px] text-slate-500">
                      Disetujui oleh: {selectedPo.approved_by_name_snapshot}
                      {selectedPo.approved_at ? ` (${new Date(selectedPo.approved_at).toLocaleString('id-ID')})` : ''}
                    </div>
                  )}
                  {selectedPo.rejection_reason && (
                    <div className="text-[11px] text-rose-600 mt-0.5">
                      Alasan tolak: {selectedPo.rejection_reason}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-slate-400">Batas Penerimaan Kumulatif</div>
                  <div className="mt-1 font-semibold text-slate-800">
                    {selectedPo.receiving_progress_text || '-'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    GRN Posted: {selectedPo.grn_posted_count || 0} • Draft: {selectedPo.grn_draft_count || 0}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase text-slate-400">Ringkasan Tagihan &amp; Bayar</div>
                  <div className="mt-1 font-mono font-bold text-slate-900">
                    PO: {formatIDR(selectedPo.total_amount ?? selectedPo.total_estimated_amount)}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Ditagihkan: {formatIDR(selectedPo.invoiced_total_amount || 0)} • Dibayar: {formatIDR(selectedPo.paid_total_amount || 0)}
                  </div>
                </div>
              </div>

              {/* PO Line Items Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 font-bold text-slate-700 flex items-center justify-between">
                  <span>Rincian Baris Pesanan PO (Batas Penerimaan Kumulatif)</span>
                  <span className="text-[10px] font-normal text-slate-500">
                    Mendukung multi-baris SKU sama dengan kemasan/satuan berbeda
                  </span>
                </div>
                <table className="w-full text-left text-[11px]" style={{ tableLayout: 'auto' }}>
                  <thead className="bg-slate-50/70 border-b border-slate-200 text-slate-500 uppercase text-[10px]">
                    <tr>
                      <th className="py-2 px-3">ID Baris</th>
                      <th className="py-2 px-3">Produk / SKU</th>
                      <th className="py-2 px-3">Satuan / Kemasan</th>
                      <th className="py-2 px-3 text-right">Dipesan</th>
                      <th className="py-2 px-3 text-right">Diterima</th>
                      <th className="py-2 px-3 text-right">Sisa</th>
                      <th className="py-2 px-3 text-right">Harga Satuan</th>
                      <th className="py-2 px-3 text-right">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(selectedPo.items || []).map((item) => {
                      const ordered = Number(item.ordered_qty || 0);
                      const received = Number(item.received_qty || 0);
                      const remaining =
                        item.remaining_qty !== undefined
                          ? Number(item.remaining_qty)
                          : Math.max(0, Number((ordered - received).toFixed(4)));
                      const factor = Number(item.conversion_factor || 1);
                      const unitLabel = item.ordered_unit || item.packaging_code || item.base_unit || 'PCS';
                      return (
                        <tr key={item.id}>
                          <td className="py-2 px-3 font-mono text-slate-500">#{item.id}</td>
                          <td className="py-2 px-3">
                            <div className="font-semibold text-slate-800">{item.product_name}</div>
                            <div className="text-[10px] text-slate-400 font-mono">
                              {item.item_code || item.product_code || `PROD-${item.product_id}`}
                            </div>
                            {(item.track_stock === false || item.track_inventory === false) && (
                              <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 border border-amber-300 text-amber-800 text-[10px] font-bold">
                                ⚠ Belum Lacak Stok GRN — Aktifkan di Master Barang &amp; Produk → Edit
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <span className="font-semibold text-slate-800">{unitLabel}</span>
                            {factor > 1 && (
                              <div className="text-[10px] text-emerald-700 font-mono">
                                1 {unitLabel} = {formatQty(factor)} {item.canonical_base_unit_code || item.base_unit}
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right font-mono font-semibold">{formatQty(ordered)}</td>
                          <td className="py-2 px-3 text-right font-mono text-emerald-700 font-semibold">{formatQty(received)}</td>
                          <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">{formatQty(remaining)}</td>
                          <td className="py-2 px-3 text-right font-mono">{formatIDR(item.unit_cost)}</td>
                          <td className="py-2 px-3 text-right font-mono font-semibold">
                            {formatIDR(item.line_total ?? ordered * Number(item.unit_cost || 0))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Linked Goods Receipts (GRN) */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 font-bold text-slate-700 flex items-center justify-between">
                  <span>Dokumen Penerimaan Barang (GRN) Terkait</span>
                  <button
                    type="button"
                    onClick={() => {
                      const poRef = selectedPo;
                      setSelectedPo(null);
                      onOpenViewReceiptsForPo(poRef);
                    }}
                    className="text-[11px] text-emerald-700 hover:underline font-semibold cursor-pointer"
                  >
                    Buka di Penerimaan Barang →
                  </button>
                </div>
                {Array.isArray(selectedPo.linked_goods_receipts) && selectedPo.linked_goods_receipts.length > 0 ? (
                  <table className="w-full text-left text-[11px]" style={{ tableLayout: 'auto' }}>
                    <thead className="bg-slate-50/70 border-b border-slate-200 text-slate-500 uppercase text-[10px]">
                      <tr>
                        <th className="py-2 px-3">No. GRN</th>
                        <th className="py-2 px-3">Tanggal</th>
                        <th className="py-2 px-3">No. Surat Jalan / Nota</th>
                        <th className="py-2 px-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedPo.linked_goods_receipts.map((grn: any) => (
                        <tr key={grn.id}>
                          <td className="py-2 px-3 font-mono font-bold text-slate-800">{grn.grn_number}</td>
                          <td className="py-2 px-3">{formatDateId(grn.receipt_date)}</td>
                          <td className="py-2 px-3 font-mono text-slate-600">{grn.invoice_no || '-'}</td>
                          <td className="py-2 px-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                grn.status === 'POSTED' || grn.status === 'COMPLETED'
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : 'bg-amber-50 text-amber-800 border border-amber-200'
                              }`}
                            >
                              {grn.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="p-4 text-center text-slate-400">
                    Belum ada dokumen Penerimaan Barang (GRN) untuk PO ini.
                  </div>
                )}
              </div>

              {/* Linked Invoices / Purchase Transactions */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 font-bold text-slate-700 flex items-center justify-between">
                  <span>Tagihan / Nota Pembelian Terkait</span>
                  {isPoEligibleForOperationalActions(selectedPo) && (
                    <button
                      type="button"
                      onClick={() => {
                        const poRef = selectedPo;
                        setSelectedPo(null);
                        onOpenCreateInvoiceForPo(poRef);
                      }}
                      className="text-[11px] text-blue-700 hover:underline font-semibold cursor-pointer"
                    >
                      + Catat Tagihan / Nota Baru →
                    </button>
                  )}
                </div>
                {Array.isArray(selectedPo.linked_invoices) && selectedPo.linked_invoices.length > 0 ? (
                  <table className="w-full text-left text-[11px]" style={{ tableLayout: 'auto' }}>
                    <thead className="bg-slate-50/70 border-b border-slate-200 text-slate-500 uppercase text-[10px]">
                      <tr>
                        <th className="py-2 px-3">No. Transaksi</th>
                        <th className="py-2 px-3">Tanggal</th>
                        <th className="py-2 px-3">No. Faktur</th>
                        <th className="py-2 px-3 text-right">Total Tagihan</th>
                        <th className="py-2 px-3 text-center">Pelunasan</th>
                        <th className="py-2 px-3 text-center">Pemeriksaan</th>
                        <th className="py-2 px-3 text-center">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedPo.linked_invoices.map((inv: any) => (
                        <tr key={inv.id}>
                          <td className="py-2 px-3 font-mono font-bold text-slate-800">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPo(null);
                                onOpenInvoiceDetailDrawer(inv.id);
                              }}
                              className="font-mono font-bold text-emerald-800 hover:text-emerald-950 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-1 rounded-xs cursor-pointer text-left"
                              title={`Buka detail ${inv.transaction_no}`}
                            >
                              {inv.transaction_no}
                            </button>
                            {inv.has_po_variance && (
                              <span className="ml-1.5 px-1.5 py-0.2 text-[9px] font-bold bg-amber-100 text-amber-800 rounded">
                                Selisih PO
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3">{formatDateId(inv.transaction_date)}</td>
                          <td className="py-2 px-3 font-mono text-slate-600">{inv.source_reference || inv.external_reference || '-'}</td>
                          <td className="py-2 px-3 text-right font-mono font-semibold">
                            {formatIDR(inv.net_amount ?? inv.total_amount ?? 0)}
                          </td>
                          <td className="py-2 px-3 text-center">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                inv.payment_status === 'PAID'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : inv.payment_status === 'PARTIAL' || inv.payment_status === 'PARTIALLY_PAID'
                                  ? 'bg-blue-50 text-blue-700'
                                  : 'bg-amber-50 text-amber-800'
                              }`}
                            >
                              {inv.payment_status === 'PAID'
                                ? 'Lunas'
                                : inv.payment_status === 'PARTIAL' || inv.payment_status === 'PARTIALLY_PAID'
                                ? 'Dibayar Sebagian'
                                : 'Belum Dibayar'}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-center">
                            <span className="text-[10px] font-semibold text-slate-600">
                              {inv.verification_status === 'VERIFIED'
                                ? 'Terverifikasi'
                                : inv.verification_status === 'REJECTED'
                                ? 'Perlu Koreksi'
                                : 'Belum Diperiksa'}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-center">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPo(null);
                                onOpenInvoiceDetailDrawer(inv.id);
                              }}
                              className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold cursor-pointer"
                            >
                              Detail / Bayar
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="p-4 text-center text-slate-400">
                    Belum Ada Tagihan untuk PO ini. Barang tetap dapat diterima terlebih dahulu menggunakan tombol <strong>Terima Barang (GRN)</strong>.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit PO Modal */}
      {showFormModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  {editingPo
                    ? `Edit / Revisi Purchase Order #${editingPo.po_number}`
                    : 'Buat Purchase Order (PO) Pengadaan Baru'}
                </h3>
                <p className="text-[11px] text-slate-500">
                  Menggunakan satu Master Rekanan kanonik (`Vendor & Supplier`). Menyimpan atau menyetujui PO tidak otomatis menambah stok atau membuat tagihan.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowFormModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 flex-1 text-xs">
              {editingPo && editingPo.approval_status === 'APPROVED' && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-[11px]">
                  <strong>Perhatian Revisi PO:</strong> Perubahan material pada pemasok, item, kuantitas, atau harga satuan akan mengembalikan status PO menjadi <strong>Menunggu Persetujuan</strong> agar diotorisasi ulang. Baris yang sudah memiliki GRN Posted dilindungi dari pengurangan di bawah jumlah diterima.
                </div>
              )}

              {formError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 font-semibold">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="sm:col-span-2">
                  <div className="flex items-center justify-between mb-1">
                    <label className="font-bold text-slate-700">
                      Supplier / Vendor (Master Rekanan) <span className="text-rose-500">*</span>
                    </label>
                    {onOpenVendorSupplierMaster && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowFormModal(false);
                          onOpenVendorSupplierMaster();
                        }}
                        className="text-[10px] font-semibold text-emerald-700 hover:underline cursor-pointer"
                      >
                        + Kelola Vendor &amp; Supplier
                      </button>
                    )}
                  </div>
                  <select
                    value={formSupplierId}
                    onChange={(e) => setFormSupplierId(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-3 py-2 bg-white text-slate-800 font-medium"
                  >
                    <option value="">-- Pilih Supplier Kanonik --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.code})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">Tanggal PO</label>
                  <input
                    type="date"
                    value={formOrderDate}
                    onChange={(e) => setFormOrderDate(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-3 py-2 bg-white text-slate-800"
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">Lokasi Tujuan Default</label>
                  <select
                    value={formLocationId}
                    onChange={(e) => setFormLocationId(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-3 py-2 bg-white text-slate-800"
                  >
                    <option value="">Gudang Utama (Default)</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name} ({loc.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Catatan PO</label>
                <input
                  type="text"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="Catatan pengiriman / spesifikasi pesanan..."
                  className="w-full border border-slate-300 rounded-xl px-3 py-2 bg-white text-slate-800"
                />
              </div>

              {/* Line Items */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="font-bold text-slate-800">
                      Daftar Barang / Bahan Baku yang Dipesan
                    </label>
                    <p className="text-[10px] text-slate-500">
                      Hanya menampilkan produk yang sudah diaktifkan <strong>Lacak Inventory</strong> ({trackedInventoryProducts.length} produk tersedia). Ketik nama atau SKU untuk mencari.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddFormLine}
                    className="px-3 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold cursor-pointer"
                  >
                    + Tambah Baris Item
                  </button>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-visible">
                  <table className="w-full text-left text-[11px]">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase text-[10px]">
                      <tr>
                        <th className="py-2 px-3 min-w-[230px]">Produk Stok (Cari Nama / SKU)</th>
                        <th className="py-2 px-3 w-36">SKU</th>
                        <th className="py-2 px-3 min-w-[165px]">Kemasan / Satuan Beli</th>
                        <th className="py-2 px-3 text-right w-24">Qty Pesan</th>
                        <th className="py-2 px-3 text-right w-36">Harga / Satuan Beli</th>
                        <th className="py-2 px-3 text-right w-32">Subtotal</th>
                        <th className="py-2 px-2 text-center w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {formItems.map((it, idx) => {
                        const prodId = Number(it.product_id);
                        const rm = rawMaterials.find((m) => Number(m.id) === prodId);
                        const skuCode = rm?.item_code || '';
                        const baseUnit = rm?.canonical_base_unit_code || rm?.base_unit || 'PCS';
                        const pkgOptions = prodId > 0 ? packagingsByProduct[prodId] || [] : [];
                        const subtotal = (parseFloat(it.ordered_qty) || 0) * (parseFloat(it.unit_cost) || 0);
                        const isLockedByReceipt = it.received_qty > 0;

                        const isSearchOpen = openSearchRowIdx === idx && !isLockedByReceipt;
                        const inputDisplayValue =
                          rowSearchQueryByIdx[idx] !== undefined
                            ? rowSearchQueryByIdx[idx]
                            : rm
                            ? rm.name
                            : '';
                        const qTrim = inputDisplayValue.trim().toLowerCase();
                        const filteredCandidates = trackedInventoryProducts
                          .filter((m) => {
                            if (!qTrim) return true;
                            const nameMatch = (m.name || '').toLowerCase().includes(qTrim);
                            const skuMatch = (m.item_code || '').toLowerCase().includes(qTrim);
                            const catMatch = (m.category_name || '').toLowerCase().includes(qTrim);
                            return nameMatch || skuMatch || catMatch;
                          })
                          .slice(0, 60);

                        return (
                          <tr key={it.id || `new-${idx}`} className="align-top">
                            <td className="py-2 px-3 relative">
                              <div className="relative">
                                <input
                                  type="text"
                                  disabled={isLockedByReceipt}
                                  value={inputDisplayValue}
                                  placeholder="Ketik nama barang / SKU (cth: beras)..."
                                  onFocus={() => {
                                    setOpenSearchRowIdx(idx);
                                    setHighlightedOptionIdx(0);
                                  }}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setRowSearchQueryByIdx((prev) => ({ ...prev, [idx]: val }));
                                    setOpenSearchRowIdx(idx);
                                    setHighlightedOptionIdx(0);
                                    if (!val.trim() && it.product_id) {
                                      handleFormLineFieldChange(idx, 'product_id', '');
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (!isSearchOpen) {
                                      if (e.key === 'ArrowDown') {
                                        setOpenSearchRowIdx(idx);
                                        setHighlightedOptionIdx(0);
                                      }
                                      return;
                                    }
                                    if (e.key === 'ArrowDown') {
                                      e.preventDefault();
                                      setHighlightedOptionIdx((prev) =>
                                        filteredCandidates.length > 0
                                          ? Math.min(prev + 1, filteredCandidates.length - 1)
                                          : 0
                                      );
                                    } else if (e.key === 'ArrowUp') {
                                      e.preventDefault();
                                      setHighlightedOptionIdx((prev) => Math.max(prev - 1, 0));
                                    } else if (e.key === 'Enter') {
                                      e.preventDefault();
                                      const picked = filteredCandidates[highlightedOptionIdx];
                                      if (picked) {
                                        void handleFormProductChange(idx, String(picked.id));
                                      }
                                    } else if (e.key === 'Escape') {
                                      setOpenSearchRowIdx(null);
                                    }
                                  }}
                                  onBlur={() => {
                                    setTimeout(() => {
                                      setOpenSearchRowIdx((curr) => (curr === idx ? null : curr));
                                      // Kembalikan teks nama produk jika sudah ada product_id terpilih
                                      if (rm) {
                                        setRowSearchQueryByIdx((prev) => ({
                                          ...prev,
                                          [idx]: rm.name,
                                        }));
                                      }
                                    }, 180);
                                  }}
                                  className={`w-full border rounded-lg pl-2.5 pr-7 py-1.5 bg-white text-slate-800 disabled:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-600/30 ${
                                    rm
                                      ? 'border-emerald-400 font-semibold text-slate-900'
                                      : 'border-slate-300'
                                  }`}
                                />
                                {inputDisplayValue && !isLockedByReceipt ? (
                                  <button
                                    type="button"
                                    tabIndex={-1}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      setRowSearchQueryByIdx((prev) => ({ ...prev, [idx]: '' }));
                                      handleFormLineFieldChange(idx, 'product_id', '');
                                      setOpenSearchRowIdx(idx);
                                      setHighlightedOptionIdx(0);
                                    }}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-rose-600 font-bold text-xs cursor-pointer"
                                    title="Hapus pilihan / ketik ulang"
                                  >
                                    ✕
                                  </button>
                                ) : (
                                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">
                                    🔍
                                  </span>
                                )}

                                {isSearchOpen && (
                                  <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-xl shadow-xl max-h-56 overflow-y-auto divide-y divide-slate-100">
                                    {filteredCandidates.length > 0 ? (
                                      filteredCandidates.map((cand, cIdx) => {
                                        const candUnit = cand.canonical_base_unit_code || cand.base_unit || 'PCS';
                                        const isSelected = Number(cand.id) === prodId;
                                        const isHighlighted = cIdx === highlightedOptionIdx;
                                        return (
                                          <button
                                            key={cand.id}
                                            type="button"
                                            onMouseDown={(e) => {
                                              e.preventDefault();
                                              void handleFormProductChange(idx, String(cand.id));
                                            }}
                                            onMouseEnter={() => setHighlightedOptionIdx(cIdx)}
                                            className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                                              isHighlighted
                                                ? 'bg-emerald-50 text-emerald-950'
                                                : isSelected
                                                ? 'bg-slate-50 font-semibold'
                                                : 'hover:bg-slate-50'
                                            }`}
                                          >
                                            <div className="min-w-0 flex-1">
                                              <div className="font-semibold text-slate-800 truncate">
                                                {cand.name}
                                              </div>
                                              <div className="text-[10px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                                                <span className="font-mono font-bold text-emerald-800 bg-emerald-100/70 px-1.5 py-0.2 rounded">
                                                  {cand.item_code || `ID-${cand.id}`}
                                                </span>
                                                <span>•</span>
                                                <span>Satuan: {candUnit}</span>
                                                {cand.category_name && (
                                                  <>
                                                    <span>•</span>
                                                    <span className="truncate">{cand.category_name}</span>
                                                  </>
                                                )}
                                              </div>
                                            </div>
                                            {isSelected && (
                                              <span className="text-emerald-700 font-bold text-xs shrink-0">
                                                ✓
                                              </span>
                                            )}
                                          </button>
                                        );
                                      })
                                    ) : (
                                      <div className="px-3 py-3 text-center text-slate-500 text-[11px]">
                                        Tidak ada produk <strong>Lacak Inventory</strong> yang cocok dengan pencarian{' '}
                                        <span className="font-mono font-semibold">"{inputDisplayValue}"</span>.
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>

                              {rm && (rm.track_stock === false || rm.track_inventory === false) && (
                                <div className="text-[10px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                                  ⚠ Produk ini belum diaktifkan untuk Lacak Stok &amp; GRN. Aktifkan di Master Barang &amp; Produk → Edit.
                                </div>
                              )}
                              {it.id && (
                                <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                                  ID Baris PO: #{it.id}
                                  {it.received_qty > 0 ? ` • Sudah diterima: ${formatQty(it.received_qty)} ${it.ordered_unit}` : ''}
                                </div>
                              )}
                            </td>

                            <td className="py-2 px-3">
                              <input
                                type="text"
                                readOnly
                                value={skuCode}
                                placeholder="Otomatis..."
                                title={skuCode ? `SKU: ${skuCode}` : 'SKU otomatis muncul saat produk dipilih'}
                                className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 bg-slate-50 font-mono text-[11px] font-bold text-emerald-900 placeholder:font-sans placeholder:font-normal placeholder:text-slate-400"
                              />
                            </td>

                            <td className="py-2 px-3">
                              <select
                                value={it.packaging_id}
                                disabled={!prodId || isLockedByReceipt}
                                onChange={(e) => handleFormPackagingChange(idx, e.target.value)}
                                className="w-full border border-slate-300 rounded-lg px-2 py-1.5 bg-white text-slate-800 disabled:bg-slate-100"
                              >
                                <option value="">Satuan Dasar ({baseUnit} × 1)</option>
                                {pkgOptions.map((pkg) => (
                                  <option key={pkg.id} value={pkg.id}>
                                    {pkg.packaging_name || pkg.packaging_code} ({pkg.packaging_code} ={' '}
                                    {formatQty(pkg.to_base_factor)} {baseUnit})
                                  </option>
                                ))}
                              </select>
                              {it.conversion_factor > 1 && (
                                <div className="text-[10px] font-mono text-emerald-700 mt-0.5">
                                  Konversi: {formatQty((parseFloat(it.ordered_qty) || 0) * it.conversion_factor)} {baseUnit}
                                </div>
                              )}
                            </td>

                            <td className="py-2 px-3">
                              <input
                                type="number"
                                min={it.received_qty > 0 ? it.received_qty : 0.01}
                                step="any"
                                value={it.ordered_qty}
                                onChange={(e) => handleFormLineFieldChange(idx, 'ordered_qty', e.target.value)}
                                className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-right font-mono"
                              />
                            </td>

                            <td className="py-2 px-3">
                              <input
                                type="number"
                                min="0"
                                step="any"
                                disabled={isLockedByReceipt}
                                value={it.unit_cost}
                                onChange={(e) => handleFormLineFieldChange(idx, 'unit_cost', e.target.value)}
                                className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-right font-mono disabled:bg-slate-100"
                              />
                            </td>

                            <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                              {formatIDR(subtotal)}
                            </td>

                            <td className="py-2 px-2 text-center">
                              {formItems.length > 1 && !isLockedByReceipt && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveFormLine(idx)}
                                  className="text-rose-600 hover:text-rose-800 font-bold cursor-pointer"
                                  title="Hapus baris"
                                >
                                  ✕
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex justify-end pt-2">
                  <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-right">
                    <span className="text-slate-500 mr-3">Total Estimasi PO:</span>
                    <span className="font-mono text-sm font-bold text-slate-900">
                      {formatIDR(calculatedPoTotal)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={isSubmittingForm}
                onClick={() => setShowFormModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                Batal
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isSubmittingForm}
                  onClick={() => void handleSubmitPoForm(false)}
                  className="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-xs font-bold text-slate-800 cursor-pointer"
                >
                  {isSubmittingForm ? 'Menyimpan...' : editingPo ? 'Simpan Perubahan' : 'Simpan Draft PO'}
                </button>
                <button
                  type="button"
                  disabled={isSubmittingForm}
                  onClick={() => void handleSubmitPoForm(true)}
                  className="px-4 py-2 rounded-xl bg-[#1b4332] hover:bg-[#143427] text-white text-xs font-bold shadow-sm cursor-pointer"
                >
                  {isSubmittingForm
                    ? 'Memproses...'
                    : editingPo
                    ? 'Simpan & Ajukan Persetujuan'
                    : 'Simpan & Ajukan Persetujuan'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
