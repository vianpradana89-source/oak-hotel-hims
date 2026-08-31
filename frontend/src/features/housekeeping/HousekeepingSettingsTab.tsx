import React, { useState, useEffect, useCallback } from 'react';
import type {
  PropertyHousekeepingSettings,
  ChecklistTemplate,
  ChecklistTemplateGroup,
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
  const [categoryBulkCheckEnabled, setCategoryBulkCheckEnabled] = useState<boolean>(
    Boolean(settings?.housekeeping_category_bulk_check_enabled)
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
  const [finalInspectionTemplateCode, setFinalInspectionTemplateCode] = useState<string>(
    settings?.default_final_inspection_template_code || 'FINAL_INSPECTION'
  );

  const [localFlags, setLocalFlags] = useState<Record<string, boolean>>(featureFlags);
  const [isSaving, setIsSaving] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Templates Management State
  const [templates, setTemplates] = useState<ChecklistTemplate[]>(initialTemplates);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(
    initialTemplates[0]?.id || null
  );

  // Template Master Modal State
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ChecklistTemplate | null>(null);
  const [templateForm, setTemplateForm] = useState<{
    name: string;
    code: string;
    task_type: string;
    description: string;
    sort_order: number;
    is_active: boolean;
    requires_verification: boolean;
  }>({
    name: '',
    code: '',
    task_type: 'ROOM_CLEANING',
    description: '',
    sort_order: 0,
    is_active: true,
    requires_verification: false
  });
  const [isTemplateSaving, setIsTemplateSaving] = useState(false);

  // Checklist Group Modal State (EMP-MOBILE-3F)
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ChecklistTemplateGroup | null>(null);
  const [groupForm, setGroupForm] = useState<{
    name: string;
    code: string;
    description: string;
    is_active: boolean;
  }>({
    name: '',
    code: '',
    description: '',
    is_active: true
  });
  const [isGroupSaving, setIsGroupSaving] = useState(false);

  // Checklist Item Modal State
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ChecklistTemplateItem | null>(null);
  const [itemForm, setItemForm] = useState<{
    group_id: number | null;
    section: string;
    label: string;
    description: string;
    is_required: boolean;
    requires_note: boolean;
    requires_photo: boolean;
    is_active: boolean;
  }>({
    group_id: null,
    section: 'BEDROOM',
    label: '',
    description: '',
    is_required: true,
    requires_note: false,
    requires_photo: false,
    is_active: true
  });
  const [isTemplateItemSaving, setIsTemplateItemSaving] = useState(false);

  // Drag & Drop tracking state
  const [draggedGroupIndex, setDraggedGroupIndex] = useState<number | null>(null);
  const [draggedItemInfo, setDraggedItemInfo] = useState<{ groupId: number | null; itemIndex: number; itemId: number } | null>(null);

  // Finding Types State
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
    block_room_ready: boolean;
  }>({
    code: '',
    label: '',
    description: '',
    severity: 'MEDIUM',
    is_active: true,
    note_required: false,
    photo_required: false,
    estimated_charge_allowed: true,
    supervisor_review_required: false,
    block_room_ready: false
  });
  const [isFindingTypeSaving, setIsFindingTypeSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setRequireFinalInspection(Boolean(settings.require_final_inspection));
      setRequireCheckoutRoomCheck(Boolean(settings.require_checkout_room_check));
      setAllowCalendarOverride(Boolean(settings.allow_calendar_room_status_override));
      setCategoryBulkCheckEnabled(Boolean(settings.housekeeping_category_bulk_check_enabled));
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
      setFinalInspectionTemplateCode(
        settings.default_final_inspection_template_code || 'FINAL_INSPECTION'
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
        housekeeping_category_bulk_check_enabled: categoryBulkCheckEnabled,
        default_cleaning_template_code: cleaningTemplateCode,
        default_room_cleaning_template_code: cleaningTemplateCode,
        default_checkout_template_code: checkoutTemplateCode,
        default_checkout_inspection_template_code: checkoutTemplateCode,
        default_final_inspection_template_code: finalInspectionTemplateCode
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

  // ---------------------------------------------------------------------------
  // Template Master Actions
  // ---------------------------------------------------------------------------

  const handleOpenAddTemplate = () => {
    setEditingTemplate(null);
    setTemplateForm({
      name: '',
      code: '',
      task_type: 'ROOM_CLEANING',
      description: '',
      sort_order: (templates.length + 1) * 10,
      is_active: true,
      requires_verification: false
    });
    setTemplateModalOpen(true);
  };

  const handleOpenEditTemplate = (template: ChecklistTemplate) => {
    setEditingTemplate(template);
    setTemplateForm({
      name: template.name,
      code: template.code,
      task_type: template.task_type,
      description: template.description || '',
      sort_order: template.sort_order || 0,
      is_active: template.is_active,
      requires_verification: template.requires_verification
    });
    setTemplateModalOpen(true);
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsTemplateSaving(true);
    setFeedbackMsg(null);
    try {
      if (editingTemplate) {
        const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${editingTemplate.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...templateForm })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal mengubah template');
        setFeedbackMsg({ type: 'success', text: `Template "${templateForm.name}" berhasil diperbarui.` });
      } else {
        const res = await fetch(`${apiBaseUrl}/housekeeping/templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...templateForm })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal membuat template');
        if (data.data?.id) setSelectedTemplateId(data.data.id);
        setFeedbackMsg({ type: 'success', text: `Template "${templateForm.name}" berhasil dibuat.` });
      }
      setTemplateModalOpen(false);
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Terjadi kesalahan sistem.' });
    } finally {
      setIsTemplateSaving(false);
    }
  };

  const handleDuplicateTemplate = async (template: ChecklistTemplate) => {
    try {
      setIsSaving(true);
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${template.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menduplikasi template');
      if (data.data?.id) setSelectedTemplateId(data.data.id);
      setFeedbackMsg({ type: 'success', text: `Template "${template.name}" berhasil diduplikasi.` });
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal menduplikasi template' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleTemplateActive = async (template: ChecklistTemplate) => {
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${template.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, is_active: !template.is_active })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mengubah status template');
      await refreshTemplates();
      setFeedbackMsg({ type: 'success', text: `Status template "${template.name}" diperbarui.` });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengubah status template' });
    }
  };

  const handleDeleteOrArchiveTemplate = async (template: ChecklistTemplate) => {
    const isSystem = template.is_system_template;
    const confirmMsg = isSystem
      ? `Template sistem "${template.name}" akan dinonaktifkan / diarsipkan secara aman. Lanjutkan?`
      : `Hapus / arsipkan template "${template.name}"?`;
    if (!window.confirm(confirmMsg)) return;

    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${template.id}?property_id=${propertyId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menghapus/mengarsipkan template');
      await refreshTemplates();
      setFeedbackMsg({
        type: 'success',
        text: `Template "${template.name}" ${data.data?.archived ? 'diarsipkan' : 'dihapus'}.`
      });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal menghapus/mengarsipkan template' });
    }
  };

  // ---------------------------------------------------------------------------
  // Checklist Groups Actions (EMP-MOBILE-3F)
  // ---------------------------------------------------------------------------

  const handleOpenAddGroup = () => {
    setEditingGroup(null);
    setGroupForm({
      name: '',
      code: '',
      description: '',
      is_active: true
    });
    setGroupModalOpen(true);
  };

  const handleOpenEditGroup = (group: ChecklistTemplateGroup) => {
    setEditingGroup(group);
    setGroupForm({
      name: group.name,
      code: group.code || '',
      description: group.description || '',
      is_active: group.is_active
    });
    setGroupModalOpen(true);
  };

  const handleSaveGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTemplate) return;
    setIsGroupSaving(true);
    setFeedbackMsg(null);
    try {
      if (editingGroup) {
        const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/groups/${editingGroup.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...groupForm })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal mengubah grup checklist');
        setFeedbackMsg({ type: 'success', text: `Grup "${groupForm.name}" berhasil diperbarui.` });
      } else {
        const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/groups`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...groupForm })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Gagal membuat grup checklist');
        setFeedbackMsg({ type: 'success', text: `Grup "${groupForm.name}" berhasil dibuat.` });
      }
      setGroupModalOpen(false);
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Terjadi kesalahan sistem.' });
    } finally {
      setIsGroupSaving(false);
    }
  };

  const handleToggleGroupActive = async (group: ChecklistTemplateGroup) => {
    if (!selectedTemplate) return;
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/groups/${group.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, is_active: !group.is_active })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal mengubah status grup');
      await refreshTemplates();
      setFeedbackMsg({ type: 'success', text: `Status grup "${group.name}" diperbarui.` });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengubah status grup' });
    }
  };

  const handleDeleteOrArchiveGroup = async (group: ChecklistTemplateGroup) => {
    if (!selectedTemplate) return;
    const confirmMsg = `Hapus atau arsipkan grup "${group.name}" beserta butir checklist di dalamnya?`;
    if (!window.confirm(confirmMsg)) return;

    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/groups/${group.id}?property_id=${propertyId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menghapus/mengarsipkan grup');
      await refreshTemplates();
      setFeedbackMsg({
        type: 'success',
        text: `Grup "${group.name}" ${data.data?.archived ? 'diarsipkan' : 'dihapus'}.`
      });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal menghapus/mengarsipkan grup' });
    }
  };

  const handleReorderGroups = async (groupIndex: number, direction: 'up' | 'down') => {
    if (!selectedTemplate || !selectedTemplate.groups) return;
    const groups = [...selectedTemplate.groups];
    const targetIndex = direction === 'up' ? groupIndex - 1 : groupIndex + 1;
    if (targetIndex < 0 || targetIndex >= groups.length) return;
    const [moved] = groups.splice(groupIndex, 1);
    groups.splice(targetIndex, 0, moved);

    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/groups/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          groups: groups.map((g, idx) => ({ id: g.id, sort_order: idx + 1 }))
        })
      });
      if (!res.ok) throw new Error('Gagal mengatur urutan grup');
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengatur urutan grup' });
    }
  };

  const handleDragDropGroup = async (fromIndex: number, toIndex: number) => {
    if (!selectedTemplate || !selectedTemplate.groups || fromIndex === toIndex) return;
    const groups = [...selectedTemplate.groups];
    if (fromIndex < 0 || fromIndex >= groups.length || toIndex < 0 || toIndex >= groups.length) return;
    const [moved] = groups.splice(fromIndex, 1);
    groups.splice(toIndex, 0, moved);

    try {
      await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/groups/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          groups: groups.map((g, idx) => ({ id: g.id, sort_order: idx + 1 }))
        })
      });
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengatur urutan grup' });
    }
  };

  // ---------------------------------------------------------------------------
  // Checklist Items Actions
  // ---------------------------------------------------------------------------

  const handleOpenAddTemplateItem = (targetGroupId?: number | null) => {
    setEditingItem(null);
    let defaultGroupId: number | null = null;
    if (targetGroupId !== undefined) {
      defaultGroupId = targetGroupId;
    } else if (selectedTemplate?.groups && selectedTemplate.groups.length > 0) {
      defaultGroupId = selectedTemplate.groups[0].id;
    }

    setItemForm({
      group_id: defaultGroupId,
      section: selectedTemplate?.code === 'CHECKOUT_INSPECTION' ? 'CHECKOUT_INSPECTION' : 'BEDROOM',
      label: '',
      description: '',
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
      group_id: item.group_id ?? null,
      section: item.section,
      label: item.label,
      description: item.description || '',
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

  const handleDeleteOrArchiveTemplateItem = async (item: ChecklistTemplateItem) => {
    if (!selectedTemplate) return;
    if (!window.confirm(`Hapus / arsipkan butir checklist "${item.label}"?`)) return;

    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/items/${item.id}?property_id=${propertyId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Gagal menghapus/mengarsipkan butir checklist');
      await refreshTemplates();
      setFeedbackMsg({ type: 'success', text: `Butir "${item.label}" ${data.data?.archived ? 'diarsipkan' : 'dihapus'}.` });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal menghapus/mengarsipkan butir checklist' });
    }
  };

  const handleReorderItemsInGroup = async (
    groupItems: ChecklistTemplateItem[],
    itemIndex: number,
    direction: 'up' | 'down'
  ) => {
    if (!selectedTemplate) return;
    const items = [...groupItems];
    const targetIndex = direction === 'up' ? itemIndex - 1 : itemIndex + 1;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    const [moved] = items.splice(itemIndex, 1);
    items.splice(targetIndex, 0, moved);

    try {
      const reorderPayload = items.map((it, idx) => ({
        id: it.id,
        group_id: it.group_id ?? null,
        sort_order: idx + 1
      }));

      await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/items/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, items: reorderPayload })
      });
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal mengatur urutan butir checklist' });
    }
  };

  const handleDragDropItem = async (
    dragged: { groupId: number | null; itemIndex: number; itemId: number },
    targetGroupId: number | null,
    targetIndex: number
  ) => {
    if (!selectedTemplate) return;
    // Build new list with dragged item moved to target group and target index
    const allItems = [...(selectedTemplate.items || [])];
    const itemIdx = allItems.findIndex((i) => i.id === dragged.itemId);
    if (itemIdx < 0) return;

    const [item] = allItems.splice(itemIdx, 1);
    item.group_id = targetGroupId;

    // Filter items in the target group
    const targetGroupItems = allItems.filter((i) => (i.group_id ?? null) === targetGroupId);
    targetGroupItems.splice(targetIndex, 0, item);

    const reorderPayload = targetGroupItems.map((it, idx) => ({
      id: it.id,
      group_id: targetGroupId,
      sort_order: idx + 1
    }));

    try {
      await fetch(`${apiBaseUrl}/housekeeping/templates/${selectedTemplate.id}/items/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, items: reorderPayload })
      });
      await refreshTemplates();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Gagal memindahkan butir checklist' });
    }
  };

  // ---------------------------------------------------------------------------
  // Finding Types Catalog Actions
  // ---------------------------------------------------------------------------

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
      supervisor_review_required: false,
      block_room_ready: false
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
      supervisor_review_required: ft.supervisor_review_required,
      block_room_ready: ft.block_room_ready
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
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || 'Gagal memperbarui jenis temuan.');
        }
      } else {
        const res = await fetch(`${apiBaseUrl}/housekeeping/finding-types`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: propertyId, ...findingForm })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.message || 'Gagal menambahkan jenis temuan.');
        }
      }
      setFindingModalOpen(false);
      await fetchFindingTypes();
      setFeedbackMsg({
        type: 'success',
        text: `Katalog jenis temuan berhasil ${editingFindingType ? 'diperbarui' : 'ditambahkan'}.`
      });
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

  const handleReorderFindingTypes = async (itemIndex: number, direction: 'up' | 'down') => {
    const list = [...findingTypes];
    const targetIndex = direction === 'up' ? itemIndex - 1 : itemIndex + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return;
    const [moved] = list.splice(itemIndex, 1);
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
        <button
          type="button"
          onClick={() => setSubTab('OPERATIONAL')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            subTab === 'OPERATIONAL'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'
          }`}
        >
          Kebijakan & Modul
        </button>
        <button
          type="button"
          onClick={() => setSubTab('TEMPLATES')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            subTab === 'TEMPLATES'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'
          }`}
        >
          Template Checklist ({templates.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab('FINDING_TYPES')}
          className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            subTab === 'FINDING_TYPES'
              ? 'bg-[#1b4332] text-white shadow-xs'
              : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'
          }`}
        >
          Katalog Jenis Temuan ({findingTypes.length > 0 ? findingTypes.length : '10'})
        </button>
      </div>

      {feedbackMsg && (
        <div
          className={`p-3.5 rounded-xl text-xs font-semibold border flex items-center justify-between ${
            feedbackMsg.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          <span>{feedbackMsg.text}</span>
          <button type="button" onClick={() => setFeedbackMsg(null)} className="text-xs opacity-70 hover:opacity-100 ml-4 font-bold cursor-pointer">
            ✕
          </button>
        </div>
      )}

      {/* SUBTAB 1: OPERATIONAL POLICIES */}
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
                <p className="text-xs text-neutral-500 mt-1">
                  Mengaktifkan operasional kebersihan kamar, alur penugasan staff, validasi checkout, dan integrasi kesiapan kamar Front Desk.
                </p>
              </div>
              <button
                type="button"
                disabled={togglingKey === 'housekeeping.enabled'}
                onClick={() => handleToggleFeature('housekeeping.enabled', isMasterEnabled)}
                className={`px-4 py-2 text-xs font-bold rounded-xl transition-colors shrink-0 shadow-xs cursor-pointer ${
                  isMasterEnabled ? 'bg-emerald-700 text-white hover:bg-emerald-800' : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
                }`}
              >
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
                <button
                  type="button"
                  disabled={togglingKey === 'housekeeping.checkout_inspection'}
                  onClick={() => handleToggleFeature('housekeeping.checkout_inspection', localFlags['housekeeping.checkout_inspection'] !== false)}
                  className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 cursor-pointer ${
                    localFlags['housekeeping.checkout_inspection'] !== false ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-neutral-200 text-neutral-600'
                  }`}
                >
                  {localFlags['housekeeping.checkout_inspection'] !== false ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-neutral-900">Final Inspection Supervisor</span>
                    <span className="text-[10px] font-mono text-neutral-400">housekeeping.final_inspection</span>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">Verifikasi kualitas kamar oleh Supervisor sebelum status kamar berubah menjadi INSPECTED / Siap Jual.</p>
                </div>
                <button
                  type="button"
                  disabled={togglingKey === 'housekeeping.final_inspection'}
                  onClick={() => handleToggleFeature('housekeeping.final_inspection', localFlags['housekeeping.final_inspection'] !== false)}
                  className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 cursor-pointer ${
                    localFlags['housekeeping.final_inspection'] !== false ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-neutral-200 text-neutral-600'
                  }`}
                >
                  {localFlags['housekeeping.final_inspection'] !== false ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-neutral-900">Permintaan Layanan Tamu</span>
                    <span className="text-[10px] font-mono text-neutral-400">housekeeping.service_requests</span>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">Pengantaran extra amenities, handuk, bantal, dan permintaan guest delivery dari Front Desk.</p>
                </div>
                <button
                  type="button"
                  disabled={togglingKey === 'housekeeping.service_requests'}
                  onClick={() => handleToggleFeature('housekeeping.service_requests', localFlags['housekeeping.service_requests'] !== false)}
                  className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 cursor-pointer ${
                    localFlags['housekeeping.service_requests'] !== false ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-neutral-200 text-neutral-600'
                  }`}
                >
                  {localFlags['housekeeping.service_requests'] !== false ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="p-4 rounded-xl border border-neutral-200/80 bg-neutral-50/50 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-neutral-900">Tugas Internal Departemen</span>
                    <span className="text-[10px] font-mono text-neutral-400">housekeeping.department_tasks</span>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">Pekerjaan internal, persiapan shift, restocking trolley, dan koordinasi antar departemen.</p>
                </div>
                <button
                  type="button"
                  disabled={togglingKey === 'housekeeping.department_tasks'}
                  onClick={() => handleToggleFeature('housekeeping.department_tasks', localFlags['housekeeping.department_tasks'] !== false)}
                  className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors shrink-0 cursor-pointer ${
                    localFlags['housekeeping.department_tasks'] !== false ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-neutral-200 text-neutral-600'
                  }`}
                >
                  {localFlags['housekeeping.department_tasks'] !== false ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          </div>

          <div className={`bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs transition-opacity ${!isMasterEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-neutral-900">Kebijakan Operasional Housekeeping</h3>
                <p className="text-xs text-neutral-500">Aturan kesiapan kamar, validasi checkout FO, dan otoritas status fisik.</p>
              </div>
              <button
                type="button"
                disabled={isSaving}
                onClick={handleSavePolicy}
                className="px-4 py-2 text-xs font-bold text-white bg-[#1b4332] rounded-xl hover:bg-[#143326] transition-colors shadow-xs cursor-pointer"
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
                  <p className="text-xs text-neutral-500 mt-0.5">Kamar yang selesai dibersihkan (VACANT_CLEAN) otomatis membuat tugas FINAL_INSPECTION untuk supervisor sebelum berstatus INSPECTED.</p>
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
                  <p className="text-xs text-neutral-500 mt-0.5">Jika diaktifkan, Front Office tidak dapat menyelesaikan checkout tamu sebelum tugas pemeriksaan minibar/kerusakan diselesaikan oleh Housekeeping (status DONE).</p>
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
                  <p className="text-xs text-neutral-500 mt-0.5">Default: <span className="font-semibold text-neutral-700">Nonaktif</span>. Housekeeping adalah otoritas tunggal kesiapan fisik kamar.</p>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={categoryBulkCheckEnabled}
                  onChange={(e) => setCategoryBulkCheckEnabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                />
                <div>
                  <div className="text-xs font-bold text-neutral-800">Checklist Semua per Kategori</div>
                  <p className="text-xs text-neutral-500 mt-0.5">Memungkinkan petugas menandai seluruh item yang memenuhi syarat dalam satu kategori sekaligus. Tugas tetap harus diselesaikan dengan tombol Submit Selesai.</p>
                </div>
              </label>

              <div className="pt-3 border-t border-neutral-100 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-bold text-neutral-800 mb-1">Standard Room Cleaning (Default)</label>
                  <select
                    value={cleaningTemplateCode}
                    onChange={(e) => setCleaningTemplateCode(e.target.value)}
                    className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                  >
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.code}>{tpl.name} ({tpl.code})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-800 mb-1">Checkout Inspection (Default)</label>
                  <select
                    value={checkoutTemplateCode}
                    onChange={(e) => setCheckoutTemplateCode(e.target.value)}
                    className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                  >
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.code}>{tpl.name} ({tpl.code})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-800 mb-1">Supervisor Final Inspection (Default)</label>
                  <select
                    value={finalInspectionTemplateCode}
                    onChange={(e) => setFinalInspectionTemplateCode(e.target.value)}
                    className="w-full text-xs bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                  >
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.code}>{tpl.name} ({tpl.code})</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 2: CHECKLIST TEMPLATES MANAGEMENT */}
      {subTab === 'TEMPLATES' && (
        <div className="bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs">
          <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-neutral-900">Editor Template Checklist Housekeeping</h3>
              <p className="text-xs text-neutral-500">Kelola master template dan butir periksa untuk Pembersihan Kamar, Pemeriksaan Checkout, dan Inspeksi Supervisor.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleOpenAddTemplate}
                className="px-3.5 py-1.5 text-xs font-bold text-white bg-[#1b4332] rounded-xl hover:bg-[#143326] transition-colors shadow-xs flex items-center gap-1.5 cursor-pointer"
              >
                <span>+</span> Tambah Template
              </button>
            </div>
          </div>

          <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Left Column: Template List */}
            <div className="space-y-2 border-r border-neutral-200 pr-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-wider">Pilih Template Master</span>
                <span className="text-[10px] text-neutral-400 font-semibold">{templates.length} Template</span>
              </div>
              <div className="space-y-1.5 max-h-[560px] overflow-y-auto pr-1">
                {templates.map((tpl) => {
                  const isDefaultCleaning = cleaningTemplateCode === tpl.code;
                  const isDefaultCheckout = checkoutTemplateCode === tpl.code;
                  const isDefaultFinal = finalInspectionTemplateCode === tpl.code;
                  const totalItems = tpl.items?.length || 0;
                  const activeItems = tpl.items?.filter((i) => i.is_active && !i.is_archived).length || 0;

                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => setSelectedTemplateId(tpl.id)}
                      className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer ${
                        selectedTemplateId === tpl.id
                          ? 'bg-emerald-50/70 border-emerald-600 text-emerald-950 font-semibold shadow-xs'
                          : 'bg-white border-neutral-200 hover:bg-neutral-50 text-neutral-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 flex-wrap">
                        <div className="text-xs font-bold truncate">{tpl.name}</div>
                        <div className="flex items-center gap-1 shrink-0">
                          {tpl.is_system_template && (
                            <span className="text-[9px] font-mono font-bold text-[#1b4332] bg-emerald-100/80 px-1.5 py-0.2 rounded">
                              SISTEM
                            </span>
                          )}
                          {tpl.is_active ? (
                            <span className="text-[9px] font-bold text-emerald-800 bg-emerald-100 px-1.5 py-0.2 rounded-full border border-emerald-200">
                              ● Aktif
                            </span>
                          ) : (
                            <span className="text-[9px] font-bold text-neutral-600 bg-neutral-200 px-1.5 py-0.2 rounded-full border border-neutral-300">
                              ○ Nonaktif
                            </span>
                          )}
                        </div>
                      </div>

                      {(isDefaultCleaning || isDefaultCheckout || isDefaultFinal) && (
                        <div className="mt-1 flex items-center gap-1 flex-wrap">
                          {isDefaultCleaning && (
                            <span className="text-[9px] font-bold text-amber-800 bg-amber-100/90 px-1.5 py-0.2 rounded border border-amber-300">
                              ★ Default Pembersihan Kamar
                            </span>
                          )}
                          {isDefaultCheckout && (
                            <span className="text-[9px] font-bold text-amber-800 bg-amber-100/90 px-1.5 py-0.2 rounded border border-amber-300">
                              ★ Default Checkout
                            </span>
                          )}
                          {isDefaultFinal && (
                            <span className="text-[9px] font-bold text-amber-800 bg-amber-100/90 px-1.5 py-0.2 rounded border border-amber-300">
                              ★ Default Final Inspection
                            </span>
                          )}
                        </div>
                      )}

                      <div className="text-[11px] text-neutral-500 mt-1.5 flex items-center justify-between">
                        <span className="font-mono text-[10px] text-neutral-400">{tpl.code}</span>
                        <span className="font-semibold text-neutral-600 text-[10px]">
                          {totalItems} Butir • {activeItems} Aktif
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Selected Template Detail & Checklist Items */}
            <div className="md:col-span-2 space-y-4">
              {selectedTemplate ? (
                <div>
                  {/* Template Header & Actions */}
                  <div className="p-4 bg-neutral-50/70 rounded-2xl border border-neutral-200/80 mb-4 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-sm font-bold text-neutral-900">{selectedTemplate.name}</h4>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-200/80 text-neutral-700 font-semibold">
                            {selectedTemplate.code}
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            selectedTemplate.is_active ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-neutral-200 text-neutral-700 border-neutral-300'
                          }`}>
                            {selectedTemplate.is_active ? '● Aktif' : '○ Nonaktif'}
                          </span>
                          {cleaningTemplateCode === selectedTemplate.code && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                              ★ Default Pembersihan Kamar
                            </span>
                          )}
                          {checkoutTemplateCode === selectedTemplate.code && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                              ★ Default Checkout Inspection
                            </span>
                          )}
                          {finalInspectionTemplateCode === selectedTemplate.code && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                              ★ Default Supervisor Final Inspection
                            </span>
                          )}
                          {selectedTemplate.is_system_template ? (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-100 text-teal-800 border border-teal-200">
                              Standard Sistem
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                              Kustom
                            </span>
                          )}
                          {selectedTemplate.is_archived && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200">
                              Arsip
                            </span>
                          )}
                        </div>
                        {selectedTemplate.description && (
                          <p className="text-xs text-neutral-600 mt-1">{selectedTemplate.description}</p>
                        )}
                        <p className="text-[11px] text-neutral-500 mt-1">
                          Tipe Tugas: <strong className="text-neutral-800">{selectedTemplate.task_type}</strong>
                          {selectedTemplate.requires_verification && ' • Wajib Verifikasi Supervisor'}
                          {' • '}
                          <span className="font-semibold text-emerald-900">
                            {selectedTemplate.items?.length || 0} Butir Total • {selectedTemplate.items?.filter(i => i.is_active && !i.is_archived).length || 0} Aktif
                          </span>
                        </p>
                      </div>

                      {/* Template Master Action Buttons */}
                      <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                        <button
                          type="button"
                          onClick={() => handleOpenEditTemplate(selectedTemplate)}
                          className="px-2.5 py-1 text-xs font-bold text-neutral-700 bg-white hover:bg-neutral-100 border border-neutral-300 rounded-xl transition cursor-pointer"
                        >
                          Edit Template
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleTemplateActive(selectedTemplate)}
                          className={`px-2.5 py-1 text-xs font-bold rounded-xl transition cursor-pointer ${
                            selectedTemplate.is_active
                              ? 'bg-amber-50 text-amber-900 hover:bg-amber-100 border border-amber-300'
                              : 'bg-emerald-700 text-white hover:bg-emerald-800 shadow-xs'
                          }`}
                        >
                          {selectedTemplate.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDuplicateTemplate(selectedTemplate)}
                          className="px-2.5 py-1 text-xs font-bold text-[#1b4332] bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-xl transition cursor-pointer"
                        >
                          Duplikat
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteOrArchiveTemplate(selectedTemplate)}
                          className="px-2.5 py-1 text-xs font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl transition cursor-pointer"
                        >
                          {selectedTemplate.is_system_template ? 'Arsipkan' : 'Hapus / Arsip'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Checklist Hierarchy Header (EMP-MOBILE-3F) */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-bold text-neutral-900 uppercase tracking-wider">
                        Struktur Grup & Butir Checklist
                      </h4>
                      <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                        {selectedTemplate.groups?.length || 0} Grup • {selectedTemplate.items?.filter(i => i.is_active && !i.is_archived).length || 0} Butir Aktif
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleOpenAddGroup}
                        className="px-3 py-1 text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-300 hover:bg-emerald-100 rounded-xl transition flex items-center gap-1 cursor-pointer"
                      >
                        <span>+</span> Tambah Group
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenAddTemplateItem(null)}
                        className="px-3 py-1 text-xs font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl transition flex items-center gap-1 cursor-pointer shadow-2xs"
                      >
                        <span>+</span> Tambah Butir
                      </button>
                    </div>
                  </div>

                  {/* Checklist Groups & Items Hierarchical List */}
                  <div className="space-y-4 max-h-[560px] overflow-y-auto pr-1">
                    {selectedTemplate.groups && selectedTemplate.groups.length > 0 ? (
                      selectedTemplate.groups.map((group, gIdx) => {
                        const groupItems = (selectedTemplate.items || [])
                          .filter((i) => (i.group_id ?? null) === group.id && !i.is_archived)
                          .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
                        const activeGroupItems = groupItems.filter((i) => i.is_active).length;

                        return (
                          <div
                            key={group.id}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (draggedGroupIndex !== null && draggedGroupIndex !== gIdx) {
                                handleDragDropGroup(draggedGroupIndex, gIdx);
                                setDraggedGroupIndex(null);
                              } else if (draggedItemInfo !== null && draggedItemInfo.groupId !== group.id) {
                                handleDragDropItem(draggedItemInfo, group.id, groupItems.length);
                                setDraggedItemInfo(null);
                              }
                            }}
                            className={`rounded-2xl border transition-all ${
                              group.is_active
                                ? 'bg-white border-neutral-300 shadow-2xs'
                                : 'bg-neutral-50/80 border-neutral-200 opacity-70'
                            }`}
                          >
                            {/* Group Header Card */}
                            <div
                              draggable
                              onDragStart={(e) => {
                                setDraggedGroupIndex(gIdx);
                                e.dataTransfer.setData('text/plain', `group:${group.id}`);
                              }}
                              className="p-3 bg-neutral-100/70 border-b border-neutral-200 rounded-t-2xl flex items-center justify-between gap-3 text-xs"
                            >
                              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                <div className="flex items-center gap-1">
                                  <span
                                    title="Tahan & geser untuk mengubah urutan grup"
                                    className="cursor-grab active:cursor-grabbing text-neutral-400 hover:text-neutral-700 font-mono text-sm px-1"
                                  >
                                    ☰
                                  </span>
                                  <div className="flex flex-col gap-0.5">
                                    <button
                                      type="button"
                                      disabled={gIdx === 0}
                                      onClick={() => handleReorderGroups(gIdx, 'up')}
                                      className="w-4 h-3.5 bg-white hover:bg-neutral-200 disabled:opacity-30 rounded text-[8px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer border border-neutral-200"
                                      title="Pindah ke atas"
                                    >
                                      ▲
                                    </button>
                                    <button
                                      type="button"
                                      disabled={gIdx === (selectedTemplate.groups?.length || 1) - 1}
                                      onClick={() => handleReorderGroups(gIdx, 'down')}
                                      className="w-4 h-3.5 bg-white hover:bg-neutral-200 disabled:opacity-30 rounded text-[8px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer border border-neutral-200"
                                      title="Pindah ke bawah"
                                    >
                                      ▼
                                    </button>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 flex-wrap min-w-0">
                                  <span className="font-bold text-sm text-neutral-900 truncate">
                                    {gIdx + 1}. {group.name}
                                  </span>
                                  {group.code && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-neutral-200/80 text-neutral-600 font-semibold">
                                      {group.code}
                                    </span>
                                  )}
                                  {group.is_active ? (
                                    <span className="text-[9px] font-bold text-emerald-800 bg-emerald-100 px-1.5 py-0.2 rounded border border-emerald-200">
                                      ● Aktif
                                    </span>
                                  ) : (
                                    <span className="text-[9px] font-bold text-neutral-600 bg-neutral-200 px-1.5 py-0.2 rounded border border-neutral-300">
                                      ○ Nonaktif
                                    </span>
                                  )}
                                  <span className="text-[10px] text-neutral-500 font-medium">
                                    ({activeGroupItems}/{groupItems.length} butir aktif)
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleOpenAddTemplateItem(group.id)}
                                  className="px-2 py-0.5 text-[10px] font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors cursor-pointer"
                                  title={`Tambah butir ke grup ${group.name}`}
                                >
                                  + Butir
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleOpenEditGroup(group)}
                                  className="px-2 py-0.5 text-[10px] font-bold text-neutral-700 bg-white hover:bg-neutral-100 border border-neutral-300 rounded-lg transition-colors cursor-pointer"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleToggleGroupActive(group)}
                                  className={`px-2 py-0.5 text-[10px] font-bold rounded-lg transition-colors cursor-pointer border ${
                                    group.is_active
                                      ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
                                      : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                                  }`}
                                >
                                  {group.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteOrArchiveGroup(group)}
                                  className="px-2 py-0.5 text-[10px] font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors cursor-pointer"
                                >
                                  Hapus
                                </button>
                              </div>
                            </div>

                            {/* Group Items List */}
                            <div className="p-2.5 space-y-1.5">
                              {groupItems.length > 0 ? (
                                groupItems.map((item, iIdx) => (
                                  <div
                                    key={item.id}
                                    draggable
                                    onDragStart={(e) => {
                                      setDraggedItemInfo({ groupId: group.id, itemIndex: iIdx, itemId: item.id });
                                      e.dataTransfer.setData('text/plain', `item:${item.id}`);
                                    }}
                                    onDragOver={(e) => {
                                      e.preventDefault();
                                      e.dataTransfer.dropEffect = 'move';
                                    }}
                                    onDrop={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      if (draggedItemInfo) {
                                        handleDragDropItem(draggedItemInfo, group.id, iIdx);
                                        setDraggedItemInfo(null);
                                      }
                                    }}
                                    className={`p-2.5 rounded-xl border flex items-center justify-between text-xs transition-all ${
                                      item.is_active
                                        ? 'bg-neutral-50/50 hover:bg-white border-neutral-200 shadow-2xs'
                                        : 'bg-neutral-100/70 border-neutral-200 opacity-60'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                      <div className="flex items-center gap-1">
                                        <span
                                          title="Geser untuk mengatur urutan atau memindahkan antar grup"
                                          className="cursor-grab active:cursor-grabbing text-neutral-400 hover:text-neutral-700 font-mono text-xs px-0.5"
                                        >
                                          ☰
                                        </span>
                                        <div className="flex flex-col gap-0.5 shrink-0">
                                          <button
                                            type="button"
                                            disabled={iIdx === 0}
                                            onClick={() => handleReorderItemsInGroup(groupItems, iIdx, 'up')}
                                            className="w-4 h-3 bg-white hover:bg-neutral-200 disabled:opacity-30 rounded text-[8px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer border border-neutral-200"
                                            title="Pindah ke atas"
                                          >
                                            ▲
                                          </button>
                                          <button
                                            type="button"
                                            disabled={iIdx === groupItems.length - 1}
                                            onClick={() => handleReorderItemsInGroup(groupItems, iIdx, 'down')}
                                            className="w-4 h-3 bg-white hover:bg-neutral-200 disabled:opacity-30 rounded text-[8px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer border border-neutral-200"
                                            title="Pindah ke bawah"
                                          >
                                            ▼
                                          </button>
                                        </div>
                                      </div>

                                      <span className="font-mono font-bold text-neutral-500 text-[11px] shrink-0">
                                        {gIdx + 1}.{iIdx + 1}
                                      </span>

                                      <div className="truncate flex-1 min-w-0">
                                        <div className="font-semibold text-neutral-900 truncate">{item.label}</div>
                                        {item.description && (
                                          <p className="text-[11px] text-neutral-500 truncate">{item.description}</p>
                                        )}
                                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                          {item.is_required ? (
                                            <span className="text-[9px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.2 rounded border border-amber-200">
                                              Wajib
                                            </span>
                                          ) : (
                                            <span className="text-[9px] font-bold text-neutral-600 bg-neutral-100 px-1.5 py-0.2 rounded border border-neutral-200">
                                              Opsional
                                            </span>
                                          )}
                                          {item.is_active ? (
                                            <span className="text-[9px] font-bold text-emerald-800 bg-emerald-100 px-1.5 py-0.2 rounded border border-emerald-200">
                                              ● Aktif
                                            </span>
                                          ) : (
                                            <span className="text-[9px] font-bold text-neutral-600 bg-neutral-200 px-1.5 py-0.2 rounded border border-neutral-300">
                                              ○ Nonaktif
                                            </span>
                                          )}
                                          {item.requires_photo && (
                                            <span className="text-[9px] font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.2 rounded">
                                              Foto
                                            </span>
                                          )}
                                          {item.requires_note && (
                                            <span className="text-[9px] font-semibold text-purple-700 bg-purple-50 px-1.5 py-0.2 rounded">
                                              Catatan
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                      <button
                                        type="button"
                                        onClick={() => handleOpenEditTemplateItem(item)}
                                        className="px-2 py-0.5 text-[10px] font-bold text-neutral-700 bg-white hover:bg-neutral-100 border border-neutral-200 rounded-lg transition-colors cursor-pointer"
                                      >
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleToggleTemplateItemActive(item)}
                                        className={`px-2 py-0.5 text-[10px] font-bold rounded-lg transition-colors cursor-pointer border ${
                                          item.is_active
                                            ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
                                            : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                                        }`}
                                      >
                                        {item.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteOrArchiveTemplateItem(item)}
                                        className="px-2 py-0.5 text-[10px] font-bold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors cursor-pointer"
                                      >
                                        Hapus
                                      </button>
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <div className="p-4 text-center text-xs text-neutral-400 bg-white rounded-xl border border-dashed border-neutral-200">
                                  Belum ada butir checklist dalam grup ini.
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="p-8 text-center text-xs text-neutral-400 bg-neutral-50 rounded-xl border border-dashed border-neutral-200">
                        Belum ada grup checklist untuk template ini. Klik tombol <strong>+ Tambah Group</strong> di atas untuk memulai.
                      </div>
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

      {/* SUBTAB 3: FINDING TYPES CATALOG */}
      {subTab === 'FINDING_TYPES' && (
        <div className="bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs">
          <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-neutral-900">Katalog Jenis Temuan Kamar</h3>
              <p className="text-xs text-neutral-500">Konfigurasi jenis temuan checkout/kerusakan dan aturan kesiapan kamar.</p>
            </div>
            <button
              type="button"
              onClick={handleOpenAddFindingType}
              className="px-3.5 py-1.5 text-xs font-bold text-white bg-[#1b4332] rounded-xl hover:bg-[#143326] transition-colors shadow-xs flex items-center gap-1.5 cursor-pointer"
            >
              <span>+</span> Tambah Jenis Temuan
            </button>
          </div>
          <div className="p-5">
            {isFindingTypesLoading ? (
              <div className="p-8 text-center text-xs text-neutral-500">Memuat katalog...</div>
            ) : findingTypes.length === 0 ? (
              <div className="p-8 text-center text-xs text-neutral-400 bg-neutral-50 rounded-xl border border-dashed border-neutral-200">
                Belum ada jenis temuan.
              </div>
            ) : (
              <div className="space-y-2.5">
                {findingTypes.map((ft, idx) => (
                  <div
                    key={ft.id}
                    className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs transition-all ${
                      ft.is_active ? 'bg-white border-neutral-200 shadow-2xs' : 'bg-neutral-100/70 border-neutral-200 opacity-60'
                    }`}
                  >
                    <div className="flex items-start sm:items-center gap-3 flex-1 min-w-0">
                      <div className="flex flex-col gap-0.5 shrink-0 mt-0.5 sm:mt-0">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => handleReorderFindingTypes(idx, 'up')}
                          className="w-5 h-4 bg-neutral-100 hover:bg-neutral-200 disabled:opacity-30 rounded text-[9px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          disabled={idx === findingTypes.length - 1}
                          onClick={() => handleReorderFindingTypes(idx, 'down')}
                          className="w-5 h-4 bg-neutral-100 hover:bg-neutral-200 disabled:opacity-30 rounded text-[9px] flex items-center justify-center font-bold text-neutral-700 cursor-pointer"
                        >
                          ▼
                        </button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-neutral-900 text-xs">{ft.label}</span>
                          <span className="text-[10px] font-mono text-neutral-400 bg-neutral-100 px-1.5 py-0.2 rounded">
                            {ft.code}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                            ft.severity === 'CRITICAL' || ft.severity === 'HIGH'
                              ? 'bg-rose-100 text-rose-800 border border-rose-200'
                              : ft.severity === 'MEDIUM'
                              ? 'bg-amber-100 text-amber-800 border border-amber-200'
                              : 'bg-neutral-100 text-neutral-600'
                          }`}>
                            {ft.severity}
                          </span>
                          {ft.block_room_ready && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1">
                              <span>🚫</span> Menghambat Kesiapan
                            </span>
                          )}
                        </div>
                        {ft.description && <p className="text-[11px] text-neutral-500 mt-0.5 truncate">{ft.description}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                      <button
                        type="button"
                        onClick={() => handleToggleFindingActive(ft)}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition-colors cursor-pointer ${
                          ft.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-200 text-neutral-600'
                        }`}
                      >
                        {ft.is_active ? 'Aktif' : 'Nonaktif'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenEditFindingType(ft)}
                        className="px-3 py-1 text-[11px] font-bold text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors cursor-pointer"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 1: TEMPLATE MASTER (ADD / EDIT) */}
      {templateModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-neutral-200 overflow-hidden">
            <div className="px-5 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
              <h4 className="text-sm font-bold text-neutral-900">
                {editingTemplate ? 'Edit Template Master' : 'Tambah Template Master'}
              </h4>
              <button
                type="button"
                onClick={() => setTemplateModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveTemplate} className="p-5 space-y-4 text-xs">
              <div>
                <label className="block font-bold text-neutral-700 mb-1">Nama Template *</label>
                <input
                  type="text"
                  required
                  value={templateForm.name}
                  onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })}
                  placeholder="Contoh: Pembersihan Standard VIP"
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-neutral-700 mb-1">Kode Template *</label>
                  <input
                    type="text"
                    required
                    disabled={Boolean(editingTemplate?.is_system_template)}
                    value={templateForm.code}
                    onChange={(e) => setTemplateForm({ ...templateForm, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                    placeholder="VIP_CLEANING"
                    className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-neutral-100 disabled:text-neutral-400"
                  />
                </div>

                <div>
                  <label className="block font-bold text-neutral-700 mb-1">Tipe Tugas</label>
                  <select
                    value={templateForm.task_type}
                    onChange={(e) => setTemplateForm({ ...templateForm, task_type: e.target.value })}
                    className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                  >
                    <option value="ROOM_CLEANING">ROOM_CLEANING</option>
                    <option value="CHECKOUT_INSPECTION">CHECKOUT_INSPECTION</option>
                    <option value="FINAL_INSPECTION">FINAL_INSPECTION</option>
                    <option value="MAINTENANCE">MAINTENANCE</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold text-neutral-700 mb-1">Deskripsi / Catatan</label>
                <input
                  type="text"
                  value={templateForm.description}
                  onChange={(e) => setTemplateForm({ ...templateForm, description: e.target.value })}
                  placeholder="Keterangan alur atau peruntukan template..."
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="space-y-2 pt-2 border-t border-neutral-100">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={templateForm.is_active}
                    onChange={(e) => setTemplateForm({ ...templateForm, is_active: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span className="font-semibold text-neutral-800">Template Aktif</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={templateForm.requires_verification}
                    onChange={(e) => setTemplateForm({ ...templateForm, requires_verification: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span className="font-semibold text-neutral-800">Wajib Verifikasi Supervisor</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => setTemplateModalOpen(false)}
                  className="px-4 py-2 font-bold text-neutral-600 hover:bg-neutral-100 rounded-xl cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isTemplateSaving}
                  className="px-4 py-2 font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl shadow-xs cursor-pointer"
                >
                  {isTemplateSaving ? 'Menyimpan...' : 'Simpan Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 1B: CHECKLIST GROUP (ADD / EDIT) - EMP-MOBILE-3F */}
      {groupModalOpen && selectedTemplate && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-neutral-200 overflow-hidden">
            <div className="px-5 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
              <h4 className="text-sm font-bold text-neutral-900">
                {editingGroup ? 'Edit Grup Checklist' : 'Tambah Grup Checklist'}
              </h4>
              <button
                type="button"
                onClick={() => setGroupModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveGroup} className="p-5 space-y-4 text-xs">
              <div>
                <label className="block font-bold text-neutral-700 mb-1">Nama Grup *</label>
                <input
                  type="text"
                  required
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  placeholder="Contoh: KAMAR MANDI, RUANGAN KAMAR, AMENITIES, MINIBAR"
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs"
                />
              </div>

              <div>
                <label className="block font-bold text-neutral-700 mb-1">Kode Grup (Opsional)</label>
                <input
                  type="text"
                  value={groupForm.code}
                  onChange={(e) => setGroupForm({ ...groupForm, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                  placeholder="BATHROOM / BEDROOM / AMENITIES / MINIBAR"
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono text-xs"
                />
              </div>

              <div>
                <label className="block font-bold text-neutral-700 mb-1">Deskripsi Grup (Opsional)</label>
                <input
                  type="text"
                  value={groupForm.description}
                  onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                  placeholder="Keterangan area atau cakupan butir..."
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="pt-2 border-t border-neutral-100">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={groupForm.is_active}
                    onChange={(e) => setGroupForm({ ...groupForm, is_active: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span className="font-semibold text-neutral-800">Grup Aktif</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => setGroupModalOpen(false)}
                  className="px-4 py-2 font-bold text-neutral-600 hover:bg-neutral-100 rounded-xl cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isGroupSaving}
                  className="px-4 py-2 font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl shadow-xs cursor-pointer"
                >
                  {isGroupSaving ? 'Menyimpan...' : 'Simpan Grup'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: CHECKLIST ITEM (ADD / EDIT) */}
      {itemModalOpen && selectedTemplate && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-neutral-200 overflow-hidden">
            <div className="px-5 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
              <h4 className="text-sm font-bold text-neutral-900">
                {editingItem ? 'Edit Butir Checklist' : 'Tambah Butir Checklist'}
              </h4>
              <button
                type="button"
                onClick={() => setItemModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveTemplateItem} className="p-5 space-y-4 text-xs">
              <div>
                <label className="block font-bold text-neutral-700 mb-1">Grup Checklist *</label>
                <select
                  value={itemForm.group_id ?? ''}
                  onChange={(e) => setItemForm({ ...itemForm, group_id: e.target.value ? Number(e.target.value) : null })}
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                >
                  <option value="">(Tanpa Grup)</option>
                  {(selectedTemplate.groups || []).map((g, idx) => (
                    <option key={g.id} value={g.id}>
                      {idx + 1}. {g.name} {!g.is_active ? '(Nonaktif)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold text-neutral-700 mb-1">Nama / Label *</label>
                <input
                  type="text"
                  required
                  value={itemForm.label}
                  onChange={(e) => setItemForm({ ...itemForm, label: e.target.value })}
                  placeholder="Contoh: Isi Minibar / Kulkas"
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-xs"
                />
              </div>

              <div>
                <label className="block font-bold text-neutral-700 mb-1">Kategori / Section</label>
                <input
                  type="text"
                  required
                  value={itemForm.section}
                  onChange={(e) => setItemForm({ ...itemForm, section: e.target.value.toUpperCase() })}
                  placeholder="BEDROOM / BATHROOM / AMENITIES"
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono text-xs"
                />
              </div>

              <div>
                <label className="block font-bold text-neutral-700 mb-1">Petunjuk / Deskripsi Butir</label>
                <input
                  type="text"
                  value={itemForm.description}
                  onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })}
                  placeholder="Keterangan standar pengecekan untuk crew..."
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="space-y-2 pt-2 border-t border-neutral-100">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={itemForm.is_required}
                    onChange={(e) => setItemForm({ ...itemForm, is_required: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span className="font-semibold text-neutral-800">Wajib Diperiksa (Mandatory)</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={itemForm.is_active}
                    onChange={(e) => setItemForm({ ...itemForm, is_active: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span className="font-semibold text-neutral-800">Status Aktif</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={itemForm.requires_photo}
                    onChange={(e) => setItemForm({ ...itemForm, requires_photo: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span className="font-semibold text-neutral-800">Wajib Lampirkan Foto</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={itemForm.requires_note}
                    onChange={(e) => setItemForm({ ...itemForm, requires_note: e.target.checked })}
                    className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                  />
                  <span className="font-semibold text-neutral-800">Wajib Lampirkan Catatan</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => setItemModalOpen(false)}
                  className="px-4 py-2 font-bold text-neutral-600 hover:bg-neutral-100 rounded-xl cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isTemplateItemSaving}
                  className="px-4 py-2 font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl shadow-xs cursor-pointer"
                >
                  {isTemplateItemSaving ? 'Menyimpan...' : 'Simpan Butir'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: FINDING TYPE (ADD / EDIT) */}
      {findingModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg border border-neutral-200 overflow-hidden">
            <div className="px-5 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
              <h4 className="text-sm font-bold text-neutral-900">
                {editingFindingType ? 'Edit Jenis Temuan' : 'Tambah Jenis Temuan'}
              </h4>
              <button
                type="button"
                onClick={() => setFindingModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-700 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveFindingType} className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-neutral-700 mb-1">Kode Unik *</label>
                  <input
                    type="text"
                    required
                    value={findingForm.code}
                    onChange={(e) => setFindingForm({ ...findingForm, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                    className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 font-mono text-xs focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="block font-bold text-neutral-700 mb-1">Severity</label>
                  <select
                    value={findingForm.severity}
                    onChange={(e) => setFindingForm({ ...findingForm, severity: e.target.value as FindingSeverity })}
                    className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:ring-2 focus:ring-emerald-500"
                  >
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
                <input
                  type="text"
                  required
                  value={findingForm.label}
                  onChange={(e) => setFindingForm({ ...findingForm, label: e.target.value })}
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block font-bold text-neutral-700 mb-1">Deskripsi Kendala</label>
                <input
                  type="text"
                  value={findingForm.description}
                  onChange={(e) => setFindingForm({ ...findingForm, description: e.target.value })}
                  placeholder="Keterangan jenis kendala atau kerusakan..."
                  className="w-full bg-white border border-neutral-300 rounded-xl px-3 py-2 text-neutral-800 text-xs focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Operational Block & Policies Configuration */}
              <div className="space-y-2.5 pt-2.5 border-t border-neutral-200">
                <label className="flex items-start gap-2.5 p-2 rounded-xl bg-rose-50/50 border border-rose-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={findingForm.block_room_ready}
                    onChange={(e) => setFindingForm({ ...findingForm, block_room_ready: e.target.checked })}
                    className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-rose-600 focus:ring-rose-500 cursor-pointer"
                  />
                  <div>
                    <span className="font-bold text-rose-950 block">Menghambat Kesiapan Kamar (Block Room Ready)</span>
                    <span className="text-[11px] text-rose-800 leading-tight block">Kamar tidak dapat check-in / dijual selama temuan jenis ini berstatus OPEN.</span>
                  </div>
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={findingForm.note_required}
                      onChange={(e) => setFindingForm({ ...findingForm, note_required: e.target.checked })}
                      className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                    />
                    <span className="font-semibold text-neutral-800">Wajib Catatan Detail</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={findingForm.photo_required}
                      onChange={(e) => setFindingForm({ ...findingForm, photo_required: e.target.checked })}
                      className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                    />
                    <span className="font-semibold text-neutral-800">Wajib Lampirkan Foto</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={findingForm.estimated_charge_allowed}
                      onChange={(e) => setFindingForm({ ...findingForm, estimated_charge_allowed: e.target.checked })}
                      className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                    />
                    <span className="font-semibold text-neutral-800">Boleh Estimasi Biaya</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={findingForm.supervisor_review_required}
                      onChange={(e) => setFindingForm({ ...findingForm, supervisor_review_required: e.target.checked })}
                      className="h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                    />
                    <span className="font-semibold text-neutral-800">Wajib Verifikasi Supervisor</span>
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => setFindingModalOpen(false)}
                  className="px-4 py-2 font-bold text-neutral-600 hover:bg-neutral-100 rounded-xl cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isFindingTypeSaving}
                  className="px-4 py-2 font-bold text-white bg-[#1b4332] hover:bg-[#143326] rounded-xl shadow-xs cursor-pointer"
                >
                  {isFindingTypeSaving ? 'Menyimpan...' : 'Simpan Jenis Temuan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
