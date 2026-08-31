import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type {
  StayChargeRule,
  StayChargeType,
  StayChargeCalculationType,
  CreateStayChargeRuleDto,
  UpdateStayChargeRuleDto
} from '../stayCharges/stayChargesTypes';
import {
  fetchStayChargeRules,
  createStayChargeRule,
  updateStayChargeRule,
  deleteStayChargeRule
} from '../stayCharges/stayChargesApi';

interface Props {
  propertyId: number;
  onChanged?: (message: string) => void;
}

const SERVICE_TYPE_LABELS: Record<string, { label: string; badge: string; group: 'service' | 'penalty' }> = {
  EXTRA_BED: { label: 'Extra Bed', badge: 'bg-emerald-100 text-emerald-800 border-emerald-300', group: 'service' },
  EXTRA_PERSON: { label: 'Extra Person', badge: 'bg-blue-100 text-blue-800 border-blue-300', group: 'service' },
  EARLY_CHECKIN: { label: 'Early Check-in', badge: 'bg-amber-100 text-amber-800 border-amber-300', group: 'service' },
  LATE_CHECKOUT: { label: 'Late Check-out', badge: 'bg-indigo-100 text-indigo-800 border-indigo-300', group: 'service' },
  PENALTY: { label: 'Denda / Penalti', badge: 'bg-rose-100 text-rose-800 border-rose-300', group: 'penalty' }
};

const CALC_TYPE_LABELS: Record<string, string> = {
  FIXED: 'Nominal Tetap (Rp)',
  FIXED_AMOUNT: 'Nominal Tetap (Rp)',
  PERCENT_ROOM_RATE: '% dari Tarif Kamar',
  PERCENTAGE_OF_NIGHTLY_RATE: '% dari Tarif Kamar',
  FULL_NIGHT_RATE: 'Tarif 1 Malam Penuh',
  FREE: 'Gratis (Rp 0)',
  MANUAL: 'Input Manual saat Posting'
};

function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(amount);
}

