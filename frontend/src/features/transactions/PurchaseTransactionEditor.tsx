import React, { useState, useEffect } from 'react';
import type {
  Supplier,
  ReceivingStatus,
  TransactionRecord
} from './transactionDomainTypes';
import { toTransactionBusinessDateYmd } from './transactionDomainTypes';
import {
  fetchPurchaseFormOptionsApi,
  createPurchaseTransactionApi,
  updatePurchaseTransactionApi,
  fetchTransactionDetailApi,
  uploadTransactionAttachmentApi
} from './transactionClient';
import { SupplierSelectorModal } from './SupplierSelectorModal';
import { canSubmitPurchaseCreate, PURCHASE_FORM_OPTIONS_ERROR } from './purchaseEditorGuard';
import {
  getPurchaseFieldMode,
  isPurchaseFieldRequired,
  isPurchaseFieldVisible,
  isPurchaseLineUnitRequired,
  isPurchaseLineUnitVisible,
  isPurchasePayNowDetailVisible,
  type PurchaseFieldPolicy,
} from './purchaseFieldPolicy';
import {
  fetchRawMaterialCandidates,
  fetchProductPackagingsForGrn,
  fetchPurchaseOrders,
  fetchPurchaseOrderDetail,
  type RawMaterialCandidate,
  type ProductPackagingOption,
  type PosPurchaseOrder,
} from '../posInventory/posPurchaseOrderApi';

interface PurchaseLineItem {
  id: string;
  po_item_id?: number | null;
  po_ordered_qty?: number | null;
  po_unit_cost?: number | null;
  product_id?: number | string | null;
  packaging_id?: number | string | null;
  line_type?: 'STOCK_PRODUCT' | 'NON_STOCK_EXPENSE';
  received_quantity?: number;
  description_snapshot: string;
  quantity: number | string;
  unit: string;
  unit_price: number | string;
  discount_amount: number | string;
  line_total: number;
}

interface PurchaseTransactionEditorProps {
  propertyId: number;
  actorName?: string;
  onBack: () => void;
  onSuccess: (createdId: string | number) => void;
  onOpenDetail?: (transactionId: string | number) => void;
  editMode?: boolean;
  initialData?: TransactionRecord | null;
  initialPoId?: number | null;
}

interface PurchaseFormSnapshot {
  txDate: string;
  categoryId: number | '';
  departmentId: number | '';
  sourceRef: string;
  supplierId: number | null;
  notes: string;
  overallDiscount: number;
  roundingAmount: number;
  linesKey: string;
}

const buildLinesSnapshotKey = (items: PurchaseLineItem[]): string =>
  JSON.stringify(
    items.map((l) => ({
      id: l.id,
      po_item_id: l.po_item_id ? Number(l.po_item_id) : null,
      product_id: l.product_id ? Number(l.product_id) : null,
      packaging_id: l.packaging_id ? Number(l.packaging_id) : null,
      line_type: l.product_id ? 'STOCK_PRODUCT' : (l.line_type || 'NON_STOCK_EXPENSE'),
      description_snapshot: String(l.description_snapshot || '').trim(),
      quantity: Number(l.quantity) || 0,
      unit: String(l.unit || '').trim(),
      unit_price: Math.round(Number(l.unit_price) || 0),
      discount_amount: Math.round(Number(l.discount_amount) || 0),
    }))
  );

const toJakartaDateInput = (val?: string | Date | null): string => {
  const ymd = toTransactionBusinessDateYmd(val);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
};

