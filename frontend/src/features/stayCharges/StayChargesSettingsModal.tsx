import React, { useState, useEffect } from 'react';
import type {
  StayChargeRule,
  StayChargeType,
  StayChargeCalculationType,
  CreateStayChargeRuleDto,
  UpdateStayChargeRuleDto
} from './stayChargesTypes';
import {
  fetchStayChargeRules,
  createStayChargeRule,
  updateStayChargeRule,
  deleteStayChargeRule
} from './stayChargesApi';

interface Props {
  propertyId: number;
  isOpen: boolean;
  onClose: () => void;
}

const CHARGE_TYPE_LABELS: Record<StayChargeType, { label: string; badge: string }> = {
  EXTRA_BED: { label: 'Extra Bed', badge: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  EXTRA_PERSON: { label: 'Extra Person', badge: 'bg-blue-100 text-blue-800 border-blue-300' },
  EARLY_CHECKIN: { label: 'Early Check-in', badge: 'bg-amber-100 text-amber-800 border-amber-300' },
  LATE_CHECKOUT: { label: 'Late Check-out', badge: 'bg-indigo-100 text-indigo-800 border-indigo-300' },
  PENALTY: { label: 'Denda / Penalti', badge: 'bg-rose-100 text-rose-800 border-rose-300' }
};

const CALC_TYPE_LABELS: Record<StayChargeCalculationType, string> = {
  FIXED: 'Nominal Tetap (Rp)',
  PERCENT_ROOM_RATE: '% dari Tarif Kamar',
  FULL_NIGHT_RATE: 'Tarif 1 Malam Penuh',
  FREE: 'Gratis (Rp 0)',
  MANUAL: 'Input Manual saat Posting'
};

export default function StayChargesSettingsModal({ propertyId, isOpen, onClose }: Props) {
  const [rules, setRules] = useState<StayChargeRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterType, setFilterType] = useState<string>('ALL');
  const [editingRule, setEditingRule] = useState<Partial<StayChargeRule> | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadRules = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const data = await fetchStayChargeRules(propertyId);
      setRules(data);
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal memuat aturan stay charge');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadRules();
      setEditingRule(null);
    }
  }, [isOpen, propertyId]);

  if (!isOpen) return null;

  const filteredRules = rules.filter(r => {
    if (filterType === 'ALL') return true;
    return r.charge_type === filterType;
  });

  const handleStartCreate = () => {
    setEditingRule({
      charge_type: (filterType !== 'ALL' ? filterType : 'EXTRA_BED') as StayChargeType,
      code: '',
      name: '',
      description: '',
      calculation_type: 'FIXED',
      default_amount: 100000,
      percentage_of_rate: 0,
      min_hours: 0,
      max_hours: 0,
      is_taxable: false,
      is_service_chargeable: false,
      is_active: true,
      display_order: rules.length + 1
    });
    setErrorMsg(null);
    setSuccessMsg(null);
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
      setLoading(true);
      setErrorMsg(null);

      if (editingRule.id) {
        // Update
        const payload: UpdateStayChargeRuleDto = {
          property_id: propertyId,
          charge_type: editingRule.charge_type,
          code: editingRule.code,
          name: editingRule.name,
          description: editingRule.description,
          calculation_type: editingRule.calculation_type,
          default_amount: editingRule.default_amount,
          percentage_of_rate: editingRule.percentage_of_rate,
          min_hours: editingRule.min_hours,
          max_hours: editingRule.max_hours,
          is_taxable: editingRule.is_taxable,
          is_service_chargeable: editingRule.is_service_chargeable,
          is_active: editingRule.is_active,
          display_order: editingRule.display_order
        };
        await updateStayChargeRule(editingRule.id, payload);
        setSuccessMsg('Aturan stay charge berhasil diperbarui');
      } else {
        // Create
        const payload: CreateStayChargeRuleDto = {
          property_id: propertyId,
          charge_type: editingRule.charge_type || 'EXTRA_BED',
          code: editingRule.code,
          name: editingRule.name,
          description: editingRule.description,
          calculation_type: editingRule.calculation_type || 'FIXED',
          default_amount: editingRule.default_amount || 0,
          percentage_of_rate: editingRule.percentage_of_rate,
          min_hours: editingRule.min_hours,
          max_hours: editingRule.max_hours,
          is_taxable: editingRule.is_taxable,
          is_service_chargeable: editingRule.is_service_chargeable,
          is_active: editingRule.is_active !== undefined ? editingRule.is_active : true,
          display_order: editingRule.display_order || 1
        };
        await createStayChargeRule(payload);
        setSuccessMsg('Aturan stay charge baru berhasil ditambahkan');
      }

      setEditingRule(null);
      await loadRules();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menyimpan aturan');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (rule: StayChargeRule) => {
    if (!window.confirm(`Yakin ingin menonaktifkan aturan "${rule.name}" (${rule.code})?`)) return;
    try {
      setLoading(true);
      setErrorMsg(null);
      await deleteStayChargeRule(rule.id, propertyId, false);
      setSuccessMsg(`Aturan "${rule.name}" berhasil diarsipkan`);
      await loadRules();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal mengarsipkan aturan');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-stone-200 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 bg-[#1e3a29] text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚙️</span>
            <div>
              <h2 className="text-lg font-bold tracking-tight text-[#f4efe6]">Pengaturan Stay Charges & Denda</h2>
              <p className="text-xs text-stone-300">Konfigurasi tarif master Extra Bed, Extra Person, Early/Late Check, dan Penalti</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-stone-300 hover:text-white bg-white/10 hover:bg-white/20 p-1.5 rounded-lg text-sm transition-colors"
          >
            ✕ Tutup
          </button>
        </div>

        {/* Subheader / Tabs */}
        <div className="px-6 py-3 bg-[#fdfbf7] border-b border-stone-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto text-xs font-semibold">
            {['ALL', 'EXTRA_BED', 'EXTRA_PERSON', 'EARLY_CHECKIN', 'LATE_CHECKOUT', 'PENALTY'].map((tab) => (
              <button
                key={tab}
                onClick={() => { setFilterType(tab); setEditingRule(null); }}
                className={`px-3 py-1.5 rounded-lg border transition-all ${
                  filterType === tab
                    ? 'bg-[#1e3a29] text-white border-[#1e3a29] shadow-xs'
                    : 'bg-white text-stone-700 border-stone-200 hover:bg-stone-50'
                }`}
              >
                {tab === 'ALL' ? 'Semua Biaya' : CHARGE_TYPE_LABELS[tab as StayChargeType]?.label || tab}
              </button>
            ))}
          </div>

          {!editingRule && (
            <button
              onClick={handleStartCreate}
              className="px-3.5 py-1.5 bg-[#d4af37] hover:bg-[#c49f27] text-stone-900 font-bold text-xs rounded-lg shadow-xs flex items-center gap-1.5 transition-all shrink-0"
            >
              <span>+ Tambah Aturan</span>
            </button>
          )}
        </div>

        {/* Notification banners */}
        {errorMsg && (
          <div className="mx-6 mt-3 p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-800 text-xs flex items-center justify-between">
            <span>⚠ {errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} className="text-rose-500 font-bold ml-2">✕</button>
          </div>
        )}
        {successMsg && (
          <div className="mx-6 mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 text-xs flex items-center justify-between">
            <span>✓ {successMsg}</span>
            <button onClick={() => setSuccessMsg(null)} className="text-emerald-500 font-bold ml-2">✕</button>
          </div>
        )}

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {editingRule ? (
            /* Form Create / Edit */
            <form onSubmit={handleSaveRule} className="bg-[#fcfaf7] border border-stone-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-stone-200 pb-3">
                <h3 className="text-sm font-bold text-stone-900 flex items-center gap-2">
                  <span>{editingRule.id ? '✏️ Edit Aturan' : '✨ Tambah Aturan Baru'}</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setEditingRule(null)}
                  className="text-xs text-stone-500 hover:text-stone-800 font-semibold"
                >
                  Batal
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div>
                  <label className="block font-semibold text-stone-700 mb-1">Tipe Biaya *</label>
                  <select
                    value={editingRule.charge_type || 'EXTRA_BED'}
                    onChange={(e) => setEditingRule({ ...editingRule, charge_type: e.target.value as StayChargeType })}
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden"
                  >
                    <option value="EXTRA_BED">Extra Bed (Kasur Tambahan)</option>
                    <option value="EXTRA_PERSON">Extra Person (Tamu Tambahan)</option>
                    <option value="EARLY_CHECKIN">Early Check-in (Check-in Awal)</option>
                    <option value="LATE_CHECKOUT">Late Check-out (Check-out Lambat)</option>
                    <option value="PENALTY">Denda / Penalti (Kerusakan/Kehilangan/Rokok)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-stone-700 mb-1">Kode Unik *</label>
                  <input
                    type="text"
                    required
                    placeholder="Contoh: EXTRA_BED_STD"
                    value={editingRule.code || ''}
                    onChange={(e) => setEditingRule({ ...editingRule, code: e.target.value.toUpperCase() })}
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white font-mono uppercase focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block font-semibold text-stone-700 mb-1">Nama Aturan / Biaya *</label>
                  <input
                    type="text"
                    required
                    placeholder="Contoh: Extra Bed Standard + Breakfast"
                    value={editingRule.name || ''}
                    onChange={(e) => setEditingRule({ ...editingRule, name: e.target.value })}
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-stone-700 mb-1">Metode Perhitungan *</label>
                  <select
                    value={editingRule.calculation_type || 'FIXED'}
                    onChange={(e) => setEditingRule({ ...editingRule, calculation_type: e.target.value as StayChargeCalculationType })}
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden"
                  >
                    <option value="FIXED">Nominal Tetap (Rp)</option>
                    <option value="PERCENT_ROOM_RATE">% dari Tarif Kamar Per Malam</option>
                    <option value="FULL_NIGHT_RATE">Tarif 1 Malam Penuh</option>
                    <option value="FREE">Gratis (Rp 0)</option>
                    <option value="MANUAL">Input Bebas / Manual saat Posting</option>
                  </select>
                </div>

                {editingRule.calculation_type === 'FIXED' && (
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Nominal Default (Rp) *</label>
                    <input
                      type="number"
                      min={0}
                      value={editingRule.default_amount ?? 0}
                      onChange={(e) => setEditingRule({ ...editingRule, default_amount: Number(e.target.value) })}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden font-mono"
                    />
                  </div>
                )}

                {editingRule.calculation_type === 'PERCENT_ROOM_RATE' && (
                  <div>
                    <label className="block font-semibold text-stone-700 mb-1">Persentase (%) *</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={editingRule.percentage_of_rate ?? 0}
                      onChange={(e) => setEditingRule({ ...editingRule, percentage_of_rate: Number(e.target.value) })}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-[#1e3a29] focus:outline-hidden font-mono"
                    />
                  </div>
                )}

                {(editingRule.charge_type === 'EARLY_CHECKIN' || editingRule.charge_type === 'LATE_CHECKOUT') && (
                  <>
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">Min Jam (Batas Awal)</label>
                      <input
                        type="number"
                        min={0}
                        max={24}
                        placeholder="Contoh: 1 (jam)"
                        value={editingRule.min_hours ?? 0}
                        onChange={(e) => setEditingRule({ ...editingRule, min_hours: Number(e.target.value) })}
                        className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-stone-700 mb-1">Max Jam (Batas Akhir)</label>
                      <input
                        type="number"
                        min={0}
                        max={24}
                        placeholder="Contoh: 4 (jam)"
                        value={editingRule.max_hours ?? 0}
                        onChange={(e) => setEditingRule({ ...editingRule, max_hours: Number(e.target.value) })}
                        className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white font-mono"
                      />
                    </div>
                  </>
                )}

                <div className="md:col-span-2">
                  <label className="block font-semibold text-stone-700 mb-1">Keterangan / Catatan</label>
                  <textarea
                    rows={2}
                    placeholder="Keterangan opsional untuk Front Office"
                    value={editingRule.description || ''}
                    onChange={(e) => setEditingRule({ ...editingRule, description: e.target.value })}
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white"
                  />
                </div>

                <div className="md:col-span-2 flex flex-wrap gap-6 pt-2 border-t border-stone-200">
                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-stone-800">
                    <input
                      type="checkbox"
                      checked={editingRule.is_taxable || false}
                      onChange={(e) => setEditingRule({ ...editingRule, is_taxable: e.target.checked })}
                      className="rounded text-[#1e3a29] focus:ring-[#1e3a29]"
                    />
                    Kena Pajak PB1/PPN (Taxable)
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-stone-800">
                    <input
                      type="checkbox"
                      checked={editingRule.is_service_chargeable || false}
                      onChange={(e) => setEditingRule({ ...editingRule, is_service_chargeable: e.target.checked })}
                      className="rounded text-[#1e3a29] focus:ring-[#1e3a29]"
                    />
                    Kena Service Charge
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-stone-800">
                    <input
                      type="checkbox"
                      checked={editingRule.is_active !== false}
                      onChange={(e) => setEditingRule({ ...editingRule, is_active: e.target.checked })}
                      className="rounded text-[#1e3a29] focus:ring-[#1e3a29]"
                    />
                    Status Aktif
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-stone-200">
                <button
                  type="button"
                  onClick={() => setEditingRule(null)}
                  className="px-4 py-2 border border-stone-300 text-stone-700 font-semibold rounded-lg hover:bg-stone-100 text-xs"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-5 py-2 bg-[#1e3a29] hover:bg-[#162b1e] text-white font-bold rounded-lg shadow-sm text-xs flex items-center gap-1.5"
                >
                  {loading ? 'Menyimpan...' : '💾 Simpan Aturan'}
                </button>
              </div>
            </form>
          ) : (
            /* Rules Table */
            <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#f7f4ed] border-b border-stone-200 text-stone-700 font-bold">
                    <th className="py-3 px-3">Kode / Tipe</th>
                    <th className="py-3 px-3">Nama Aturan</th>
                    <th className="py-3 px-3">Perhitungan</th>
                    <th className="py-3 px-3 text-right">Tarif Default</th>
                    <th className="py-3 px-3 text-center">Pajak / Servis</th>
                    <th className="py-3 px-3 text-center">Status</th>
                    <th className="py-3 px-3 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {filteredRules.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-stone-400">
                        Belum ada aturan stay charge yang dibuat untuk kategori ini.
                      </td>
                    </tr>
                  ) : (
                    filteredRules.map((rule) => {
                      const meta = CHARGE_TYPE_LABELS[rule.charge_type] || { label: rule.charge_type, badge: 'bg-stone-100' };
                      return (
                        <tr key={rule.id} className="hover:bg-[#faf8f5] transition-colors">
                          <td className="py-2.5 px-3">
                            <div className="font-mono font-bold text-stone-900">{rule.code}</div>
                            <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border mt-0.5 font-semibold ${meta.badge}`}>
                              {meta.label}
                            </span>
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="font-bold text-stone-900">{rule.name}</div>
                            {rule.description && (
                              <div className="text-[11px] text-stone-500 mt-0.5 line-clamp-1">{rule.description}</div>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-stone-700">
                            <div>{CALC_TYPE_LABELS[rule.calculation_type] || rule.calculation_type}</div>
                            {rule.calculation_type === 'PERCENT_ROOM_RATE' && (
                              <span className="font-mono font-semibold text-emerald-700">{rule.percentage_of_rate}% per malam</span>
                            )}
                            {(rule.min_hours || rule.max_hours) ? (
                              <span className="text-[10px] text-stone-500 block">
                                Jam: {rule.min_hours || 0} - {rule.max_hours || 24} jam
                              </span>
                            ) : null}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-stone-900">
                            {rule.calculation_type === 'FIXED' ? (
                              `Rp ${Number(rule.default_amount).toLocaleString('id-ID')}`
                            ) : rule.calculation_type === 'FREE' ? (
                              <span className="text-emerald-700 font-semibold">Gratis</span>
                            ) : rule.calculation_type === 'PERCENT_ROOM_RATE' ? (
                              `${rule.percentage_of_rate}%`
                            ) : (
                              'Variabel'
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <div className="flex items-center justify-center gap-1">
                              {rule.is_taxable && (
                                <span className="px-1.5 py-0.5 bg-sky-50 text-sky-800 border border-sky-200 rounded text-[10px] font-bold" title="Kena Pajak PB1">
                                  TAX
                                </span>
                              )}
                              {rule.is_service_chargeable && (
                                <span className="px-1.5 py-0.5 bg-amber-50 text-amber-800 border border-amber-200 rounded text-[10px] font-bold" title="Kena Service Charge">
                                  SVC
                                </span>
                              )}
                              {!rule.is_taxable && !rule.is_service_chargeable && (
                                <span className="text-stone-400 text-[11px]">-</span>
                              )}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              rule.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-600'
                            }`}>
                              {rule.is_active ? 'Aktif' : 'Nonaktif'}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => setEditingRule(rule)}
                                className="px-2 py-1 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded font-semibold text-[11px] transition-colors"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => handleDelete(rule)}
                                className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded font-semibold text-[11px] transition-colors"
                              >
                                Hapus
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
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-[#fdfbf7] border-t border-stone-200 flex items-center justify-between text-xs text-stone-500 shrink-0">
          <span>OAK HIMS Stay Charge Engine · Total {rules.length} Aturan</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-stone-200 hover:bg-stone-300 text-stone-800 font-semibold rounded-lg transition-colors"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
