import React, { useState, useEffect, useCallback } from 'react';
import { safeFetchJson } from './calendarApi';
import { useAuth } from '../auth/AuthContext';
import { StayChargePickerCombobox } from '../stayCharges/StayChargePickerCombobox';
import { fetchStayChargeRules } from '../stayCharges/stayChargesApi';
import type { StayChargeRule } from '../stayCharges/stayChargesTypes';

interface AddStayChargeModalProps {
  isOpen: boolean;
  onClose: () => void;
  reservationId: number;
  propertyId: number;
  roomNightlyRate?: number;
  existingCharges?: any[];
  onSuccess: () => void;
}

export const AddStayChargeModal: React.FC<AddStayChargeModalProps> = ({
  isOpen,
  onClose,
  reservationId,
  propertyId,
  roomNightlyRate = 0,
  existingCharges = [],
  onSuccess
}) => {
  const [rules, setRules] = useState<StayChargeRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState<boolean>(false);
  const [selectedRule, setSelectedRule] = useState<StayChargeRule | null>(null);
  const [chargeType, setChargeType] = useState<string>('EXTRA_BED');
  const [description, setDescription] = useState<string>('Extra Bed (Kasur Tambahan)');
  const [quantity, setQuantity] = useState<number>(1);
  const [unitPrice, setUnitPrice] = useState<number>(150000);
  const [isManual, setIsManual] = useState<boolean>(false);
  const [isOverride, setIsOverride] = useState<boolean>(false);
  const [overridePrice, setOverridePrice] = useState<number>(150000);
  const [overrideReason, setOverrideReason] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const { authFetch } = useAuth();

  const loadRules = useCallback(async () => {
    if (!propertyId) return;
    try {
      setRulesLoading(true);
      const data = await fetchStayChargeRules(propertyId, { includeArchived: false });
      setRules(data);
    } catch (err: any) {
      console.error('Failed to load stay charge rules:', err);
      setError('Data layanan tambahan belum berhasil dimuat. Silakan coba lagi.');
    } finally {
      setRulesLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    if (isOpen) {
      void loadRules();
      setIsOverride(false);
      setOverrideReason('');
    }
  }, [isOpen, loadRules]);

  if (!isOpen) return null;

  const handleSelectRule = (rule: StayChargeRule | any) => {
    setSelectedRule(rule);
    setChargeType(rule.charge_type || 'EXTRA_BED');
    setDescription(rule.name || rule.charge_type);
    setIsOverride(false);
    setOverrideReason('');

    // Check single-occurrence
    if (rule.charge_type === 'EARLY_CHECKIN' || rule.charge_type === 'LATE_CHECKOUT') {
      const alreadyHas = existingCharges.some(
        c => (c.entry_type === rule.charge_type || c.charge_type === rule.charge_type) && !c.is_voided
      );
      if (alreadyHas) {
        setError(`Layanan ${rule.name || rule.charge_type} sudah ditambahkan pada reservasi ini.`);
      } else {
        setError(null);
      }
    } else {
      setError(null);
    }

    if (rule.charge_method === 'MANUAL') {
      setIsManual(true);
      setUnitPrice(0);
      setOverridePrice(0);
    } else {
      setIsManual(false);
      let calculatedPrice = 0;
      if (rule.charge_method === 'FIXED_AMOUNT') {
        calculatedPrice = Number(rule.default_amount ?? rule.default_price ?? 0);
      } else if (rule.charge_method === 'FREE') {
        calculatedPrice = 0;
      } else if (rule.charge_method === 'FULL_NIGHT') {
        calculatedPrice = roomNightlyRate > 0 ? roomNightlyRate : 0;
      } else if (rule.charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE') {
        const pct = Number(rule.percentage_rate ?? rule.percentage_of_rate ?? 50);
        calculatedPrice = roomNightlyRate > 0 ? Math.round((roomNightlyRate * pct) / 100) : 0;
      }
      setUnitPrice(calculatedPrice);
      setOverridePrice(calculatedPrice);
    }
  };

  const activeUnitPrice = isManual ? unitPrice : (isOverride ? overridePrice : unitPrice);
  const totalAmount = quantity * activeUnitPrice;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reservationId) return;

    if (isOverride && !overrideReason.trim()) {
      setError('Alasan override harga wajib diisi');
      return;
    }

    if (isManual && activeUnitPrice <= 0) {
      setError('Nominal biaya manual harus lebih besar dari 0');
      return;
    }

    if (activeUnitPrice < 0 || quantity <= 0) {
      setError('Nominal dan jumlah harus valid');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const result = await safeFetchJson(
        '/api/stay-charges/post-charge',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            property_id: propertyId,
            reservation_id: reservationId,
            rule_id: selectedRule?.id,
            charge_type: chargeType,
            custom_description: description.trim() || undefined,
            quantity,
            unit_price: activeUnitPrice,
            is_override: isOverride,
            override_amount: isOverride ? overridePrice : undefined,
            override_reason: isOverride ? overrideReason.trim() : undefined,
            notes: notes.trim() || undefined,
            actor_name: 'Front Desk',
            actor_role: 'STAFF'
          })
        },
        'Gagal menambahkan biaya stay charge',
        authFetch
      );

      if (!result.ok) {
        throw new Error(result.errorMessage || 'Gagal menambahkan biaya stay charge');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Gagal menyimpan biaya tambahan');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-stone-200">
          <div>
            <h3 className="text-base font-bold text-stone-900 flex items-center gap-2">
              <span>💳 Tambah Biaya Layanan / Denda</span>
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Posting tagihan ke folio kamar reservasi #{reservationId}.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 text-lg font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs flex items-center justify-between font-medium">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-rose-600 hover:text-rose-900 font-bold ml-2 cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          {/* Searchable Stay Charge Combobox */}
          <div>
            <StayChargePickerCombobox
              rules={rules}
              onSelectRule={handleSelectRule}
              label="Pilih Layanan Tambahan / Denda"
              placeholder="Cari Extra Bed, Late Check-out, Denda Merokok, dll"
              disabled={rulesLoading}
            />
          </div>

          <div>
            <label className="block font-semibold text-stone-700 mb-1">
              Keterangan Biaya <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-[#1b4332] focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-stone-700 mb-1">
                Jumlah (Qty) <span className="text-rose-500">*</span>
              </label>
              <div className="flex items-center border border-stone-300 rounded-xl overflow-hidden bg-white">
                <button
                  type="button"
                  disabled={quantity <= 1 || chargeType === 'EARLY_CHECKIN' || chargeType === 'LATE_CHECKOUT'}
                  onClick={() => setQuantity(prev => Math.max(1, prev - 1))}
                  className="px-3 py-2 text-stone-600 hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed font-bold"
                >
                  -
                </button>
                <input
                  type="number"
                  min={1}
                  required
                  disabled={chargeType === 'EARLY_CHECKIN' || chargeType === 'LATE_CHECKOUT'}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
                  className="w-full text-center py-2 border-0 focus:outline-none font-semibold font-mono disabled:bg-stone-50"
                />
                <button
                  type="button"
                  disabled={chargeType === 'EARLY_CHECKIN' || chargeType === 'LATE_CHECKOUT'}
                  onClick={() => setQuantity(prev => prev + 1)}
                  className="px-3 py-2 text-stone-600 hover:bg-stone-100 disabled:opacity-40 disabled:cursor-not-allowed font-bold"
                >
                  +
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block font-semibold text-stone-700">
                  Harga Satuan (Rp) <span className="text-rose-500">*</span>
                </label>
                {!isManual && selectedRule && selectedRule.charge_method !== 'FREE' && (
                  <button
                    type="button"
                    onClick={() => setIsOverride(!isOverride)}
                    className="text-[10px] text-amber-800 font-bold hover:underline cursor-pointer"
                  >
                    {isOverride ? '✕ Batal Override' : '⚙️ Override'}
                  </button>
                )}
              </div>

              {isManual ? (
                <input
                  type="number"
                  min={0}
                  step={1000}
                  required
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(Math.max(0, Number(e.target.value)))}
                  placeholder="Nominal manual..."
                  className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-[#1b4332] focus:outline-none font-mono text-stone-900"
                />
              ) : (
                <div className="px-3 py-2 bg-stone-100 border border-stone-200 rounded-xl font-mono text-stone-800 font-semibold flex items-center justify-between">
                  <span>
                    {unitPrice === 0 ? 'Gratis (Rp 0)' : `Rp ${unitPrice.toLocaleString('id-ID')}`}
                  </span>
                  <span className="text-[10px] text-stone-500 font-sans font-normal">
                    {selectedRule?.charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE' ? '50% Tarif' : 'Master'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Controlled Override Section */}
          {isOverride && !isManual && (
            <div className="p-3 bg-amber-50/70 border border-amber-200 rounded-xl space-y-2 animate-in fade-in duration-150">
              <div className="flex items-center justify-between text-[11px] font-bold text-amber-900">
                <span>⚙️ Override Harga Khusus</span>
                <span className="text-stone-500 font-mono font-normal">
                  Master: Rp {unitPrice.toLocaleString('id-ID')}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-semibold text-amber-900 mb-0.5">
                    Harga Baru (Rp) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    required
                    value={overridePrice}
                    onChange={(e) => setOverridePrice(Math.max(0, Number(e.target.value)))}
                    className="w-full px-2.5 py-1.5 bg-white border border-amber-300 rounded-lg font-mono font-bold text-stone-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-amber-900 mb-0.5">
                    Alasan Override <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Contoh: Diskon GM, Kompensasi..."
                    className="w-full px-2.5 py-1.5 bg-white border border-amber-300 rounded-lg text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200 flex items-center justify-between">
            <span className="font-semibold text-emerald-900">Total Tagihan Tambahan:</span>
            <span className="font-bold text-sm font-mono text-emerald-900">
              Rp {totalAmount.toLocaleString('id-ID')}
            </span>
          </div>

          <div>
            <label className="block font-semibold text-stone-700 mb-1">
              Catatan Internal / Referensi {isManual ? <span className="text-rose-500">*</span> : ''}
            </label>
            <input
              type="text"
              required={isManual}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Contoh: Tambahan 1 selimut & bantal, atau denda sprei kena noda..."
              className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl focus:ring-2 focus:ring-[#1b4332] focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-stone-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-stone-300 text-stone-700 font-bold rounded-xl hover:bg-stone-100 transition-colors cursor-pointer"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-[#1b4332] hover:bg-[#15281c] disabled:opacity-50 text-[#f4efe6] font-bold rounded-xl shadow-xs transition-colors cursor-pointer"
            >
              {loading ? 'Menyimpan...' : 'Posting Biaya ke Folio'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
