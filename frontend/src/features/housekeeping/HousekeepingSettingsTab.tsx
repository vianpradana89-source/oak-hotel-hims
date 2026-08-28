import React, { useState, useEffect, useCallback } from 'react';
import type {
  PropertyHousekeepingSettings,
  ChecklistTemplate,
  ChecklistTemplateItem,
  HkFindingType,
  FindingSeverity
} from './housekeepingTypes';

interface HousekeepingSettingsTabProps {
  propertyId: number;
  settings: PropertyHousekeepingSettings | null;
  templates: ChecklistTemplate[];
  featureFlags?: Record<string, boolean>;
  onSaveSettings: (settings: Partial<PropertyHousekeepingSettings>) => Promise<void>;
  onUpdateFeatureFlag?: (featureKey: string, enabled: boolean) => Promise<void>;
  isLoading: boolean;
  apiBaseUrl?: string;
}

export const HousekeepingSettingsTab: React.FC<HousekeepingSettingsTabProps> = ({
  propertyId,
  settings,
  templates: initialTemplates,
  featureFlags = {},
  onSaveSettings,
  onUpdateFeatureFlag,
  isLoading,
  apiBaseUrl = '/api'
}) => {
  const [subTab, setSubTab] = useState<'OPERATIONAL' | 'TEMPLATES' | 'FINDING_TYPES'>('OPERATIONAL');

  const [requireFinalInspection, setRequireFinalInspection] = useState<boolean>(
    Boolean(settings?.require_final_inspection)
  );
  const [requireCheckoutRoomCheck, setRequireCheckoutRoomCheck] = useState<boolean>(
    Boolean(settings?.require_checkout_room_check)
  );
  const [allowCalendarOverride, setAllowCalendarOverride] = useState<boolean>(
    Boolean(settings?.allow_calendar_room_status_override)
  );
  const [cleaningTemplateCode, setCleaningTemplateCode] = useState<string>(
    settings?.default_cleaning_template_code ||
    settings?.default_room_cleaning_template_code ||
    'STANDARD_ROOM_CLEANING'
  );
  const [checkoutTemplateCode, setCheckoutTemplateCode] = useState<string>(
    settings?.default_checkout_template_code ||
    settings?.default_checkout_inspection_template_code ||
    'CHECKOUT_INSPECTION'
  );

  const [localFlags, setLocalFlags] = useState<Record<string, boolean>>(featureFlags);
  const [isSaving, setIsSaving] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [templates, setTemplates] = useState<ChecklistTemplate[]>(initialTemplates);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(
    initialTemplates[0]?.id || null
  );
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ChecklistTemplateItem | null>(null);
  const [itemForm, setItemForm] = useState<{
    section: string;
    label: string;
    is_required: boolean;
    requires_note: boolean;
    requires_photo: boolean;
    is_active: boolean;
  }>({
    section: 'CHECKLIST',
    label: '',
    is_required: true,
    requires_note: false,
    requires_photo: false,
    is_active: true
  });
  const [isTemplateItemSaving, setIsTemplateItemSaving] = useState(false);

  const [findingTypes, setFindingTypes] = useState<HkFindingType[]>([]);
  const [isFindingTypesLoading, setIsFindingTypesLoading] = useState(false);
  const [findingModalOpen, setFindingModalOpen] = useState(false);
  const [editingFindingType, setEditingFindingType] = useState<HkFindingType | null>(null);
  const [findingForm, setFindingForm] = useState<{
    code: string;
    label: string;
    description: string;
    severity: FindingSeverity;
    is_active: boolean;
    note_required: boolean;
    photo_required: boolean;
    estimated_charge_allowed: boolean;
    supervisor_review_required: boolean;
  }>({
    code: '',
    label: '',
    description: '',
    severity: 'MEDIUM',
    is_active: true,
    note_required: false,
    photo_required: false,
    estimated_charge_allowed: true,
    supervisor_review_required: false
  });
  const [isFindingTypeSaving, setIsFindingTypeSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setRequireFinalInspection(Boolean(settings.require_final_inspection));
      setRequireCheckoutRoomCheck(Boolean(settings.require_checkout_room_check));
      setAllowCalendarOverride(Boolean(settings.allow_calendar_room_status_override));
      setCleaningTemplateCode(
        settings.default_cleaning_template_code ||
        settings.default_room_cleaning_template_code ||
        'STANDARD_ROOM_CLEANING'
      );
      setCheckoutTemplateCode(
        settings.default_checkout_template_code ||
        settings.default_checkout_inspection_template_code ||
        'CHECKOUT_INSPECTION'
      );
    }
  }, [settings]);

  useEffect(() => {
    setLocalFlags(featureFlags);
  }, [featureFlags]);

  useEffect(() => {
    setTemplates(initialTemplates);
    if (initialTemplates.length > 0 && !selectedTemplateId) {
      setSelectedTemplateId(initialTemplates[0].id);
    }
  }, [initialTemplates, selectedTemplateId]);

  const refreshTemplates = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates?property_id=${propertyId}`);
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          setTemplates(json.data);
          if (!selectedTemplateId && json.data.length > 0) {
            setSelectedTemplateId(json.data[0].id);
          }
        }
      }
    } catch (err) {
      console.error('Failed to reload templates:', err);
    }
  }, [apiBaseUrl, propertyId, selectedTemplateId]);

  const fetchFindingTypes = useCallback(async () => {
    setIsFindingTypesLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/finding-types?property_id=${propertyId}&scope=all`);
      if (res.ok) {
        const json = await res.json();
        setFindingTypes(json.data || []);
      }
    } catch (err) {
      console.error('Failed to load finding types:', err);
    } finally {
      setIsFindingTypesLoading(false);
    }
  }, [apiBaseUrl, propertyId]);

  useEffect(() => {
    if (subTab === 'FINDING_TYPES') {
      fetchFindingTypes();
    }
  }, [subTab, fetchFindingTypes]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0];

  const handleSavePolicy = async () => {
    setIsSaving(true);
    setFeedbackMsg(null);
    try {
      await onSaveSettings({
        require_final_inspection: requireFinalInspection,
        require_checkout_room_check: requireCheckoutRoomCheck,
        allow_calendar_room_status_override: allowCalendarOverride,
        default_cleaning_template_code: cleaningTemplateCode,
        default_room_cleaning_template_code: cleaningTemplateCode,
        default_checkout_template_code: checkoutTemplateCode,
        default_checkout_inspection_template_code: checkoutTemplateCode
      });
      setFeedbackMsg({ type: 'success', text: 'Pengaturan kebijakan housekeeping berhasil disimpan.' });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal menyimpan pengaturan housekeeping.' });
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

  const handleOpenAddTemplateItem = () => {
    setEditingItem(null);
    setItemForm({
      section: selectedTemplate?.code === 'CHECKOUT_INSPECTION' ? 'CHECKOUT_INSPECTION' : 'BEDROOM',
      label: '',
      is_required: true,
      requires_note: false,
      requires_photo: false,
      is_active: true
    });
    setItemModalOpen(true);
  };

  const handleOpenEditTemplateItem = (item: ChecklistTemplateItem) => {
    setEditingItem(item);
    setItemForm({
      section: item.section,
      label: item.label,
      is_required: item.is_required,
      requires_note: item.requires_note,
      requires_photo: item.requires_photo,
      is_active: item.is_active
    });
    setItemModalOpen(true);
  };

  const handleSaveTemplateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTemplate) return;
    setIsTemplateItemSaving(true);
    setFeedbackMsg(null);
    try {
      if (editingItem) {
        const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/items/${editingItem.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...itemForm })
        });
        if (!res.ok) throw new Error('Gagal mengubah butir checklist');
      } else {
        const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...itemForm })
        });
        if (!res.ok) throw new Error('Gagal menambahkan butir checklist');
      }
      setItemModalOpen(false);
      await refreshTemplates();
      setFeedbackMsg({ type: 'success', text: `Butir checklist berhasil ${editingItem ? 'diperbarui' : 'ditambahkan'}.` });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Terjadi kesalahan sistem.' });
    } finally {
      setIsTemplateItemSaving(false);
    }
  };

  const handleToggleTemplateItemActive = async (item: ChecklistTemplateItem) => {
    if (!selectedTemplate) return;
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, is_active: !item.is_active })
      });
      if (!res.ok) throw new Error('Gagal mengubah status aktif butir checklist');
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengubah status butir checklist' });
    }
  };

  const handleReorderTemplateItems = async (itemIndex: number, direction: 'up' | 'down') => {
    if (!selectedTemplate || !selectedTemplate.items) return;
    const items = [...selectedTemplate.items];
    const targetIndex = direction === 'up' ? itemIndex - 1 : itemIndex + 1;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    const [moved] = items.splice(itemIndex, 1);
    items.splice(targetIndex, 0, moved);
    try {
      await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, item_ids: items.map((i) => i.id) })
      });
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengatur urutan butir checklist' });
    }
  };

  const handleOpenAddFindingType = () => {
    setEditingFindingType(null);
    setFindingForm({
      code: '',
      label: '',
      description: '',
      severity: 'MEDIUM',
      is_active: true,
      note_required: false,
      photo_required: false,
      estimated_charge_allowed: true,
      supervisor_review_required: false
    });
    setFindingModalOpen(true);
  };

  const handleOpenEditFindingType = (ft: HkFindingType) => {
    setEditingFindingType(ft);
    setFindingForm({
      code: ft.code,
      label: ft.label,
      description: ft.description || '',
      severity: ft.severity,
      is_active: ft.is_active,
      note_required: ft.note_required,
      photo_required: ft.photo_required,
      estimated_charge_allowed: ft.estimated_charge_allowed,
      supervisor_review_required: ft.supervisor_review_required
    });
    setFindingModalOpen(true);
  };

  const handleSaveFindingType = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsFindingTypeSaving(true);
    setFeedbackMsg(null);
    try {
      if (editingFindingType) {
        const res = await fetch(`${apiBaseUrl}/housekeeping/finding-types/${editingFindingType.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...findingForm })
        });
        if (!res.ok) throw new Error('Gagal mengubah jenis temuan');
      } else {
        const res = await fetch(`${apiBaseUrl}/housekeeping/finding-types`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...findingForm })
        });
        if (!res.ok) throw new Error('Gagal menambahkan jenis temuan');
      }
      setFindingModalOpen(false);
      await fetchFindingTypes();
      setFeedbackMsg({ type: 'success', text: `Jenis temuan berhasil ${editingFindingType ? 'diperbarui' : 'ditambahkan'}.` });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Terjadi kesalahan sistem.' });
    } finally {
      setIsFindingTypeSaving(false);
    }
  };

  const handleToggleFindingActive = async (ft: HkFindingType) => {
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/finding-types/${ft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, is_active: !ft.is_active })
      });
      if (!res.ok) throw new Error('Gagal mengubah status aktif jenis temuan');
      await fetchFindingTypes();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengubah status jenis temuan' });
    }
  };

  const handleReorderFindingTypes = async (index: number, direction: 'up' | 'down') => {
    const list = [...findingTypes];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return;
    const [moved] = list.splice(index, 1);
    list.splice(targetIndex, 0, moved);
    try {
      await fetch(`${apiBaseUrl}/housekeeping/finding-types/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, item_ids: list.map((i) => i.id) })
      });
      await fetchFindingTypes();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengatur urutan jenis temuan' });
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
      <div className="flex items-center gap-2 border-b border-neutral-200 pb-3">
        <button type="button" onClick={() => setSubTab('OPERATIONAL')} className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${subTab === 'OPERATIONAL' ? 'bg-[#1b4332] text-white shadow-xs' : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'}`}>Kebijakan & Modul</button>
        <button type="button" onClick={() => setSubTab('TEMPLATES')} className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${subTab === 'TEMPLATES' ? 'bg-[#1b4332] text-white shadow-xs' : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'}`}>Template Checklist ({templates.length})</button>
        <button type="button" onClick={() => setSubTab('FINDING_TYPES')} className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all ${subTab === 'FINDING_TYPES' ? 'bg-[#1b4332] text-white shadow-xs' : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'}`}>Katalog Jenis Temuan ({findingTypes.length > 0 ? findingTypes.length : '10'})</button>
      </div>

      {feedbackMsg && (
        <div className={`p-3.5 rounded-xl text-xs font-semibold border flex items-center justify-between ${feedbackMsg.type === 'success' ? 'bg-emerald-50 text-emerald-900 border-emerald-200' : 'bg-red-50 text-red-900 border-red-200'}`}>
          <span>{feedbackMsg.text}</span>
          <button type="button" onClick={() => setFeedbackMsg(null)} className="text-xs opacity-70 hover:opacity-100 ml-4 font-bold">✕</button>
        </div>
      )}

      {subTab === 'OPERATIONAL' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-neutral-200/90 p-5 shadow-xs">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <h3 className="text-sm font-bold text-neutral-900">Master Switch Modul Housekeeping</h3>
                  <span className="text-xs font-mono text-neutral-400">housekeeping.enabled</span>
                </div>
                <p className="text-xs text-neutral-500 mt-1">Mengaktifkan operasional kebersihan kamar, alur penugasan staff, validasi checkout, dan integrasi kesiapan kamar Front Desk.</p>
              </div>
              <button type="button" disabled={togglingKey === 'housekeeping.enabled'} onClick={() => handleToggleFeature('housekeeping.enabled', isMasterEnabled)} className={`px-4 py-2 text-xs font-bold rounded-xl transition-colors shrink-0 shadow-xs cursor-pointer ${isMasterEnabled ? 'bg-emerald-700 text-white hover:bg-emerald-800' : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'}`}>
                {togglingKey === 'housekeeping.enabled' ? 'Memproses...' : isMasterEnabled ? 'AKTIF' : 'NONAKTIF'}
              </button>
            </div>
          </div>

          <div className={`bg-white rounded-2xl border border-neutral-200/90 p-5 shadow-xs space-y-4 transition-opacity ${!isMasterEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div>
              <h3 className="text-sm font-bold text-neutral-900">Sub-Fitur & Workflow Housekeeping</h3>
              <p className="text-xs text-neutral-500">Konfigurasi alur kerja dan integrasi departemen operasional.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-neutral-900">Pemeriksaan Kamar Checkout</span>
                    <span className="text-[10px] font-mono text-neutral-400">housekeeping.checkout_inspection</span>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">Inspeksi minibar, linen rusak, dan inventaris kamar sebelum tamu meninggalkan hotel.</p>
                </div>
                <button type="button" disabled={togglingKey === 'housekeeping.checkout_inspection'} onClick={() => handleToggleFeature('housekeeping.checkout_inspection', localFlags['housekeeping.checkout_inspection'] !== false)} className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${localFlags['housekeeping.checkout_inspection'] !== false ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-neutral-200 text-neutral-600'}`}>{localFlags['housekeeping.checkout_inspection'] !== false ? 'ON' : 'OFF'}</button>
              </div>
              <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-neutral-900">Final Inspection Supervisor</span>
                    <span className="text-[10px] font-mono text-neutral-400">housekeeping.final_inspection</span>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">Verifikasi kualitas kamar oleh Supervisor sebelum status kamar berubah menjadi INSPECTED / Siap Jual.</p>
                </div>
                <button type="button" disabled={togglingKey === 'housekeeping.final_inspection'} onClick={() => handleToggleFeature('housekeeping.final_inspection', localFlags['housekeeping.final_inspection'] !== false)} className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${localFlags['housekeeping.final_inspection'] !== false ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-neutral-200 text-neutral-600'}`}>{localFlags['housekeeping.final_inspection'] !== false ? 'ON' : 'OFF'}</button>
              </div>
              <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-neutral-900">Permintaan Layanan Tamu</span>
                    <span className="text-[10px] font-mono text-neutral-400">housekeeping.service_requests</span>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">Pengantaran extra amenities, handuk, bantal, dan permintaan guest delivery dari Front Desk.</p>
                </div>
                <button type="button" disabled={togglingKey === 'housekeeping.service_requests'} onClick={() => handleToggleFeature('housekeeping.service_requests', localFlags['housekeeping.service_requests'] !== false)} className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${localFlags['housekeeping.service_requests'] !== false ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-neutral-200 text-neutral-600'}`}>{localFlags['housekeeping.service_requests'] !== false ? 'ON' : 'OFF'}</button>
              </div>
              <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-neutral-900">Tugas Internal Departemen</span>
                    <span className="text-[10px] font-mono text-neutral-400">housekeeping.department_tasks</span>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">Pekerjaan internal, persiapan shift, restocking trolley, dan koordinasi antar departemen.</p>
                </div>
                <button type="button" disabled={togglingKey === 'housekeeping.department_tasks'} onClick={() => handleToggleFeature('housekeeping.department_tasks', localFlags['housekeeping.department_tasks'] !== false)} className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 ${localFlags['housekeeping.department_tasks'] !== false ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-neutral-200 text-neutral-600'}`}>{localFlags['housekeeping.department_tasks'] !== false ? 'ON' : 'OFF'}</button>
              </div>
            </div>
          </div>

          <div className={`bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs transition-opacity ${!isMasterEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-neutral-900">Kebijakan Operasional Housekeeping</h3>
                <p className="text-xs text-neutral-500">Aturan kesiapan kamar, validasi checkout FO, dan otoritas status fisik.</p>
              </div>
              <button type="button" disabled={isSaving} onClick={handleSavePolicy} className="px-4 py-2 text-xs font-bold text-white bg-[#1b4332] rounded-xl hover:bg-[#143326] transition-colors shadow-xs cursor-pointer">{isSaving ? 'Menyimpan...' : 'Simpan Kebijakan'}</button>
            </div>
            <div className="p-5 space-y-4">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input type="checkbox" checked={requireFinalInspection} onChange={(e) => setRequireFinalInspection(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500" />
                <div>
                  <div className="text-xs font-bold text-neutral-800">Wajibkan Final Inspection oleh Supervisor</div>
                  <p className="text-xs text-neutral-500 mt-0.5">Kamar yang selesai dibersihkan (VACANT_CLEAN) otomatis membuat tugas FINAL_INSPECTION untuk supervisor sebelum berstatus INSPECTED.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input type="checkbox" checked={requireCheckoutRoomCheck} onChange={(e) => setRequireCheckoutRoomCheck(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500" />
                <div>
                  <div className="text-xs font-bold text-neutral-800">Wajibkan Pemeriksaan Kamar Sebelum Final Checkout (Mandatory FO Room Check)</div>
                  <p className="text-xs text-neutral-500 mt-0.5">Jika diaktifkan, Front Office tidak dapat menyelesaikan checkout tamu sebelum tugas pemeriksaan minibar/kerusakan diselesaikan oleh Housekeeping (status DONE).</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input type="checkbox" checked={allowCalendarOverride} onChange={(e) => setAllowCalendarOverride(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500" />
                <div>
                  <div className="text-xs font-bold text-neutral-800">Izinkan Kalender Mengubah Status Kesiapan Kamar (Override)</div>
                  <p className="text-xs text-neutral-500 mt-0.5">Default: <span className="font-semibold text-neutral-700">Nonaktif</span>. Housekeeping adalah otoritas tunggal kesiapan fisik kamar.</p>
                </div>
              </label>
              <div className="pt-3 border-t border-neutral-100 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-neutral-800 mb-1">Template Pembersihan Kamar (Default)</label>
                  <select value={cleaningTemplateCode} onChange={(e) => setCleaningTemplateCode(e.target.value)} className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    {templates.map((tpl) => (<option key={tpl.id} value={tpl.code}>{tpl.name} ({tpl.code})</option>))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-800 mb-1">Template Pemeriksaan Checkout (Default)</label>
                  <select value={checkoutTemplateCode} onChange={(e) => setCheckoutTemplateCode(e.target.value)} className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    {templates.map((tpl) => (<option key={tpl.id} value={tpl.code}>{tpl.name} ({tpl.code})</option>))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {subTab === 'TEMPLATES' && (
        <div className="bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs">
          <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-neutral-900">Editor Template Checklist Housekeeping</h3>
              <p className="text-xs text-neutral-500">Atur butir periksa standard untuk Pembersihan Kamar, Pemeriksaan Checkout, dan Inspeksi Supervisor.</p>
            </div>
            {selectedTemplate && (
              <button type="button" onClick={handleOpenAddTemplateItem} className="px-3.5 py-1.5 text-xs font-bold text-white bg-[#1b4332] rounded-xl hover:bg-[#143326] transition-colors shadow-xs flex items-center gap-1.5 cursor-pointer"><span>+</span> Tambah Butir Periksa</button>
            )}
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2 border-r border-neutral-200 pr-4">
              <div className="text-[11px] font-bold text-neutral-500 uppercase tracking-wider mb-2">Pilih Template</div>
              {templates.map((tpl) => (
                <button key={tpl.id} type="button" onClick={() => setSelectedTemplateId(tpl.id)} className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer ${selectedTemplateId === tpl.id ? 'bg-emerald-50/70 border-emerald-600 text-emerald-950 font-semibold shadow-xs' : 'bg-white border-neutral-200 hover:bg-neutral-50 text-neutral-700'}`}>
                  <div className="text-xs font-bold">{tpl.name}</div>
                  <div className="text-[11px] text-neutral-500 mt-0.5 flex items-center justify-between">
                    <span>{tpl.task_type}</span>
                    <span className="font-medium text-neutral-600">{tpl.items?.length || 0} butir</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="md:col-span-2 space-y-4">
              {selectedTemplate ? (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h4 className="text-xs font-bold text-neutral-900 uppercase tracking-wider">{selectedTemplate.name}</h4>
                      <p className="text-[11px] text-neutral-500">Kode: <span className="font-mono">{selectedTemplate.code}</span> • Tipe: {selectedTemplate.task_type}</p>
                    </div>
                    <span className="px-2.5 py-0.5 text-xs font-bold rounded-full bg-emerald-100 text-emerald-800">{selectedTemplate.items?.length || 0} Butir</span>
                  </div>
                  <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
                    {selectedTemplate.items && selectedTemplate.items.length > 0 ? (
                      selectedTemplate.items.map((item, idx) => (
                        <div key={item.id} className={`p-3 rounded-xl border flex items-center justify-between text-xs transition-all ${item.is_active ? 'bg-white border-neutral-200 shadow-2xs' : 'bg-neutral-100/70 border-neutral-200 opacity-60'}`}>
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className="flex flex-col gap-0.5 shrink-0">
                              <button type="button" disabled={idx === 0} onClick={() => handleReorderTemplateItems(idx, 'up')} className="w-5 h-4 bg-neutral-100 hover:bg-neutral-200 disabled:opacity-30 rounded text-[9px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer">▲</button>
                              <button type="button" disabled={idx === (selectedTemplate.items?.length || 1) - 1} onClick={() => handleReorderTemplateItems(idx, 'down')} className="w-5 h-4 bg-neutral-100 hover:bg-neutral-200 disabled:opacity-30 rounded text-[9px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer">▼</button>
                            </div>
                            <span className="w-5 h-5 rounded-full bg-neutral-100 text-neutral-600 flex items-center justify-center text-[10px] font-bold shrink-0">{idx + 1}</span>
                            <div className="truncate">
                              <div className="font-semibold text-neutral-900 truncate">{item.label}</div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[10px] font-mono text-neutral-400 uppercase">{item.section}</span>
                                {item.is_required ? <span className="text-[9px] font-bold text-red-700 bg-red-50 px-1.5 py-0.2 rounded border border-red-200">Wajib</span> : <span className="text-[9px] font-bold text-neutral-600 bg-neutral-100 px-1.5 py-0.2 rounded">Opsional</span>}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-3">
                            <button type="button" onClick={() => handleToggleTemplateItemActive(item)} className={`px-2 py-0.5 text-[10px] font-bold rounded-lg transition-colors cursor-pointer ${item.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-200 text-neutral-600'}`}>{item.is_active ? 'Aktif' : 'Nonaktif'}</button>
                            <button type="button" onClick={() => handleOpenEditTemplateItem(item)} className="px-2.5 py-1 text-[11px] font-bold text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors cursor-pointer">Edit</button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="p-8 text-center text-xs text-neutral-400 bg-neutral-50 rounded-xl border border-dashed border-neutral-200">Belum ada butir checklist.</div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-xs text-neutral-400">Pilih template di panel kiri.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {subTab === 'FINDING_TYPES' && (
        <div className="bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs">
          <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-neutral-900">Katalog Jenis Temuan Kamar</h3>
              <p className="text-xs text-neutral-500">Konfigurasi jenis temuan checkout/kerusakan.</p>
            </div>
            <button type="button" onClick={handleOpenAddFindingType} className="px-3.5 py-1.5 text-xs font-bold text-white bg-[#1b4332] rounded-xl hover:bg-[#143326] transition-colors shadow-xs flex items-center gap-1.5 cursor-pointer"><span>+</span> Tambah Jenis Temuan</button>
          </div>
          <div className="p-5">
            {isFindingTypesLoading ? (
              <div className="p-8 text-center text-xs text-neutral-500">Memuat katalog...</div>
            ) : findingTypes.length === 0 ? (
              <div className="p-8 text-center text-xs text-neutral-400 bg-neutral-50 rounded-xl border border-dashed border-neutral-200">Belum ada jenis temuan.</div>
            ) : (
              <div className="space-y-2.5">
                {findingTypes.map((ft, idx) => (
                  <div key={ft.id} className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition-all ${ft.is_active ? 'bg-white border-neutral-200 shadow-2xs' : 'bg-neutral-100/70 border-neutral-200 opacity-60'}`}>
                    <div className="flex items-start sm:items-center gap-3 flex-1 min-w-0">
                      <div className="flex flex-col gap-0.5 shrink-0 mt-0.5 sm:mt-0">
                        <button type="button" disabled={idx === 0} onClick={() => handleReorderFindingTypes(idx, 'up')} className="w-5 h-4 bg-neutral-100 hover:bg-neutral-200 disabled:opacity-30 rounded text-[9px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer">▲</button>
                        <button type="button" disabled={idx === findingTypes.length - 1} onClick={() => handleReorderFindingTypes(idx, 'down')} className="w-5 h-4 bg-neutral-100 hover:bg-neutral-200 disabled:opacity-30 rounded text-[9px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer">▼</button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-neutral-900 text-xs">{ft.label}</span>
                          <span className="text-[10px] font-mono text-neutral-400 bg-neutral-100 px-1.5 py-0.2 rounded">{ft.code}</span>
                        </div>
                        {ft.description && <p className="text-[11px] text-neutral-500 mt-0.5 truncate">{ft.description}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                      <button type="button" onClick={() => handleToggleFindingActive(ft)} className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition-colors cursor-pointer ${ft.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-200 text-neutral-600'}`}>{ft.is_active ? 'Aktif' : 'Nonaktif'}</button>
                      <button type="button" onClick={() => handleOpenEditFindingType(ft)} className="px-3 py-1 text-[11px] font-bold text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors cursor-pointer">Edit</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {itemModalOpen && selectedTemplate && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-neutral-200 overflow-hidden">
            <div className="px-5 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
              <h4 className="text-sm font-bold text-neutral-900">{editingItem ? 'Edit Butir Checklist' : 'Tambah Butir Checklist'}</h4>
              <button type="button" onClick={() => setItemModalOpen(false)} className="text-neutral-400 hover:text-neutral-700 font-bold cursor-pointer">✕</button>
            </div>
            <form onSubmit={handleSaveTemplateItem} className="p-5 space-y-4 text-xs">
              <div>
                <label className="block font-bold text-neutral-700 mb-1">Nama / Label *</label>
                <input type="text" required value={itemForm.label} onChange={(e) => setItemForm({ ...itemForm, label: e.target.value })} className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs" />
              </div>
              <div>
                <label className="block font-bold text-neutral-700 mb-1">Kategori / Section</label>
                <input type="text" required value={itemForm.section} onChange={(e) => setItemForm({ ...itemForm, section: e.target.value.toUpperCase() })} className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono text-xs" />
              </div>
              <div className="space-y-2 pt-2 border-t border-neutral-100">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={itemForm.is_required} onChange={(e) => setItemForm({ ...itemForm, is_required: e.target.checked })} className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500" />
                  <span className="font-semibold text-neutral-800">Wajib Diperiksa</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={itemForm.requires_photo} onChange={(e) => setItemForm({ ...itemForm, requires_photo: e.target.checked })} className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500" />
                  <span className="font-semibold text-neutral-800">Wajib Lampirkan Foto</span>
                </label>
              </div>
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-100">
                <button type="button" onClick={() => setItemModalOpen(false)} className="px-4 py-2 font-bold text-neutral-600 hover:bg-neutral-100 rounded-xl cursor-pointer">Batal</button>
                <button type="submit" disabled={isTemplateItemSaving} className="px-4 py-2 font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl shadow-xs cursor-pointer">{isTemplateItemSaving ? 'Menyimpan...' : 'Simpan Butir'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {findingModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg border border-neutral-200 overflow-hidden">
            <div className="px-5 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
              <h4 className="text-sm font-bold text-neutral-900">{editingFindingType ? 'Edit Jenis Temuan' : 'Tambah Jenis Temuan'}</h4>
              <button type="button" onClick={() => setFindingModalOpen(false)} className="text-neutral-400 hover:text-neutral-700 font-bold cursor-pointer">✕</button>
            </div>
            <form onSubmit={handleSaveFindingType} className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-neutral-700 mb-1">Kode Unik *</label>
                  <input type="text" required value={findingForm.code} onChange={(e) => setFindingForm({ ...findingForm, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 font-mono text-xs focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="block font-bold text-neutral-700 mb-1">Severity</label>
                  <select value={findingForm.severity} onChange={(e) => setFindingForm({ ...findingForm, severity: e.target.value as FindingSeverity })} className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:ring-2 focus:ring-emerald-500">
                    <option value="INFO">INFO</option>
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                    <option value="CRITICAL">CRITICAL</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-bold text-neutral-700 mb-1">Label *</label>
                <input type="text" required value={findingForm.label} onChange={(e) => setFindingForm({ ...findingForm, label: e.target.value })} className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:ring-2 focus:ring-emerald-500" />
              </div>
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-100">
                <button type="button" onClick={() => setFindingModalOpen(false)} className="px-4 py-2 font-bold text-neutral-600 hover:bg-neutral-100 rounded-xl cursor-pointer">Batal</button>
                <button type="submit" disabled={isFindingTypeSaving} className="px-4 py-2 font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl shadow-xs cursor-pointer">{isFindingTypeSaving ? 'Menyimpan...' : 'Simpan Jenis Temuan'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
