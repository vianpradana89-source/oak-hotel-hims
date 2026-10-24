/**
 * OAK HIMS — MP-04D Goods Receipt Note (GRN) Management Section
 * Tampilan Daftar & Form Penerimaan Barang dari PO atau Pembelian Langsung
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  fetchGoodsReceipts,
  fetchGoodsReceiptById,
  createGoodsReceipt,
  fetchPurchaseOrders,
  fetchPurchaseOrderById,
  fetchSuppliers,
  fetchRawMaterialCandidates,
  type PosGoodsReceipt,
  type PosPurchaseOrder,
  type PosSupplier,
  type RawMaterialCandidate,
} from './posPurchaseOrderApi';
import { fetchStockLocations } from './posInventoryApi';
import type { StockLocation } from './posInventoryTypes';

interface Props {
  propertyId: number;
  preselectedPo?: PosPurchaseOrder | null;
  onClearPreselectedPo?: () => void;
  onNotifySuccess?: (msg: string) => void;
}

function formatIDR(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) || 0 : value || 0;
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

export default function GoodsReceiptSection({
  propertyId,
  preselectedPo,
  onClearPreselectedPo,
  onNotifySuccess,
}: Props) {
  const [receipts, setReceipts] = useState<PosGoodsReceipt[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals
  const [selectedGrn, setSelectedGrn] = useState<PosGoodsReceipt | null>(null);
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);

  // Reference Data
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [activePos, setActivePos] = useState<PosPurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<PosSupplier[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterialCandidate[]>([]);

  // Create Form State
  const [receiptType, setReceiptType] = useState<'FROM_PO' | 'DIRECT'>('FROM_PO');
  const [selectedPoId, setSelectedPoId] = useState<string>('');
  const [formSupplierId, setFormSupplierId] = useState<string>('');
  const [formLocationId, setFormLocationId] = useState<string>('');
  const [formReceiptDate, setFormReceiptDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [formInvoiceNo, setFormInvoiceNo] = useState<string>('');
  const [formReceivedBy, setFormReceivedBy] = useState<string>('Staf Gudang');
  const [formNotes, setFormNotes] = useState<string>('');
  const [formItems, setFormItems] = useState<
    Array<{
      product_id: string;
      product_name?: string;
      po_item_id?: number | null;
      received_qty: string;
      unit_cost: string;
      remaining_qty?: number;
      base_unit?: string;
    }>
  >([]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Load GRN list
  const loadReceipts = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetchGoodsReceipts(propertyId, {
        search: searchQuery.trim() || undefined,
      });
      setReceipts(res.receipts || []);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal memuat riwayat penerimaan barang');
    } finally {
      setLoading(false);
    }
  }, [propertyId, searchQuery]);

  useEffect(() => {
    void loadReceipts();
  }, [loadReceipts]);

  // Handle preselected PO from parent / PO Section
  useEffect(() => {
    if (preselectedPo) {
      void openCreateWithPo(preselectedPo);
    }
  }, [preselectedPo]);

  // Open modal with preselected PO
  const openCreateWithPo = async (po: PosPurchaseOrder) => {
    setReceiptType('FROM_PO');
    setSelectedPoId(String(po.id));
    setShowCreateModal(true);

    try {
      const [locsRes, poDetail] = await Promise.all([
        fetchStockLocations(propertyId),
        fetchPurchaseOrderById(propertyId, po.id),
      ]);
      const activeLocs = locsRes.filter((l) => l.is_active);
      setLocations(activeLocs);
      if (activeLocs.length > 0) setFormLocationId(String(activeLocs[0].id));

      setFormSupplierId(String(poDetail.supplier_id));

      // Populate items with remaining quantities
      const lines = (poDetail.items || []).map((it) => {
        const ordered = parseFloat(it.ordered_qty) || 0;
        const received = parseFloat(it.received_qty) || 0;
        const remaining = Math.max(0, ordered - received);
        return {
          product_id: String(it.product_id),
          product_name: it.product_name,
          po_item_id: it.id,
          received_qty: String(remaining),
          unit_cost: it.unit_cost,
          remaining_qty: remaining,
          base_unit: it.canonical_base_unit_code || it.base_unit || 'UNIT',
        };
      });
      setFormItems(lines);
    } catch (e: any) {
      console.error('Error preloading PO lines for GRN:', e);
    }
  };

  // Open modal manually
  const openCreateModal = async () => {
    setShowCreateModal(true);
    try {
      const [locsRes, poRes, supRes, rawRes] = await Promise.all([
        fetchStockLocations(propertyId),
        fetchPurchaseOrders(propertyId, { limit: 100 }),
        fetchSuppliers(propertyId, { is_active: true }),
        fetchRawMaterialCandidates(propertyId),
      ]);

      const activeLocs = locsRes.filter((l) => l.is_active);
      setLocations(activeLocs);
      if (activeLocs.length > 0 && !formLocationId) {
        setFormLocationId(String(activeLocs[0].id));
      }

      // Filter POs that can be received (ORDERED or PARTIALLY_RECEIVED)
      const receivablePos = poRes.orders.filter(
        (p) => p.status === 'ORDERED' || p.status === 'PARTIALLY_RECEIVED'
      );
      setActivePos(receivablePos);
      setSuppliers(supRes);
      setRawMaterials(rawRes);

      if (receivablePos.length > 0 && receiptType === 'FROM_PO') {
        setSelectedPoId(String(receivablePos[0].id));
        void handleSelectPoChange(String(receivablePos[0].id));
      } else {
        setReceiptType('DIRECT');
        setFormItems([{ product_id: '', received_qty: '1', unit_cost: '0' }]);
      }
    } catch (e: any) {
      console.error('Error opening GRN modal:', e);
    }
  };

  const handleSelectPoChange = async (poIdStr: string) => {
    setSelectedPoId(poIdStr);
    if (!poIdStr) {
      setFormItems([]);
      return;
    }

    try {
      const poDetail = await fetchPurchaseOrderById(propertyId, Number(poIdStr));
      setFormSupplierId(String(poDetail.supplier_id));

      const lines = (poDetail.items || []).map((it) => {
        const ordered = parseFloat(it.ordered_qty) || 0;
        const received = parseFloat(it.received_qty) || 0;
        const remaining = Math.max(0, ordered - received);
        return {
          product_id: String(it.product_id),
          product_name: it.product_name,
          po_item_id: it.id,
          received_qty: String(remaining),
          unit_cost: it.unit_cost,
          remaining_qty: remaining,
          base_unit: it.canonical_base_unit_code || it.base_unit || 'UNIT',
        };
      });
      setFormItems(lines);
    } catch (e: any) {
      alert(e?.message || 'Gagal memuat item dari PO terpilih');
    }
  };

  // Direct receipt item management
  const handleAddDirectItem = () => {
    setFormItems((prev) => [...prev, { product_id: '', received_qty: '1', unit_cost: '0' }]);
  };

  const handleRemoveDirectItem = (index: number) => {
    if (formItems.length <= 1) return;
    setFormItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleDirectItemChange = (index: number, field: string, val: string) => {
    setFormItems((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: val };

      if (field === 'product_id') {
        const prod = rawMaterials.find((r) => r.id === Number(val));
        if (prod) {
          copy[index].product_name = prod.name;
          copy[index].base_unit = prod.canonical_base_unit_code || prod.base_unit || 'UNIT';
          if (prod.last_cost && parseFloat(String(prod.last_cost)) > 0) {
            copy[index].unit_cost = String(prod.last_cost);
          } else if (prod.average_cost && parseFloat(String(prod.average_cost)) > 0) {
            copy[index].unit_cost = String(prod.average_cost);
          }
        }
      }
      return copy;
    });
  };

  // View detail
  const handleViewDetail = async (grnId: number) => {
    try {
      const detail = await fetchGoodsReceiptById(propertyId, grnId);
      setSelectedGrn(detail);
    } catch (e: any) {
      alert(e?.message || 'Gagal memuat detail Goods Receipt');
    }
  };

  // Submit GRN
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formLocationId) {
      alert('Pilih gudang penerimaan terlebih dahulu');
      return;
    }

    const validItems = formItems
      .filter((it) => Number(it.product_id) > 0 && parseFloat(it.received_qty) > 0)
      .map((it) => ({
        product_id: Number(it.product_id),
        po_item_id: it.po_item_id || null,
        received_qty: parseFloat(it.received_qty),
        unit_cost: parseFloat(it.unit_cost || '0'),
      }));

    if (validItems.length === 0) {
      alert('Pastikan minimal terdapat 1 item dengan kuantitas penerimaan lebih dari 0');
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await createGoodsReceipt({
        property_id: propertyId,
        po_id: receiptType === 'FROM_PO' && selectedPoId ? Number(selectedPoId) : null,
        supplier_id: formSupplierId ? Number(formSupplierId) : null,
        location_id: Number(formLocationId),
        receipt_date: formReceiptDate || undefined,
        invoice_no: formInvoiceNo || null,
        received_by: formReceivedBy || null,
        notes: formNotes || null,
        items: validItems,
      });

      setShowCreateModal(false);
      if (onClearPreselectedPo) onClearPreselectedPo();
      if (onNotifySuccess) {
        onNotifySuccess(
          `Penerimaan barang #${created.grn_number} berhasil dicatat! Saldo stok diperbarui dan Moving Average Cost telah dikalkulasi.`
        );
      }
      await loadReceipts();
    } catch (e: any) {
      alert(e?.message || 'Gagal mencatat penerimaan barang (GRN)');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Total GRN Valuation in form
  const totalGrnFormAmount = useMemo(() => {
    return formItems.reduce((sum, it) => {
      const q = parseFloat(it.received_qty) || 0;
      const c = parseFloat(it.unit_cost) || 0;
      return sum + q * c;
    }, 0);
  }, [formItems]);

  return (
    <div className="space-y-5">
      {/* Top Filter & Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-gray-200 shadow-2xs">
        {/* Search Input */}
        <div className="relative min-w-[260px]">
          <input
            type="text"
            placeholder="Cari No. GRN, No. Invoice, atau Supplier..."
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

        {/* Create GRN Button */}
        <button
          type="button"
          onClick={() => void openCreateModal()}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#1b4332] hover:bg-[#143427] text-white text-xs font-bold shadow-2xs transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4 text-[#d4af37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Catat Penerimaan Barang (GRN)
        </button>
      </div>

      {/* Error Banner */}
      {errorMsg && (
        <div className="p-3 bg-red-50 text-red-800 text-xs rounded-xl border border-red-200 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button onClick={() => void loadReceipts()} className="font-bold underline cursor-pointer">
            Coba Lagi
          </button>
        </div>
      )}

      {/* Goods Receipts Table */}
      <div className="bg-white rounded-2xl border border-gray-200/90 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/80 border-b border-gray-200 text-[11px] font-bold text-gray-600 uppercase tracking-wider">
                <th className="py-3 px-4">No. GRN</th>
                <th className="py-3 px-4">Tanggal Terima</th>
                <th className="py-3 px-4">Terkait PO</th>
                <th className="py-3 px-4">Supplier &amp; Faktur</th>
                <th className="py-3 px-4">Lokasi Gudang</th>
                <th className="py-3 px-4">Penerima</th>
                <th className="py-3 px-4 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-gray-400">
                    <div className="inline-block animate-spin w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full mb-2"></div>
                    <div>Memuat riwayat penerimaan barang...</div>
                  </td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-gray-400">
                    Belum ada riwayat penerimaan barang (GRN).
                  </td>
                </tr>
              ) : (
                receipts.map((grn) => (
                  <tr key={grn.id} className="hover:bg-emerald-50/30 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-[#1b4332]">{grn.grn_number}</td>
                    <td className="py-3 px-4 text-gray-600">{grn.receipt_date}</td>
                    <td className="py-3 px-4">
                      {grn.po_number ? (
                        <span className="font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px] font-semibold border border-blue-200">
                          {grn.po_number}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-[11px] italic">Pembelian Langsung</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-gray-900">{grn.supplier_name || '-'}</div>
                      {grn.invoice_no && (
                        <div className="text-[10px] text-gray-500 font-mono">Inv: {grn.invoice_no}</div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-semibold text-gray-800">{grn.location_name || '-'}</span>
                    </td>
                    <td className="py-3 px-4 text-gray-600">{grn.received_by || '-'}</td>
                    <td className="py-3 px-4 text-center">
                      <button
                        type="button"
                        onClick={() => void handleViewDetail(grn.id)}
                        className="px-3 py-1 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 text-[11px] font-semibold cursor-pointer shadow-2xs"
                      >
                        Lihat Rincian
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          MODAL: Form Catat Penerimaan Barang (GRN)
          ───────────────────────────────────────────────────────────────────────────── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-4xl w-full p-6 shadow-2xl border border-gray-200 animate-in fade-in duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Catat Penerimaan Barang (Goods Receipt Note)</h2>
                <p className="text-xs text-gray-500">
                  Verifikasi fisik barang masuk ke gudang, pemutakhiran saldo stok, dan kalkulasi moving average cost
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowCreateModal(false);
                  if (onClearPreselectedPo) onClearPreselectedPo();
                }}
                className="text-gray-400 hover:text-gray-600 p-1 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={(e) => void handleCreateSubmit(e)} className="mt-4 space-y-4">
              {/* Receipt Source Mode */}
              <div className="flex items-center gap-3 p-2 bg-gray-50 rounded-xl border border-gray-200">
                <span className="text-xs font-bold text-gray-700 ml-2">Sumber Penerimaan:</span>
                <label className="flex items-center gap-1.5 text-xs text-gray-800 cursor-pointer">
                  <input
                    type="radio"
                    name="receiptType"
                    checked={receiptType === 'FROM_PO'}
                    onChange={() => {
                      setReceiptType('FROM_PO');
                      if (activePos.length > 0) void handleSelectPoChange(String(activePos[0].id));
                    }}
                  />
                  Berdasarkan Purchase Order (PO)
                </label>
                <label className="flex items-center gap-1.5 text-xs text-gray-800 cursor-pointer ml-3">
                  <input
                    type="radio"
                    name="receiptType"
                    checked={receiptType === 'DIRECT'}
                    onChange={() => {
                      setReceiptType('DIRECT');
                      setSelectedPoId('');
                      setFormItems([{ product_id: '', received_qty: '1', unit_cost: '0' }]);
                    }}
                  />
                  Pembelian Langsung / Tanpa PO (Darurat/Pasar)
                </label>
              </div>

              {/* Header Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-gray-50/70 p-3.5 rounded-xl border border-gray-200/80">
                {receiptType === 'FROM_PO' ? (
                  <div>
                    <label className="block text-[11px] font-bold text-gray-700 mb-1">
                      Pilih Purchase Order (PO) <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={selectedPoId}
                      onChange={(e) => void handleSelectPoChange(e.target.value)}
                      required
                      className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                    >
                      <option value="">-- Pilih PO Aktif --</option>
                      {activePos.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.po_number} ({p.supplier_name || 'Vendor'}) - {p.status}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className="block text-[11px] font-bold text-gray-700 mb-1">Supplier / Vendor</label>
                    <select
                      value={formSupplierId}
                      onChange={(e) => setFormSupplierId(e.target.value)}
                      className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                    >
                      <option value="">-- Pilih Supplier --</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">
                    Gudang Tujuan Penerimaan <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formLocationId}
                    onChange={(e) => setFormLocationId(e.target.value)}
                    required
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  >
                    <option value="">-- Pilih Lokasi Gudang --</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name} ({loc.location_type})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">
                    Tanggal Penerimaan Fisik <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={formReceiptDate}
                    onChange={(e) => setFormReceiptDate(e.target.value)}
                    required
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">
                    Nomor Surat Jalan / Faktur Vendor
                  </label>
                  <input
                    type="text"
                    placeholder="Contoh: SJ-2026-9982"
                    value={formInvoiceNo}
                    onChange={(e) => setFormInvoiceNo(e.target.value)}
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">Petugas Penerima (Checker)</label>
                  <input
                    type="text"
                    value={formReceivedBy}
                    onChange={(e) => setFormReceivedBy(e.target.value)}
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-gray-700 mb-1">Catatan Tambahan</label>
                  <input
                    type="text"
                    placeholder="Kondisi kemasan utuh, kadaluarsa aman"
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332]"
                  />
                </div>
              </div>

              {/* Items Section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-gray-800 uppercase tracking-wider">
                    Item Bahan Baku Diterima ({formItems.length} Baris)
                  </h3>
                  {receiptType === 'DIRECT' && (
                    <button
                      type="button"
                      onClick={handleAddDirectItem}
                      className="px-2.5 py-1 text-[11px] font-bold text-[#1b4332] bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer"
                    >
                      + Tambah Baris
                    </button>
                  )}
                </div>

                <div className="max-h-60 overflow-y-auto space-y-2 border border-gray-200 rounded-xl p-2 bg-gray-50/50">
                  {formItems.length === 0 ? (
                    <div className="py-6 text-center text-xs text-gray-400">
                      Pilih Purchase Order terlebih dahulu untuk memuat baris item.
                    </div>
                  ) : (
                    formItems.map((item, idx) => {
                      const rowSubtotal = (parseFloat(item.received_qty) || 0) * (parseFloat(item.unit_cost) || 0);
                      return (
                        <div
                          key={idx}
                          className="grid grid-cols-1 sm:grid-cols-12 gap-2 bg-white p-2.5 rounded-lg border border-gray-200 items-center text-xs"
                        >
                          <div className="sm:col-span-5">
                            <label className="block text-[10px] text-gray-500 mb-0.5">Produk Bahan Baku</label>
                            {receiptType === 'FROM_PO' ? (
                              <div className="font-semibold text-gray-900">
                                {item.product_name}
                                {item.remaining_qty !== undefined && (
                                  <span className="text-[10px] text-gray-400 font-normal ml-1">
                                    (Sisa pesanan: {item.remaining_qty} {item.base_unit})
                                  </span>
                                )}
                              </div>
                            ) : (
                              <select
                                value={item.product_id}
                                onChange={(e) => handleDirectItemChange(idx, 'product_id', e.target.value)}
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
                            )}
                          </div>

                          <div className="sm:col-span-3">
                            <label className="block text-[10px] text-gray-500 mb-0.5">
                              Kuantitas Diterima Fisik {item.base_unit ? `(${item.base_unit})` : ''}
                            </label>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              max={receiptType === 'FROM_PO' && item.remaining_qty ? item.remaining_qty : undefined}
                              value={item.received_qty}
                              onChange={(e) => {
                                const val = e.target.value;
                                setFormItems((prev) => {
                                  const copy = [...prev];
                                  copy[idx] = { ...copy[idx], received_qty: val };
                                  return copy;
                                });
                              }}
                              required
                              className="w-full text-xs p-1.5 border border-gray-300 rounded font-mono font-bold text-[#1b4332]"
                            />
                          </div>

                          <div className="sm:col-span-2">
                            <label className="block text-[10px] text-gray-500 mb-0.5">Harga Beli Satuan (Rp)</label>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              value={item.unit_cost}
                              onChange={(e) => {
                                const val = e.target.value;
                                setFormItems((prev) => {
                                  const copy = [...prev];
                                  copy[idx] = { ...copy[idx], unit_cost: val };
                                  return copy;
                                });
                              }}
                              required
                              className="w-full text-xs p-1.5 border border-gray-300 rounded font-mono"
                            />
                          </div>

                          <div className="sm:col-span-2 text-right">
                            <label className="block text-[10px] text-gray-500 mb-0.5">Subtotal</label>
                            <div className="flex items-center justify-end gap-2">
                              <span className="font-mono font-bold text-gray-800 text-[11px]">
                                {Math.round(rowSubtotal).toLocaleString('id-ID')}
                              </span>
                              {receiptType === 'DIRECT' && formItems.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveDirectItem(idx)}
                                  className="text-red-500 hover:text-red-700 p-0.5 text-xs font-bold"
                                  title="Hapus baris item"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Info Note on Weighted Moving Average Cost */}
              <div className="p-3 bg-amber-50/70 border border-amber-200/80 rounded-xl text-xs text-amber-900 flex items-start gap-2">
                <span className="text-amber-600 font-bold text-base">ℹ</span>
                <div>
                  <span className="font-bold">Kalkulasi Otomatis Moving Average Cost:</span>
                  <div className="text-[11px] text-amber-800/90 mt-0.5">
                    Ketika barang diterima di gudang, sistem secara otomatis menghitung Weighted Moving Average Cost
                    pada master produk dan memperbarui kartu stok ledger pergerakan barang (PURCHASE_RECEIPT).
                  </div>
                </div>
              </div>

              {/* Total Summary Banner */}
              <div className="flex items-center justify-between p-3.5 bg-emerald-50 rounded-xl border border-emerald-200">
                <span className="text-xs font-bold text-[#1b4332]">Total Nilai Barang Diterima:</span>
                <span className="text-base font-black font-mono text-[#1b4332]">
                  {formatIDR(totalGrnFormAmount)}
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
                  {isSubmitting ? 'Memproses Penerimaan...' : 'Konfirmasi Penerimaan Barang (GRN)'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          MODAL: Detail Goods Receipt Note
          ───────────────────────────────────────────────────────────────────────────── */}
      {selectedGrn && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-gray-200">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-black text-[#1b4332]">{selectedGrn.grn_number}</span>
                <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                  COMPLETED
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedGrn(null)}
                className="text-gray-400 hover:text-gray-600 p-1 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-gray-50 p-3 rounded-xl">
              <div>
                <span className="text-gray-400 block text-[10px]">Terkait PO:</span>
                <span className="font-mono font-semibold text-blue-700">
                  {selectedGrn.po_number || 'Tanpa PO'}
                </span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Supplier:</span>
                <span className="font-semibold text-gray-800">{selectedGrn.supplier_name || '-'}</span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Tanggal Terima:</span>
                <span className="font-semibold text-gray-800">{selectedGrn.receipt_date}</span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Lokasi Gudang:</span>
                <span className="font-semibold text-gray-800">{selectedGrn.location_name || '-'}</span>
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-3 text-xs bg-gray-50 p-2.5 rounded-lg border border-gray-200">
              <div>
                <span className="text-gray-400 block text-[10px]">No. Surat Jalan / Faktur:</span>
                <span className="font-mono font-semibold text-gray-800">{selectedGrn.invoice_no || '-'}</span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Petugas Penerima:</span>
                <span className="font-semibold text-gray-800">{selectedGrn.received_by || '-'}</span>
              </div>
            </div>

            {selectedGrn.notes && (
              <div className="mt-2 text-xs text-gray-600 bg-amber-50/60 p-2 rounded-lg border border-amber-200/60">
                <span className="font-bold">Catatan:</span> {selectedGrn.notes}
              </div>
            )}

            {/* Received Items Table */}
            <div className="mt-4">
              <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">Item Barang Diterima</h4>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-gray-100/70 border-b border-gray-200 text-[10px] text-gray-600 font-bold uppercase">
                    <tr>
                      <th className="p-2.5">Produk</th>
                      <th className="p-2.5 text-center">Kuantitas</th>
                      <th className="p-2.5 text-right">Harga Satuan</th>
                      <th className="p-2.5 text-right">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {selectedGrn.items?.map((it) => (
                      <tr key={it.id}>
                        <td className="p-2.5">
                          <span className="font-semibold text-gray-900">{it.product_name}</span>
                          <span className="text-[10px] text-gray-400 block font-mono">{it.item_code}</span>
                        </td>
                        <td className="p-2.5 text-center font-mono font-bold text-[#1b4332]">
                          {it.received_qty} {it.canonical_base_unit_code || it.base_unit || ''}
                        </td>
                        <td className="p-2.5 text-right font-mono">{formatIDR(it.unit_cost)}</td>
                        <td className="p-2.5 text-right font-mono font-bold text-gray-900">
                          {formatIDR(it.subtotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="mt-5 flex items-center justify-end pt-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setSelectedGrn(null)}
                className="px-4 py-2 border border-gray-200 text-gray-700 text-xs font-semibold rounded-xl hover:bg-gray-50 cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
