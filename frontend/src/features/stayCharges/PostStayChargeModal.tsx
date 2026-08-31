import React, { useState, useEffect } from 'react';
import type {
  StayChargeRule,
  StayChargeType,
  PostStayChargeDto
} from './stayChargesTypes';
import {
  fetchStayChargeRules,
  postStayChargeToFolio
} from './stayChargesApi';

interface Props {
  propertyId: number;
  reservationId: number;
  reservationNumber?: string;
  roomNumber?: string;
  guestName?: string;
  nightlyRate?: number;
  initialChargeType?: StayChargeType;
  initialDescription?: string;
  initialAmount?: number;
  initialNote?: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (data: any) => void;
}

const CHARGE_TYPE_LABELS: Record<StayChargeType, { label: string; badge: string }> = {
  EXTRA_BED: { label: 'Extra Bed (Kasur Tambahan)', badge: 'bg-emerald-100 text-emerald-800' },
  EXTRA_PERSON: { label: 'Extra Person (Tamu Tambahan)', badge: 'bg-blue-100 text-blue-800' },
  EARLY_CHECKIN: { label: 'Early Check-in (Check-in Awal)', badge: 'bg-amber-100 text-amber-800' },
  LATE_CHECKOUT: { label: 'Late Check-out (Check-out Lambat)', badge: 'bg-indigo-100 text-indigo-800' },
  PENALTY: { label: 'Denda / Penalti Kerusakan & Kehilangan', badge: 'bg-rose-100 text-rose-800' }
};

