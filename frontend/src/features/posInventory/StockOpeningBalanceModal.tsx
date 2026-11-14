/**
 * OAK HIMS — Catat Saldo Awal Persediaan Modal
 * Pencatatan stok fisik lama yang sudah ada sebelum sistem dipakai (OPENING_BALANCE)
 * tanpa membuat Purchase Order (PO) atau tagihan pembelian baru.
 */

import { useState, useEffect, useMemo, useRef, type FormEvent } from 'react';
import {
  fetchInventoryValuation,
  fetchStockTrackedProducts,
  submitStockOpeningBalance,
} from './posInventoryApi';
import type {
  StockLocation,
  InventoryValuationItem,
  StockTrackedProductOption,
} from './posInventoryTypes';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  propertyId: number;
  locations: StockLocation[];
  valuationItems: InventoryValuationItem[];
  onSuccess: (message: string) => void;
  onOpenOpnameForItem?: (item: InventoryValuationItem) => void;
}

const DECIMAL_ALLOWED_UNITS = new Set(['KG', 'GRAM', 'LITER', 'ML']);

function generateOperationKey(): string {
  return `opb-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

function formatIDR(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Rp 0';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(num)) return 'Rp 0';
  return 'Rp ' + Math.round(num).toLocaleString('id-ID');
}

function formatQty(value: number | string): string {
  const num = typeof value === 'string' ? parseFloat(value) || 0 : value || 0;
  return num.toLocaleString('id-ID', { maximumFractionDigits: 3 });
}

export default function StockOpeningBalanceModal({
  isOpen,
  onClose,
  propertyId,
  locations,
  valuationItems: _valuationItems,
  onSuccess,
  onOpenOpnameForItem,
}: Props) {
  const [products, setProducts] = useState<StockTrackedProductOption[]>([]);
  const [loadingProducts, setLoadingProducts] = useState<boolean>(false);
  const [selectedProductId, setSelectedProductId] = useState<number | ''>('');
  const [selectedLocationId, setSelectedLocationId] = useState<number | ''>('');
  const [quantityStr, setQuantityStr] = useState<string>('');
  const [unitCostStr, setUnitCostStr] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fetchedTargetItem, setFetchedTargetItem] = useState<InventoryValuationItem | null>(null);
  const [targetBalanceStatus, setTargetBalanceStatus] = useState<'IDLE' | 'LOADING' | 'READY' | 'ERROR'>('IDLE');
  const [targetBalanceError, setTargetBalanceError] = useState<string | null>(null);
  const [balanceReloadTick, setBalanceReloadTick] = useState<number>(0);

  // Idempotency key: dipertahankan selama input form tidak berubah pada sesi modal yang sama
  const [operationKey, setOperationKey] = useState<string>(() => generateOperationKey());
  const lastFingerprintRef = useRef<string>('');
  const balanceReqSeqRef = useRef<number>(0);

  const activeLocations = useMemo(
    () => locations.filter((loc) => loc.is_active),
    [locations]
  );

  useEffect(() => {
    if (!isOpen) return;

    setSelectedProductId('');
    setSelectedLocationId(activeLocations.length > 0 ? activeLocations[0].id : '');
    setQuantityStr('');
    setUnitCostStr('');
    setNotes('');
    setErrorMsg(null);
    const freshKey = generateOperationKey();
    setOperationKey(freshKey);
    lastFingerprintRef.current = '';

    let cancelled = false;
    setLoadingProducts(true);
    fetchStockTrackedProducts(propertyId)
      .then((list) => {
        if (cancelled) return;
        setProducts(list);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setErrorMsg(err?.message || 'Gagal memuat daftar produk master');
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, propertyId]);

  useEffect(() => {
    if (isOpen && selectedLocationId === '' && activeLocations.length > 0) {
      setSelectedLocationId(activeLocations[0].id);
    }
  }, [isOpen, selectedLocationId, activeLocations]);

  // Perbarui operationKey hanya jika nilai input form berubah
  useEffect(() => {
    if (!isOpen) return;
    const fp = `${propertyId}|${selectedProductId}|${selectedLocationId}|${quantityStr.trim()}|${unitCostStr.trim()}|${notes.trim()}`;
    if (lastFingerprintRef.current && lastFingerprintRef.current !== fp) {
      setOperationKey(generateOperationKey());
    }
    lastFingerprintRef.current = fp;
  }, [isOpen, propertyId, selectedProductId, selectedLocationId, quantityStr, unitCostStr, notes]);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === Number(selectedProductId)) || null,
    [products, selectedProductId]
  );

  const selectedLocation = useMemo(
    () => activeLocations.find((l) => l.id === Number(selectedLocationId)) || null,
    [activeLocations, selectedLocationId]
  );

  const baseUnit = selectedProduct?.base_unit_code || 'SATUAN';
  const allowsDecimal = DECIMAL_ALLOWED_UNITS.has(baseUnit);

  // Query mandiri saldo aktual untuk pasangan (propertyId, productId, locationId) tanpa bergantung filter/search tabel utama
  useEffect(() => {
    if (!isOpen || !selectedProductId || !selectedLocationId) {
      setFetchedTargetItem(null);
      setTargetBalanceStatus('IDLE');
      setTargetBalanceError(null);
      return;
    }

    let cancelled = false;
    const reqId = ++balanceReqSeqRef.current;
    setFetchedTargetItem(null);
    setTargetBalanceStatus('LOADING');
    setTargetBalanceError(null);

    fetchInventoryValuation(propertyId, {
      product_id: Number(selectedProductId),
      location_id: Number(selectedLocationId),
    })
      .then((res) => {
        if (cancelled || balanceReqSeqRef.current !== reqId) return;
        const items = Array.isArray(res?.items) ? res.items : [];
        const matched =
          items.find(
            (it) =>
              Number(it.product_id) === Number(selectedProductId) &&
              Number(it.location_id) === Number(selectedLocationId)
          ) || null;
        setFetchedTargetItem(matched);
        setTargetBalanceStatus('READY');
        setTargetBalanceError(null);
      })
      .catch((err: any) => {
        if (cancelled || balanceReqSeqRef.current !== reqId) return;
        setFetchedTargetItem(null);
        setTargetBalanceStatus('ERROR');
        setTargetBalanceError(err?.message || 'Gagal memeriksa saldo lokasi sasaran');
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, propertyId, selectedProductId, selectedLocationId, balanceReloadTick]);

  // Cek apakah lokasi yang dipilih sudah memiliki baris saldo aktif untuk produk ini dari hasil query mandiri
  const existingLocationValuationItem = useMemo(() => {
    if (!selectedProduct || !selectedLocation) return null;
    if (targetBalanceStatus !== 'READY' || !fetchedTargetItem) return null;
    const qty = parseFloat(fetchedTargetItem.quantity || '0') || 0;
    return qty > 0 ? fetchedTargetItem : null;
  }, [selectedProduct, selectedLocation, targetBalanceStatus, fetchedTargetItem]);

  const currentLocationBalance = useMemo(() => {
    if (!existingLocationValuationItem) return 0;
    return parseFloat(existingLocationValuationItem.quantity || '0') || 0;
  }, [existingLocationValuationItem]);

  // Validasi kuantitas sesuai presisi satuan dasar
  const quantityValidation = useMemo(() => {
    const trimmed = quantityStr.trim();
    if (!trimmed) {
      return { valid: false, message: null as string | null, numericValue: 0, canonicalStr: '0.000' };
    }
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      return {
        valid: false,
        message: 'Jumlah stok harus berupa angka positif yang valid.',
        numericValue: 0,
        canonicalStr: '0.000',
      };
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) {
      return {
        valid: false,
        message: 'Jumlah stok awal harus lebih besar dari 0.',
        numericValue: 0,
        canonicalStr: '0.000',
      };
    }
    const parts = trimmed.split('.');
    const frac = parts[1] || '';
    if (!allowsDecimal && frac.length > 0 && !/^0+$/.test(frac)) {
      return {
        valid: false,
        message: `Satuan dasar ${baseUnit} adalah satuan hitung bulat (COUNT) dan tidak menerima angka desimal/pecahan.`,
        numericValue: num,
        canonicalStr: trimmed,
      };
    }
    if (allowsDecimal && frac.length > 3) {
      return {
        valid: false,
        message: `Satuan dasar ${baseUnit} maksimal menggunakan 3 angka di belakang titik desimal.`,
        numericValue: num,
        canonicalStr: trimmed,
      };
    }
    return {
      valid: true,
      message: null as string | null,
      numericValue: num,
      canonicalStr: num.toFixed(3),
    };
  }, [quantityStr, allowsDecimal, baseUnit]);

  // Validasi biaya pokok per satuan dasar (wajib diisi, tidak boleh kosong dianggap 0)
  const costValidation = useMemo(() => {
    const trimmed = unitCostStr.trim();
    if (trimmed === '') {
      return {
        valid: false,
        isEmpty: true,
        message: null as string | null,
        numericValue: 0,
        canonicalStr: '',
      };
    }
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
      return {
        valid: false,
        isEmpty: false,
        message: `Biaya pokok per ${baseUnit} harus berupa angka non-negatif (>= 0) dengan maksimal 2 desimal.`,
        numericValue: 0,
        canonicalStr: trimmed,
      };
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) {
      return {
        valid: false,
        isEmpty: false,
        message: `Biaya pokok per ${baseUnit} tidak boleh negatif.`,
        numericValue: 0,
        canonicalStr: trimmed,
      };
    }
    return {
      valid: true,
      isEmpty: false,
      message: null as string | null,
      numericValue: num,
      canonicalStr: num.toFixed(2),
    };
  }, [unitCostStr, baseUnit]);

  const projectedLocationBalance = useMemo(() => {
    if (!quantityValidation.valid) return currentLocationBalance;
    return Math.round((currentLocationBalance + quantityValidation.numericValue) * 1000) / 1000;
  }, [currentLocationBalance, quantityValidation]);

  const projectedOpeningValue = useMemo(() => {
    if (!quantityValidation.valid || !costValidation.valid) return 0;
    return quantityValidation.numericValue * costValidation.numericValue;
  }, [quantityValidation, costValidation]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!selectedProduct) {
      setErrorMsg('Pilih produk terlebih dahulu.');
      return;
    }
    if (!selectedLocation) {
      setErrorMsg('Pilih lokasi penyimpanan stok terlebih dahulu.');
      return;
    }
    if (targetBalanceStatus === 'LOADING') {
      setErrorMsg('Sedang memeriksa saldo lokasi sasaran. Mohon tunggu sebentar.');
      return;
    }
    if (targetBalanceStatus === 'ERROR') {
      setErrorMsg(
        targetBalanceError ||
          'Gagal memeriksa saldo lokasi sasaran. Silakan coba periksa ulang saldo sebelum menyimpan.'
      );
      return;
    }
    if (!quantityValidation.valid) {
      setErrorMsg(
        quantityValidation.message ||
          `Masukkan jumlah stok lama yang belum tercatat (> 0 ${baseUnit}).`
      );
      return;
    }
    if (!costValidation.valid) {
      if (costValidation.isEmpty) {
        setErrorMsg(
          `Biaya Pokok per ${baseUnit} (Rp) wajib diisi dan tidak boleh dikosongkan. Isi 0 hanya jika biaya perolehan barang memang diketahui nol.`
        );
      } else {
        setErrorMsg(
          costValidation.message || `Biaya Pokok per ${baseUnit} (Rp) tidak valid.`
        );
      }
      return;
    }

    setSubmitting(true);
    try {
      await submitStockOpeningBalance({
        property_id: propertyId,
        product_id: selectedProduct.id,
        location_id: selectedLocation.id,
        quantity: quantityValidation.canonicalStr,
        unit_cost: costValidation.canonicalStr,
        operation_key: operationKey,
        notes: notes.trim() || undefined,
      });

      onSuccess(
        `Saldo awal ${selectedProduct.name} (${formatQty(quantityValidation.numericValue)} ${baseUnit}) di ${selectedLocation.name} berhasil dicatat!`
      );
      onClose();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Gagal mencatat saldo awal persediaan');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="opening-balance-modal-title"
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-xl w-full border border-gray-200 overflow-hidden flex flex-col my-auto animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 bg-[#1b4332] text-white flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-[#d4af37]">
              Persediaan Awal Tanpa PO / Pembelian
            </div>
            <h3 id="opening-balance-modal-title" className="text-base font-extrabold text-white mt-0.5">
              Catat Saldo Awal Persediaan
            </h3>
            <p className="text-xs text-[#f4f1ea]/90 mt-1">
              Untuk stok lama yang belum tercatat. Tidak membuat pembelian atau tagihan baru.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-white/70 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
            aria-label="Tutup"
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} noValidate className="p-6 space-y-4 max-h-[82vh] overflow-y-auto">
          {errorMsg && (
            <div
              data-testid="opening-balance-error"
              className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-start justify-between gap-2"
            >
              <span>{errorMsg}</span>
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                className="font-bold hover:text-rose-900 shrink-0"
              >
                ✕
              </button>
            </div>
          )}

          {/* Produk */}
          <div>
            <label
              htmlFor="opening-balance-product"
              className="block text-xs font-bold text-gray-700 mb-1"
            >
              Produk <span className="text-rose-600">*</span>
            </label>
            {loadingProducts ? (
              <div className="px-3 py-2 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-xl">
                Memuat daftar produk aktif (track_stock = true)...
              </div>
            ) : products.length === 0 ? (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-xs">
                Belum ada produk aktif dengan pelacakan stok (<code>track_stock = true</code>). Aktifkan pelacakan stok pada Master Barang &amp; Produk terlebih dahulu.
              </div>
            ) : (
              <select
                id="opening-balance-product"
                data-testid="opening-balance-product-select"
                value={selectedProductId}
                onChange={(e) =>
                  setSelectedProductId(e.target.value ? Number(e.target.value) : '')
                }
                disabled={submitting}
                className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
              >
                <option value="">— Pilih produk —</option>
                {products.map((prod) => (
                  <option key={prod.id} value={prod.id}>
                    {prod.name}
                    {prod.item_code ? ` (${prod.item_code})` : ''} — Satuan: {prod.base_unit_code}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Lokasi Stok & Satuan Dasar */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label
                htmlFor="opening-balance-location"
                className="block text-xs font-bold text-gray-700 mb-1"
              >
                Lokasi Stok <span className="text-rose-600">*</span>
              </label>
              <select
                id="opening-balance-location"
                data-testid="opening-balance-location-select"
                value={selectedLocationId}
                onChange={(e) =>
                  setSelectedLocationId(e.target.value ? Number(e.target.value) : '')
                }
                disabled={submitting || activeLocations.length === 0}
                className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700"
              >
                {activeLocations.length === 0 ? (
                  <option value="">Tidak ada lokasi aktif</option>
                ) : (
                  activeLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name} ({loc.code})
                    </option>
                  ))
                )}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                Satuan Dasar
              </label>
              <div
                data-testid="opening-balance-base-unit"
                className="px-3 py-2 text-xs font-extrabold text-[#1b4332] bg-[#faf9f5] border border-gray-200 rounded-xl flex items-center justify-between"
              >
                <span>{baseUnit}</span>
                <span className="text-[10px] font-semibold text-gray-500">
                  {allowsDecimal ? 'Desimal (≤3)' : 'Bulat'}
                </span>
              </div>
            </div>
          </div>

          {/* Jumlah Stok Lama yang Belum Tercatat */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor="opening-balance-quantity"
                className="text-xs font-bold text-gray-700"
              >
                Jumlah Stok Lama yang Belum Tercatat ({baseUnit}){' '}
                <span className="text-rose-600">*</span>
              </label>
              <span className="text-[11px] text-gray-500">
                {allowsDecimal
                  ? `Angka > 0 (maks. 3 desimal, mis. 2.500 ${baseUnit})`
                  : `Bilangan bulat > 0 (dalam ${baseUnit})`}
              </span>
            </div>
            <input
              id="opening-balance-quantity"
              data-testid="opening-balance-quantity-input"
              type="text"
              inputMode={allowsDecimal ? 'decimal' : 'numeric'}
              placeholder={allowsDecimal ? `Contoh: 2.500` : `Contoh: 10`}
              value={quantityStr}
              onChange={(e) => setQuantityStr(e.target.value)}
              disabled={submitting}
              className={`w-full px-3 py-2 text-sm border rounded-xl bg-white focus:outline-none focus:ring-2 ${
                quantityStr.trim() !== '' && !quantityValidation.valid
                  ? 'border-rose-400 focus:ring-rose-500'
                  : 'border-gray-300 focus:ring-emerald-700'
              }`}
            />
            {quantityStr.trim() !== '' && quantityValidation.message && (
              <p
                data-testid="opening-balance-quantity-error"
                className="text-[11px] text-rose-600 mt-1 font-semibold"
              >
                ⚠ {quantityValidation.message}
              </p>
            )}
          </div>

          {/* Biaya Pokok per Satuan Dasar */}
          <div>
            <label
              htmlFor="opening-balance-unit-cost"
              className="block text-xs font-bold text-gray-700 mb-1"
            >
              Biaya Pokok per {baseUnit} (Rp) <span className="text-rose-600">*</span>
            </label>
            <input
              id="opening-balance-unit-cost"
              data-testid="opening-balance-unit-cost-input"
              type="text"
              inputMode="decimal"
              placeholder={`Masukkan harga beli/pokok per ${baseUnit}, mis. 2000`}
              value={unitCostStr}
              onChange={(e) => setUnitCostStr(e.target.value)}
              disabled={submitting}
              className={`w-full px-3 py-2 text-sm border rounded-xl bg-white focus:outline-none focus:ring-2 ${
                unitCostStr.trim() !== '' && !costValidation.valid
                  ? 'border-rose-400 focus:ring-rose-500'
                  : 'border-gray-300 focus:ring-emerald-700'
              }`}
            />
            {unitCostStr.trim() !== '' && costValidation.message && (
              <p
                data-testid="opening-balance-cost-error"
                className="text-[11px] text-rose-600 mt-1 font-semibold"
              >
                ⚠ {costValidation.message}
              </p>
            )}
            <div className="mt-1.5 p-2.5 bg-[#faf9f5] border border-gray-200 rounded-xl text-[11px] text-gray-600 space-y-1">
              <div>
                • Masukkan <strong>harga beli/perolehan pokok per 1 {baseUnit}</strong> (bukan harga jual menu POS).
              </div>
              <div>
                • Isi <strong>0</strong> hanya jika biaya perolehan barang memang diketahui nol (<code>unit_cost = 0</code>). Barang komplimen untuk tamu tetap memiliki biaya perolehan bila dibeli oleh hotel. Input kosong akan ditolak dan tidak pernah dianggap Rp0 secara diam-diam.
              </div>
              <div>
                • Jika biaya pokok belum diketahui, pastikan harga perolehan terlebih dahulu sebelum mencatat saldo awal melalui form ini.
              </div>
            </div>
          </div>

          {/* Catatan / Alasan */}
          <div>
            <label
              htmlFor="opening-balance-notes"
              className="block text-xs font-bold text-gray-700 mb-1"
            >
              Catatan / Alasan Pencatatan
            </label>
            <textarea
              id="opening-balance-notes"
              data-testid="opening-balance-notes-input"
              rows={2}
              placeholder="Stok fisik sudah ada di gudang sebelum sistem dipakai"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={submitting}
              className="w-full px-3 py-2 text-xs border border-gray-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 resize-none"
            />
          </div>

          {/* Pratinjau Sebelum Simpan */}
          <div
            data-testid="opening-balance-preview"
            className="p-4 bg-[#faf9f5] rounded-2xl border border-[#1b4332]/20 space-y-2.5"
          >
            <div className="flex items-center justify-between border-b border-gray-200 pb-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#1b4332]">
                Pratinjau Sebelum Simpan
              </span>
              {selectedLocation && (
                <span className="text-[11px] font-semibold text-gray-600">
                  Lokasi: {selectedLocation.name}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="text-gray-600">Jumlah Saldo Awal Dicatat:</div>
              <div className="text-right font-bold text-gray-900" data-testid="preview-opening-qty">
                {quantityValidation.valid
                  ? `+${formatQty(quantityValidation.numericValue)} ${baseUnit}`
                  : `- ${baseUnit}`}
              </div>

              <div className="text-gray-600">Biaya Pokok per {baseUnit}:</div>
              <div className="text-right font-bold text-gray-900" data-testid="preview-unit-cost">
                {costValidation.valid ? `${formatIDR(costValidation.numericValue)} / ${baseUnit}` : '-'}
              </div>

              <div className="text-gray-600">Nilai Persediaan Awal:</div>
              <div className="text-right font-extrabold text-[#1b4332]" data-testid="preview-total-value">
                {quantityValidation.valid && costValidation.valid
                  ? formatIDR(projectedOpeningValue)
                  : '-'}
              </div>

              <div className="text-gray-600">Saldo Lokasi Sebelum → Sesudah:</div>
              <div className="text-right font-extrabold text-gray-900" data-testid="preview-location-balance">
                {!selectedProduct || !selectedLocation || targetBalanceStatus === 'IDLE' ? (
                  <span className="text-gray-400 font-normal">Pilih produk &amp; lokasi</span>
                ) : targetBalanceStatus === 'LOADING' ? (
                  <span data-testid="preview-balance-loading" className="text-amber-700 font-semibold">
                    Memeriksa saldo lokasi...
                  </span>
                ) : targetBalanceStatus === 'ERROR' ? (
                  <span data-testid="preview-balance-error" className="text-rose-700 font-semibold">
                    Gagal memeriksa saldo lokasi
                  </span>
                ) : (
                  <>
                    {formatQty(currentLocationBalance)} {baseUnit} →{' '}
                    <span className="text-[#1b4332]">
                      {formatQty(projectedLocationBalance)} {baseUnit}
                    </span>
                  </>
                )}
              </div>
            </div>

            {targetBalanceStatus === 'ERROR' && (
              <div
                data-testid="opening-balance-target-balance-error"
                className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-[11px] text-rose-800 flex items-center justify-between gap-2"
              >
                <span>
                  {targetBalanceError || 'Gagal memeriksa saldo lokasi sasaran. Pratinjau saldo belum dapat ditampilkan.'}
                </span>
                <button
                  type="button"
                  data-testid="opening-balance-retry-balance-btn"
                  onClick={() => setBalanceReloadTick((t) => t + 1)}
                  className="px-2.5 py-1 rounded-lg bg-rose-700 hover:bg-rose-800 text-white text-[10px] font-bold transition-colors cursor-pointer shrink-0"
                >
                  Coba Lagi
                </button>
              </div>
            )}

            {existingLocationValuationItem && (
              <div
                data-testid="opening-balance-existing-location-notice"
                className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900 space-y-1.5"
              >
                <div>
                  <strong>Catatan Saldo Lokasi:</strong> Produk ini sudah memiliki saldo tercatat sebesar{' '}
                  <strong>
                    {formatQty(currentLocationBalance)} {baseUnit}
                  </strong>{' '}
                  di <strong>{selectedLocation?.name}</strong>. Pencatatan <em>Saldo Awal</em> bersifat{' '}
                  <strong>menambah</strong> saldo lokasi ({formatQty(currentLocationBalance)} +{' '}
                  {quantityValidation.valid ? formatQty(quantityValidation.numericValue) : '0'} ={' '}
                  {formatQty(projectedLocationBalance)} {baseUnit}) dan hanya diizinkan 1 kali per produk per lokasi.
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Bila tujuan Anda adalah menghitung ulang total stok fisik menjadi angka target, gunakan{' '}
                    <strong>Opname Fisik</strong>.
                  </span>
                  {onOpenOpnameForItem && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenOpnameForItem(existingLocationValuationItem);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-purple-700 hover:bg-purple-800 text-white text-[10px] font-bold transition-colors cursor-pointer shrink-0"
                    >
                      Buka Opname Fisik
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="pt-2 flex items-center justify-end gap-2 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              Batal
            </button>
            <button
              type="submit"
              data-testid="opening-balance-submit-btn"
              disabled={
                submitting ||
                products.length === 0 ||
                activeLocations.length === 0 ||
                targetBalanceStatus === 'LOADING' ||
                targetBalanceStatus === 'ERROR'
              }
              className="px-5 py-2 bg-[#1b4332] hover:bg-[#2d6a4f] text-white text-xs font-bold rounded-xl shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {submitting ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  <span>Menyimpan...</span>
                </>
              ) : (
                <span>Simpan Saldo Awal</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