export const PurchaseTransactionEditor: React.FC<PurchaseTransactionEditorProps> = ({
  propertyId,
  actorName = 'Staff',
  onBack,
  onSuccess,
  onOpenDetail,
  editMode = false,
  initialData = null,
  initialPoId = null,
}) => {
  const [categories, setCategories] = useState<Array<{ id: number; code: string; name: string }>>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; code: string; name: string }>>([]);
  const [stockProducts, setStockProducts] = useState<RawMaterialCandidate[]>([]);
  const [packagingsByProduct, setPackagingsByProduct] = useState<Record<number, ProductPackagingOption[]>>({});
  const [approvedPos, setApprovedPos] = useState<PosPurchaseOrder[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<number | ''>(initialPoId ? Number(initialPoId) : '');
  const [selectedPoDetail, setSelectedPoDetail] = useState<PosPurchaseOrder | null>(null);
  const [isLegacyWithoutPo, setIsLegacyWithoutPo] = useState<boolean>(false);

  // Form State
  const [txDate, setTxDate] = useState<string>(() =>
    toJakartaDateInput(editMode ? initialData?.transaction_date : undefined)
  );
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [departmentId, setDepartmentId] = useState<number | ''>('');
  const [sourceRef, setSourceRef] = useState<string>(''); // No Faktur / Nota
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [showSupplierModal, setShowSupplierModal] = useState<boolean>(false);
  const [receivingStatus, setReceivingStatus] = useState<ReceivingStatus>('BELUM_DITERIMA');
  const [notes, setNotes] = useState<string>('');

  // Multi-line Items
  const [lines, setLines] = useState<PurchaseLineItem[]>([
    {
      id: 'item-1',
      product_id: null,
      packaging_id: null,
      line_type: 'NON_STOCK_EXPENSE',
      received_quantity: 0,
      description_snapshot: '',
      quantity: 1,
      unit: 'kg',
      unit_price: 0,
      discount_amount: 0,
      line_total: 0
    }
  ]);

  // Overall Discount & Rounding
  const [overallDiscount, setOverallDiscount] = useState<number | string>(0);
  const [roundingAmount, setRoundingAmount] = useState<number | string>(0);

  // Settlement Option (default to Tempo / Belum Dibayar for PO-based invoice recording)
  const [isImmediatelyPaid, setIsImmediatelyPaid] = useState<boolean>(false);
  const [paymentMethod, setPaymentMethod] = useState<string>('');
  const [paidAmount, setPaidAmount] = useState<number | string>('');

  // Upload Evidence
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [paymentProofFile, setPaymentProofFile] = useState<File | null>(null);

  // Status
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [fieldPolicy, setFieldPolicy] = useState<PurchaseFieldPolicy | null>(null);
  const [loadedDetail, setLoadedDetail] = useState<TransactionRecord | null>(initialData);
  const [initialSnapshot, setInitialSnapshot] = useState<PurchaseFormSnapshot | null>(null);

  const ensureProductPackagings = async (prodId: number) => {
    if (!prodId || packagingsByProduct[prodId]) return;
    try {
      const pkgs = await fetchProductPackagingsForGrn(propertyId, prodId);
      setPackagingsByProduct((prev) => ({
        ...prev,
        [prodId]: pkgs.filter((p) => p.is_active !== false),
      }));
    } catch {
      // non-fatal
    }
  };

  const handleSelectPo = async (poIdVal: number | '') => {
    setSelectedPoId(poIdVal);
    if (!poIdVal) {
      setSelectedPoDetail(null);
      return;
    }
    try {
      const detail = await fetchPurchaseOrderDetail(propertyId, Number(poIdVal));
      setSelectedPoDetail(detail);
      const canonicalSupId = Number(detail.canonical_supplier_id || detail.supplier_id || 0);
      if (canonicalSupId > 0 || detail.supplier_name) {
        setSelectedSupplier({
          id: canonicalSupId,
          property_id: propertyId,
          code: detail.supplier_code || '',
          name: detail.supplier_name || `Supplier #${canonicalSupId}`,
          phone: detail.supplier_phone || null,
          bank_name: null,
          bank_account: null,
          address: null,
          is_active: true,
        });
      }
      if (detail.items && detail.items.length > 0) {
        detail.items.forEach((it: any) => {
          if (it.product_id && Number(it.product_id) > 0) {
            void ensureProductPackagings(Number(it.product_id));
          }
        });
        setLines(
          detail.items.map((it: any, idx: number) => {
            const q = Number(it.ordered_qty) || 1;
            const p = Math.round(Number(it.unit_cost) || 0);
            const unitLabel = it.ordered_unit || it.packaging_code || it.base_unit || 'PCS';
            return {
              id: `po-item-${it.id || idx + 1}`,
              po_item_id: Number(it.id),
              po_ordered_qty: q,
              po_unit_cost: p,
              product_id: Number(it.product_id),
              packaging_id: it.packaging_id !== undefined && it.packaging_id !== null ? Number(it.packaging_id) : null,
              line_type: 'STOCK_PRODUCT',
              received_quantity: Number(it.received_qty || 0),
              description_snapshot: it.product_name || `Produk #${it.product_id}`,
              quantity: q,
              unit: unitLabel,
              unit_price: p,
              discount_amount: 0,
              line_total: Math.round(q * p),
            };
          })
        );
      }
    } catch (err) {
      console.error('Failed to load PO detail for invoice editor:', err);
    }
  };

  useEffect(() => {
    loadCategories();
    fetchRawMaterialCandidates(propertyId)
      .then((list) => setStockProducts(Array.isArray(list) ? list : []))
      .catch(() => setStockProducts([]));
    fetchPurchaseOrders(propertyId)
      .then((res: any) => {
        const list = Array.isArray(res) ? res : Array.isArray(res?.orders) ? res.orders : [];
        const eligible = list.filter((po: any) =>
          ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'PARTIAL_RECEIVED', 'RECEIVED', 'COMPLETED'].includes(
            String(po.approval_status || po.status || '').toUpperCase()
          )
        );
        setApprovedPos(eligible);
      })
      .catch(() => setApprovedPos([]));
  }, [propertyId]);

  useEffect(() => {
    if (!editMode && initialPoId && Number(initialPoId) > 0) {
      void handleSelectPo(Number(initialPoId));
    }
  }, [editMode, initialPoId, propertyId]);

  useEffect(() => {
    if (editMode && initialData) {
      setLoadedDetail(initialData);
      fetchTransactionDetailApi(initialData.id, propertyId)
        .then((detail) => {
          setLoadedDetail(detail);
          const nextTxDate = detail.transaction_date
            ? toJakartaDateInput(detail.transaction_date)
            : toJakartaDateInput(initialData.transaction_date);
          const nextCategoryId: number | '' = detail.purchase_category_id ? Number(detail.purchase_category_id) : '';
          const nextDepartmentId: number | '' = detail.department_id ? Number(detail.department_id) : '';
          const nextSourceRef = detail.source_reference || '';
          const nextSupplierId = detail.supplier_id ? Number(detail.supplier_id) : null;
          const nextNotes = detail.notes || '';
          const nextOverallDiscount = detail.discount_amount !== undefined ? Number(detail.discount_amount) || 0 : 0;
          const nextRoundingAmount = detail.rounding_amount !== undefined ? Number(detail.rounding_amount) || 0 : 0;

          setTxDate(nextTxDate);
          if (detail.purchase_category_id) setCategoryId(nextCategoryId);
          if (detail.department_id) setDepartmentId(nextDepartmentId);
          setSourceRef(nextSourceRef);
          if (detail.po_id) {
            setSelectedPoId(Number(detail.po_id));
            fetchPurchaseOrderDetail(propertyId, Number(detail.po_id))
              .then((poDet: any) => setSelectedPoDetail(poDet))
              .catch(() => {});
          }
          setIsLegacyWithoutPo(Boolean(detail.is_legacy_without_po));
          if (detail.supplier_id || detail.party_name) {
            setSelectedSupplier({
              id: detail.supplier_id ? Number(detail.supplier_id) : 0,
              property_id: propertyId,
              code: '',
              name: detail.party_name || detail.supplier_name || '',
              phone: detail.supplier_phone || null,
              bank_name: detail.supplier_bank_name || null,
              bank_account: detail.supplier_bank_account || null,
              address: detail.supplier_address || null,
              is_active: true
            });
          }
          if (detail.receiving_status) setReceivingStatus(detail.receiving_status);
          setNotes(nextNotes);
          let nextLines: PurchaseLineItem[] = lines;
          if (detail.lines && detail.lines.length > 0) {
            detail.lines.forEach((l: any) => {
              if (l.product_id && Number(l.product_id) > 0) {
                void ensureProductPackagings(Number(l.product_id));
              }
            });
            nextLines = detail.lines.map((l: any, idx: number) => ({
              id: String(l.id || `item-${idx + 1}`),
              po_item_id: l.po_item_id !== undefined && l.po_item_id !== null ? Number(l.po_item_id) : null,
              product_id: l.product_id !== undefined && l.product_id !== null ? Number(l.product_id) : null,
              packaging_id: l.packaging_id !== undefined && l.packaging_id !== null ? Number(l.packaging_id) : null,
              line_type: l.line_type || (l.product_id ? 'STOCK_PRODUCT' : 'NON_STOCK_EXPENSE'),
              received_quantity: Number(l.received_quantity || 0),
              description_snapshot: l.description_snapshot || l.description || '',
              quantity: Number(l.quantity) || 1,
              unit: l.unit || 'kg',
              unit_price: Number(l.unit_price) || 0,
              discount_amount: Number(l.discount_amount) || 0,
              line_total: Number(l.line_total) || (Number(l.quantity) * Number(l.unit_price) - Number(l.discount_amount || 0))
            }));
            setLines(nextLines);
          }
          if (detail.discount_amount !== undefined) setOverallDiscount(detail.discount_amount);
          if (detail.rounding_amount !== undefined) setRoundingAmount(detail.rounding_amount);
          if (detail.payment_method) setPaymentMethod(detail.payment_method);
          setIsImmediatelyPaid(detail.payment_status === 'PAID');
          setInitialSnapshot({
            txDate: nextTxDate,
            categoryId: nextCategoryId,
            departmentId: nextDepartmentId,
            sourceRef: nextSourceRef.trim(),
            supplierId: nextSupplierId,
            notes: nextNotes.trim(),
            overallDiscount: nextOverallDiscount,
            roundingAmount: nextRoundingAmount,
            linesKey: buildLinesSnapshotKey(nextLines),
          });
        })
        .catch((err) => {
          console.error('Failed to load purchase detail for editing:', err);
        });
    }
  }, [editMode, initialData, propertyId]);

  const loadCategories = async () => {
    setOptionsLoading(true);
    setOptionsFailed(false);
    try {
      const data = await fetchPurchaseFormOptionsApi(propertyId);
      setCategories(data.categories);
      setDepartments(data.departments);
      setFieldPolicy(data.field_policy || null);
      setOptionsLoaded(true);
      const categoryHidden = getPurchaseFieldMode(data.field_policy, 'category') === 'HIDDEN';
      const departmentHidden = getPurchaseFieldMode(data.field_policy, 'department') === 'HIDDEN';
      if (!editMode) {
        if (categoryHidden) {
          setCategoryId('');
        } else if (data.categories.length > 0) {
          setCategoryId(data.categories[0].id);
        } else {
          setCategoryId('');
        }
        if (departmentHidden) {
          setDepartmentId('');
        } else if (data.departments.length > 0) {
          setDepartmentId(data.departments[0].id);
        } else {
          setDepartmentId('');
        }
        if (getPurchaseFieldMode(data.field_policy, 'payment_status') === 'HIDDEN') {
          setIsImmediatelyPaid(false);
        }
      } else {
        setCategoryId((prev) => {
          if (categoryHidden) return '';
          if (prev !== '') return prev;
          if (initialData?.purchase_category_id) return Number(initialData.purchase_category_id);
          return data.categories.length > 0 ? data.categories[0].id : '';
        });
        setDepartmentId((prev) => {
          if (departmentHidden) return '';
          if (prev !== '') return prev;
          if (initialData?.department_id) return Number(initialData.department_id);
          return '';
        });
      }
    } catch {
      setCategories([]);
      setDepartments([]);
      setCategoryId('');
      setDepartmentId('');
      setFieldPolicy(null);
      setOptionsLoaded(false);
      setOptionsFailed(true);
      setError(PURCHASE_FORM_OPTIONS_ERROR);
    } finally {
      setOptionsLoading(false);
    }
  };

  const canSubmit = canSubmitPurchaseCreate({
    optionsFailed,
    optionsLoaded,
    categories,
    categoryId,
    fieldPolicy
  });
  const vis = (key: Parameters<typeof isPurchaseFieldVisible>[1]) => isPurchaseFieldVisible(fieldPolicy, key);
  const req = (key: Parameters<typeof isPurchaseFieldRequired>[1]) => isPurchaseFieldRequired(fieldPolicy, key);

  // Line item manipulation
  const updateLine = (id: string, field: keyof PurchaseLineItem, val: any) => {
    setLines((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, [field]: val };
        const q = Number(updated.quantity) || 0;
        const p = Number(updated.unit_price) || 0;
        const d = Number(updated.discount_amount) || 0;
        const gross = Math.round(q * p);
        updated.line_total = Math.max(0, gross - d);
        return updated;
      })
    );
  };

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      {
        id: `item-${Date.now()}`,
        product_id: null,
        packaging_id: null,
        line_type: 'NON_STOCK_EXPENSE',
        received_quantity: 0,
        description_snapshot: '',
        quantity: 1,
        unit: '',
        unit_price: 0,
        discount_amount: 0,
        line_total: 0
      }
    ]);
  };

  const handleSelectLineProduct = (lineId: string, productIdStr: string) => {
    const prodId = productIdStr ? Number(productIdStr) : null;
    const prod = prodId ? stockProducts.find((p) => Number(p.id) === prodId) : null;
    if (prodId) {
      void ensureProductPackagings(prodId);
    }
    setLines((prev) =>
      prev.map((item) => {
        if (item.id !== lineId) return item;
        if (!prodId || !prod) {
          return {
            ...item,
            product_id: null,
            packaging_id: null,
            line_type: 'NON_STOCK_EXPENSE',
          };
        }
        const defaultUnit = prod.canonical_base_unit_code || prod.base_unit || item.unit || 'PCS';
        const defaultCost = Number(prod.last_cost || prod.average_cost || 0);
        const nextPrice = Number(item.unit_price) > 0 ? item.unit_price : (defaultCost > 0 ? Math.round(defaultCost) : item.unit_price);
        const q = Number(item.quantity) || 1;
        const p = Number(nextPrice) || 0;
        const d = Number(item.discount_amount) || 0;
        return {
          ...item,
          product_id: prodId,
          packaging_id: null,
          line_type: 'STOCK_PRODUCT',
          description_snapshot: item.description_snapshot.trim() ? item.description_snapshot : prod.name,
          unit: defaultUnit,
          unit_price: nextPrice,
          line_total: Math.max(0, Math.round(q * p) - d),
        };
      })
    );
  };

  const handleSelectLinePackaging = (lineId: string, packagingIdStr: string) => {
    const pkgId = packagingIdStr ? Number(packagingIdStr) : null;
    setLines((prev) =>
      prev.map((item) => {
        if (item.id !== lineId) return item;
        const prodId = item.product_id ? Number(item.product_id) : 0;
        const prod = prodId ? stockProducts.find((p) => Number(p.id) === prodId) : null;
        const pkgs = prodId ? (packagingsByProduct[prodId] || []) : [];
        const pkg = pkgId ? pkgs.find((k) => Number(k.id) === pkgId) : null;
        const nextUnit = pkg
          ? pkg.packaging_code
          : (prod?.canonical_base_unit_code || prod?.base_unit || item.unit);
        return {
          ...item,
          packaging_id: pkgId,
          unit: nextUnit || item.unit,
        };
      })
    );
  };

  const removeLine = (id: string) => {
    if (lines.length <= 1) return;
    setLines((prev) => prev.filter((item) => item.id !== id));
  };

  // Total Math
  const linesSubtotal = lines.reduce((acc, curr) => acc + (curr.line_total || 0), 0);
  const numOverallDiscount = Number(overallDiscount) || 0;
  const numRounding = Number(roundingAmount) || 0;
  const grandTotal = Math.max(0, linesSubtotal - numOverallDiscount + numRounding);

  const effectivePaid = isImmediatelyPaid
    ? (paidAmount !== '' ? Number(paidAmount) || 0 : grandTotal)
    : 0;

  // Saved transaction payment summary (read-only in editMode)
  const savedTotalTagihan = Number(loadedDetail?.net_amount ?? initialData?.net_amount ?? 0);
  const savedTelahDibayar = Number(loadedDetail?.paid_amount ?? initialData?.paid_amount ?? 0);
  const rawSavedSisa =
    loadedDetail?.outstanding_amount ??
    (loadedDetail as any)?.balance_amount ??
    initialData?.outstanding_amount ??
    (initialData as any)?.balance_amount;
  const savedSisaTagihan =
    rawSavedSisa !== undefined && rawSavedSisa !== null
      ? Math.max(0, Number(rawSavedSisa) || 0)
      : Math.max(0, savedTotalTagihan - savedTelahDibayar);
  const savedPaymentStatus = loadedDetail?.payment_status ?? initialData?.payment_status ?? 'UNPAID';

  // Dirty check for unsaved changes in editMode
  const isDirty = Boolean(
    editMode &&
      initialSnapshot &&
      (txDate !== initialSnapshot.txDate ||
        (categoryId !== initialSnapshot.categoryId && !(initialSnapshot.categoryId === '' && categories.length > 0 && categoryId === categories[0]?.id)) ||
        departmentId !== initialSnapshot.departmentId ||
        sourceRef.trim() !== initialSnapshot.sourceRef ||
        (selectedSupplier?.id ?? null) !== initialSnapshot.supplierId ||
        notes.trim() !== initialSnapshot.notes ||
        numOverallDiscount !== initialSnapshot.overallDiscount ||
        numRounding !== initialSnapshot.roundingAmount ||
        buildLinesSnapshotKey(lines) !== initialSnapshot.linesKey)
  );

  const confirmDiscardIfDirty = (): boolean => {
    if (!isDirty) return true;
    return window.confirm('Perubahan pada form belum disimpan. Lanjutkan dan abaikan perubahan yang belum disimpan?');
  };

  const handleBackClick = () => {
    if (!confirmDiscardIfDirty()) return;
    onBack();
  };

  const handleOpenDetailClick = () => {
    const targetId = loadedDetail?.id ?? initialData?.id;
    if (targetId === undefined || targetId === null) return;
    if (!confirmDiscardIfDirty()) return;
    if (onOpenDetail) {
      onOpenDetail(targetId);
    }
  };

  // Detect live PO vs Invoice variance
  const livePoVarianceMessages = lines.reduce<string[]>((acc, l) => {
    if (l.po_item_id && selectedPoDetail?.items) {
      const poIt = selectedPoDetail.items.find((pi) => Number(pi.id) === Number(l.po_item_id));
      if (poIt) {
        const poQty = Number(poIt.ordered_qty) || 0;
        const poCost = Math.round(Number(poIt.unit_cost) || 0);
        const invQty = Number(l.quantity) || 0;
        const invCost = Math.round(Number(l.unit_price) || 0);
        if (Math.abs(invQty - poQty) > 0.0001) {
          acc.push(`${l.description_snapshot || poIt.product_name}: Qty Nota ${invQty} vs PO ${poQty}`);
        }
        if (Math.abs(invCost - poCost) > 0.5) {
          acc.push(`${l.description_snapshot || poIt.product_name}: Harga Nota Rp${invCost.toLocaleString('id-ID')} vs PO Rp${poCost.toLocaleString('id-ID')}`);
        }
      }
    }
    return acc;
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editMode && !selectedPoId) {
      setError('Tahap 1A: Pencatatan tagihan/pembelian baru wajib mengacu pada Purchase Order (PO) yang sudah disetujui.');
      return;
    }
    if (!canSubmit) {
      setError(optionsFailed ? PURCHASE_FORM_OPTIONS_ERROR : 'Kategori pembelian wajib dipilih');
      return;
    }
    if (isPurchaseFieldRequired(fieldPolicy, 'supplier') && !selectedSupplier) {
      setError('Supplier / Vendor wajib dipilih');
      return;
    }
    if (isPurchaseFieldRequired(fieldPolicy, 'department') && !departmentId) {
      setError('Departemen alokasi wajib dipilih');
      return;
    }
    if (isPurchaseFieldRequired(fieldPolicy, 'invoice_reference') && !sourceRef.trim()) {
      setError('No. faktur supplier wajib diisi');
      return;
    }
    if (isPurchaseFieldRequired(fieldPolicy, 'notes') && !notes.trim()) {
      setError('Catatan pembelian wajib diisi');
      return;
    }

    const validLines = lines.filter((l) => l.description_snapshot.trim() !== '');
    if (validLines.length === 0) {
      setError('Minimal satu rincian item pembelian harus diisi');
      return;
    }
    if (validLines.some((l) => !String(l.unit || '').trim())) {
      setError('Satuan item wajib diisi');
      return;
    }
    const paymentHidden = !isPurchaseFieldVisible(fieldPolicy, 'payment_status');
    const payNow = editMode || paymentHidden ? false : isImmediatelyPaid;
    if (!editMode && payNow && !String(paymentMethod || '').trim()) {
      setError('Metode pembayaran wajib dipilih');
      return;
    }
    if (!editMode && payNow && isPurchasePayNowDetailVisible(fieldPolicy) && isPurchaseFieldRequired(fieldPolicy, 'paid_amount') && paidAmount === '') {
      setError('Nominal dibayarkan wajib diisi');
      return;
    }
    if (!editMode && isPurchaseFieldRequired(fieldPolicy, 'receipt_attachment') && !invoiceFile) {
      setError('Bukti Nota / Struk wajib diunggah');
      return;
    }
    if (!editMode && payNow && isPurchaseFieldRequired(fieldPolicy, 'payment_evidence') && !paymentProofFile) {
      setError('Bukti Bayar / Transfer wajib diunggah');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const dept = departments.find((d) => d.id === departmentId);
      const categoryHidden = !isPurchaseFieldVisible(fieldPolicy, 'category');
      const departmentHidden = !isPurchaseFieldVisible(fieldPolicy, 'department');
      const supplierHidden = !isPurchaseFieldVisible(fieldPolicy, 'supplier');
      const payNowDetailsVisible = isPurchasePayNowDetailVisible(fieldPolicy);

      if (editMode && initialData) {
        const updated = await updatePurchaseTransactionApi(initialData.id, {
          property_id: propertyId,
          po_id: selectedPoId ? Number(selectedPoId) : undefined,
          transaction_date: txDate,
          purchase_category_id: categoryHidden ? undefined : (categoryId || undefined),
          department_id: departmentHidden ? undefined : (departmentId || undefined),
          department_code: departmentHidden ? undefined : dept?.code,
          supplier_id: supplierHidden ? undefined : selectedSupplier?.id,
          source_reference: isPurchaseFieldVisible(fieldPolicy, 'invoice_reference') ? (sourceRef.trim() || null) : null,
          discount_amount: isPurchaseFieldVisible(fieldPolicy, 'transaction_discount') ? numOverallDiscount : 0,
          rounding_amount: numRounding,
          lines: validLines.map((l) => ({
            id: /^\d+$/.test(l.id) ? Number(l.id) : null,
            po_item_id: l.po_item_id ? Number(l.po_item_id) : null,
            product_id: l.product_id ? Number(l.product_id) : null,
            packaging_id: l.packaging_id ? Number(l.packaging_id) : null,
            line_type: l.product_id ? 'STOCK_PRODUCT' : (l.line_type || 'NON_STOCK_EXPENSE'),
            description_snapshot: l.description_snapshot.trim(),
            quantity: Number(l.quantity) || 1,
            unit: String(l.unit || '').trim(),
            unit_price: Math.round(Number(l.unit_price) || 0),
            discount_amount: isPurchaseFieldVisible(fieldPolicy, 'line_discount')
              ? Math.round(Number(l.discount_amount) || 0)
              : 0
          })),
          notes: isPurchaseFieldVisible(fieldPolicy, 'notes') ? (notes.trim() || null) : null,
          actor_name: actorName
        });
        onSuccess(updated.id);
        return;
      }

      const created = await createPurchaseTransactionApi({
        property_id: propertyId,
        po_id: selectedPoId ? Number(selectedPoId) : null,
        transaction_date: txDate,
        purchase_category_id: categoryHidden ? undefined : (categoryId || undefined),
        department_id: departmentHidden ? undefined : (departmentId || undefined),
        department_code: departmentHidden ? undefined : dept?.code,
        supplier_id: supplierHidden ? undefined : selectedSupplier?.id,
        source_reference: isPurchaseFieldVisible(fieldPolicy, 'invoice_reference') ? (sourceRef.trim() || null) : null,
        receiving_status: validLines.some((l) => Boolean(l.product_id))
          ? undefined
          : (isPurchaseFieldVisible(fieldPolicy, 'receiving_status') ? receivingStatus : undefined),
        discount_amount: isPurchaseFieldVisible(fieldPolicy, 'transaction_discount') ? numOverallDiscount : 0,
        rounding_amount: numRounding,
        lines: validLines.map((l) => ({
          po_item_id: l.po_item_id ? Number(l.po_item_id) : null,
          product_id: l.product_id ? Number(l.product_id) : null,
          packaging_id: l.packaging_id ? Number(l.packaging_id) : null,
          line_type: l.product_id ? 'STOCK_PRODUCT' : (l.line_type || 'NON_STOCK_EXPENSE'),
          description_snapshot: l.description_snapshot.trim(),
          quantity: Number(l.quantity) || 1,
          unit: String(l.unit || '').trim(),
          unit_price: Math.round(Number(l.unit_price) || 0),
          discount_amount: isPurchaseFieldVisible(fieldPolicy, 'line_discount')
            ? Math.round(Number(l.discount_amount) || 0)
            : 0
        })),
        is_immediately_paid: payNow,
        payment_method: payNow && payNowDetailsVisible ? paymentMethod.trim() : undefined,
        paid_amount: payNow && payNowDetailsVisible ? effectivePaid : undefined,
        notes: isPurchaseFieldVisible(fieldPolicy, 'notes') ? (notes.trim() || null) : null,
        actor_name: actorName
      });

      const uploadErrors: string[] = [];
      if (invoiceFile && isPurchaseFieldVisible(fieldPolicy, 'receipt_attachment')) {
        try {
          await uploadTransactionAttachmentApi(
            created.id,
            propertyId,
            invoiceFile,
            'RECEIPT',
            actorName
          );
        } catch (err: any) {
          uploadErrors.push(err.message || 'Gagal mengunggah bukti nota / struk');
        }
      }

      if (paymentProofFile && payNow && isPurchaseFieldVisible(fieldPolicy, 'payment_evidence')) {
        try {
          await uploadTransactionAttachmentApi(
            created.id,
            propertyId,
            paymentProofFile,
            'PAYMENT_PROOF',
            actorName
          );
        } catch (err: any) {
          uploadErrors.push(err.message || 'Gagal mengunggah bukti pembayaran');
        }
      }

      if (uploadErrors.length > 0) {
        setError(`Transaksi tersimpan, tetapi lampiran gagal: ${uploadErrors.join('; ')}`);
        setSubmitting(false);
        onSuccess(created.id);
        return;
      }

      onSuccess(created.id);
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan transaksi pembelian');
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Top Bar Header */}
      <div className="flex items-center justify-between border-b border-slate-200/80 pb-4 bg-white px-6 py-4 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleBackClick}
            className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div>
            <h2 className="text-lg font-bold text-slate-800">{editMode ? 'Edit / Revisi Pembelian' : 'Transaksi Pembelian Operasional'}</h2>
            <p className="text-xs text-slate-500">
              Catat pembelian bahan makanan, perlengkapan kamar, amenitas, atau inventaris operasional hotel
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-start gap-2.5">
          <svg className="w-5 h-5 flex-shrink-0 text-rose-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div className="flex-1">
            <div className="font-bold">{optionsFailed ? 'Gagal Memuat Form Pembelian' : 'Gagal Menyimpan Transaksi'}</div>
            <div>{error}</div>
          </div>
          {optionsFailed && (
            <button
              type="button"
              onClick={() => { setError(null); loadCategories(); }}
              disabled={optionsLoading}
              className="px-3 py-1.5 text-xs font-bold bg-white border border-rose-300 rounded-lg text-rose-800 hover:bg-rose-50 disabled:opacity-50"
            >
              {optionsLoading ? 'Memuat…' : 'Muat ulang'}
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section 1: Header Info & Supplier */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
            <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
            1. Referensi Purchase Order (PO) &amp; Informasi Supplier
          </h3>

          {/* Tahap 1A: Mandatory Approved PO Reference */}
          <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-xs font-bold text-[#1b4332]">
                Acuan Purchase Order (PO Disetujui) {!isLegacyWithoutPo && <span className="text-rose-500">*</span>}
              </label>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white text-[#1b4332] border border-emerald-300">
                {isLegacyWithoutPo ? 'Transaksi Baseline Lama (Tanpa PO)' : 'Otorisasi Pengadaan dari PO Disetujui'}
              </span>
            </div>
            {isLegacyWithoutPo && editMode ? (
              <div className="text-xs text-slate-600">
                Transaksi ini merupakan data historis/baseline lama sebelum kewajiban PO Tahap 1A.
              </div>
            ) : (
              <select
                value={selectedPoId}
                disabled={editMode && Boolean(selectedPoId)}
                onChange={(e) => void handleSelectPo(e.target.value ? Number(e.target.value) : '')}
                required={!editMode}
                className="w-full px-3 py-2 text-xs bg-white border border-emerald-300 rounded-xl focus:border-emerald-700 outline-none font-semibold text-slate-800 disabled:bg-slate-100"
              >
                <option value="">-- Pilih Purchase Order (PO Disetujui) --</option>
                {approvedPos.map((po) => (
                  <option key={po.id} value={po.id}>
                    {po.po_number} • {po.supplier_name || 'Tanpa Supplier'} • Rp {Math.round(Number(po.total_amount || 0)).toLocaleString('id-ID')} ({po.receiving_status === 'DITERIMA_LENGKAP' ? 'Diterima Lengkap' : po.receiving_status === 'DITERIMA_SEBAGIAN' ? 'Diterima Sebagian' : 'Belum Diterima'})
                  </option>
                ))}
              </select>
            )}
            {selectedPoDetail && (
              <div className="text-[11px] text-emerald-900 flex flex-wrap items-center gap-3 pt-1">
                <span><strong>No. PO:</strong> {selectedPoDetail.po_number}</span>
                <span>•</span>
                <span><strong>Status PO:</strong> Disetujui ({selectedPoDetail.approved_by || 'Authorized'})</span>
                <span>•</span>
                <span><strong>Batas Penerimaan:</strong> Satu kuota kumulatif bersama GRN PO</span>
              </div>
            )}
          </div>

          {livePoVarianceMessages.length > 0 && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-xs space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <span>⚠</span>
                <span>Selisih PO vs Nota Terdeteksi (Akan Dicatat untuk Pemeriksaan Tagihan)</span>
              </div>
              <ul className="list-disc list-inside text-[11px] text-amber-800 space-y-0.5">
                {livePoVarianceMessages.map((msg, idx) => (
                  <li key={idx}>{msg}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Supplier Picker */}
            {vis('supplier') && (
            <div className={vis('supplier') ? 'md:col-span-2' : ''}>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Supplier / Vendor {req('supplier') && <span className="text-rose-500">*</span>}
              </label>
              {selectedSupplier ? (
                <div className="p-3 bg-emerald-50/60 border border-emerald-300 rounded-xl flex items-center justify-between">
                  <div>
                    <div className="font-bold text-xs text-emerald-900 flex items-center gap-2">
                      <span>{selectedSupplier.name}</span>
                      {selectedSupplier.phone && (
                        <span className="font-normal text-emerald-700">• {selectedSupplier.phone}</span>
                      )}
                    </div>
                    {selectedSupplier.bank_account && (
                      <div className="text-[11px] text-emerald-700">
                        {selectedSupplier.bank_name} {selectedSupplier.bank_account} (a/n {selectedSupplier.bank_holder})
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSupplierModal(true)}
                    className="px-3 py-1.5 bg-white text-emerald-800 border border-emerald-300 text-xs font-bold rounded-lg hover:bg-emerald-50 transition-colors"
                  >
                    Ganti
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSupplierModal(true)}
                  className="w-full py-3 px-4 border-2 border-dashed border-slate-300 hover:border-emerald-500 rounded-xl text-slate-600 hover:text-emerald-700 text-xs font-bold flex items-center justify-center gap-2 transition-all bg-slate-50/50 hover:bg-emerald-50/30"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  Pilih / Tambah Rekanan Vendor
                </button>
              )}
            </div>
            )}

            {/* Tanggal */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Tanggal Pembelian <span className="text-rose-500">*</span>
              </label>
              <input
                type="date"
                required
                value={txDate}
                onChange={(e) => setTxDate(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            {vis('category') && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Kategori Pembelian {req('category') && <span className="text-rose-500">*</span>}
              </label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')}
                disabled={optionsFailed || optionsLoading || categories.length === 0}
                required={req('category')}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none font-semibold text-slate-700 disabled:opacity-60"
              >
                {categories.length === 0 && <option value="">Pilih kategori</option>}
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            )}

            {vis('department') && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Departemen Alokasi {req('department') && <span className="text-rose-500">*</span>}
              </label>
              <select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : '')}
                required={req('department')}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none font-semibold text-slate-700"
              >
                {departments.length === 0 && <option value="">Tidak ada departemen aktif</option>}
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            )}

            {vis('invoice_reference') && (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                No. Faktur / Nota Supplier {req('invoice_reference') && <span className="text-rose-500">*</span>}
              </label>
              <input
                type="text"
                placeholder="INV-2026-XXXX / Nota #123"
                value={sourceRef}
                onChange={(e) => setSourceRef(e.target.value)}
                required={req('invoice_reference')}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
              />
            </div>
            )}
          </div>
        </div>

        {/* Section 2: Multi-line Items Table */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              2. Rincian Barang / Produk
            </h3>
            <button
              type="button"
              onClick={addLine}
              className="px-3 py-1.5 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-200 text-xs font-bold rounded-xl flex items-center gap-1.5 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              + Tambah Baris
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase bg-slate-50">
                  <th className="py-2.5 px-2 min-w-[190px]">Produk Inventori / Kemasan</th>
                  <th className="py-2.5 px-3 min-w-[200px]">Nama Barang / Deskripsi</th>
                  <th className="py-2.5 px-2 w-24">Jumlah (Qty)</th>
                  {isPurchaseLineUnitVisible() && <th className="py-2.5 px-2 w-24">Satuan {isPurchaseLineUnitRequired() && <span className="text-rose-500">*</span>}</th>}
                  <th className="py-2.5 px-2 w-36 text-right">Harga Satuan (Rp)</th>
                  {vis('line_discount') && <th className="py-2.5 px-2 w-28 text-right">Diskon (Rp) {req('line_discount') && <span className="text-rose-500">*</span>}</th>}
                  <th className="py-2.5 px-3 w-36 text-right">Total (Rp)</th>
                  <th className="py-2.5 px-2 w-10 text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((item) => {
                  const prodIdNum = item.product_id ? Number(item.product_id) : 0;
                  const pkgOptions = prodIdNum ? (packagingsByProduct[prodIdNum] || []) : [];
                  const hasReceived = Number(item.received_quantity || 0) > 0;
                  return (
                  <tr key={item.id} className="hover:bg-slate-50/60">
                    <td className="py-2 px-2 space-y-1">
                      <select
                        value={item.product_id ?? ''}
                        disabled={hasReceived}
                        onChange={(e) => handleSelectLineProduct(item.id, e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-[11px] font-medium disabled:opacity-60"
                      >
                        <option value="">-- Non-Stok / Bebas --</option>
                        {stockProducts.map((sp) => (
                          <option key={sp.id} value={sp.id}>
                            {sp.item_code ? `[${sp.item_code}] ` : ''}{sp.name} ({sp.canonical_base_unit_code || sp.base_unit || 'PCS'})
                          </option>
                        ))}
                      </select>
                      {prodIdNum > 0 && pkgOptions.length > 0 && (
                        <select
                          value={item.packaging_id ?? ''}
                          disabled={hasReceived}
                          onChange={(e) => handleSelectLinePackaging(item.id, e.target.value)}
                          className="w-full px-2 py-1 bg-amber-50/70 border border-amber-200 text-amber-900 rounded-lg focus:bg-white focus:border-amber-600 outline-none text-[10px] font-semibold disabled:opacity-60"
                        >
                          <option value="">Satuan Dasar Produk</option>
                          {pkgOptions.map((pk) => (
                            <option key={pk.id} value={pk.id}>
                              {pk.packaging_label} ({pk.packaging_code} = {Number(pk.to_base_factor)} {pk.base_unit_code})
                            </option>
                          ))}
                        </select>
                      )}
                      {hasReceived && (
                        <div className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded inline-block">
                          Sudah Diterima: {Number(item.received_quantity)}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="text"
                        required
                        placeholder="Contoh: Beras Premium Pandan Wangi"
                        value={item.description_snapshot}
                        onChange={(e) => updateLine(item.id, 'description_snapshot', e.target.value)}
                        className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        min={hasReceived ? Number(item.received_quantity) : 0.001}
                        step="any"
                        required
                        value={item.quantity}
                        onChange={(e) => updateLine(item.id, 'quantity', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs font-mono font-bold"
                      />
                    </td>
                    {isPurchaseLineUnitVisible() && (
                    <td className="py-2 px-2">
                      <input
                        type="text"
                        placeholder="kg / karung / liter"
                        required={isPurchaseLineUnitRequired()}
                        disabled={hasReceived}
                        value={item.unit}
                        onChange={(e) => updateLine(item.id, 'unit', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs disabled:opacity-60"
                      />
                    </td>
                    )}
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={item.unit_price}
                        onChange={(e) => updateLine(item.id, 'unit_price', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs text-right font-mono font-bold"
                      />
                    </td>
                    {vis('line_discount') && (
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required={req('line_discount')}
                        value={item.discount_amount}
                        onChange={(e) => updateLine(item.id, 'discount_amount', e.target.value)}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-emerald-600 outline-none text-xs text-right font-mono"
                      />
                    </td>
                    )}
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-800">
                      Rp {item.line_total.toLocaleString('id-ID')}
                    </td>
                    <td className="py-2 px-2 text-center">
                      <button
                        type="button"
                        disabled={lines.length <= 1 || hasReceived}
                        onClick={() => removeLine(item.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-20 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Subtotals and Grand Total Math */}
          <div className="pt-4 border-t border-slate-100 flex flex-col md:flex-row justify-between items-start gap-4">
            <div className="w-full md:w-1/2 space-y-3">
              {vis('receiving_status') && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Status Penerimaan Fisik Barang
                </label>
                <div className="p-3 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <span
                      className={`inline-flex items-center text-xs font-bold px-2.5 py-1 rounded-lg border ${
                        receivingStatus === 'DITERIMA' || receivingStatus === 'DITERIMA_LENGKAP'
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                          : receivingStatus === 'DITERIMA_SEBAGIAN'
                          ? 'bg-amber-50 border-amber-300 text-amber-800'
                          : 'bg-slate-200/70 border-slate-300 text-slate-700'
                      }`}
                    >
                      {receivingStatus === 'DITERIMA' || receivingStatus === 'DITERIMA_LENGKAP'
                        ? '✓ Diterima Lengkap'
                        : receivingStatus === 'DITERIMA_SEBAGIAN'
                        ? '◐ Diterima Sebagian'
                        : '○ Belum Diterima'}
                    </span>
                    <p className="text-[11px] text-slate-500">
                      Status penerimaan barang stok mengikuti dokumen Penerimaan Barang (GRN) yang di-Post.
                    </p>
                  </div>
                </div>
              </div>
              )}

              {vis('notes') && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Catatan Tambahan {req('notes') && <span className="text-rose-500">*</span>}
                </label>
                <textarea
                  rows={2}
                  placeholder="Catatan pengiriman, no PO, kondisi barang..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  required={req('notes')}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-emerald-600 outline-none"
                />
              </div>
              )}
            </div>

            {/* Calculations Box */}
            <div className="w-full md:w-80 bg-slate-50/80 rounded-2xl p-4 border border-slate-200 space-y-2 text-xs">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal Barang:</span>
                <span className="font-mono font-bold">Rp {linesSubtotal.toLocaleString('id-ID')}</span>
              </div>
              {vis('transaction_discount') && (
              <div className="flex justify-between items-center text-slate-600">
                <span>Diskon Tambahan (Rp) {req('transaction_discount') && <span className="text-rose-500">*</span>}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  required={req('transaction_discount')}
                  value={overallDiscount}
                  onChange={(e) => setOverallDiscount(e.target.value)}
                  className="w-28 px-2 py-1 text-right bg-white border border-slate-200 rounded-lg text-xs font-mono font-bold"
                />
              </div>
              )}
              <div className="flex justify-between items-center text-slate-600">
                <span>Pembulatan (+/- Rp):</span>
                <input
                  type="number"
                  step="1"
                  value={roundingAmount}
                  onChange={(e) => setRoundingAmount(e.target.value)}
                  className="w-28 px-2 py-1 text-right bg-white border border-slate-200 rounded-lg text-xs font-mono font-bold"
                />
              </div>
              <div className="pt-2 border-t border-slate-200 flex justify-between items-center font-bold text-sm text-slate-800">
                <span>Total Tagihan:</span>
                <span className="text-base text-emerald-800 font-mono">
                  Rp {grandTotal.toLocaleString('id-ID')}
                </span>
              </div>
            </div>
          </div>
        </div>

        {editMode ? (
          /* Ringkasan Pembayaran (Read-only in Edit/Revisi mode) */
          <div data-testid="edit-payment-summary-panel" className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
                <h3 className="text-sm font-bold text-slate-800">Ringkasan Pembayaran</h3>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                  savedPaymentStatus === 'PAID'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : savedPaymentStatus === 'PARTIAL' || savedPaymentStatus === 'PARTIALLY_PAID'
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-rose-50 text-rose-700 border-rose-200'
                }`}>
                  {savedPaymentStatus === 'PAID'
                    ? 'Lunas'
                    : savedPaymentStatus === 'PARTIAL' || savedPaymentStatus === 'PARTIALLY_PAID'
                    ? 'Dibayar Sebagian'
                    : 'Belum Dibayar'}
                </span>
              </div>
              <span className="text-[11px] font-medium text-slate-500">
                Data tersimpan transaksi (baca-saja)
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="p-3 bg-slate-50/80 rounded-xl border border-slate-200">
                <span className="text-[10px] text-slate-500 font-bold block">Total Tagihan</span>
                <span className="font-mono font-bold text-sm text-slate-800">
                  Rp {savedTotalTagihan.toLocaleString('id-ID')}
                </span>
              </div>
              <div className="p-3 bg-slate-50/80 rounded-xl border border-slate-200">
                <span className="text-[10px] text-slate-500 font-bold block">Telah Dibayar</span>
                <span className="font-mono font-bold text-sm text-emerald-700">
                  Rp {savedTelahDibayar.toLocaleString('id-ID')}
                </span>
              </div>
              <div className="p-3 bg-slate-50/80 rounded-xl border border-slate-200">
                <span className="text-[10px] text-slate-500 font-bold block">Sisa Tagihan / Hutang</span>
                <span className={`font-mono font-bold text-sm ${savedSisaTagihan > 0 ? 'text-rose-700' : 'text-slate-700'}`}>
                  Rp {savedSisaTagihan.toLocaleString('id-ID')}
                </span>
              </div>
            </div>

            {grandTotal !== savedTotalTagihan && (
              <div className="px-3 py-2 rounded-xl bg-amber-50/80 border border-amber-200 text-[11px] text-amber-800">
                Perubahan nilai pada form saat ini (<span className="font-mono font-bold">Rp {grandTotal.toLocaleString('id-ID')}</span>) belum disimpan. Ringkasan di atas menampilkan nilai transaksi yang sudah tersimpan.
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
              <p className="text-xs text-slate-600 font-medium">
                Pembayaran dan lampiran bukti dikelola melalui Detail transaksi.
              </p>
              {onOpenDetail && (loadedDetail?.id ?? initialData?.id) !== undefined && (
                <button
                  type="button"
                  data-testid="edit-open-detail-btn"
                  onClick={handleOpenDetailClick}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl border border-slate-200 transition-colors shrink-0"
                >
                  Buka Detail
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Section 3: Pembayaran & Settlement */}
            {vis('payment_status') && (
            <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
                <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
                3. Status Pelunasan Pembayaran {req('payment_status') && <span className="text-rose-500">*</span>}
              </h3>

              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="payment_choice"
                      checked={isImmediatelyPaid}
                      onChange={() => setIsImmediatelyPaid(true)}
                      className="accent-emerald-700 w-4 h-4"
                    />
                    <span className="text-xs font-bold text-slate-800">Dibayar Lunas Langsung</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="payment_choice"
                      checked={!isImmediatelyPaid}
                      onChange={() => setIsImmediatelyPaid(false)}
                      className="accent-emerald-700 w-4 h-4"
                    />
                    <span className="text-xs font-bold text-slate-800">Hutang Vendor (Belum Dibayar / Tempo)</span>
                  </label>
                </div>

                {isImmediatelyPaid && isPurchasePayNowDetailVisible(fieldPolicy) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-slate-50 rounded-xl border border-slate-200 animate-in fade-in">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">
                        Metode Pembayaran <span className="text-rose-500">*</span>
                      </label>
                      <select
                        value={paymentMethod}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                        required
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:border-emerald-600 outline-none font-semibold text-slate-700"
                      >
                        <option value="">Pilih metode pembayaran</option>
                        <option value="CASH">Tunai (Cash / Kasir)</option>
                        <option value="TRANSFER">Transfer Bank</option>
                        <option value="QRIS">QRIS</option>
                        <option value="EDC">Debit / Kartu Kredit</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">
                        Nominal Dibayarkan (Rp) {req('paid_amount') && <span className="text-rose-500">*</span>}
                      </label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        required={req('paid_amount')}
                        placeholder={`Default lunas: ${grandTotal}`}
                        value={paidAmount}
                        onChange={(e) => setPaidAmount(e.target.value)}
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:border-emerald-600 outline-none font-mono font-bold"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
            )}

            {/* Section 4: File Evidence & Bukti Lampiran */}
            {(vis('receipt_attachment') || vis('payment_evidence')) && (
            <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 border-b border-slate-100 pb-3">
                <svg className="w-4 h-4 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                4. Lampiran Bukti Transaksi
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {vis('receipt_attachment') && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Bukti Nota / Struk {req('receipt_attachment') && <span className="text-rose-500">*</span>}
                  </label>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    required={req('receipt_attachment')}
                    onChange={(e) => setInvoiceFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100 cursor-pointer"
                  />
                </div>
                )}

                {vis('payment_evidence') && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Bukti Bayar / Transfer {req('payment_evidence') && <span className="text-rose-500">*</span>}
                  </label>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    required={isImmediatelyPaid && req('payment_evidence')}
                    onChange={(e) => setPaymentProofFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100 cursor-pointer"
                  />
                </div>
                )}
              </div>
            </div>
            )}
          </>
        )}

        {/* Submit Bar */}
        <div className="flex items-center justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={handleBackClick}
            className="px-5 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
          >
            Batal
          </button>
          <button
            type="submit"
            disabled={submitting || !canSubmit}
            className="px-6 py-2.5 bg-emerald-800 hover:bg-emerald-900 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
            {submitting ? 'Menyimpan Transaksi...' : (editMode ? 'Simpan Perubahan Pembelian' : 'Simpan Transaksi Pembelian')}
          </button>
        </div>
      </form>

      {/* Supplier Modal */}
      {vis('supplier') && (
      <SupplierSelectorModal
        isOpen={showSupplierModal}
        propertyId={propertyId}
        actorName={actorName}
        selectedSupplierId={selectedSupplier?.id}
        onSelect={(sup) => setSelectedSupplier(sup)}
        onClose={() => setShowSupplierModal(false)}
      />
      )}
    </div>
  );
};