export default function LayananTambahanView({ propertyId, onChanged }: Props) {
  const [rules, setRules] = useState<StayChargeRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<'SERVICE' | 'PENALTY'>('SERVICE');
  const [searchTerm, setSearchTerm] = useState('');
  const [editingRule, setEditingRule] = useState<Partial<StayChargeRule> | null>(null);
  const [saving, setSaving] = useState(false);

  const loadRules = useCallback(async () => {
    if (!propertyId) return;
    try {
      setLoading(true);
      setErrorMsg(null);
      const data = await fetchStayChargeRules(propertyId, { includeArchived: true });
      setRules(data);
    } catch (err: any) {
      setErrorMsg('Data layanan tambahan belum berhasil dimuat. Silakan coba lagi.');
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  useEffect(() => {
    if (successMsg) {
      const timer = window.setTimeout(() => setSuccessMsg(null), 4000);
      return () => window.clearTimeout(timer);
    }
  }, [successMsg]);

  const serviceRules = useMemo(() => {
    return rules.filter(r => r.charge_type !== 'PENALTY' && !r.is_archived);
  }, [rules]);

  const penaltyRules = useMemo(() => {
    return rules.filter(r => r.charge_type === 'PENALTY' && !r.is_archived);
  }, [rules]);

  const filteredRules = useMemo(() => {
    const list = activeGroup === 'PENALTY' ? penaltyRules : serviceRules;
    if (!searchTerm.trim()) return list;
    const q = searchTerm.toLowerCase().trim();
    return list.filter(r => {
      const name = (r.name || '').toLowerCase();
      const code = (r.code || '').toLowerCase();
      const desc = (r.description || '').toLowerCase();
      return name.includes(q) || code.includes(q) || desc.includes(q);
    });
  }, [activeGroup, serviceRules, penaltyRules, searchTerm]);

  // Current Extra Bed Rule summary
  const extraBedRule = useMemo(() => {
    return rules.find(r => r.charge_type === 'EXTRA_BED' && r.is_active && !r.is_archived);
  }, [rules]);

  const handleStartCreate = (defaultType: StayChargeType = 'EXTRA_BED') => {
    setEditingRule({
      charge_type: defaultType,
      code: '',
      name: '',
      description: '',
      calculation_type: 'FIXED',
      default_amount: defaultType === 'EXTRA_BED' ? 150000 : 100000,
      percentage_of_rate: 0,
      min_hours: 0,
      max_hours: 0,
      is_taxable: defaultType !== 'PENALTY',
      is_service_chargeable: defaultType !== 'PENALTY',
      is_active: true,
      display_order: rules.length + 1
    });
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handleEdit = (rule: StayChargeRule) => {
    setEditingRule({
      id: rule.id,
      property_id: rule.property_id,
      charge_type: rule.charge_type,
      code: rule.code,
      name: rule.name,
      description: rule.description || '',
      calculation_type: rule.calculation_type || 'FIXED',
      default_amount: Number(rule.default_amount || 0),
      percentage_of_rate: Number(rule.percentage_of_rate || 0),
      min_hours: rule.min_hours || 0,
      max_hours: rule.max_hours || 0,
      is_taxable: rule.is_taxable,
      is_service_chargeable: rule.is_service_chargeable,
      is_active: rule.is_active,
      display_order: rule.display_order
    });
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handleToggleActive = async (rule: StayChargeRule) => {
    try {
      setSaving(true);
      setErrorMsg(null);
      await updateStayChargeRule(rule.id, {
        property_id: propertyId,
        is_active: !rule.is_active
      });
      const msg = `Aturan ${rule.name} berhasil ${!rule.is_active ? 'diaktifkan' : 'dinonaktifkan'}.`;
      setSuccessMsg(msg);
      onChanged?.(msg);
      await loadRules();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal mengubah status aturan');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (rule: StayChargeRule) => {
    if (!window.confirm(`Yakin ingin mengarsipkan aturan "${rule.name}" (${rule.code})?`)) return;
    try {
      setSaving(true);
      setErrorMsg(null);
      await deleteStayChargeRule(rule.id, propertyId, false);
      const msg = `Aturan "${rule.name}" berhasil diarsipkan.`;
      setSuccessMsg(msg);
      onChanged?.(msg);
      await loadRules();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal mengarsipkan aturan');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRule) return;

    if (!editingRule.code?.trim()) {
      setErrorMsg('Kode aturan wajib diisi');
      return;
    }
    if (!editingRule.name?.trim()) {
      setErrorMsg('Nama aturan wajib diisi');
      return;
    }

    try {
      setSaving(true);
      setErrorMsg(null);

      if (editingRule.id) {
        const payload: UpdateStayChargeRuleDto = {
          property_id: propertyId,
          charge_type: editingRule.charge_type,
          code: editingRule.code.trim().toUpperCase(),
          name: editingRule.name.trim(),
          description: editingRule.description?.trim() || null,
          calculation_type: editingRule.calculation_type,
          default_amount: Number(editingRule.default_amount || 0),
          percentage_of_rate: Number(editingRule.percentage_of_rate || 0),
          min_hours: Number(editingRule.min_hours || 0),
          max_hours: Number(editingRule.max_hours || 0),
          is_taxable: Boolean(editingRule.is_taxable),
          is_service_chargeable: Boolean(editingRule.is_service_chargeable),
          is_active: editingRule.is_active !== undefined ? editingRule.is_active : true,
          display_order: Number(editingRule.display_order || 1)
        };
        await updateStayChargeRule(editingRule.id, payload);
        const msg = `Aturan ${editingRule.name} berhasil diperbarui.`;
        setSuccessMsg(msg);
        onChanged?.(msg);
      } else {
        const payload: CreateStayChargeRuleDto = {
          property_id: propertyId,
          charge_type: editingRule.charge_type || 'EXTRA_BED',
          code: editingRule.code.trim().toUpperCase(),
          name: editingRule.name.trim(),
          description: editingRule.description?.trim() || null,
          calculation_type: editingRule.calculation_type || 'FIXED',
          default_amount: Number(editingRule.default_amount || 0),
          percentage_of_rate: Number(editingRule.percentage_of_rate || 0),
          min_hours: Number(editingRule.min_hours || 0),
          max_hours: Number(editingRule.max_hours || 0),
          is_taxable: Boolean(editingRule.is_taxable),
          is_service_chargeable: Boolean(editingRule.is_service_chargeable),
          is_active: editingRule.is_active !== undefined ? editingRule.is_active : true,
          display_order: Number(editingRule.display_order || 1)
        };
        await createStayChargeRule(payload);
        const msg = `Aturan ${editingRule.name} baru berhasil ditambahkan.`;
        setSuccessMsg(msg);
        onChanged?.(msg);
      }

      setEditingRule(null);
      await loadRules();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menyimpan aturan');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="rm-state">
        <div className="rm-state-title">Memuat Layanan Tambahan & Denda…</div>
        <div className="text-xs text-stone-500 mt-2">Mengambil data aturan master stay charges dari server</div>
      </div>
    );
  }

  if (errorMsg && rules.length === 0) {
    return (
      <div className="rm-state">
        <div className="rm-state-title">Gagal Memuat Data Layanan Tambahan</div>
        <div className="text-xs text-rose-600 mt-1">{errorMsg}</div>
        <div className="mt-4">
          <button
            type="button"
            className="px-4 py-2 bg-emerald-800 text-white rounded-lg text-xs font-semibold hover:bg-emerald-900 cursor-pointer"
            onClick={() => void loadRules()}
          >
            Coba Lagi
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Notifications */}
      {errorMsg && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <span>⚠</span>
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg(null)} className="text-rose-600 hover:text-rose-900 font-bold ml-2">✕</button>
        </div>
      )}
      {successMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <span>✓</span>
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg(null)} className="text-emerald-600 hover:text-emerald-900 font-bold ml-2">✕</button>
        </div>
      )}

      {/* Overview Info Banner */}
      <div className="bg-gradient-to-r from-[#1e3a29]/10 to-[#d4af37]/10 border border-[#1e3a29]/20 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#1e3a29] text-[#f4efe6] uppercase tracking-wider">
              Master Pricing Tambahan
            </span>
            <span className="text-xs text-stone-500">Property #{propertyId}</span>
          </div>
          <h4 className="text-sm font-bold text-stone-900">Layanan Tambahan & Master Denda</h4>
          <p className="text-xs text-stone-600">
            Tarif Extra Bed berlaku secara <strong>property-wide (seluruh tipe kamar)</strong>. Nilai ini menjadi sumber kebenaran harga pada Reservasi Cepat dan Folio Tamu.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => handleStartCreate('EXTRA_BED')}
            className="px-3 py-2 bg-[#1e3a29] hover:bg-[#15281c] text-[#f4efe6] rounded-xl text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <span>+ Layanan</span>
          </button>
          <button
            type="button"
            onClick={() => handleStartCreate('PENALTY')}
            className="px-3 py-2 bg-rose-700 hover:bg-rose-800 text-white rounded-xl text-xs font-semibold shadow-xs flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <span>+ Denda</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs">
          <div className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider">Tarif Extra Bed</div>
          <div className="text-lg font-black text-[#1e3a29] mt-0.5">
            {extraBedRule ? formatIDR(Number(extraBedRule.default_amount)) : 'Rp 150.000'}
          </div>
          <div className="text-[10px] text-emerald-700 font-medium mt-0.5">Berlaku Semua Tipe Kamar</div>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs">
          <div className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider">Layanan Tambahan</div>
          <div className="text-lg font-black text-stone-900 mt-0.5">{serviceRules.length} Aturan</div>
          <div className="text-[10px] text-stone-500 mt-0.5">Extra Bed, Early, Late, dll.</div>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs">
          <div className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider">Denda & Penalti</div>
          <div className="text-lg font-black text-rose-800 mt-0.5">{penaltyRules.length} Aturan</div>
          <div className="text-[10px] text-stone-500 mt-0.5">Smoking, Kunci, Kerusakan, dll.</div>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs">
          <div className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider">Integrasi Otomatis</div>
          <div className="text-lg font-black text-[#1e3a29] mt-0.5">Sinkron</div>
          <div className="text-[10px] text-stone-500 mt-0.5">Terkoneksi Folio & Booking</div>
        </div>
      </div>

      {/* Subnav Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-stone-200 pb-3">
        <div className="flex gap-2 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setActiveGroup('SERVICE')}
            className={`px-3.5 py-2 rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
              activeGroup === 'SERVICE'
                ? 'bg-[#1e3a29] text-[#f4efe6] shadow-xs font-bold'
                : 'bg-stone-100 text-stone-600 hover:bg-stone-200 font-medium'
            }`}
          >
            <span>🛎️ Layanan Tambahan</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
              activeGroup === 'SERVICE' ? 'bg-emerald-950/40 text-emerald-100' : 'bg-stone-200 text-stone-700'
            }`}>
              {serviceRules.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveGroup('PENALTY')}
            className={`px-3.5 py-2 rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
              activeGroup === 'PENALTY'
                ? 'bg-rose-800 text-white shadow-xs font-bold'
                : 'bg-stone-100 text-stone-600 hover:bg-stone-200 font-medium'
            }`}
          >
            <span>⚠️ Denda & Penalti</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
              activeGroup === 'PENALTY' ? 'bg-rose-950/40 text-rose-100' : 'bg-stone-200 text-stone-700'
            }`}>
              {penaltyRules.length}
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Cari aturan layanan / denda..."
              className="pl-8 pr-7 py-1.5 bg-white border border-stone-300 rounded-xl text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-[#1e3a29] w-56 shadow-2xs"
            />
            <span className="absolute left-2.5 top-2 text-stone-400 text-xs">🔍</span>
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="absolute right-2 top-2 text-stone-400 hover:text-stone-600 text-xs cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => void loadRules()}
            className="p-2 text-stone-500 hover:text-stone-800 rounded-xl hover:bg-stone-100 transition-colors border border-stone-200 bg-white"
            title="Muat Ulang"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Rules Table */}
      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#fcfaf7] border-b border-stone-200 text-stone-600 font-bold uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-3 px-4">Kode & Nama Layanan / Denda</th>
                <th className="py-3 px-3">Kategori</th>
                <th className="py-3 px-3">Metode & Tarif Standar</th>
                <th className="py-3 px-3">Pajak & Service</th>
                <th className="py-3 px-3">Cakupan</th>
                <th className="py-3 px-3 text-center">Status</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {filteredRules.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-stone-500">
                    <div className="text-2xl mb-1">📋</div>
                    <div className="font-semibold text-stone-700">
                      {searchTerm
                        ? `Tidak ditemukan aturan yang cocok dengan "${searchTerm}"`
                        : `Belum ada aturan pada kelompok ${activeGroup === 'SERVICE' ? 'Layanan Tambahan' : 'Denda & Penalti'}.`}
                    </div>
                    <div className="text-[11px] text-stone-400 mt-1">
                      {searchTerm
                        ? 'Coba gunakan kata kunci pencarian lainnya.'
                        : 'Klik tombol tambah di atas untuk menambahkan aturan baru.'}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredRules.map((rule) => {
                  const typeMeta = SERVICE_TYPE_LABELS[rule.charge_type] || {
                    label: rule.charge_type,
                    badge: 'bg-stone-100 text-stone-700 border-stone-200',
                    group: 'service'
                  };
                  const calcLabel = CALC_TYPE_LABELS[rule.calculation_type] || rule.calculation_type;

                  return (
                    <tr key={rule.id} className="hover:bg-stone-50/70 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-bold text-stone-900">{rule.name}</div>
                        <div className="font-mono text-[11px] text-stone-500">{rule.code}</div>
                        {rule.description && (
                          <div className="text-[10px] text-stone-400 mt-0.5">{rule.description}</div>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${typeMeta.badge}`}>
                          {typeMeta.label}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        {rule.calculation_type === 'PERCENT_ROOM_RATE' || (rule as any).charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE' ? (
                          <div>
                            <span className="font-bold text-[#1e3a29] text-xs">
                              {Number(rule.percentage_of_rate || (rule as any).percentage_rate || 0)}%
                            </span>
                            <span className="text-[10px] text-stone-500 block">dari tarif kamar</span>
                          </div>
                        ) : rule.calculation_type === 'MANUAL' || (rule as any).charge_method === 'MANUAL' ? (
                          <div>
                            <span className="font-semibold text-stone-700">Input Manual</span>
                            <span className="text-[10px] text-stone-400 block">ditentukan saat posting</span>
                          </div>
                        ) : (
                          <div>
                            <span className="font-bold text-stone-900 text-xs">
                              {formatIDR(Number(rule.default_amount || 0))}
                            </span>
                            <span className="text-[10px] text-stone-500 block">{calcLabel}</span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                            rule.is_taxable ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-stone-100 text-stone-400'
                          }`}>
                            PPN {rule.is_taxable ? '✓' : '✗'}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                            rule.is_service_chargeable ? 'bg-blue-50 text-blue-800 border border-blue-200' : 'bg-stone-100 text-stone-400'
                          }`}>
                            Service {rule.is_service_chargeable ? '✓' : '✗'}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-stone-100 text-stone-700 border border-stone-200">
                          Property-wide (Semua Tipe)
                        </span>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <button
                          type="button"
                          onClick={() => handleToggleActive(rule)}
                          disabled={saving}
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold cursor-pointer transition-colors border ${
                            rule.is_active
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                              : 'bg-stone-100 text-stone-500 border-stone-300 hover:bg-stone-200'
                          }`}
                        >
                          {rule.is_active ? 'Aktif' : 'Nonaktif'}
                        </button>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleEdit(rule)}
                            className="px-2 py-1 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded font-semibold text-[11px] cursor-pointer transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleArchive(rule)}
                            className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded font-semibold text-[11px] cursor-pointer transition-colors"
                          >
                            Arsip
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit / Create Modal */}
      {editingRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl border border-stone-200 w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-5 py-4 bg-[#1e3a29] text-white flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[#f4efe6]">
                  {editingRule.id ? 'Edit Aturan Layanan / Denda' : 'Tambah Aturan Layanan / Denda Baru'}
                </h3>
                <p className="text-[11px] text-stone-300">Konfigurasi tarif master yang berlaku di seluruh kamar</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingRule(null)}
                className="text-stone-300 hover:text-white p-1 rounded-lg text-xs"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveRule} className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-stone-700 mb-1">Jenis Layanan / Denda *</label>
                  <select
                    value={editingRule.charge_type || 'EXTRA_BED'}
                    onChange={(e) => setEditingRule({ ...editingRule, charge_type: e.target.value as StayChargeType })}
                    className="w-full bg-stone-50 border border-stone-300 rounded-lg px-2.5 py-2 font-medium"
                  >
                    <option value="EXTRA_BED">Extra Bed</option>
                    <option value="EXTRA_PERSON">Extra Person</option>
                    <option value="EARLY_CHECKIN">Early Check-in</option>
                    <option value="LATE_CHECKOUT">Late Check-out</option>
                    <option value="PENALTY">Denda / Penalti</option>
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-stone-700 mb-1">Kode Aturan (SKU) *</label>
                  <input
                    type="text"
                    required
                    placeholder="Contoh: EXTRA_BED_STD"
                    value={editingRule.code || ''}
                    onChange={(e) => setEditingRule({ ...editingRule, code: e.target.value.toUpperCase() })}
                    className="w-full bg-stone-50 border border-stone-300 rounded-lg px-2.5 py-2 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-stone-700 mb-1">Nama Layanan / Denda *</label>
                <input
                  type="text"
                  required
                  placeholder="Contoh: Extra Bed Standar Dewasa"
                  value={editingRule.name || ''}
                  onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })}
                  className="w-full bg-stone-50 border border-stone-300 rounded-lg px-2.5 py-2"
                />
              </div>

              <div>
                <label className="block font-bold text-stone-700 mb-1">Deskripsi Tambahan</label>
                <textarea
                  rows={2}
                  placeholder="Keterangan kelengkapan atau syarat ketentuan..."
                  value={editingRule.description || ''}
                  onChange={(e) => setEditingRule({ ...editingRule, description: e.target.value })}
                  className="w-full bg-stone-50 border border-stone-300 rounded-lg px-2.5 py-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-stone-700 mb-1">Metode Perhitungan</label>
                  <select
                    value={editingRule.calculation_type || 'FIXED'}
                    onChange={(e) => setEditingRule({ ...editingRule, calculation_type: e.target.value as StayChargeCalculationType })}
                    className="w-full bg-stone-50 border border-stone-300 rounded-lg px-2.5 py-2"
                  >
                    <option value="FIXED">Nominal Tetap (Rp)</option>
                    <option value="PERCENT_ROOM_RATE">% dari Tarif Kamar</option>
                    <option value="FULL_NIGHT_RATE">Tarif 1 Malam Penuh</option>
                    <option value="MANUAL">Input Manual saat Posting</option>
                    <option value="FREE">Gratis (Rp 0)</option>
                  </select>
                </div>

                <div>
                  {editingRule.calculation_type === 'PERCENT_ROOM_RATE' ? (
                    <div>
                      <label className="block font-bold text-stone-700 mb-1">Persentase (%)</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={editingRule.percentage_of_rate || 0}
                        onChange={(e) => setEditingRule({ ...editingRule, percentage_of_rate: Number(e.target.value) })}
                        className="w-full bg-stone-50 border border-stone-300 rounded-lg px-2.5 py-2 font-mono"
                      />
                    </div>
                  ) : editingRule.calculation_type === 'MANUAL' ? (
                    <div>
                      <label className="block font-bold text-stone-700 mb-1">Tarif Standar</label>
                      <input
                        type="text"
                        disabled
                        value="Sesuai Kasus / Temuan"
                        className="w-full bg-stone-100 border border-stone-300 rounded-lg px-2.5 py-2 text-stone-500"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="block font-bold text-stone-700 mb-1">Tarif Standar (Rp) *</label>
                      <input
                        type="number"
                        min="0"
                        step="1000"
                        value={editingRule.default_amount || 0}
                        onChange={(e) => setEditingRule({ ...editingRule, default_amount: Number(e.target.value) })}
                        className="w-full bg-stone-50 border border-stone-300 rounded-lg px-2.5 py-2 font-mono"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Checkboxes: Tax & Service & Active */}
              <div className="bg-stone-50 border border-stone-200 rounded-xl p-3 space-y-2">
                <div className="font-bold text-stone-700">Ketentuan Finansial & Status</div>
                <div className="grid grid-cols-3 gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(editingRule.is_taxable)}
                      onChange={(e) => setEditingRule({ ...editingRule, is_taxable: e.target.checked })}
                      className="rounded text-emerald-700 focus:ring-emerald-500"
                    />
                    <span>Kena Pajak (PPN)</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(editingRule.is_service_chargeable)}
                      onChange={(e) => setEditingRule({ ...editingRule, is_service_chargeable: e.target.checked })}
                      className="rounded text-emerald-700 focus:ring-emerald-500"
                    />
                    <span>Kena Service</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editingRule.is_active !== false}
                      onChange={(e) => setEditingRule({ ...editingRule, is_active: e.target.checked })}
                      className="rounded text-emerald-700 focus:ring-emerald-500"
                    />
                    <span>Status Aktif</span>
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-stone-200">
                <button
                  type="button"
                  onClick={() => setEditingRule(null)}
                  className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 bg-[#1e3a29] hover:bg-[#15281c] text-[#f4efe6] rounded-xl font-bold shadow-xs cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'Menyimpan…' : 'Simpan Aturan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
