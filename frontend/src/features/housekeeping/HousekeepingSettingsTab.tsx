import React, { useState, useEffect } from 'react';
import type {
  PropertyHousekeepingSettings,
  ChecklistTemplate
} from './housekeepingTypes';

interface HousekeepingSettingsTabProps {
  propertyId: number;
  settings: PropertyHousekeepingSettings | null;
  templates: ChecklistTemplate[];
  featureFlags?: Record<string, boolean>;
  onSaveSettings: (settings: Partial<PropertyHousekeepingSettings>) => Promise<void>;
  onUpdateFeatureFlag?: (featureKey: string, enabled: boolean) => Promise<void>;
  isLoading: boolean;
}

export const HousekeepingSettingsTab: React.FC<HousekeepingSettingsTabProps> = ({
  propertyId: _propertyId,
  settings,
  templates,
  featureFlags = {},
  onSaveSettings,
  onUpdateFeatureFlag,
  isLoading
}) => {
  const [requireFinalInspection, setRequireFinalInspection] = useState(
    settings?.require_final_inspection || false
  );
  const [requireCheckoutRoomCheck, setRequireCheckoutRoomCheck] = useState(
    settings?.require_checkout_room_check || false
  );
  const [allowCalendarOverride, setAllowCalendarOverride] = useState(
    settings?.allow_calendar_room_status_override || false
  );

  const [localFlags, setLocalFlags] = useState<Record<string, boolean>>(featureFlags);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(
    templates[0]?.id || null
  );
  const [isSaving, setIsSaving] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (settings) {
      setRequireFinalInspection(settings.require_final_inspection || false);
      setRequireCheckoutRoomCheck(settings.require_checkout_room_check || false);
      setAllowCalendarOverride(settings.allow_calendar_room_status_override || false);
    }
  }, [settings]);

  useEffect(() => {
    setLocalFlags(featureFlags);
  }, [featureFlags]);

  useEffect(() => {
    if (templates.length > 0 && !selectedTemplateId) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0];

  const handleSavePolicy = async () => {
    setIsSaving(true);
    setFeedbackMsg(null);
    try {
      await onSaveSettings({
        require_final_inspection: requireFinalInspection,
        require_checkout_room_check: requireCheckoutRoomCheck,
        allow_calendar_room_status_override: allowCalendarOverride
      });
      setFeedbackMsg({ type: 'success', text: 'Kebijakan operasional Housekeeping berhasil diperbarui.' });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal menyimpan pengaturan.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleFeature = async (key: string, currentValue: boolean) => {
    const newValue = !currentValue;
    setTogglingKey(key);
    setFeedbackMsg(null);
    try {
      if (onUpdateFeatureFlag) {
        await onUpdateFeatureFlag(key, newValue);
      }
      setLocalFlags((prev) => ({ ...prev, [key]: newValue }));
      setFeedbackMsg({
        type: 'success',
        text: `Fitur ${key} berhasil di-${newValue ? 'aktifkan' : 'nonaktifkan'}.`
      });
    } catch (err: any) {
      setFeedbackMsg({
        type: 'error',
        text: err.message || `Gagal mengubah status fitur ${key}.`
      });
    } finally {
      setTogglingKey(null);
    }
  };

  const isMasterEnabled = localFlags['housekeeping.enabled'] !== false;

  if (isLoading && !settings) {
    return (
      <div className="p-8 text-center text-xs text-neutral-500">
        Memuat konfigurasi modul housekeeping...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {feedbackMsg && (
        <div
          className={`p-3.5 rounded-xl text-xs font-semibold border flex items-center justify-between ${
            feedbackMsg.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          <span>{feedbackMsg.text}</span>
          <button
            type="button"
            onClick={() => setFeedbackMsg(null)}
            className="text-neutral-400 hover:text-neutral-700 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {/* 1. Master Switch Card */}
      <div className={`p-5 rounded-2xl border transition-all ${
        isMasterEnabled
          ? 'bg-emerald-50/40 border-emerald-200/80'
          : 'bg-rose-50/40 border-rose-200/80'
      }`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className={`w-3 h-3 rounded-full ${isMasterEnabled ? 'bg-emerald-600 animate-pulse' : 'bg-rose-500'}`} />
              <h3 className="text-base font-bold text-neutral-900">
                Master Switch: Modul Housekeeping
              </h3>
              <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${
                isMasterEnabled ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
              }`}>
                {isMasterEnabled ? 'AKTIF' : 'NONAKTIF'}
              </span>
            </div>
            <p className="text-xs text-neutral-600 mt-1">
              {isMasterEnabled
                ? 'Modul Housekeeping aktif penuh. Kesiapan fisik kamar, turnover, inspeksi, dan checklist operasional berfungsi normal.'
                : 'Modul Housekeeping dinonaktifkan. UI navigasi HK disembunyikan, pembuatan tugas otomatis ditangguhkan, dan API operasional HK ditolak. Seluruh data historis tetap utuh.'}
            </p>
          </div>

          <button
            type="button"
            disabled={togglingKey === 'housekeeping.enabled'}
            onClick={() => handleToggleFeature('housekeeping.enabled', isMasterEnabled)}
            className={`px-4 py-2 text-xs font-bold rounded-xl transition-all shadow-xs shrink-0 cursor-pointer ${
              isMasterEnabled
                ? 'bg-rose-600 hover:bg-rose-700 text-white'
                : 'bg-emerald-700 hover:bg-emerald-800 text-white'
            }`}
          >
            {togglingKey === 'housekeeping.enabled'
              ? 'Memproses...'
              : isMasterEnabled
              ? 'Nonaktifkan Modul'
              : 'Aktifkan Modul'}
          </button>
        </div>
      </div>

      {/* 2. Sub-Feature Toggles Card */}
      <div className={`bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs transition-opacity ${
        !isMasterEnabled ? 'opacity-50 pointer-events-none' : ''
      }`}>
        <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-neutral-900">Sub-Fitur & Kapabilitas Housekeeping</h3>
            <p className="text-xs text-neutral-500">Kontrol granular untuk mengaktifkan atau menonaktifkan fitur operasional spesifik.</p>
          </div>
          <span className="text-[11px] font-semibold text-neutral-400">Authoritative Property Scope</span>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Room Operations */}
          <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-neutral-900">Operasi & Pembersihan Kamar</span>
                <span className="text-[10px] font-mono text-neutral-400">housekeeping.room_operations</span>
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                Pembersihan kamar harian, stayover, deep clean, dan auto-create tugas turnover saat checkout.
              </p>
            </div>
            <button
              type="button"
              disabled={togglingKey === 'housekeeping.room_operations'}
              onClick={() => handleToggleFeature('housekeeping.room_operations', localFlags['housekeeping.room_operations'] !== false)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${
                localFlags['housekeeping.room_operations'] !== false
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : 'bg-neutral-200 text-neutral-600'
              }`}
            >
              {localFlags['housekeeping.room_operations'] !== false ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Checkout Inspection */}
          <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-neutral-900">Pemeriksaan Checkout (FO Room Check)</span>
                <span className="text-[10px] font-mono text-neutral-400">housekeeping.checkout_inspection</span>
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                Inspeksi minibar & kerusakan fisik saat tamu checkout melalui Front Office clearance.
              </p>
            </div>
            <button
              type="button"
              disabled={togglingKey === 'housekeeping.checkout_inspection'}
              onClick={() => handleToggleFeature('housekeeping.checkout_inspection', localFlags['housekeeping.checkout_inspection'] !== false)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${
                localFlags['housekeeping.checkout_inspection'] !== false
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : 'bg-neutral-200 text-neutral-600'
              }`}
            >
              {localFlags['housekeeping.checkout_inspection'] !== false ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Final Inspection */}
          <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-neutral-900">Final Inspeksi Supervisor</span>
                <span className="text-[10px] font-mono text-neutral-400">housekeeping.final_inspection</span>
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                Alur verifikasi supervisor sebelum kamar berpindah ke status siap huni (INSPECTED).
              </p>
            </div>
            <button
              type="button"
              disabled={togglingKey === 'housekeeping.final_inspection'}
              onClick={() => handleToggleFeature('housekeeping.final_inspection', localFlags['housekeeping.final_inspection'] !== false)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${
                localFlags['housekeeping.final_inspection'] !== false
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : 'bg-neutral-200 text-neutral-600'
              }`}
            >
              {localFlags['housekeeping.final_inspection'] !== false ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Guest Service Requests */}
          <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-neutral-900">Permintaan Layanan Tamu</span>
                <span className="text-[10px] font-mono text-neutral-400">housekeeping.service_requests</span>
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                Pengantaran extra amenities, handuk, bantal, dan permintaan guest delivery dari Front Desk.
              </p>
            </div>
            <button
              type="button"
              disabled={togglingKey === 'housekeeping.service_requests'}
              onClick={() => handleToggleFeature('housekeeping.service_requests', localFlags['housekeeping.service_requests'] !== false)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${
                localFlags['housekeeping.service_requests'] !== false
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : 'bg-neutral-200 text-neutral-600'
              }`}
            >
              {localFlags['housekeeping.service_requests'] !== false ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Department Tasks */}
          <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-neutral-900">Tugas Internal Departemen</span>
                <span className="text-[10px] font-mono text-neutral-400">housekeeping.department_tasks</span>
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                Pekerjaan internal, persiapan shift, restocking trolley, dan koordinasi antar departemen.
              </p>
            </div>
            <button
              type="button"
              disabled={togglingKey === 'housekeeping.department_tasks'}
              onClick={() => handleToggleFeature('housekeeping.department_tasks', localFlags['housekeeping.department_tasks'] !== false)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${
                localFlags['housekeeping.department_tasks'] !== false
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : 'bg-neutral-200 text-neutral-600'
              }`}
            >
              {localFlags['housekeeping.department_tasks'] !== false ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Future Modules (Roadmap Preview) */}
          <div className="p-4 rounded-xl border border-dashed border-neutral-300 bg-neutral-50/30 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-neutral-600">Laundry, Linen & Lost/Found</span>
                <span className="px-1.5 py-0.2 text-[9px] font-bold bg-amber-100 text-amber-800 rounded">Roadmap</span>
              </div>
              <p className="text-xs text-neutral-400 mt-1">
                Stok linen, perlengkapan amenities, operasional laundry kiloan/satuan, dan pencatatan Lost & Found.
              </p>
            </div>
            <span className="px-2.5 py-1 text-[11px] font-semibold bg-neutral-100 text-neutral-400 rounded-lg">
              Coming Soon
            </span>
          </div>
        </div>
      </div>

      {/* 3. Operational Policies Card */}
      <div className={`bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs transition-opacity ${
        !isMasterEnabled ? 'opacity-50 pointer-events-none' : ''
      }`}>
        <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-neutral-900">Kebijakan Operasional Housekeeping</h3>
            <p className="text-xs text-neutral-500">Aturan kesiapan kamar, validasi checkout FO, dan otoritas status fisik.</p>
          </div>
          <button
            type="button"
            disabled={isSaving}
            onClick={handleSavePolicy}
            className="px-4 py-2 text-xs font-bold text-white bg-emerald-700 rounded-xl hover:bg-emerald-800 transition-colors shadow-xs cursor-pointer"
          >
            {isSaving ? 'Menyimpan...' : 'Simpan Kebijakan'}
          </button>
        </div>

        <div className="p-5 space-y-4">
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={requireFinalInspection}
              onChange={(e) => setRequireFinalInspection(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
            />
            <div>
              <div className="text-xs font-bold text-neutral-800">Wajibkan Final Inspection oleh Supervisor</div>
              <p className="text-xs text-neutral-500 mt-0.5">
                Kamar yang selesai dibersihkan (VACANT_CLEAN) otomatis membuat tugas FINAL_INSPECTION untuk supervisor sebelum berstatus INSPECTED.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={requireCheckoutRoomCheck}
              onChange={(e) => setRequireCheckoutRoomCheck(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
            />
            <div>
              <div className="text-xs font-bold text-neutral-800">Wajibkan Pemeriksaan Kamar Sebelum Final Checkout (Mandatory FO Room Check)</div>
              <p className="text-xs text-neutral-500 mt-0.5">
                Jika diaktifkan, Front Office tidak dapat menyelesaikan checkout tamu sebelum tugas pemeriksaan minibar/kerusakan diselesaikan oleh Housekeeping (status DONE).
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowCalendarOverride}
              onChange={(e) => setAllowCalendarOverride(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
            />
            <div>
              <div className="text-xs font-bold text-neutral-800">Izinkan Kalender Mengubah Status Kesiapan Kamar (Override)</div>
              <p className="text-xs text-neutral-500 mt-0.5">
                Default: <span className="font-semibold text-neutral-700">Nonaktif</span>. Housekeeping adalah otoritas tunggal kesiapan fisik kamar. Kalender hanya menampilkan indikator kesiapan secara read-only.
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* 4. Checklist Templates Card */}
      <div className={`bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs transition-opacity ${
        !isMasterEnabled ? 'opacity-50 pointer-events-none' : ''
      }`}>
        <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90">
          <h3 className="text-sm font-bold text-neutral-900">Template Checklist Standard</h3>
          <p className="text-xs text-neutral-500">Standarisasi butir periksa untuk pembersihan kamar, inspeksi checkout, dan evaluasi supervisor.</p>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Template List */}
          <div className="space-y-2 border-r border-neutral-200 pr-4">
            <div className="text-[11px] font-bold text-neutral-500 uppercase tracking-wider mb-2">Pilih Template</div>
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => setSelectedTemplateId(tpl.id)}
                className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer ${
                  (selectedTemplateId === tpl.id || (!selectedTemplateId && tpl.id === templates[0]?.id))
                    ? 'bg-emerald-50/70 border-emerald-600 text-emerald-950 font-semibold shadow-xs'
                    : 'bg-white border-neutral-200 hover:bg-neutral-50 text-neutral-700'
                }`}
              >
                <div className="text-xs font-bold">{tpl.name}</div>
                <div className="text-[11px] text-neutral-500 mt-0.5 flex items-center justify-between">
                  <span>{tpl.task_type}</span>
                  <span className="font-medium text-neutral-600">{tpl.items?.length || 0} butir</span>
                </div>
              </button>
            ))}
          </div>

          {/* Template Items Detail */}
          <div className="md:col-span-2 space-y-4">
            {selectedTemplate ? (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="text-xs font-bold text-neutral-900 uppercase tracking-wider">{selectedTemplate.name}</h4>
                    <p className="text-[11px] text-neutral-500">Kode: {selectedTemplate.code} • Tipe: {selectedTemplate.task_type}</p>
                  </div>
                  <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">
                    Aktif
                  </span>
                </div>

                <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
                  {selectedTemplate.items && selectedTemplate.items.length > 0 ? (
                    selectedTemplate.items.map((item, idx) => (
                      <div
                        key={item.id}
                        className="p-2.5 bg-neutral-50 rounded-xl border border-neutral-200/80 flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="w-5 h-5 rounded-full bg-neutral-200 text-neutral-700 flex items-center justify-center text-[10px] font-bold">
                            {idx + 1}
                          </span>
                          <span className="font-medium text-neutral-800">{item.label}</span>
                          {item.is_required && (
                            <span className="text-[10px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">
                              Wajib
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-neutral-400 uppercase tracking-wider font-semibold">
                          {item.section}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="p-4 text-center text-xs text-neutral-400">
                      Tidak ada butir checklist.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-neutral-400">
                Pilih template untuk melihat butir checklist.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
