/**
 * OAK HIMS — MP-04D / Inventori 01 Goods Receipt Note (GRN) Management Section
 * Tampilan Daftar (Semua, Draft, Diposting) & Form Penerimaan Barang (Simpan Draft vs Post Penerimaan)
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  fetchGoodsReceipts,
  fetchGoodsReceiptById,
  createGoodsReceipt,
  updateGoodsReceiptDraftApi,
  postGoodsReceiptApi,
  cancelGoodsReceiptDraftApi,
  fetchPurchaseOrders,
  fetchPurchaseOrderById,
  fetchSuppliers,
  fetchRawMaterialCandidates,
  fetchApprovedPurchasesForReceiving,
  fetchPurchaseTransactionReceivablePreview,
  fetchPurchaseOrderReceivablePreview,
  type PosGoodsReceipt,
  type PosPurchaseOrder,
  type PosSupplier,
  type RawMaterialCandidate,
  type ApprovedPurchaseOption,
} from './posPurchaseOrderApi';
import { fetchStockLocations } from './posInventoryApi';
import type { StockLocation } from './posInventoryTypes';

interface Props {
  propertyId: number;
  preselectedPo?: PosPurchaseOrder | null;
  onClearPreselectedPo?: () => void;
  preselectedPoId?: number | null;
  onClearPreselectedPoId?: () => void;
  preselectedPurchaseTxId?: number | null;
  onClearPreselectedPurchaseTx?: () => void;
  initialSearchQuery?: string;
  onNotifySuccess?: (msg: string) => void;
}

function formatIDR(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) || 0 : value || 0;
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

function formatQty(value: number | string | null | undefined): string {
  const num = typeof value === 'string' ? parseFloat(value) : Number(value ?? 0);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('id-ID', { maximumFractionDigits: 3 });
}

function isPoEligibleForReceipt(p: PosPurchaseOrder): boolean {
  const st = String(p.status || '').toUpperCase();
  const app = String(p.approval_status || '').toUpperCase();
  const rec = String((p as any).receiving_status || '').toUpperCase();
  if (['CANCELLED', 'REJECTED', 'DRAFT', 'PENDING_APPROVAL', 'COMPLETED'].includes(st)) return false;
  if (['REJECTED', 'DRAFT', 'PENDING_APPROVAL'].includes(app)) return false;
  if (['RECEIVED', 'DITERIMA', 'DITERIMA_LENGKAP', 'COMPLETED'].includes(rec)) return false;
  return app === 'APPROVED' || (!app && ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(st));
}

function getJakartaDateToday(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function formatDateOnly(val?: string | null): string {
  if (!val) return '-';
  const raw = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(parsed);
    } catch {
      return raw.slice(0, 10);
    }
  }
  return raw.slice(0, 10);
}

type GrnTabFilter = 'ALL' | 'DRAFT' | 'POSTED';

export function mapDraftItemWithPurchaseSource(
  it: any,
  sourceLines: any[],
  requireSourceMatch = true
) {
  const hasExplicitTxLineId =
    it.transaction_line_id !== undefined &&
    it.transaction_line_id !== null &&
    String(it.transaction_line_id).trim() !== '' &&
    Number(it.transaction_line_id) > 0;
  const hasExplicitPoItemId =
    it.po_item_id !== undefined &&
    it.po_item_id !== null &&
    String(it.po_item_id).trim() !== '' &&
    Number(it.po_item_id) > 0;
  const sourceHasTxLineIds = sourceLines.some((ln: any) => ln.transaction_line_id != null);

  let srcLn: any = undefined;
  let sourceRefError: string | null = null;

  if (hasExplicitTxLineId && (sourceHasTxLineIds || !hasExplicitPoItemId)) {
    const targetLineId = Number(it.transaction_line_id);
    srcLn = sourceLines.find(
      (ln: any) =>
        ln.transaction_line_id != null &&
        Number(ln.transaction_line_id) === targetLineId
    );
    if (!srcLn && (requireSourceMatch || sourceLines.length > 0)) {
      sourceRefError = `Referensi baris pembelian sumber (#${targetLineId}) tidak ditemukan pada transaksi pembelian.`;
    }
  } else if (hasExplicitPoItemId) {
    const targetPoItemId = Number(it.po_item_id);
    srcLn = sourceLines.find(
      (ln: any) =>
        (ln.po_item_id != null && Number(ln.po_item_id) === targetPoItemId) ||
        (ln.id != null && ln.po_item_id == null && ln.transaction_line_id == null && Number(ln.id) === targetPoItemId)
    );
    if (!srcLn && (requireSourceMatch || sourceLines.length > 0)) {
      sourceRefError = `Referensi baris PO sumber (#${targetPoItemId}) tidak ditemukan pada PO.`;
    }
  } else if (requireSourceMatch || sourceLines.length > 0) {
    const candidates = sourceLines.filter(
      (ln: any) => Number(ln.product_id) === Number(it.product_id)
    );
    if (candidates.length === 1) {
      srcLn = candidates[0];
    } else if (candidates.length > 1) {
      sourceRefError = `Referensi baris sumber ambigu: terdapat ${candidates.length} baris pembelian untuk produk #${it.product_id} tanpa transaction_line_id/po_item_id eksplisit.`;
    } else {
      sourceRefError = `Referensi baris pembelian sumber untuk produk #${it.product_id} tidak ditemukan pada transaksi pembelian.`;
    }
  }

  const parsedQty = Number(it.received_qty);
  const parsedCost = Number(it.unit_cost ?? srcLn?.unit_cost ?? 0);
  const rawDraftFactor = Number(it.conversion_factor_snapshot ?? it.to_base_factor ?? 0);
  const factor = rawDraftFactor > 0 ? rawDraftFactor : Number(srcLn?.to_base_factor || 1);
  const resolvedPackagingId =
    it.packaging_id !== undefined && it.packaging_id !== null
      ? Number(it.packaging_id)
      : it.packaging_id === null && rawDraftFactor === 1
      ? null
      : srcLn?.packaging_id != null
      ? Number(srcLn.packaging_id)
      : null;
  const baseUnit =
    srcLn?.base_unit || it.canonical_base_unit_code || it.base_unit || 'UNIT';
  const resolvedPackagingLabel =
    resolvedPackagingId != null || factor > 1
      ? it.packaging_label || srcLn?.packaging_label || null
      : null;
  const orderedUnit =
    resolvedPackagingId == null && factor <= 1
      ? srcLn?.ordered_unit || it.ordered_unit || baseUnit
      : srcLn?.ordered_unit ||
        it.packaging_code ||
        it.ordered_unit ||
        (resolvedPackagingLabel
          ? String(resolvedPackagingLabel).replace(/^1\s+/i, '').split(/\s*\(/)[0].trim() ||
            resolvedPackagingLabel
          : null) ||
        baseUnit;

  return {
    id: it.id != null ? Number(it.id) : undefined,
    product_id: String(it.product_id ?? srcLn?.product_id ?? ''),
    product_name: it.product_name || srcLn?.product_name || srcLn?.description_snapshot,
    po_item_id: hasExplicitPoItemId
      ? Number(it.po_item_id)
      : srcLn?.po_item_id != null
      ? Number(srcLn.po_item_id)
      : null,
    transaction_line_id: hasExplicitTxLineId
      ? Number(it.transaction_line_id)
      : srcLn?.transaction_line_id != null
      ? Number(srcLn.transaction_line_id)
      : null,
    packaging_id: resolvedPackagingId,
    packaging_label: resolvedPackagingLabel,
    to_base_factor: factor > 0 ? factor : 1,
    received_qty: !Number.isNaN(parsedQty) ? String(parsedQty) : String(it.received_qty || 0),
    unit_cost: !Number.isNaN(parsedCost)
      ? String(parsedCost)
      : String(it.unit_cost ?? srcLn?.unit_cost ?? 0),
    remaining_qty: srcLn?.remaining_qty,
    ordered_unit: orderedUnit,
    base_unit: baseUnit,
    track_stock:
      it.track_stock !== undefined
        ? Boolean(it.track_stock)
        : srcLn?.track_stock !== undefined
        ? Boolean(srcLn.track_stock)
        : undefined,
    track_inventory:
      it.track_inventory !== undefined
        ? Boolean(it.track_inventory)
        : srcLn?.track_inventory !== undefined
        ? Boolean(srcLn.track_inventory)
        : undefined,
    source_ref_error: sourceRefError,
  };
}

export default function GoodsReceiptSection({
  propertyId,
  preselectedPo,
  onClearPreselectedPo,
  preselectedPoId,
  onClearPreselectedPoId,
  preselectedPurchaseTxId,
  onClearPreselectedPurchaseTx,
  initialSearchQuery,
  onNotifySuccess,
}: Props) {
  const [receipts, setReceipts] = useState<PosGoodsReceipt[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const notifySuccess = useCallback(
    (msg: string) => {
      setSuccessMsg(msg);
      if (onNotifySuccess) onNotifySuccess(msg);
    },
    [onNotifySuccess]
  );

  // Status Tab & Search Filters
  const [activeTab, setActiveTab] = useState<GrnTabFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>(() => {
    if (initialSearchQuery !== undefined) return initialSearchQuery;
    try {
      const pendingSearch = sessionStorage.getItem('oak_hims_pending_grn_search');
      if (pendingSearch !== null) {
        sessionStorage.removeItem('oak_hims_pending_grn_search');
        return pendingSearch;
      }
    } catch {
      /* ignore */
    }
    return '';
  });

  // Modals & Action States
  const [selectedGrn, setSelectedGrn] = useState<PosGoodsReceipt | null>(null);
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<number | null>(null);

  // Reference Data
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [activePos, setActivePos] = useState<PosPurchaseOrder[]>([]);
  const [approvedPurchases, setApprovedPurchases] = useState<ApprovedPurchaseOption[]>([]);
  const [suppliers, setSuppliers] = useState<PosSupplier[]>([]);
  const [rawMaterials, setRawMaterials] = useState<RawMaterialCandidate[]>([]);

  // Create Form State
  const [receiptType, setReceiptType] = useState<'FROM_PURCHASE' | 'FROM_PO' | 'DIRECT'>('FROM_PURCHASE');
  const [selectedPurchaseTxId, setSelectedPurchaseTxId] = useState<string>('');
  const [selectedPoId, setSelectedPoId] = useState<string>('');
  const [formSupplierId, setFormSupplierId] = useState<string>('');
  const [formLocationId, setFormLocationId] = useState<string>('');
  const [formReceiptDate, setFormReceiptDate] = useState<string>(getJakartaDateToday());
  const [formInvoiceNo, setFormInvoiceNo] = useState<string>('');
  const [formReceivedBy, setFormReceivedBy] = useState<string>('Staf Gudang');
  const [formNotes, setFormNotes] = useState<string>('');
  const [formItems, setFormItems] = useState<
    Array<{
      id?: number | null;
      product_id: string;
      product_name?: string;
      po_item_id?: number | null;
      transaction_line_id?: number | null;
      packaging_id?: number | null;
      packaging_label?: string | null;
      to_base_factor?: number;
      received_qty: string;
      unit_cost: string;
      remaining_qty?: number;
      ordered_unit?: string;
      base_unit?: string;
      track_stock?: boolean;
      track_inventory?: boolean;
      source_ref_error?: string | null;
    }>
  >([]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [formActionKey, setFormActionKey] = useState<string>('');
  const contextGenRef = useRef<number>(0);

  const generateNewFormActionKey = useCallback(
    () => `grn-ui-${propertyId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    [propertyId]
  );

  const pickGudang1OrFirst = (locs: StockLocation[]): string => {
    if (!locs || locs.length === 0) return '';
    const activePhysical = locs.filter((l) => {
      if (l.is_active === false) return false;
      const lt = String(l.location_type || 'WAREHOUSE').toUpperCase();
      return !['SUMMARY', 'CONTAINER', 'VIRTUAL'].includes(lt);
    });
    if (activePhysical.length === 0) return '';
    const gudang1 = activePhysical.find(
      (l) =>
        String(l.location_type || 'WAREHOUSE').toUpperCase() === 'WAREHOUSE' &&
        (String(l.code || '').trim().toUpperCase() === 'WH-01' ||
          String(l.name || '').trim().toLowerCase() === 'gudang 1')
    );
    return gudang1 ? String(gudang1.id) : String(activePhysical[0].id);
  };

  // Consume pending GRN bridges from sessionStorage when opened as standalone submenu
  const consumePendingGrnBridges = useCallback(() => {
    try {
      const pendingPoId = sessionStorage.getItem('oak_hims_pending_grn_po_id');
      if (pendingPoId) {
        sessionStorage.removeItem('oak_hims_pending_grn_po_id');
        const num = Number(pendingPoId);
        if (Number.isFinite(num) && num > 0) {
          void openCreateWithPoId(num);
        }
      }
      const pendingTxId = sessionStorage.getItem('oak_hims_pending_grn_purchase_tx_id');
      if (pendingTxId) {
        sessionStorage.removeItem('oak_hims_pending_grn_purchase_tx_id');
        const num = Number(pendingTxId);
        if (Number.isFinite(num) && num > 0) {
          void openCreateWithPurchaseTx(num);
        }
      }
      const pendingSearch = sessionStorage.getItem('oak_hims_pending_grn_search');
      if (pendingSearch !== null) {
        sessionStorage.removeItem('oak_hims_pending_grn_search');
        setActiveTab('ALL');
        setSearchQuery(pendingSearch);
      }
    } catch {
      /* ignore */
    }
  }, [propertyId]);

  useEffect(() => {
    contextGenRef.current += 1;
    setShowCreateModal(false);
    setSelectedGrn(null);
    setEditingDraftId(null);
    setSelectedPoId('');
    setSelectedPurchaseTxId('');
    setFormItems([]);
    consumePendingGrnBridges();
    return () => {
      contextGenRef.current += 1;
    };
  }, [propertyId, consumePendingGrnBridges]);

  useEffect(() => {
    const handler = () => consumePendingGrnBridges();
    window.addEventListener('oak_hims_pending_grn_bridge', handler);
    return () => window.removeEventListener('oak_hims_pending_grn_bridge', handler);
  }, [consumePendingGrnBridges]);

  // Load GRN list with status filter
  const loadReceipts = useCallback(async () => {
    const reqGen = contextGenRef.current;
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetchGoodsReceipts(propertyId, {
        status: activeTab,
        search: searchQuery.trim() || undefined,
      });
      if (contextGenRef.current !== reqGen) return;
      setReceipts(res.receipts || []);
    } catch (err: any) {
      if (contextGenRef.current !== reqGen) return;
      setErrorMsg(err?.message || 'Gagal memuat riwayat penerimaan barang');
    } finally {
      if (contextGenRef.current === reqGen) {
        setLoading(false);
      }
    }
  }, [propertyId, activeTab, searchQuery]);

  useEffect(() => {
    void loadReceipts();
  }, [loadReceipts]);

  // Handle preselected PO from parent / PO Section
  useEffect(() => {
    if (preselectedPo) {
      void openCreateWithPo(preselectedPo);
    }
  }, [preselectedPo]);

  // Handle preselected PO ID from Pembelian / Procurement Menu
  useEffect(() => {
    if (preselectedPoId && preselectedPoId > 0) {
      void openCreateWithPoId(preselectedPoId);
    }
  }, [preselectedPoId]);

  useEffect(() => {
    if (initialSearchQuery !== undefined) {
      setSearchQuery(initialSearchQuery);
    }
  }, [initialSearchQuery]);

  // Handle preselected Purchase Transaction from Pembelian Menu
  useEffect(() => {
    if (preselectedPurchaseTxId && preselectedPurchaseTxId > 0) {
      void openCreateWithPurchaseTx(preselectedPurchaseTxId);
    }
  }, [preselectedPurchaseTxId]);

  const handleSelectPurchaseTxChange = async (txIdStr: string) => {
    const reqGen = contextGenRef.current;
    setSelectedPurchaseTxId(txIdStr);
    if (!txIdStr) {
      setFormItems([]);
      return;
    }
    try {
      const preview = await fetchPurchaseTransactionReceivablePreview(propertyId, Number(txIdStr));
      if (contextGenRef.current !== reqGen) return;
      if (preview.transaction_id && typeof setApprovedPurchases === 'function') {
        setApprovedPurchases((prev) => {
          if (prev.some((p) => Number(p.id) === Number(preview.transaction_id))) return prev;
          return [
            {
              id: Number(preview.transaction_id),
              transaction_no: preview.transaction_no || `TRX-${preview.transaction_id}`,
              transaction_date: preview.transaction_date || '',
              party_name: preview.supplier_name || null,
              supplier_name: preview.supplier_name || null,
              description: '',
              net_amount: 0,
              approval_status: preview.approval_status || 'APPROVED',
              receiving_status: preview.receiving_status || 'BELUM_DITERIMA',
            },
            ...prev,
          ];
        });
      }
      const activeDraftId = preview.active_draft_id
        ? Number(preview.active_draft_id)
        : preview.active_draft?.id
        ? Number(preview.active_draft.id)
        : null;
      if (typeof setEditingDraftId === 'function') {
        setEditingDraftId(activeDraftId);
      }

      const sourceLines = Array.isArray(preview.lines)
        ? preview.lines
        : Array.isArray(preview.items)
        ? preview.items
        : [];

      if (activeDraftId) {
        const draftDetail =
          typeof fetchGoodsReceiptById === 'function'
            ? await fetchGoodsReceiptById(propertyId, activeDraftId)
            : preview.active_draft;
        const draft: any = draftDetail || preview.active_draft || {};
        const supId = draft.supplier_id ?? preview.supplier_id;
        if (supId) {
          setFormSupplierId(String(supId));
        }
        const invNo = draft.invoice_no || preview.active_draft?.invoice_no || preview.source_reference || '';
        if (invNo || !formInvoiceNo) {
          setFormInvoiceNo(invNo);
        }
        const locId = draft.location_id || preview.active_draft?.location_id || preview.default_location?.id;
        if (locId) {
          setFormLocationId(String(locId));
        }
        if (typeof setFormReceiptDate === 'function' && (draft.receipt_date || preview.active_draft?.receipt_date)) {
          const rawDate = String(draft.receipt_date || preview.active_draft?.receipt_date).trim();
          const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
            ? rawDate
            : (() => {
                const parsed = new Date(rawDate);
                return !Number.isNaN(parsed.getTime())
                  ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(parsed)
                  : rawDate.slice(0, 10);
              })();
          setFormReceiptDate(normalizedDate);
        }
        if (typeof setFormReceivedBy === 'function' && (draft.received_by || preview.active_draft?.received_by)) {
          setFormReceivedBy(String(draft.received_by || preview.active_draft?.received_by));
        }
        if (
          typeof setFormNotes === 'function' &&
          (draft.notes !== undefined || preview.active_draft?.notes !== undefined)
        ) {
          setFormNotes(String(draft.notes ?? preview.active_draft?.notes ?? ''));
        }

        const draftItems =
          Array.isArray(draft.items) && draft.items.length > 0
            ? draft.items
            : Array.isArray((preview.active_draft as any)?.items) && (preview.active_draft as any).items.length > 0
            ? (preview.active_draft as any).items
            : null;

        if (draftItems) {
          const lines = draftItems.map((it: any) => {
            const hasExplicitTxLineId =
              it.transaction_line_id !== undefined &&
              it.transaction_line_id !== null &&
              String(it.transaction_line_id).trim() !== '' &&
              Number(it.transaction_line_id) > 0;

            let srcLn: any = undefined;
            let sourceRefError: string | null = null;

            if (hasExplicitTxLineId) {
              const targetLineId = Number(it.transaction_line_id);
              srcLn = sourceLines.find(
                (ln: any) =>
                  ln.transaction_line_id != null &&
                  Number(ln.transaction_line_id) === targetLineId
              );
              if (!srcLn) {
                sourceRefError = `Referensi baris pembelian sumber (#${targetLineId}) tidak ditemukan pada transaksi pembelian.`;
              }
            } else {
              const candidates = sourceLines.filter(
                (ln: any) => Number(ln.product_id) === Number(it.product_id)
              );
              if (candidates.length === 1) {
                srcLn = candidates[0];
              } else if (candidates.length > 1) {
                sourceRefError = `Referensi baris sumber ambigu: terdapat ${candidates.length} baris pembelian untuk produk #${it.product_id} tanpa transaction_line_id eksplisit.`;
              } else {
                sourceRefError = `Referensi baris pembelian sumber untuk produk #${it.product_id} tidak ditemukan pada transaksi pembelian.`;
              }
            }

            const parsedQty = Number(it.received_qty);
            const parsedCost = Number(it.unit_cost ?? srcLn?.unit_cost ?? 0);
            const rawDraftFactor = Number(it.conversion_factor_snapshot ?? it.to_base_factor ?? 0);
            const factor = rawDraftFactor > 0 ? rawDraftFactor : Number(srcLn?.to_base_factor || 1);
            const resolvedPackagingId =
              it.packaging_id !== undefined && it.packaging_id !== null
                ? Number(it.packaging_id)
                : it.packaging_id === null && rawDraftFactor === 1
                ? null
                : srcLn?.packaging_id != null
                ? Number(srcLn.packaging_id)
                : null;
            const baseUnit =
              srcLn?.base_unit || it.canonical_base_unit_code || it.base_unit || 'UNIT';
            const resolvedPackagingLabel =
              resolvedPackagingId != null || factor > 1
                ? it.packaging_label || srcLn?.packaging_label || null
                : null;
            const orderedUnit =
              resolvedPackagingId == null && factor <= 1
                ? srcLn?.ordered_unit || it.ordered_unit || baseUnit
                : srcLn?.ordered_unit ||
                  it.packaging_code ||
                  it.ordered_unit ||
                  (resolvedPackagingLabel
                    ? String(resolvedPackagingLabel).replace(/^1\s+/i, '').split(/\s*\(/)[0].trim() ||
                      resolvedPackagingLabel
                    : null) ||
                  baseUnit;

            return {
              id: it.id != null ? Number(it.id) : undefined,
              product_id: String(it.product_id ?? srcLn?.product_id ?? ''),
              product_name: it.product_name || srcLn?.product_name || srcLn?.description_snapshot,
              po_item_id: it.po_item_id != null ? Number(it.po_item_id) : null,
              transaction_line_id: hasExplicitTxLineId
                ? Number(it.transaction_line_id)
                : srcLn?.transaction_line_id != null
                ? Number(srcLn.transaction_line_id)
                : null,
              packaging_id: resolvedPackagingId,
              packaging_label: resolvedPackagingLabel,
              to_base_factor: factor > 0 ? factor : 1,
              received_qty: !Number.isNaN(parsedQty) ? String(parsedQty) : String(it.received_qty || 0),
              unit_cost: !Number.isNaN(parsedCost)
                ? String(parsedCost)
                : String(it.unit_cost ?? srcLn?.unit_cost ?? 0),
              remaining_qty: srcLn?.remaining_qty,
              ordered_unit: orderedUnit,
              base_unit: baseUnit,
              source_ref_error: sourceRefError,
            };
          });
          const firstRefErr = lines.find((l: any) => l.source_ref_error)?.source_ref_error || null;
          if (typeof setErrorMsg === 'function') {
            setErrorMsg(firstRefErr);
          }
          setFormItems(lines);
          return;
        }
      }

      if (preview.supplier_id) {
        setFormSupplierId(String(preview.supplier_id));
      }
      if (preview.source_reference && !formInvoiceNo) {
        setFormInvoiceNo(preview.source_reference);
      }
      if (preview.default_location?.id) {
        setFormLocationId(String(preview.default_location.id));
      }
      const lines = sourceLines.map((ln) => ({
        product_id: String(ln.product_id),
        product_name: ln.product_name || ln.description_snapshot,
        po_item_id: ln.po_item_id ?? null,
        transaction_line_id: ln.transaction_line_id,
        packaging_id: ln.packaging_id,
        packaging_label: ln.packaging_label,
        to_base_factor: Number(ln.to_base_factor || 1),
        received_qty: String(ln.remaining_qty > 0 ? ln.remaining_qty : 0),
        unit_cost: String(ln.unit_cost || 0),
        remaining_qty: ln.remaining_qty,
        ordered_unit: ln.ordered_unit,
        base_unit: ln.base_unit,
      }));
      setFormItems(lines);
    } catch (e: any) {
      alert(e?.message || 'Gagal memuat pratinjau penerimaan dari transaksi pembelian');
    }
  };

  const openCreateWithPurchaseTx = async (txId: number) => {
    const reqGen = contextGenRef.current;
    if (typeof setErrorMsg === 'function') setErrorMsg(null);
    setEditingDraftId(null);
    setFormActionKey(generateNewFormActionKey());
    setFormReceiptDate(getJakartaDateToday());
    setReceiptType('FROM_PURCHASE');
    setSelectedPurchaseTxId(String(txId));
    setSelectedPoId('');
    setShowCreateModal(true);

    try {
      const [locsRes, purchasesRes, supRes, rawRes] = await Promise.all([
        fetchStockLocations(propertyId),
        fetchApprovedPurchasesForReceiving(propertyId),
        fetchSuppliers(propertyId, { is_active: true }),
        fetchRawMaterialCandidates(propertyId),
      ]);
      if (contextGenRef.current !== reqGen) return;
      const activeLocs = locsRes.filter((l) => l.is_active);
      setLocations(activeLocs);
      const defaultLoc = pickGudang1OrFirst(activeLocs);
      setFormLocationId(defaultLoc || '');
      if (!defaultLoc) {
        setErrorMsg('Belum ada lokasi gudang fisik aktif yang dikonfigurasi.');
      }
      setApprovedPurchases(purchasesRes);
      setSuppliers(supRes);
      setRawMaterials(rawRes);

      await handleSelectPurchaseTxChange(String(txId));
    } catch (e: any) {
      console.error('Error preloading purchase transaction for GRN:', e);
    }
  };

  const openCreateWithPoId = async (poId: number) => {
    const reqGen = contextGenRef.current;
    if (typeof setErrorMsg === 'function') setErrorMsg(null);
    setEditingDraftId(null);
    setFormActionKey(generateNewFormActionKey());
    setFormReceiptDate(getJakartaDateToday());
    setReceiptType('FROM_PO');
    setSelectedPoId(String(poId));
    setSelectedPurchaseTxId('');
    setShowCreateModal(true);

    try {
      const [locsRes, poRes, supRes, rawRes] = await Promise.all([
        fetchStockLocations(propertyId),
        fetchPurchaseOrders(propertyId, { limit: 100 }).catch(() => ({ orders: [] })),
        fetchSuppliers(propertyId, { is_active: true }),
        fetchRawMaterialCandidates(propertyId),
      ]);
      if (contextGenRef.current !== reqGen) return;
      const activeLocs = locsRes.filter((l) => l.is_active);
      setLocations(activeLocs);
      const defaultLoc = pickGudang1OrFirst(activeLocs);
      setFormLocationId(defaultLoc || '');
      if (!defaultLoc) {
        setErrorMsg('Belum ada lokasi gudang fisik aktif yang dikonfigurasi.');
      }
      const receivablePos = (poRes.orders || []).filter(
        (p) => isPoEligibleForReceipt(p) || Number(p.id) === Number(poId)
      );
      setActivePos(receivablePos);
      setSuppliers(supRes);
      setRawMaterials(rawRes);

      await handleSelectPoChange(String(poId));
    } catch (e: any) {
      console.error('Error preloading PO lines for GRN:', e);
    }
  };

  // Open modal with preselected PO
  const openCreateWithPo = async (po: PosPurchaseOrder) => {
    await openCreateWithPoId(po.id);
  };

  // Open modal manually
  const openCreateModal = async () => {
    if (typeof setErrorMsg === 'function') setErrorMsg(null);
    setEditingDraftId(null);
    setFormActionKey(generateNewFormActionKey());
    setFormReceiptDate(getJakartaDateToday());
    setSelectedPoId('');
    setSelectedPurchaseTxId('');
    setFormItems([]);
    setFormInvoiceNo('');
    setFormNotes('');
    setShowCreateModal(true);
    try {
      const [locsRes, purchasesRes, poRes, supRes, rawRes] = await Promise.all([
        fetchStockLocations(propertyId),
        fetchApprovedPurchasesForReceiving(propertyId),
        fetchPurchaseOrders(propertyId, { limit: 100 }),
        fetchSuppliers(propertyId, { is_active: true }),
        fetchRawMaterialCandidates(propertyId),
      ]);

      const activeLocs = locsRes.filter((l) => l.is_active);
      setLocations(activeLocs);
      const defaultLoc = pickGudang1OrFirst(activeLocs);
      setFormLocationId(defaultLoc || '');
      if (!defaultLoc) {
        setErrorMsg('Belum ada lokasi gudang fisik aktif yang dikonfigurasi.');
      }

      const postedTxIds = new Set(
        receipts
          .filter((r) => String(r.status || '').toUpperCase() === 'POSTED' && r.transaction_id)
          .map((r) => Number(r.transaction_id))
      );
      const filteredPurchases = purchasesRes.filter((tx) => !postedTxIds.has(Number(tx.id)));
      setApprovedPurchases(filteredPurchases);

      // Filter POs that can be received (APPROVED and not pending re-approval)
      const receivablePos = poRes.orders.filter((p) => isPoEligibleForReceipt(p));
      setActivePos(receivablePos);
      setSuppliers(supRes);
      setRawMaterials(rawRes);

      if (receivablePos.length > 0) {
        setReceiptType('FROM_PO');
        setSelectedPoId(String(receivablePos[0].id));
        void handleSelectPoChange(String(receivablePos[0].id));
      } else if (filteredPurchases.length > 0) {
        setReceiptType('FROM_PURCHASE');
        setSelectedPurchaseTxId(String(filteredPurchases[0].id));
        void handleSelectPurchaseTxChange(String(filteredPurchases[0].id));
      } else {
        setReceiptType('FROM_PO');
        setFormItems([]);
      }
    } catch (e: any) {
      console.error('Error opening GRN modal:', e);
    }
  };

  // Open modal to edit an existing DRAFT receipt
  const openEditDraftModal = async (grnId: number) => {
    try {
      const [detail, locsRes, purchasesRes, supRes, rawRes] = await Promise.all([
        fetchGoodsReceiptById(propertyId, grnId),
        fetchStockLocations(propertyId),
        typeof fetchApprovedPurchasesForReceiving === 'function'
          ? fetchApprovedPurchasesForReceiving(propertyId).catch(() => [])
          : Promise.resolve([]),
        fetchSuppliers(propertyId, { is_active: true }),
        fetchRawMaterialCandidates(propertyId),
      ]);
      if (detail.status !== 'DRAFT') {
        alert('Hanya dokumen berstatus DRAFT yang dapat diedit.');
        return;
      }
      setLocations(locsRes.filter((l) => l.is_active));
      setSuppliers(supRes);
      setRawMaterials(rawRes);

      let sourceLines: any[] = [];
      let mergedPurchases = Array.isArray(purchasesRes) ? [...purchasesRes] : [];

      setEditingDraftId(detail.id);
      if (detail.transaction_id) {
        setReceiptType('FROM_PURCHASE');
        setSelectedPurchaseTxId(String(detail.transaction_id));
        setSelectedPoId('');

        const txIdNum = Number(detail.transaction_id);
        const preview =
          typeof fetchPurchaseTransactionReceivablePreview === 'function'
            ? await fetchPurchaseTransactionReceivablePreview(propertyId, txIdNum).catch(() => null)
            : null;
        if (preview) {
          sourceLines = Array.isArray(preview.lines)
            ? preview.lines
            : Array.isArray(preview.items)
            ? preview.items
            : [];
        }
        const txNo = preview?.transaction_no || detail.transaction_number || `TRX-${txIdNum}`;
        const txSupplier = preview?.supplier_name || detail.supplier_name || null;
        if (!mergedPurchases.some((p) => Number(p.id) === txIdNum)) {
          mergedPurchases = [
            {
              id: txIdNum,
              transaction_no: txNo,
              transaction_date: preview?.transaction_date || detail.receipt_date || '',
              party_name: txSupplier,
              supplier_name: txSupplier,
              description: '',
              net_amount: 0,
              approval_status: preview?.approval_status || 'APPROVED',
              receiving_status: preview?.receiving_status || 'BELUM_DITERIMA',
            },
            ...mergedPurchases,
          ];
        }
      } else if (detail.po_id) {
        setReceiptType('FROM_PO');
        setSelectedPoId(String(detail.po_id));
        setSelectedPurchaseTxId('');
        const poIdNum = Number(detail.po_id);
        const poPreview =
          typeof fetchPurchaseOrderReceivablePreview === 'function'
            ? await fetchPurchaseOrderReceivablePreview(propertyId, poIdNum).catch(() => null)
            : null;
        if (poPreview) {
          sourceLines = Array.isArray(poPreview.lines)
            ? poPreview.lines
            : Array.isArray(poPreview.items)
            ? poPreview.items
            : [];
        }
        if (typeof fetchPurchaseOrders === 'function') {
          const poListRes = await fetchPurchaseOrders(propertyId, { limit: 100 }).catch(() => ({ orders: [] }));
          const receivablePos = (poListRes.orders || []).filter(
            (p) =>
              p.status === 'APPROVED' ||
              p.status === 'ORDERED' ||
              p.status === 'PARTIALLY_RECEIVED' ||
              Number(p.id) === Number(detail.po_id)
          );
          if (!receivablePos.some((p) => Number(p.id) === poIdNum) && poPreview) {
            receivablePos.unshift({
              id: poIdNum,
              property_id: propertyId,
              po_number: poPreview.po_number || detail.po_number || `PO-${poIdNum}`,
              supplier_id: Number(poPreview.supplier_id || detail.supplier_id || 0),
              supplier_name: poPreview.supplier_name || detail.supplier_name || 'Vendor',
              order_date: poPreview.po_date || detail.receipt_date || '',
              expected_date: null,
              status: (poPreview.status as any) || 'APPROVED',
              total_amount: '0',
              notes: null,
              created_by: null,
              created_at: '',
              updated_at: '',
            });
          }
          setActivePos(receivablePos);
        }
      } else {
        setReceiptType('FROM_PO');
        setSelectedPurchaseTxId('');
        setSelectedPoId('');
      }
      setApprovedPurchases(mergedPurchases);
      setFormSupplierId(detail.supplier_id ? String(detail.supplier_id) : '');
      setFormLocationId(detail.location_id ? String(detail.location_id) : pickGudang1OrFirst(locsRes));
      setFormReceiptDate(detail.receipt_date ? formatDateOnly(detail.receipt_date) : getJakartaDateToday());
      setFormInvoiceNo(detail.invoice_no || '');
      setFormReceivedBy(detail.received_by || 'Staf Gudang');
      setFormNotes(detail.notes || '');
      const isFromPoOnly = Boolean(detail.po_id && !detail.transaction_id);
      const mappedDraftLines = (detail.items || []).map((it: any) => {
        const hasExplicitTxLineId =
          it.transaction_line_id !== undefined &&
          it.transaction_line_id !== null &&
          String(it.transaction_line_id).trim() !== '' &&
          Number(it.transaction_line_id) > 0;
        const hasExplicitPoItemId =
          it.po_item_id !== undefined &&
          it.po_item_id !== null &&
          String(it.po_item_id).trim() !== '' &&
          Number(it.po_item_id) > 0;
        const requirePurchaseMatch =
          typeof detail !== 'undefined' && detail && ('transaction_id' in detail || 'po_id' in detail)
            ? Boolean(detail.transaction_id || detail.po_id)
            : true;
        const sourceHasTxLineIds = sourceLines.some((ln: any) => ln.transaction_line_id != null);

        let srcLn: any = undefined;
        let sourceRefError: string | null = null;

        if (!isFromPoOnly && hasExplicitTxLineId && (sourceHasTxLineIds || !hasExplicitPoItemId)) {
          const targetLineId = Number(it.transaction_line_id);
          srcLn = sourceLines.find(
            (ln: any) =>
              ln.transaction_line_id != null &&
              Number(ln.transaction_line_id) === targetLineId
          );
          if (!srcLn && (requirePurchaseMatch || sourceLines.length > 0)) {
            sourceRefError = `Referensi baris pembelian sumber (#${targetLineId}) tidak ditemukan pada transaksi pembelian.`;
          }
        } else if (hasExplicitPoItemId) {
          const targetPoItemId = Number(it.po_item_id);
          srcLn = sourceLines.find(
            (ln: any) =>
              (ln.po_item_id != null && Number(ln.po_item_id) === targetPoItemId) ||
              (ln.id != null && ln.po_item_id == null && ln.transaction_line_id == null && Number(ln.id) === targetPoItemId)
          );
          if (!srcLn && (requirePurchaseMatch || sourceLines.length > 0)) {
            sourceRefError = `Referensi baris PO sumber (#${targetPoItemId}) tidak ditemukan pada PO.`;
          }
        } else if (requirePurchaseMatch || sourceLines.length > 0) {
          const candidates = sourceLines.filter(
            (ln: any) => Number(ln.product_id) === Number(it.product_id)
          );
          if (candidates.length === 1) {
            srcLn = candidates[0];
          } else if (candidates.length > 1) {
            sourceRefError = `Referensi baris sumber ambigu: terdapat ${candidates.length} baris pembelian untuk produk #${it.product_id} tanpa transaction_line_id/po_item_id eksplisit.`;
          } else {
            sourceRefError = `Referensi baris pembelian sumber untuk produk #${it.product_id} tidak ditemukan pada transaksi pembelian.`;
          }
        }

        const parsedQty = Number(it.received_qty);
        const parsedCost = Number(it.unit_cost ?? srcLn?.unit_cost ?? 0);
        const rawDraftFactor = Number(it.conversion_factor_snapshot ?? it.to_base_factor ?? 0);
        const factor = rawDraftFactor > 0 ? rawDraftFactor : Number(srcLn?.to_base_factor || 1);
        const resolvedPackagingId =
          it.packaging_id !== undefined && it.packaging_id !== null
            ? Number(it.packaging_id)
            : it.packaging_id === null && rawDraftFactor === 1
            ? null
            : srcLn?.packaging_id != null
            ? Number(srcLn.packaging_id)
            : null;
        const baseUnit =
          srcLn?.base_unit || it.canonical_base_unit_code || it.base_unit || 'UNIT';
        const resolvedPackagingLabel =
          resolvedPackagingId != null || factor > 1
            ? it.packaging_label || srcLn?.packaging_label || null
            : null;
        const orderedUnit =
          resolvedPackagingId == null && factor <= 1
            ? srcLn?.ordered_unit || it.ordered_unit || baseUnit
            : srcLn?.ordered_unit ||
              it.packaging_code ||
              it.ordered_unit ||
              (resolvedPackagingLabel
                ? String(resolvedPackagingLabel).replace(/^1\s+/i, '').split(/\s*\(/)[0].trim() ||
                  resolvedPackagingLabel
                : null) ||
              baseUnit;

        return {
          id: it.id != null ? Number(it.id) : undefined,
          product_id: String(it.product_id ?? srcLn?.product_id ?? ''),
          product_name: it.product_name || srcLn?.product_name || srcLn?.description_snapshot,
          po_item_id: hasExplicitPoItemId
            ? Number(it.po_item_id)
            : srcLn?.po_item_id != null
            ? Number(srcLn.po_item_id)
            : null,
          transaction_line_id: isFromPoOnly
            ? null
            : hasExplicitTxLineId
            ? Number(it.transaction_line_id)
            : srcLn?.transaction_line_id != null
            ? Number(srcLn.transaction_line_id)
            : null,
          packaging_id: resolvedPackagingId,
          packaging_label: resolvedPackagingLabel,
          to_base_factor: factor > 0 ? factor : 1,
          received_qty: !Number.isNaN(parsedQty) ? String(parsedQty) : String(it.received_qty || 0),
          unit_cost: !Number.isNaN(parsedCost) ? String(parsedCost) : String(it.unit_cost || 0),
          remaining_qty: srcLn?.remaining_qty,
          ordered_unit: orderedUnit,
          base_unit: baseUnit,
          source_ref_error: sourceRefError,
        };
      });
      const firstRefErr = mappedDraftLines.find((l: any) => l.source_ref_error)?.source_ref_error || null;
      if (typeof setErrorMsg === 'function') {
        setErrorMsg(firstRefErr);
      }
      setFormItems(mappedDraftLines);
      setSelectedGrn(null);
      setShowCreateModal(true);
    } catch (e: any) {
      alert(e?.message || 'Gagal memuat draft penerimaan untuk diedit');
    }
  };

  const handleSelectPoChange = async (poIdStr: string) => {
    const reqGen = contextGenRef.current;
    setSelectedPoId(poIdStr);
    if (!poIdStr) {
      setFormItems([]);
      return;
    }

    try {
      const preview =
        typeof fetchPurchaseOrderReceivablePreview === 'function'
          ? await fetchPurchaseOrderReceivablePreview(propertyId, Number(poIdStr)).catch(() => null)
          : null;
      if (contextGenRef.current !== reqGen) return;

      if (preview) {
        if (preview.po_id && typeof setActivePos === 'function') {
          setActivePos((prev) => {
            if (prev.some((p) => Number(p.id) === Number(preview.po_id))) return prev;
            return [
              {
                id: Number(preview.po_id),
                property_id: propertyId,
                po_number: preview.po_number || `PO-${preview.po_id}`,
                supplier_id: Number(preview.supplier_id || 0),
                supplier_name: preview.supplier_name || 'Vendor',
                order_date: preview.po_date || '',
                expected_date: null,
                status: (preview.status as any) || 'APPROVED',
                total_amount: '0',
                notes: null,
                created_by: null,
                created_at: '',
                updated_at: '',
              },
              ...prev,
            ];
          });
        }

        const activeDraftId = preview.active_draft_id
          ? Number(preview.active_draft_id)
          : preview.active_draft?.id
          ? Number(preview.active_draft.id)
          : null;
        if (typeof setEditingDraftId === 'function') {
          setEditingDraftId(activeDraftId);
        }

        const sourceLines = Array.isArray(preview.lines)
          ? preview.lines
          : Array.isArray(preview.items)
          ? preview.items
          : [];

        if (activeDraftId) {
          const draftDetail =
            typeof fetchGoodsReceiptById === 'function'
              ? await fetchGoodsReceiptById(propertyId, activeDraftId)
              : preview.active_draft;
          if (contextGenRef.current !== reqGen) return;
          const draft: any = draftDetail || preview.active_draft || {};
          const supId = draft.supplier_id ?? preview.supplier_id;
          if (supId) {
            setFormSupplierId(String(supId));
          }
          const invNo = draft.invoice_no || preview.active_draft?.invoice_no || preview.source_reference || '';
          if (invNo || !formInvoiceNo) {
            setFormInvoiceNo(invNo);
          }
          const locId = draft.location_id || preview.active_draft?.location_id || preview.default_location?.id;
          if (locId) {
            setFormLocationId(String(locId));
          }
          if (typeof setFormReceiptDate === 'function' && (draft.receipt_date || preview.active_draft?.receipt_date)) {
            setFormReceiptDate(formatDateOnly(draft.receipt_date || preview.active_draft?.receipt_date));
          }
          if (typeof setFormReceivedBy === 'function' && (draft.received_by || preview.active_draft?.received_by)) {
            setFormReceivedBy(String(draft.received_by || preview.active_draft?.received_by));
          }
          if (
            typeof setFormNotes === 'function' &&
            (draft.notes !== undefined || preview.active_draft?.notes !== undefined)
          ) {
            setFormNotes(String(draft.notes ?? preview.active_draft?.notes ?? ''));
          }

          const draftItems =
            Array.isArray(draft.items) && draft.items.length > 0
              ? draft.items
              : Array.isArray((preview.active_draft as any)?.items) && (preview.active_draft as any).items.length > 0
              ? (preview.active_draft as any).items
              : null;

          if (draftItems) {
            const lines = draftItems.map((it: any) => ({
              ...mapDraftItemWithPurchaseSource(
                it.po_item_id != null ? { ...it, transaction_line_id: null } : it,
                sourceLines,
                true
              ),
              transaction_line_id: null,
            }));
            const firstRefErr = lines.find((l: any) => l.source_ref_error)?.source_ref_error || null;
            if (typeof setErrorMsg === 'function') {
              setErrorMsg(firstRefErr);
            }
            setFormItems(lines);
            return;
          }
        }

        if (preview.supplier_id) {
          setFormSupplierId(String(preview.supplier_id));
        }
        if (preview.source_reference && !formInvoiceNo) {
          setFormInvoiceNo(preview.source_reference);
        }
        if (preview.default_location?.id) {
          setFormLocationId(String(preview.default_location.id));
        }
        const lines = sourceLines.map((ln) => ({
          product_id: String(ln.product_id),
          product_name: ln.product_name || ln.description_snapshot,
          po_item_id: ln.po_item_id ?? null,
          transaction_line_id: null,
          packaging_id: ln.packaging_id ?? null,
          packaging_label: ln.packaging_label ?? null,
          to_base_factor: Number(ln.to_base_factor || 1),
          received_qty: String(ln.remaining_qty > 0 ? ln.remaining_qty : 0),
          unit_cost: String(ln.unit_cost || 0),
          remaining_qty: ln.remaining_qty,
          ordered_unit: ln.ordered_unit,
          base_unit: ln.base_unit,
          track_stock: ln.track_stock,
          track_inventory: ln.track_inventory,
        }));
        setFormItems(lines);
        return;
      }

      const poDetail = await fetchPurchaseOrderById(propertyId, Number(poIdStr));
      if (contextGenRef.current !== reqGen) return;
      setFormSupplierId(String(poDetail.supplier_id));

      const lines = (poDetail.items || []).map((it) => {
        const ordered = parseFloat(String(it.ordered_qty ?? 0)) || 0;
        const received = parseFloat(String(it.received_qty ?? 0)) || 0;
        const remaining = Math.max(0, ordered - received);
        return {
          product_id: String(it.product_id),
          product_name: it.product_name,
          po_item_id: it.id,
          transaction_line_id: null,
          packaging_id: it.packaging_id ?? null,
          packaging_label: it.packaging_label ?? null,
          to_base_factor: Number(it.conversion_factor_snapshot || it.to_base_factor || 1),
          received_qty: String(remaining),
          unit_cost: String(it.unit_cost ?? 0),
          remaining_qty: remaining,
          ordered_unit: it.packaging_code || it.canonical_base_unit_code || it.base_unit || 'UNIT',
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

  // Submit GRN: Mode DRAFT vs POSTED (supports creating new or updating an existing DRAFT)
  const handleCreateSubmit = async (mode: 'DRAFT' | 'POSTED') => {
    if (!formLocationId) {
      alert('Pilih gudang penerimaan terlebih dahulu');
      return;
    }

    const brokenRefItem = formItems.find((it) => Boolean(it.source_ref_error));
    if (brokenRefItem?.source_ref_error) {
      alert(brokenRefItem.source_ref_error);
      return;
    }

    const validItems = formItems
      .filter((it) => Number(it.product_id) > 0 && parseFloat(it.received_qty) > 0)
      .map((it) => ({
        ...(it.id != null ? { id: Number(it.id) } : {}),
        product_id: Number(it.product_id),
        po_item_id: it.po_item_id ? Number(it.po_item_id) : null,
        transaction_line_id:
          receiptType === 'FROM_PURCHASE' && it.transaction_line_id
            ? Number(it.transaction_line_id)
            : null,
        packaging_id: it.packaging_id ? Number(it.packaging_id) : null,
        received_qty: parseFloat(it.received_qty),
        unit_cost: parseFloat(it.unit_cost || '0'),
      }));

    if (validItems.length === 0) {
      alert('Pastikan minimal terdapat 1 item dengan kuantitas penerimaan lebih dari 0');
      return;
    }

    setIsSubmitting(true);
    try {
      const isDraft = mode === 'DRAFT';

      if (editingDraftId) {
        const updated = await updateGoodsReceiptDraftApi(propertyId, editingDraftId, {
          supplier_id: formSupplierId ? Number(formSupplierId) : null,
          location_id: Number(formLocationId),
          receipt_date: formReceiptDate || undefined,
          invoice_no: formInvoiceNo || null,
          received_by: formReceivedBy || null,
          notes: formNotes || null,
          items: validItems,
        });

        if (!isDraft) {
          await postGoodsReceiptApi(propertyId, editingDraftId, formReceivedBy || 'Staf Gudang');
        }

        setShowCreateModal(false);
        setEditingDraftId(null);
        if (onClearPreselectedPo) onClearPreselectedPo();
        if (onClearPreselectedPoId) onClearPreselectedPoId();
        if (onClearPreselectedPurchaseTx) onClearPreselectedPurchaseTx();
        if (isDraft) {
          notifySuccess(`Perubahan draft penerimaan #${updated.grn_number} berhasil disimpan.`);
        } else {
          notifySuccess(
            `Draft #${updated.grn_number} berhasil diperbarui dan diposting! Saldo stok Gudang & biaya rata-rata diperbarui.`
          );
        }
        await loadReceipts();
        return;
      }

      const created = await createGoodsReceipt({
        property_id: propertyId,
        po_id: receiptType === 'FROM_PO' && selectedPoId ? Number(selectedPoId) : null,
        transaction_id:
          receiptType === 'FROM_PURCHASE' && selectedPurchaseTxId ? Number(selectedPurchaseTxId) : null,
        supplier_id: formSupplierId ? Number(formSupplierId) : null,
        location_id: Number(formLocationId),
        receipt_date: formReceiptDate || undefined,
        invoice_no: formInvoiceNo || null,
        received_by: formReceivedBy || null,
        notes: formNotes || null,
        idempotency_key: formActionKey || `grn-ui-${propertyId}-${Date.now()}`,
        operation_key: formActionKey || `grn-ui-${propertyId}-${Date.now()}`,
        is_draft: isDraft,
        status: isDraft ? 'DRAFT' : 'POSTED',
        items: validItems,
      });

      setShowCreateModal(false);
      setEditingDraftId(null);
      if (onClearPreselectedPo) onClearPreselectedPo();
      if (onClearPreselectedPoId) onClearPreselectedPoId();
      if (onClearPreselectedPurchaseTx) onClearPreselectedPurchaseTx();
      if (isDraft) {
        notifySuccess(`Draft penerimaan barang #${created.grn_number} berhasil disimpan tanpa merubah saldo stok.`);
      } else {
        notifySuccess(
          `Penerimaan barang #${created.grn_number} berhasil diposting! Saldo stok diperbarui dan Moving Average Cost telah dikalkulasi.`
        );
      }
      await loadReceipts();
    } catch (e: any) {
      alert(e?.message || 'Gagal mencatat penerimaan barang (GRN)');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Post Draft action directly
  const handlePostDraft = async (grnId: number) => {
    const confirmPost = window.confirm(
      'Posting draft penerimaan ini akan menambah kuantitas fisik stok gudang dan mengupdate moving average cost. Lanjutkan?'
    );
    if (!confirmPost) return;

    setActionLoadingId(grnId);
    try {
      await postGoodsReceiptApi(propertyId, grnId, 'Staf Gudang');
      notifySuccess('Draft penerimaan berhasil diposting ke kartu stok dan saldo ledger!');
      if (selectedGrn && selectedGrn.id === grnId) {
        setSelectedGrn(null);
      }
      await loadReceipts();
    } catch (err: any) {
      alert(err?.message || 'Gagal memposting draft penerimaan');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Cancel Draft action
  const handleCancelDraft = async (grnId: number) => {
    const reason = window.prompt('Masukkan alasan pembatalan draft penerimaan barang (opsional):');
    if (reason === null) return;

    setActionLoadingId(grnId);
    try {
      await cancelGoodsReceiptDraftApi(propertyId, grnId, reason || undefined);
      notifySuccess('Draft penerimaan barang berhasil dibatalkan.');
      if (selectedGrn && selectedGrn.id === grnId) {
        setSelectedGrn(null);
      }
      await loadReceipts();
    } catch (err: any) {
      alert(err?.message || 'Gagal membatalkan draft penerimaan');
    } finally {
      setActionLoadingId(null);
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
      {/* Context Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-gray-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wider bg-emerald-50 text-emerald-800 border border-emerald-200/60 uppercase">
              Manajemen Persediaan
            </span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs text-gray-500">Property #{propertyId || 1}</span>
          </div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Penerimaan Barang (GRN)</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Pencatatan fisik barang datang ke lokasi gudang (dari PO, Faktur Pembelian, atau Pembelian Langsung), pengelolaan draft, serta posting saldo stok &amp; biaya rata-rata (Moving Average Cost).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadReceipts()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-semibold transition-colors cursor-pointer"
            title="Refresh Data GRN"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {successMsg && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-900 text-xs flex items-center justify-between shadow-2xs">
          <div className="flex items-center gap-2">
            <span className="text-emerald-600 font-bold">✓</span>
            <span>{successMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            className="text-emerald-700 hover:text-emerald-950 font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Tab Navigation: Semua, Draft, Diposting */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-gray-200 shadow-2xs">
        <div className="flex items-center gap-1.5 p-1 bg-gray-100/90 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('ALL')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
              activeTab === 'ALL'
                ? 'bg-white text-[#1b4332] shadow-xs font-bold'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Semua Penerimaan
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('DRAFT')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
              activeTab === 'DRAFT'
                ? 'bg-white text-amber-800 shadow-xs font-bold'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            Draft
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('POSTED')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer ${
              activeTab === 'POSTED'
                ? 'bg-white text-emerald-800 shadow-xs font-bold'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Diposting
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Search Input */}
          <div className="relative min-w-[240px]">
            <input
              type="text"
              placeholder="Cari No. GRN, Invoice, Supplier..."
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
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-[#1b4332] hover:bg-[#143427] text-white text-xs font-bold shadow-2xs transition-colors cursor-pointer whitespace-nowrap"
          >
            <svg className="w-4 h-4 text-[#d4af37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            Catat Penerimaan Barang
          </button>
        </div>
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
                <th className="py-3 px-3 text-center">Status</th>
                <th className="py-3 px-4">Tanggal Terima</th>
                <th className="py-3 px-4">Terkait PO / Pembelian</th>
                <th className="py-3 px-4">Supplier &amp; Faktur</th>
                <th className="py-3 px-4">Lokasi Gudang</th>
                <th className="py-3 px-4">Penerima / Petugas</th>
                <th className="py-3 px-4 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-gray-400">
                    <div className="inline-block animate-spin w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full mb-2"></div>
                    <div>Memuat riwayat penerimaan barang...</div>
                  </td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-gray-400">
                    {activeTab === 'DRAFT'
                      ? 'Tidak ada draft penerimaan barang.'
                      : activeTab === 'POSTED'
                      ? 'Tidak ada penerimaan barang yang diposting.'
                      : 'Belum ada riwayat penerimaan barang (GRN).'}
                  </td>
                </tr>
              ) : (
                receipts.map((grn) => {
                  const isDraft = grn.status === 'DRAFT';
                  const isPosted = grn.status === 'POSTED' || grn.status === 'COMPLETED';
                  const isCancelled = grn.status === 'CANCELLED';
                  const isRowLoading = actionLoadingId === grn.id;

                  return (
                    <tr key={grn.id} className="hover:bg-emerald-50/30 transition-colors">
                      <td className="py-3 px-4 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void handleViewDetail(grn.id)}
                          className="font-mono font-bold text-[#1b4332] hover:text-emerald-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 rounded px-1 -mx-1 cursor-pointer transition-colors text-left"
                          title={`Lihat rincian ${grn.grn_number}`}
                        >
                          {grn.grn_number}
                        </button>
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        {isDraft && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            Draft
                          </span>
                        )}
                        {isPosted && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                            Diposting
                          </span>
                        )}
                        {isCancelled && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                            Dibatalkan
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-gray-600 whitespace-nowrap">{formatDateOnly(grn.receipt_date)}</td>
                      <td className="py-3 px-4">
                        {grn.po_number ? (
                          <span className="font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px] font-semibold border border-blue-200">
                            PO: {grn.po_number}
                          </span>
                        ) : grn.transaction_number ? (
                          <span className="font-mono px-2 py-0.5 rounded bg-purple-50 text-purple-700 text-[11px] font-semibold border border-purple-200">
                            Faktur: {grn.transaction_number}
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
                      <td className="py-3 px-4 text-gray-600">
                        <div>{grn.received_by || '-'}</div>
                        {grn.posted_by && isPosted && (
                          <div className="text-[10px] text-gray-400">Posted: {grn.posted_by}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {isDraft ? (
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              disabled={isRowLoading}
                              onClick={() => void openEditDraftModal(grn.id)}
                              className="px-2.5 py-1 rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 text-[10px] font-bold cursor-pointer transition-colors disabled:opacity-50"
                              title="Edit draft penerimaan barang"
                            >
                              Edit Draft
                            </button>
                            <button
                              type="button"
                              disabled={isRowLoading}
                              onClick={() => void handlePostDraft(grn.id)}
                              className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold cursor-pointer transition-colors shadow-2xs disabled:opacity-50"
                              title="Posting draft ke kartu stok dan saldo ledger"
                            >
                              {isRowLoading ? 'Memproses...' : 'Post'}
                            </button>
                            <button
                              type="button"
                              disabled={isRowLoading}
                              onClick={() => void handleCancelDraft(grn.id)}
                              className="px-2 py-1 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 text-[10px] font-semibold cursor-pointer transition-colors disabled:opacity-50"
                              title="Batalkan draft penerimaan"
                            >
                              Batalkan
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-gray-400 font-medium">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
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
                <h2 className="text-lg font-bold text-gray-900">
                  {editingDraftId
                    ? 'Edit Draft Penerimaan Barang (GRN)'
                    : 'Catat Penerimaan Barang (Goods Receipt Note)'}
                </h2>
                <p className="text-xs text-gray-500">
                  Verifikasi fisik barang masuk ke gudang — Simpan sebagai Draft atau langsung Posting ke saldo stok
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowCreateModal(false);
                  setEditingDraftId(null);
                  if (onClearPreselectedPo) onClearPreselectedPo();
                  if (onClearPreselectedPoId) onClearPreselectedPoId();
                  if (onClearPreselectedPurchaseTx) onClearPreselectedPurchaseTx();
                }}
                className="text-gray-400 hover:text-gray-600 p-1 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-4">
              {/* Receipt Source Mode (Tahap 1A: PO Wajib) */}
              <div className="flex flex-wrap items-center gap-3 p-2.5 bg-gray-50 rounded-xl border border-gray-200">
                <span className="text-xs font-bold text-gray-700 ml-1">Sumber Penerimaan:</span>
                <label className="flex items-center gap-1.5 text-xs text-gray-800 cursor-pointer font-medium">
                  <input
                    type="radio"
                    name="receiptType"
                    disabled={Boolean(editingDraftId)}
                    checked={receiptType === 'FROM_PO'}
                    onChange={() => {
                      if (typeof setErrorMsg === 'function') setErrorMsg(null);
                      setReceiptType('FROM_PO');
                      setSelectedPurchaseTxId('');
                      setFormItems([]);
                      if (activePos.length > 0) void handleSelectPoChange(String(activePos[0].id));
                    }}
                  />
                  Berdasarkan Purchase Order (PO Disetujui)
                </label>
                <label className="flex items-center gap-1.5 text-xs text-gray-800 cursor-pointer font-medium">
                  <input
                    type="radio"
                    name="receiptType"
                    disabled={Boolean(editingDraftId)}
                    checked={receiptType === 'FROM_PURCHASE'}
                    onChange={() => {
                      if (typeof setErrorMsg === 'function') setErrorMsg(null);
                      setReceiptType('FROM_PURCHASE');
                      setSelectedPoId('');
                      setFormItems([]);
                      if (approvedPurchases.length > 0) {
                        void handleSelectPurchaseTxChange(String(approvedPurchases[0].id));
                      }
                    }}
                  />
                  Berdasarkan Faktur/Nota Pembelian Terkait PO
                </label>
                <span className="ml-auto px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-[#1b4332] border border-emerald-200">
                  PO Disetujui Wajib (Tahap 1A)
                </span>
              </div>

              {/* Header Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-gray-50/70 p-3.5 rounded-xl border border-gray-200/80">
                {receiptType === 'FROM_PURCHASE' ? (
                  <div>
                    <label className="block text-[11px] font-bold text-gray-700 mb-1">
                      Pilih Transaksi Pembelian (APPROVED) <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={selectedPurchaseTxId}
                      disabled={Boolean(editingDraftId)}
                      onChange={(e) => void handleSelectPurchaseTxChange(e.target.value)}
                      required
                      className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332] disabled:bg-gray-100"
                    >
                      <option value="">-- Pilih Pembelian Disetujui --</option>
                      {approvedPurchases.map((tx) => (
                        <option key={tx.id} value={tx.id}>
                          {tx.transaction_no} ({tx.supplier_name || tx.party_name || 'Vendor'})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : receiptType === 'FROM_PO' ? (
                  <div>
                    <label className="block text-[11px] font-bold text-gray-700 mb-1">
                      Pilih Purchase Order (PO) <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={selectedPoId}
                      disabled={Boolean(editingDraftId)}
                      onChange={(e) => void handleSelectPoChange(e.target.value)}
                      required
                      className="w-full text-xs p-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#1b4332] disabled:bg-gray-100"
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
                    Rincian Item Barang Masuk
                  </h3>
                  {receiptType === 'DIRECT' && (
                    <button
                      type="button"
                      onClick={handleAddDirectItem}
                      className="text-xs text-[#1b4332] font-bold hover:underline cursor-pointer"
                    >
                      + Tambah Item Lain
                    </button>
                  )}
                </div>

                {formItems.some((it) => Boolean(it.source_ref_error)) && (
                  <div
                    data-testid="grn-source-ref-error-banner"
                    className="p-2.5 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 font-medium"
                  >
                    {formItems.find((it) => Boolean(it.source_ref_error))?.source_ref_error}
                  </div>
                )}

                {formItems.some((it) => {
                  const rm = rawMaterials.find((r) => Number(r.id) === Number(it.product_id));
                  const ts = it.track_stock ?? rm?.track_stock;
                  const ti = it.track_inventory ?? rm?.track_inventory;
                  return ts === false || ti === false;
                }) && (
                  <div
                    data-testid="grn-untracked-product-warning"
                    className="p-3 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-900 space-y-1"
                  >
                    <div className="font-bold text-amber-950">
                      ⚠ Produk pada dokumen ini belum diaktifkan untuk Pelacakan Stok &amp; Penerimaan Gudang (GRN)
                    </div>
                    <p className="text-[11px] text-amber-800 leading-relaxed">
                      Satu atau lebih item memiliki pengaturan <code className="font-mono font-bold">track_stock / track_inventory = false</code>.
                      Buka menu <strong>Master Barang &amp; Produk → Edit</strong> pada produk tersebut, centang{' '}
                      <strong>&ldquo;Lacak Stok &amp; Penerimaan Gudang (GRN)&rdquo;</strong>, lalu simpan sebelum melanjutkan Simpan Draft atau Post GRN.
                    </p>
                  </div>
                )}

                <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                  {formItems.length === 0 ? (
                    <div className="p-4 text-center text-xs text-gray-400 bg-gray-50 rounded-lg">
                      {receiptType === 'FROM_PURCHASE'
                        ? 'Pilih Transaksi Pembelian Disetujui terlebih dahulu atau seluruh item stok sudah selesai diterima.'
                        : receiptType === 'FROM_PO'
                        ? 'Pilih PO terlebih dahulu atau seluruh item PO sudah selesai diterima.'
                        : 'Belum ada item ditambahkan.'}
                    </div>
                  ) : (
                    formItems.map((item, idx) => {
                      const qtyNum = parseFloat(item.received_qty) || 0;
                      const rowSubtotal = qtyNum * (parseFloat(item.unit_cost) || 0);
                      const factor = Number(item.to_base_factor) || 1;
                      const baseQtyCalculated = Math.round(qtyNum * factor * 10000) / 10000;

                      return (
                        <div
                          key={idx}
                          className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center p-2.5 bg-gray-50/80 rounded-xl border border-gray-200"
                        >
                          <div className="sm:col-span-5">
                            <label className="block text-[10px] text-gray-500 mb-0.5">Nama Bahan Baku / Produk</label>
                            {receiptType === 'FROM_PO' || receiptType === 'FROM_PURCHASE' ? (
                              <div className="font-semibold text-xs text-gray-800 truncate">
                                {item.product_name}
                                {item.source_ref_error && (
                                  <span className="text-[10px] text-red-600 font-semibold block whitespace-normal">
                                    ⚠ {item.source_ref_error}
                                  </span>
                                )}
                                {item.remaining_qty !== undefined && (
                                  <span className="text-[10px] text-blue-600 block">
                                    Sisa Pesanan: {formatQty(item.remaining_qty)}{' '}
                                    {item.ordered_unit || item.packaging_label || item.base_unit || ''}
                                  </span>
                                )}
                                {factor > 1 && (
                                  <span className="text-[10px] text-emerald-700 font-mono block">
                                    Konversi: 1 {item.ordered_unit || item.packaging_label || 'Kemasan'} = {formatQty(factor)}{' '}
                                    {item.base_unit || 'Satuan Dasar'} (Stok masuk: {formatQty(baseQtyCalculated)}{' '}
                                    {item.base_unit || 'unit'})
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
                              Kuantitas Diterima Fisik{' '}
                              {item.ordered_unit || item.base_unit
                                ? `(${item.ordered_unit || item.base_unit})`
                                : ''}
                            </label>
                            <input
                              type="number"
                              step="any"
                              min="0"
                              max={
                                (receiptType === 'FROM_PO' || receiptType === 'FROM_PURCHASE') &&
                                item.remaining_qty
                                  ? item.remaining_qty
                                  : undefined
                              }
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
                                  className="text-red-500 hover:text-red-700 p-0.5 text-xs font-bold cursor-pointer"
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

              {/* Info Note on Draft vs Post */}
              <div className="p-3 bg-amber-50/70 border border-amber-200/80 rounded-xl text-xs text-amber-900 flex items-start gap-2">
                <span className="text-amber-600 font-bold text-base">ℹ</span>
                <div>
                  <span className="font-bold">Siklus Penerimaan Barang OAK HIMS:</span>
                  <div className="text-[11px] text-amber-800/90 mt-0.5">
                    <strong>Simpan Draft:</strong> Menyimpan dokumen penerimaan fisik tanpa memotong sisa pesanan atau mengubah saldo stok gudang.<br />
                    <strong>Post Penerimaan:</strong> Atomik mencatat stok masuk ke kartu stok (ledger), memperbarui saldo gudang, dan mengkalkulasi Weighted Moving Average Cost.
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

              {/* Modal Actions: Draft vs Post */}
              <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setEditingDraftId(null);
                  }}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100 rounded-xl cursor-pointer"
                >
                  Batal
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void handleCreateSubmit('DRAFT')}
                    className="px-4 py-2 text-xs font-bold text-amber-800 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-xl shadow-2xs disabled:opacity-50 cursor-pointer"
                  >
                    {isSubmitting ? 'Menyimpan...' : editingDraftId ? 'Simpan Perubahan Draft' : 'Simpan Sebagai Draft'}
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void handleCreateSubmit('POSTED')}
                    className="px-5 py-2 text-xs font-bold text-white bg-[#1b4332] hover:bg-[#143427] rounded-xl shadow-2xs disabled:opacity-50 cursor-pointer"
                  >
                    {isSubmitting ? 'Memproses...' : 'Post Penerimaan Sekarang'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          MODAL: Detail Goods Receipt Note
          ───────────────────────────────────────────────────────────────────────────── */}
      {selectedGrn && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-gray-200 animate-in fade-in duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-black text-[#1b4332]">{selectedGrn.grn_number}</span>
                {selectedGrn.status === 'DRAFT' && (
                  <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-300">
                    DRAFT (BELUM DIPOSTING)
                  </span>
                )}
                {(selectedGrn.status === 'POSTED' || selectedGrn.status === 'COMPLETED') && (
                  <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                    DIPOSTING (SELESAI)
                  </span>
                )}
                {selectedGrn.status === 'CANCELLED' && (
                  <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-50 text-rose-800 border border-rose-200">
                    DIBATALKAN
                  </span>
                )}
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
                <span className="text-gray-400 block text-[10px]">Terkait PO / Faktur:</span>
                <span className="font-mono font-semibold text-blue-700">
                  {selectedGrn.po_number || selectedGrn.transaction_number || 'Tanpa Referensi'}
                </span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Supplier:</span>
                <span className="font-semibold text-gray-800">{selectedGrn.supplier_name || '-'}</span>
              </div>
              <div>
                <span className="text-gray-400 block text-[10px]">Tanggal Terima:</span>
                <span className="font-semibold text-gray-800">{formatDateOnly(selectedGrn.receipt_date)}</span>
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
                          {formatQty(it.received_qty)}{' '}
                          {it.packaging_code || it.packaging_name || it.canonical_base_unit_code || it.base_unit || ''}
                          {(it.base_quantity ?? it.received_base_qty) != null &&
                            Number(it.base_quantity ?? it.received_base_qty) !== Number(it.received_qty) && (
                              <span className="block text-[10px] text-emerald-700">
                                (= {formatQty(it.base_quantity ?? it.received_base_qty)}{' '}
                                {it.canonical_base_unit_code || it.base_unit || 'unit dasar'})
                              </span>
                            )}
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
            <div className="mt-5 flex items-center justify-between pt-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setSelectedGrn(null)}
                className="px-4 py-2 border border-gray-200 text-gray-700 text-xs font-semibold rounded-xl hover:bg-gray-50 cursor-pointer"
              >
                Tutup
              </button>
              {selectedGrn.status === 'DRAFT' && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const idToEdit = selectedGrn.id;
                      setSelectedGrn(null);
                      void openEditDraftModal(idToEdit);
                    }}
                    className="px-3 py-1.5 border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-bold rounded-xl cursor-pointer"
                  >
                    Edit Draft
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCancelDraft(selectedGrn.id)}
                    className="px-3 py-1.5 border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold rounded-xl cursor-pointer"
                  >
                    Batalkan Draft
                  </button>
                  <button
                    type="button"
                    onClick={() => void handlePostDraft(selectedGrn.id)}
                    className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-2xs cursor-pointer"
                  >
                    Post Penerimaan Sekarang
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
