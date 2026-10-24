/**
 * OAK HIMS — MP-04D Purchase Order Management Section
 * Tampilan Daftar, Detail, dan Pembuatan Purchase Order Bahan Baku POS
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  fetchPurchaseOrders,
  fetchPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  fetchSuppliers,
  fetchRawMaterialCandidates,
  fetchProductUoms,
  type PosPurchaseOrder,
  type PosSupplier,
  type RawMaterialCandidate,
} from './posPurchaseOrderApi';

interface Props {
  propertyId: number;
  onOpenGrnForPo?: (po: PosPurchaseOrder) => void;
  onNotifySuccess?: (msg: string) => void;
}

function formatIDR(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) || 0 : value || 0;
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

export default function PurchaseOrderSection({
  propertyId,
  onOpenGrnForPo,
  onNotifySuccess,
}: Props) {
  const [orders, setOrders] = useState<PosPurchaseOrder[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals
  const [selectedPo, setSelectedPo] = useState<PosPurchaseOrder | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState<boolean>(false);
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);

  // References for Create PO Form
  const [suppliers, setSuppliers] = useState<PosSupplier[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterialCandidate[]>([]);
  const [uoms, setUoms] = useState<Array<{ id: number; code: string; name: string }>>([]);

  // Create Form State
  const [formSupplierId, setFormSupplierId] = useState<string>('');
  const [formOrderDate, setFormOrderDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [formExpectedDate, setFormExpectedDate] = useState<string>('');
  const [formNotes, setFormNotes] = useState<string>('');
  const [formCreatedBy, setFormCreatedBy] = useState<string>('Purchasing Staff');
  const [formItems, setFormItems] = useState<
    Array<{
      product_id: string;
      ordered_qty: string;
      unit_cost: string;
      uom_id: string;
      notes: string;
    }>
  >([{ product_id: '', ordered_qty: '1', unit_cost: '0', uom_id: '', notes: '' }]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [actionLoadingId, setActionLoadingId] = useState<number | null>(null);

  // Load PO list
  const loadOrders = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetchPurchaseOrders(propertyId, {
        status: statusFilter,
        search: searchQuery.trim() || undefined,
      });
      setOrders(res.orders || []);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal memuat daftar Purchase Order');
    } finally {
      setLoading(false);
    }
  }, [propertyId, statusFilter, searchQuery]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  // Load form options when modal opens
  const openCreateModal = async () => {
    setShowCreateModal(true);
    try {
      const [supRes, rawRes, uomRes] = await Promise.all([
        fetchSuppliers(propertyId, { is_active: true }),
        fetchRawMaterialCandidates(propertyId),
        fetchProductUoms(propertyId),
      ]);
      setSuppliers(supRes);
      setRawMaterials(rawRes);
      setUoms(uomRes);
      if (supRes.length > 0 && !formSupplierId) {
        setFormSupplierId(String(supRes[0].id));
      }
    } catch (e: any) {
      console.error('Error preloading PO form data:', e);
    }
  };

  // View detail
  const handleViewDetail = async (poId: number) => {
    setIsDetailLoading(true);
    try {
      const detail = await fetchPurchaseOrderById(propertyId, poId);
      setSelectedPo(detail);
    } catch (e: any) {
      alert(e?.message || 'Gagal mengambil detail PO');
    } finally {
      setIsDetailLoading(false);
    }
  };

  // Status transitions
  const handleUpdateStatus = async (po: PosPurchaseOrder, newStatus: 'ORDERED' | 'CANCELLED') => {
    const actionLabel = newStatus === 'ORDERED' ? 'menyetujui (ORDERED)' : 'membatalkan';
    if (!confirm(`Apakah Anda yakin ingin ${actionLabel} PO #${po.po_number}?`)) return;

    setActionLoadingId(po.id);
    try {
      await updatePurchaseOrderStatus(propertyId, po.id, newStatus, 'Manager F&B');
      if (onNotifySuccess) onNotifySuccess(`PO #${po.po_number} berhasil diperbarui menjadi ${newStatus}`);
      await loadOrders();
      if (selectedPo && selectedPo.id === po.id) {
        const refreshed = await fetchPurchaseOrderById(propertyId, po.id);
        setSelectedPo(refreshed);
      }
    } catch (e: any) {
      alert(e?.message || 'Gagal memperbarui status PO');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Form item management
  const handleAddItem = () => {
    setFormItems((prev) => [
      ...prev,
      { product_id: '', ordered_qty: '1', unit_cost: '0', uom_id: '', notes: '' },
    ]);
  };

  const handleRemoveItem = (index: number) => {
    if (formItems.length <= 1) return;
    setFormItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleItemChange = (index: number, field: string, val: string) => {
    setFormItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: val };

      // Auto pre-fill unit cost and UOM if selecting product
      if (field === 'product_id') {
        const prodId = Number(val);
        const rm = rawMaterials.find((m) => m.id === prodId);
        if (rm) {
          if (rm.last_cost && parseFloat(String(rm.last_cost)) > 0) {
            copy[index].unit_cost = String(rm.last_cost);
          } else if (rm.average_cost && parseFloat(String(rm.average_cost)) > 0) {
            copy[index].unit_cost = String(rm.average_cost);
          }
          if (rm.canonical_base_unit_code) {
            const matchedUom = uoms.find(
              (u) => u.code.toUpperCase() === rm.canonical_base_unit_code?.toUpperCase()
            );
            if (matchedUom) copy[index].uom_id = String(matchedUom.id);
          }
        }
      }
      return copy;
    });
  };

  // Total calculated form estimated
  const calculatedEstimatedTotal = useMemo(() => {
    return formItems.reduce((sum, it) => {
      const q = parseFloat(it.ordered_qty) || 0;
      const c = parseFloat(it.unit_cost) || 0;
      return sum + q * c;
    }, 0);
  }, [formItems]);

  // Submit PO Create
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSupplierId) {
      alert('Pilih supplier terlebih dahulu');
      return;
    }

    const cleanedItems = formItems.map((it) => ({
      product_id: Number(it.product_id),
      ordered_qty: parseFloat(it.ordered_qty),
      unit_cost: parseFloat(it.unit_cost || '0'),
      uom_id: it.uom_id ? Number(it.uom_id) : null,
      notes: it.notes.trim() || null,
    }));

    if (cleanedItems.some((it) => !it.product_id || isNaN(it.ordered_qty) || it.ordered_qty <= 0)) {
      alert('Pastikan setiap baris item memiliki produk yang valid dan kuantitas lebih dari 0');
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await createPurchaseOrder({
        property_id: propertyId,
        supplier_id: Number(formSupplierId),
        order_date: formOrderDate || undefined,
        expected_date: formExpectedDate || null,
        notes: formNotes || null,
        created_by: formCreatedBy || null,
        items: cleanedItems,
      });

      setShowCreateModal(false);
      // Reset form
      setFormItems([{ product_id: '', ordered_qty: '1', unit_cost: '0', uom_id: '', notes: '' }]);
      setFormNotes('');
      if (onNotifySuccess) onNotifySuccess(`Purchase Order #${created.po_number} berhasil dibuat (Status: DRAFT)`);
      await loadOrders();
    } catch (e: any) {
      alert(e?.message || 'Gagal membuat Purchase Order');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Status badges
  const renderStatusBadge = (status: PosPurchaseOrder['status']) => {
    switch (status) {
      case 'DRAFT':
        return (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
            DRAFT
          </span>
        );
      case 'ORDERED':
        return (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-200">
            ORDERED
          </span>
        );
      case 'PARTIALLY_RECEIVED':
        return (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-purple-50 text-purple-800 border border-purple-200">
            PARSIAL DITERIMA
          </span>
        );
      case 'COMPLETED':
        return (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
            SELESAI (COMPLETED)
          </span>
        );
      case 'CANCELLED':
        return (
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-gray-100 text-gray-700 border border-gray-300">
            DIBATALKAN
          </span>
        );
      default:
        return <span className="px-2 py-0.5 rounded text-xs bg-gray-100">{status}</span>;
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Filter & Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-gray-200 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* Status Filter */}
          <div className="flex items-center gap-1 bg-gray-50 p-1 rounded-lg border border-gray-200">
            {['ALL', 'DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED'].map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
                  statusFilter === st
                    ? 'bg-[#1b4332] text-white shadow-2xs'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                }`}
              >
                {st === 'ALL'
                  ? 'Semua Status'
                  : st === 'PARTIALLY_RECEIVED'
                  ? 'Parsial'
                  : st === 'COMPLETED'
                  ? 'Selesai'
                  : st}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative min-w-[220px]">
            <input
              type="text"
              placeholder="Cari No. PO atau Supplier..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1b4332]/20 focus:border-[#1b4332]"
            />
            <svg
              className="w-4 h-4 text-gray-400 absolute left-2.5 top-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
        </div>

        {/* Create PO Button */}
        <button
          type="button"
          onClick={() => void openCreateModal()}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#1b4332] hover:bg-[#143427] text-white text-xs font-bold shadow-2xs transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4 text-[#d4af37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
          </svg>
          Buat Purchase Order (PO)
        </button>
      </div>

      {/* Error Banner */}
      {errorMsg && (
        <div className="p-3 bg-red-50 text-red-800 text-xs rounded-xl border border-red-200 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button onClick={() => void loadOrders()} className="font-bold underline cursor-pointer">
            Coba Lagi
          </button>
        </div>
      )}

      {/* Purchase Orders Table */}
      <div className="bg-white rounded-2xl border border-gray-200/90 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/80 border-b border-gray-200 text-[11px] font-bold text-gray-600 uppercase tracking-wider">
                <th className="py-3 px-4">No. PO</th>
                <th className="py-3 px-4">Tanggal Pesan</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4 text-right">Estimasi Nilai</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-center">Aksi &amp; Operasional</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-gray-400">
                    <div className="inline-block animate-spin w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full mb-2"></div>
                    <div>Memuat daftar Purchase Order...</div>
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-gray-400">
                    Belum ada Purchase Order sesuai filter.
                  </td>
                </tr>
              ) : (
                orders.map((po) => (
                  <tr key={po.id} className="hover:bg-amber-50/30 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-gray-900">
                      {po.po_number}
                      {po.expected_date && (
                        <div className="text-[10px] text-gray-400 font-sans font-normal">
                          Target: {po.expected_date}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-gray-600">{po.order_date}</td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-gray-900">{po.supplier_name || '-'}</div>
                      <div className="text-[10px] text-gray-400">{po.supplier_code}</div>
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold text-gray-900">
                      {formatIDR(po.total_estimated_amount)}
                    </td>
                    <td className="py-3 px-4 text-center">{renderStatusBadge(po.status)}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-center gap-1.5 flex-wrap">
                        {/* Detail Button */}
                        <button
                          type="button"
                          onClick={() => void handleViewDetail(po.id)}
                          className="px-2.5 py-1 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 text-[11px] font-semibold cursor-pointer shadow-2xs"
                        >
                          Lihat Detail
                        </button>

                        {/* Approve ORDERED Button (for DRAFT) */}
                        {po.status === 'DRAFT' && (
                          <button
                            type="button"
                            disabled={actionLoadingId === po.id}
                            onClick={() => void handleUpdateStatus(po, 'ORDERED')}
                            className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold cursor-pointer shadow-2xs"
                          >
                            Setujui (ORDERED)
                          </button>
                        )}

                        {/* Receive Goods Button (for ORDERED or PARTIALLY_RECEIVED) */}
                        {(po.status === 'ORDERED' || po.status === 'PARTIALLY_RECEIVED') && (
                          <button
                            type="button"
                            onClick={() => {
                              if (onOpenGrnForPo) onOpenGrnForPo(po);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-[#1b4332] hover:bg-[#143427] text-white text-[11px] font-semibold cursor-pointer shadow-2xs flex items-center gap-1"
                          >
                            <span className="text-[#d4af37]">✓</span> Terima Barang
                          </button>
                        )}

                        {/* Cancel Button (for DRAFT or ORDERED) */}
                        {(po.status === 'DRAFT' || po.status === 'ORDERED') && (
                          <button
                            type="button"
                            disabled={actionLoadingId === po.id}
                            onClick={() => void handleUpdateStatus(po, 'CANCELLED')}
                            className="px-2.5 py-1 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 text-[11px] font-semibold cursor-pointer"
                          >
                            Batalkan
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          MODAL: Buat Purchase Order Baru
          ───────────────────────────────────────────────────────────────────────────── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-4xl w-full p-6 shadow-2xl border border-gray-200 animate-in fade-in duration-150">
            <div className="flex items-center justify-between pb-4 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Buat Purchase Order (PO) Bahan Baku</h2>
                <p className="text-xs text-gray-500">
                  Pemesanan bahan baku baru dari vendor/supplier resmi dengan kalkulasi estimasi nilai
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-gray-400 hover:text-gray-600 p-1 text-sm font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={(e) => void handleCreateSubmit(e)} className="mt-4 space-y-4">
              {/* Header Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-gray-50/70 p-3.5 rounded-xl border border-gray-200/80">
                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">
                    Supplier / Vendor <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formSupplierId}
                    onChange={(e) => setFormSupplierId(e.target.value)}
                    required
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  >
                    <option value="">-- Pilih Supplier --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} - {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">
                    Tanggal Pemesanan <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={formOrderDate}
                    onChange={(e) => setFormOrderDate(e.target.value)}
                    required
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">
                    Estimasi Kedatangan (Expected)
                  </label>
                  <input
                    type="date"
                    value={formExpectedDate}
                    onChange={(e) => setFormExpectedDate(e.target.value)}
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">Catatan Pemesanan</label>
                  <input
                    type="text"
                    placeholder="Contoh: Pengiriman via armada supplier, pembayaran tempo 14 hari"
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">Dibuat Oleh</label>
                  <input
                    type="text"
                    value={formCreatedBy}
                    onChange={(e) => setFormCreatedBy(e.target.value)}
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                </div>
              </div>

              {/* Items Section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-gray-800 uppercase tracking-wider">
                    Daftar Bahan Baku / Produk Pesanan ({formItems.length} Item)
                  </h3>
                  <button
                    type="button"
                    onClick={handleAddItem}
                    className="px-2.5 py-1 text-[11px] font-bold text-[#1b4332] bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer"
                  >
                    + Tambah Baris Item
                  </button>
                </div>

                <div className="max-h-60 overflow-y-auto space-y-2 border border-gray-200 rounded-xl p-2 bg-gray-50/50">
                  {formItems.map((item, idx) => {
                    const rowSubtotal = (parseFloat(item.ordered_qty) || 0) * (parseFloat(item.unit_cost) || 0);
                    return (
                      <div
                        key={idx}
                        className="grid grid-cols-1 sm:grid-cols-12 gap-2 bg-white p-2.5 rounded-lg border border-gray-200 items-center text-xs"
                      >
                        <div className="sm:col-span-4">
                          <label className="block text-[10px] text-gray-500 mb-0.5">Produk Bahan Baku</label>
                          <select
                            value={item.product_id}
                            onChange={(e) => handleItemChange(idx, 'product_id', e.target.value)}
                            required
                            className="w-full text-xs p-1.5 border border-gray-300 rounded focus:outline-none"
                          >
                            <option value="">-- Pilih Bahan Baku --</option>
                            {rawMaterials.map((rm) => (
                              <option key={rm.id} value={rm.id}>
                                {rm.name} ({rm.canonical_base_unit_code || rm.base_unit || 'UNIT'})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-[10px] text-gray-500 mb-0.5">Kuantitas</label>
                          <input
                            type="number"
                            step="any"
                            min="0.0001"
                            value={item.ordered_qty}
                            onChange={(e) => handleItemChange(idx, 'ordered_qty', e.target.value)}
                            required
                            className="w-full text-xs p-1.5 border border-gray-300 rounded font-mono"
                          />
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-[10px] text-gray-500 mb-0.5">Satuan (UOM)</label>
                          <select
                            value={item.uom_id}
                            onChange={(e) => handleItemChange(idx, 'uom_id', e.target.value)}
                            className="w-full text-xs p-1.5 border border-gray-300 rounded"
                          >
                            <option value="">Default Unit</option>
                            {uoms.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.code}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="sm:col-span-2">
                          <label className="block text-[10px] text-gray-500 mb-0.5">Harga Beli Satuan (Rp)</label>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={item.unit_cost}
                            onChange={(e) => handleItemChange(idx, 'unit_cost', e.target.value)}
                            required
                            className="w-full text-xs p-1.5 border border-gray-300 rounded font-mono"
                          />
                        </div>

                        <div className="sm:col-span-1 text-right">
                          <label className="block text-[10px] text-gray-500 mb-0.5">Subtotal</label>
                          <span className="font-mono font-bold text-gray-700 text-[11px]">
                            {Math.round(rowSubtotal).toLocaleString('id-ID')}
                          </span>
                        </div>

                        <div className="sm:col-span-1 text-center">
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(idx)}
                            disabled={formItems.length <= 1}
                            className="text-red-500 hover:text-red-700 font-bold p-1 disabled:opacity-30 cursor-pointer"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Total Summary Banner */}
              <div className="flex items-center justify-between p-3.5 bg-emerald-50 rounded-xl border border-emerald-200">
                <span className="text-xs font-bold text-[#1b4332]">Total Estimasi Nilai Purchase Order:</span>
                <span className="text-base font-black font-mono text-[#1b4332]">
                  {formatIDR(calculatedEstimatedTotal)}
                </span>
              </div>

              {/* Modal Actions */}
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100 rounded-xl cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 text-xs font-bold text-white bg-[#1b4332] hover:bg-[#143427] rounded-xl shadow-2xs disabled:opacity-50 cursor-pointer"
                >
                  {isSubmitting ? 'Menyimpan...' : 'Simpan Purchase Order (DRAFT)'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Loading Indicator for Detail */}
      {isDetailLoading && (
        <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-xs flex items-center justify-center">
          <div className="bg-white p-4 rounded-xl shadow-lg flex items-center gap-2 text-xs font-semibold text-gray-700">
            <div className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-[#1b4332] border-t-transparent"></div>
            Memuat detail PO...
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          MODAL: Detail Purchase Order
          ───────────────────────────────────────────────────────────────────────────── */}
      {selectedPo && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-gray-200">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-black text-gray-900">{selectedPo.po_number}</span>
                {renderStatusBadge(selectedPo.status)}
              </div>
              <button
                type="button"
                onClick={() => setSelectedPo(null)}
                className="text-gray-400 hover:text-gray-600 p-1 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-gray-50 p-3 rounded-xl">
              <div>
                <span className="text-gray-400 block text-[10px]">Supplier:</span>
                <span className="font-semibold text-gray-800">{selectedPo.supplier_name || '-'}</span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Tgl Pemesanan:</span>
                <span className="font-semibold text-gray-800">{selectedPo.order_date}</span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Target Kedatangan:</span>
                <span className="font-semibold text-gray-800">{selectedPo.expected_date || '-'}</span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Total Estimasi:</span>
                <span className="font-mono font-bold text-[#1b4332]">
                  {formatIDR(selectedPo.total_estimated_amount)}
                </span>
              </div>
            </div>

            {selectedPo.notes && (
              <div className="mt-2 text-xs text-gray-600 bg-amber-50/60 p-2.5 rounded-lg border border-amber-200/60">
                <span className="font-bold">Catatan:</span> {selectedPo.notes}
              </div>
            )}

            {/* Line Items List with Progress */}
            <div className="mt-4">
              <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">Item Rincian Pesanan &amp; Progres</h4>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-gray-100/70 border-b border-gray-200 text-[10px] text-gray-600 font-bold uppercase">
                    <tr>
                      <th className="p-2.5">Produk</th>
                      <th className="p-2.5 text-center">Dipesan</th>
                      <th className="p-2.5 text-center">Diterima</th>
                      <th className="p-2.5 text-center">Progres</th>
                      <th className="p-2.5 text-right">Harga Satuan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {selectedPo.items?.map((it) => {
                      const ordered = parseFloat(it.ordered_qty) || 0;
                      const received = parseFloat(it.received_qty) || 0;
                      const pct = ordered > 0 ? Math.min(100, Math.round((received / ordered) * 100)) : 0;
                      return (
                        <tr key={it.id}>
                          <td className="p-2.5">
                            <span className="font-semibold text-gray-900">{it.product_name}</span>
                            <span className="text-[10px] text-gray-400 block font-mono">{it.item_code}</span>
                          </td>
                          <td className="p-2.5 text-center font-mono font-semibold">
                            {ordered} {it.canonical_base_unit_code || it.base_unit || ''}
                          </td>
                          <td className="p-2.5 text-center font-mono font-semibold text-emerald-700">
                            {received} {it.canonical_base_unit_code || it.base_unit || ''}
                          </td>
                          <td className="p-2.5 text-center w-32">
                            <div className="w-full bg-gray-200 h-2 rounded-full overflow-hidden">
                              <div
                                className={`h-full ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
                                style={{ width: `${pct}%` }}
                              ></div>
                            </div>
                            <span className="text-[10px] text-gray-500 font-mono mt-0.5 block">{pct}%</span>
                          </td>
                          <td className="p-2.5 text-right font-mono">{formatIDR(it.unit_cost)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="mt-5 flex items-center justify-between pt-3 border-t border-gray-100">
              <div className="text-[11px] text-gray-400">
                Dibuat oleh: {selectedPo.created_by || 'Sistem'}
              </div>

              <div className="flex items-center gap-2">
                {selectedPo.status === 'DRAFT' && (
                  <button
                    type="button"
                    onClick={() => void handleUpdateStatus(selectedPo, 'ORDERED')}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl cursor-pointer shadow-2xs"
                  >
                    Setujui (ORDERED)
                  </button>
                )}

                {(selectedPo.status === 'ORDERED' || selectedPo.status === 'PARTIALLY_RECEIVED') && (
                  <button
                    type="button"
                    onClick={() => {
                      const poToReceive = selectedPo;
                      setSelectedPo(null);
                      if (onOpenGrnForPo) onOpenGrnForPo(poToReceive);
                    }}
                    className="px-4 py-2 bg-[#1b4332] hover:bg-[#143427] text-white text-xs font-bold rounded-xl cursor-pointer shadow-2xs"
                  >
                    Terima Barang (GRN)
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setSelectedPo(null)}
                  className="px-4 py-2 border border-gray-200 text-gray-700 text-xs font-semibold rounded-xl hover:bg-gray-50 cursor-pointer"
                >
                  Tutup
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