export default function PostStayChargeModal({
  propertyId,
  reservationId,
  reservationNumber,
  roomNumber,
  guestName,
  nightlyRate = 0,
  initialChargeType = 'EXTRA_BED',
  initialDescription = '',
  initialAmount,
  initialNote = '',
  isOpen,
  onClose,
  onSuccess
}: Props) {
  const [rules, setRules] = useState<StayChargeRule[]>([]);
  const [chargeType, setChargeType] = useState<StayChargeType>(initialChargeType);
  const [selectedRuleId, setSelectedRuleId] = useState<number | null>(null);
  const [description, setDescription] = useState<string>(initialDescription);
  const [amount, setAmount] = useState<number>(initialAmount ?? 0);
  const [quantity, setQuantity] = useState<number>(1);
  const [hoursApplied, setHoursApplied] = useState<number>(0);
  const [taxable, setTaxable] = useState<boolean>(false);
  const [serviceChargeable, setServiceChargeable] = useState<boolean>(false);
  const [note, setNote] = useState<string>(initialNote);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setChargeType(initialChargeType);
      setDescription(initialDescription);
      setAmount(initialAmount ?? 0);
      setNote(initialNote);
      setQuantity(1);
      setErrorMsg(null);
      loadRules();
    }
  }, [isOpen, propertyId, initialChargeType, initialDescription, initialAmount, initialNote]);

  const loadRules = async () => {
    try {
      const data = await fetchStayChargeRules(propertyId);
      setRules(data.filter(r => r.is_active));
    } catch (err: any) {
      console.warn('Gagal memuat aturan stay charge:', err);
    }
  };

  const currentRules = rules.filter(r => r.charge_type === chargeType);

  const handleRuleChange = (ruleIdStr: string) => {
    if (!ruleIdStr) {
      setSelectedRuleId(null);
      return;
    }
    const rId = Number(ruleIdStr);
    setSelectedRuleId(rId);
    const rule = rules.find(r => r.id === rId);
    if (!rule) return;

    setDescription(rule.name);
    setTaxable(rule.is_taxable);
    setServiceChargeable(rule.is_service_chargeable);

    if (rule.calculation_type === 'FIXED') {
      setAmount(Number(rule.default_amount));
    } else if (rule.calculation_type === 'PERCENT_ROOM_RATE') {
      const calc = Math.round((nightlyRate * Number(rule.percentage_of_rate || 0)) / 100);
      setAmount(calc);
    } else if (rule.calculation_type === 'FULL_NIGHT_RATE') {
      setAmount(nightlyRate);
    } else if (rule.calculation_type === 'FREE') {
      setAmount(0);
    }
  };

  const handleChargeTypeChange = (newType: StayChargeType) => {
    setChargeType(newType);
    setSelectedRuleId(null);
    const matching = rules.filter(r => r.charge_type === newType);
    if (matching.length > 0) {
      const first = matching[0];
      setSelectedRuleId(first.id);
      setDescription(first.name);
      setTaxable(first.is_taxable);
      setServiceChargeable(first.is_service_chargeable);
      if (first.calculation_type === 'FIXED') setAmount(Number(first.default_amount));
      else if (first.calculation_type === 'PERCENT_ROOM_RATE') setAmount(Math.round((nightlyRate * Number(first.percentage_of_rate || 0)) / 100));
      else if (first.calculation_type === 'FULL_NIGHT_RATE') setAmount(nightlyRate);
      else if (first.calculation_type === 'FREE') setAmount(0);
    } else {
      setDescription('');
      setAmount(0);
    }
  };

  if (!isOpen) return null;

  const rawSubtotal = amount * quantity;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) {
      setErrorMsg('Keterangan biaya wajib diisi');
      return;
    }
    if (amount < 0) {
      setErrorMsg('Nominal tidak boleh negatif');
      return;
    }

    try {
      setLoading(true);
      setErrorMsg(null);

      const payload: PostStayChargeDto = {
        property_id: propertyId,
        reservation_id: reservationId,
        rule_id: selectedRuleId,
        charge_type: chargeType,
        description: description.trim(),
        custom_amount: amount,
        quantity: quantity || 1,
        hours_applied: hoursApplied > 0 ? hoursApplied : null,
        taxable,
        service_chargeable: serviceChargeable,
        note: note.trim() || null
      };

      const result = await postStayChargeToFolio(payload);
      onSuccess(result);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal memposting biaya');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-lg flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 bg-[#1e3a29] text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">💳</span>
            <div>
              <h2 className="text-base font-bold text-[#f4efe6]">Tambah Biaya / Denda ke Folio</h2>
              <p className="text-xs text-stone-300">
                {roomNumber ? `Kamar ${roomNumber}` : ''} {guestName ? `· ${guestName}` : ''} {reservationNumber ? `(${reservationNumber})` : ''}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-stone-300 hover:text-white bg-white/10 hover:bg-white/20 p-1.5 rounded-lg text-xs"
          >
            ✕
          </button>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div className="mx-6 mt-4 p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs flex items-center justify-between">
            <span>⚠ {errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} className="text-rose-500 font-bold ml-2">✕</button>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-stone-700 mb-1">Kategori Biaya</label>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {(['EXTRA_BED', 'EXTRA_PERSON', 'EARLY_CHECKIN', 'LATE_CHECKOUT', 'PENALTY'] as StayChargeType[]).map((type) => (
                <button
                  type="button"
                  key={type}
                  onClick={() => handleChargeTypeChange(type)}
                  className={`p-2 rounded-lg border text-left transition-all ${
                    chargeType === type
                      ? 'border-[#1e3a29] bg-[#1e3a29]/5 text-[#1e3a29] font-bold shadow-xs'
                      : 'border-stone-200 hover:bg-stone-50 text-stone-700'
                  }`}
                >
                  <div className="text-[11px] truncate">{CHARGE_TYPE_LABELS[type]?.label.split(' (')[0]}</div>
                </button>
              ))}
            </div>
          </div>

          {currentRules.length > 0 && (
            <div>
              <label className="block font-semibold text-stone-700 mb-1">Pilih Master Aturan (Opsional)</label>
              <select
                value={selectedRuleId || ''}
                onChange={(e) => handleRuleChange(e.target.value)}
                className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden"
              >
                <option value="">-- Kustom / Bebas --</option>
                {currentRules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.code}) · {r.calculation_type === 'FIXED' ? `Rp ${Number(r.default_amount).toLocaleString('id-ID')}` : r.calculation_type}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block font-semibold text-stone-700 mb-1">Keterangan Tagihan *</label>
            <input
              type="text"
              required
              placeholder="Contoh: Extra Bed Standar, Denda Hilang Kunci Kamar, dll"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white font-medium focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-stone-700 mb-1">Nominal Satuan (Rp) *</label>
              <input
                type="number"
                min={0}
                required
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white font-mono font-bold focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden"
              />
            </div>
            <div>
              <label className="block font-semibold text-stone-700 mb-1">Jumlah (Qty) *</label>
              <input
                type="number"
                min={1}
                required
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
                className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white font-mono font-bold focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden"
              />
            </div>
          </div>

          {(chargeType === 'EARLY_CHECKIN' || chargeType === 'LATE_CHECKOUT') && (
            <div>
              <label className="block font-semibold text-stone-700 mb-1">Durasi Jam (Opsional)</label>
              <input
                type="number"
                min={0}
                max={24}
                placeholder="Jumlah jam lebih awal / lambat"
                value={hoursApplied || ''}
                onChange={(e) => setHoursApplied(Number(e.target.value))}
                className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white font-mono"
              />
            </div>
          )}

          <div>
            <label className="block font-semibold text-stone-700 mb-1">Catatan Tambahan (Opsional)</label>
            <textarea
              rows={2}
              placeholder="Catatan internal / bukti temuan untuk Front Office"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white"
            />
          </div>

          <div className="flex flex-wrap gap-4 pt-1">
            <label className="flex items-center gap-2 cursor-pointer font-semibold text-stone-700">
              <input
                type="checkbox"
                checked={taxable}
                onChange={(e) => setTaxable(e.target.checked)}
                className="rounded text-[#1e3a29] focus:ring-[#1e3a29]"
              />
              Pajak (Tax)
            </label>
            <label className="flex items-center gap-2 cursor-pointer font-semibold text-stone-700">
              <input
                type="checkbox"
                checked={serviceChargeable}
                onChange={(e) => setServiceChargeable(e.target.checked)}
                className="rounded text-[#1e3a29] focus:ring-[#1e3a29]"
              />
              Service Charge
            </label>
          </div>

          {/* Subtotal preview */}
          <div className="bg-[#faf8f5] border border-stone-200 rounded-lg p-3 flex items-center justify-between">
            <span className="font-semibold text-stone-600">Total Tagihan Debit:</span>
            <span className="font-mono font-extrabold text-base text-[#1e3a29]">
              Rp {rawSubtotal.toLocaleString('id-ID')}
            </span>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-stone-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-stone-300 text-stone-700 font-semibold rounded-lg hover:bg-stone-100"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-[#1e3a29] hover:bg-[#162b1e] text-white font-bold rounded-lg shadow-sm flex items-center gap-1.5"
            >
              {loading ? 'Posting...' : '💳 Post ke Folio'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
