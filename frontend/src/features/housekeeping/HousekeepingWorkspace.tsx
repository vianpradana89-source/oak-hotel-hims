import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  HousekeepingTaskRecord,
  HousekeepingDailyMetrics,
  HousekeepingTab,
  ChecklistTemplate,
  TaskChecklistItem,
  HkInspectionResult,
  HkIssueType,
  HkTaskCategory,
  HkTaskPriority,
  HkTaskStatus
} from './housekeepingTypes';
import { HousekeepingTaskDetailDrawer } from './HousekeepingTaskDetailDrawer';
import { CreateTaskModal } from './CreateTaskModal';
interface HousekeepingWorkspaceProps {
  propertyId: number;
  apiBaseUrl?: string;
  onNavigateToSettings?: (section?: string) => void;
  featureFlags?: Record<string, boolean>;
}

export const HousekeepingWorkspace: React.FC<HousekeepingWorkspaceProps> = ({
  propertyId,
  apiBaseUrl = '/api',
  onNavigateToSettings,
  featureFlags: _featureFlags
}) => {
  const [activeTab, setActiveTab] = useState<HousekeepingTab>('room_operations');
  const [dateStr, setDateStr] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [metrics, setMetrics] = useState<HousekeepingDailyMetrics | null>(null);
  const [tasks, setTasks] = useState<HousekeepingTaskRecord[]>([]);
  const [historyTasks, setHistoryTasks] = useState<HousekeepingTaskRecord[]>([]);
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [rooms, setRooms] = useState<Array<{ id: number; room_number: string }>>([]);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filter & Search
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [metricFilter, setMetricFilter] = useState<string | null>(null);

  // Drawer & Modal State
  const [selectedTask, setSelectedTask] = useState<HousekeepingTaskRecord | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [isActionSubmitting, setIsActionSubmitting] = useState<boolean>(false);

  // History Tab Specific States
  const [historyPreset, setHistoryPreset] = useState<'today' | 'yesterday' | '7days' | '30days' | 'this_month' | 'all'>('today');
  const [includeArchived, setIncludeArchived] = useState<boolean>(false);
  const [historyEditTask, setHistoryEditTask] = useState<HousekeepingTaskRecord | null>(null);
  const [historyEditForm, setHistoryEditForm] = useState<{
    notes: string;
    inspection_result: string;
    damage_charge_estimate: string;
    reason: string;
  }>({
    notes: '',
    inspection_result: 'CLEAR',
    damage_charge_estimate: '0',
    reason: ''
  });
  const [isHistorySaving, setIsHistorySaving] = useState<boolean>(false);

  // Fetch daily operations & tasks
  const fetchDailyOperations = useCallback(async (isBackground = false) => {
    if (!isBackground) setIsLoading(true);
    else setIsRefreshing(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/daily-operations?property_id=${propertyId}&date=${dateStr}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal memuat operasional housekeeping');
      }
      const json = await res.json();
      if (json.status === 'OK' && json.data) {
        setMetrics(json.data.metrics);
        setTasks(json.data.tasks || []);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan sistem');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [apiBaseUrl, propertyId, dateStr]);

  // Fetch templates & rooms for task creation
  const fetchTemplatesAndRooms = useCallback(async () => {
    try {
      const [tplRes, roomRes] = await Promise.all([
        fetch(`${apiBaseUrl}/housekeeping/templates?property_id=${propertyId}`),
        fetch(`${apiBaseUrl}/rooms?property_id=${propertyId}`)
      ]);

      if (tplRes.ok) {
        const tplJson = await tplRes.json();
        setTemplates(tplJson.data || []);
      }
      if (roomRes.ok) {
        const roomJson = await roomRes.json();
        setRooms(roomJson.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch templates/rooms:', err);
    }
  }, [apiBaseUrl, propertyId]);

  // Fetch history tasks
  const fetchHistory = useCallback(async (preset = historyPreset, incArchived = includeArchived) => {
    try {
      const presetParam = preset === 'all' ? '' : `&preset=${preset}`;
      const url = `${apiBaseUrl}/housekeeping/history?property_id=${propertyId}${presetParam}${incArchived ? '&include_archived=true' : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        setHistoryTasks(json.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch HK history:', err);
    }
  }, [apiBaseUrl, propertyId, historyPreset, includeArchived]);

  useEffect(() => {
    fetchDailyOperations();
    fetchTemplatesAndRooms();
  }, [fetchDailyOperations, fetchTemplatesAndRooms]);

  useEffect(() => {
    if (activeTab === 'history') {
      fetchHistory(historyPreset, includeArchived);
    }
  }, [activeTab, historyPreset, includeArchived, fetchHistory]);

  // History Actions: Safe Edit, Archive, Unarchive
  const handleOpenHistoryEdit = (task: HousekeepingTaskRecord) => {
    setHistoryEditTask(task);
    setHistoryEditForm({
      notes: task.notes || '',
      inspection_result: task.inspection_result || 'CLEAR',
      damage_charge_estimate: String(task.damage_charge_estimate || 0),
      reason: ''
    });
  };

  const handleSaveHistoryEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!historyEditTask) return;
    if (!historyEditForm.reason.trim()) {
      alert('Alasan perubahan riwayat wajib diisi untuk audit log.');
      return;
    }

    try {
      setIsHistorySaving(true);
      const res = await fetch(`${apiBaseUrl}/housekeeping/tasks/${historyEditTask.id}/history-edit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          actor_name: 'Supervisor HK',
          actor_role: 'Supervisor',
          reason: historyEditForm.reason.trim(),
          notes: historyEditForm.notes.trim(),
          inspection_result: historyEditForm.inspection_result,
          damage_charge_estimate: Number(historyEditForm.damage_charge_estimate) || 0
        })
      });

      if (res.ok) {
        setHistoryEditTask(null);
        await fetchHistory(historyPreset, includeArchived);
      } else {
        const data = await res.json();
        alert(data.message || 'Gagal menyimpan perubahan riwayat.');
      }
    } catch (err: any) {
      alert(err.message || 'Koneksi gagal.');
    } finally {
      setIsHistorySaving(false);
    }
  };

  const handleArchiveTask = async (task: HousekeepingTaskRecord) => {
    const reason = prompt('Masukkan alasan pengarsipan tugas ini (Audit Log):', 'Pembersihan duplikat / koreksi manual');
    if (!reason) return;

    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          archived_by: 'Supervisor HK',
          archive_reason: reason
        })
      });

      if (res.ok) {
        await fetchHistory(historyPreset, includeArchived);
        await fetchDailyOperations(true);
      } else {
        const data = await res.json();
        alert(data.message || 'Gagal mengarsipkan tugas.');
      }
    } catch (err: any) {
      alert(err.message || 'Koneksi error.');
    }
  };

  const handleUnarchiveTask = async (task: HousekeepingTaskRecord) => {
    if (!confirm(`Batalkan arsip untuk tugas ${task.task_number}?`)) return;

    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/unarchive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          unarchived_by: 'Supervisor HK'
        })
      });

      if (res.ok) {
        await fetchHistory(historyPreset, includeArchived);
        await fetchDailyOperations(true);
      } else {
        const data = await res.json();
        alert(data.message || 'Gagal membatalkan arsip.');
      }
    } catch (err: any) {
      alert(err.message || 'Koneksi error.');
    }
  };

  // Filter tasks based on activeTab, metricFilter, statusFilter, and searchTerm
  const filteredTasks = useMemo(() => {
    let source = tasks;
    if (activeTab === 'history') {
      source = historyTasks;
    } else if (activeTab === 'room_operations') {
      source = tasks.filter((t) => t.task_category === 'ROOM_OPERATIONS');
    } else if (activeTab === 'checkout_inspection') {
      source = tasks.filter((t) => t.task_type === 'CHECKOUT_ROOM_CHECK');
    } else if (activeTab === 'service_requests') {
      source = tasks.filter((t) => t.task_category === 'SERVICE_REQUEST');
    } else if (activeTab === 'department_tasks') {
      source = tasks.filter((t) => t.task_category === 'DEPARTMENT_TASK');
    }

    // Metric card filter if active
    if (metricFilter) {
      const now = new Date();
      if (metricFilter === 'DIRTY') {
        source = source.filter((t) => t.room_status === 'VACANT_DIRTY' || t.room_status === 'OCCUPIED_DIRTY');
      } else if (metricFilter === 'CLEANING') {
        source = source.filter((t) => t.room_status === 'CLEANING' || t.status === 'IN_PROGRESS');
      } else if (metricFilter === 'WAITING_INSPECTION') {
        source = source.filter((t) => t.task_type === 'FINAL_INSPECTION' && t.status !== 'DONE');
      } else if (metricFilter === 'READY') {
        source = source.filter((t) => t.room_status === 'VACANT_CLEAN' || t.room_status === 'INSPECTED');
      } else if (metricFilter === 'CHECKOUT_CHECK') {
        source = source.filter((t) => t.task_type === 'CHECKOUT_ROOM_CHECK' && t.status !== 'DONE');
      } else if (metricFilter === 'OVERDUE') {
        source = source.filter((t) => t.due_at && new Date(t.due_at) < now && t.status !== 'DONE' && t.status !== 'CANCELLED');
      } else if (metricFilter === 'TURNOVER') {
        source = source.filter((t) => t.priority === 'TURNOVER');
      }
    }

    // Status filter
    if (statusFilter !== 'ALL') {
      source = source.filter((t) => t.status === statusFilter);
    }

    // Search query
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase().trim();
      source = source.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.room_number && String(t.room_number).toLowerCase().includes(q)) ||
          (t.assigned_user_name_snapshot && t.assigned_user_name_snapshot.toLowerCase().includes(q)) ||
          (t.description && t.description.toLowerCase().includes(q))
      );
    }

    return source;
  }, [tasks, historyTasks, activeTab, metricFilter, statusFilter, searchTerm]);

  // Actions
  const handleAcknowledge = async (task: HousekeepingTaskRecord) => {
    setIsActionSubmitting(true);
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/acknowledge`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, actor_name: 'Housekeeping Staff' })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal menerima tugas');
      }
      await fetchDailyOperations(true);
      setIsDrawerOpen(false);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsActionSubmitting(false);
    }
  };

  const handleStart = async (task: HousekeepingTaskRecord) => {
    setIsActionSubmitting(true);
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/start`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, actor_name: 'Housekeeping Staff' })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal memulai pengerjaan');
      }
      await fetchDailyOperations(true);
      // Refresh active selected task in drawer
      const updatedJson = await res.json();
      setSelectedTask(updatedJson.data);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsActionSubmitting(false);
    }
  };

  const handleToggleChecklistItem = async (
    task: HousekeepingTaskRecord,
    item: TaskChecklistItem,
    isCompleted: boolean
  ) => {
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/checklist-items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          is_completed: isCompleted,
          actor_name: 'Housekeeping Staff'
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal memperbarui checklist');
      }
      const updatedItem = (await res.json()).data;

      // Update state locally in selectedTask
      setSelectedTask((prev) => {
        if (!prev) return null;
        const newItems = (prev.checklist_items || []).map((i) =>
          i.id === item.id ? updatedItem : i
        );
        return { ...prev, checklist_items: newItems };
      });
      fetchDailyOperations(true);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleComplete = async (
    task: HousekeepingTaskRecord,
    payload: {
      completion_note?: string;
      inspection_result?: HkInspectionResult;
      issue_type?: HkIssueType;
      issue_note?: string;
      estimated_charge?: number;
    }
  ) => {
    setIsActionSubmitting(true);
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/complete`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          ...payload,
          actor_name: 'Housekeeping Staff'
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal menyelesaikan tugas');
      }
      await fetchDailyOperations(true);
      setIsDrawerOpen(false);
    } finally {
      setIsActionSubmitting(false);
    }
  };

  const handleCreateTask = async (payload: {
    task_category: HkTaskCategory;
    task_type: any;
    room_number?: string;
    title: string;
    description?: string;
    priority: HkTaskPriority;
    assigned_user_name_snapshot?: string;
    template_code?: string;
  }) => {
    const res = await fetch(`${apiBaseUrl}/housekeeping/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        ...payload
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Gagal membuat tugas');
    }
    await fetchDailyOperations(true);
  };

  const openTaskDrawer = (task: HousekeepingTaskRecord) => {
    setSelectedTask(task);
    setIsDrawerOpen(true);
  };

  // Helper duration calculation
  const getRunningDuration = (startedAt?: string | null) => {
    if (!startedAt) return null;
    const diffMs = new Date().getTime() - new Date(startedAt).getTime();
    if (diffMs < 0) return '0m';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}j ${remMins}m`;
  };

  const getPriorityBadge = (priority: HkTaskPriority) => {
    switch (priority) {
      case 'CRITICAL':
        return <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-red-100 text-red-800 border border-red-200">CRITICAL</span>;
      case 'TURNOVER':
        return <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-red-600 text-white animate-pulse">TURNOVER</span>;
      case 'VIP':
        return <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-amber-500 text-white">VIP</span>;
      case 'HIGH':
        return <span className="px-2 py-0.5 text-[11px] font-semibold rounded-full bg-amber-100 text-amber-800 border border-amber-200">HIGH</span>;
      case 'LOW':
        return <span className="px-2 py-0.5 text-[11px] font-semibold rounded-full bg-neutral-100 text-neutral-600">LOW</span>;
      default:
        return <span className="px-2 py-0.5 text-[11px] font-semibold rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">NORMAL</span>;
    }
  };

  const getStatusBadge = (status: HkTaskStatus) => {
    switch (status) {
      case 'IN_PROGRESS':
        return <span className="px-2 py-0.5 text-[11px] font-bold rounded-md bg-blue-100 text-blue-800 animate-pulse">IN PROGRESS</span>;
      case 'ACKNOWLEDGED':
        return <span className="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-indigo-100 text-indigo-800">ACKNOWLEDGED</span>;
      case 'DONE':
      case 'VERIFIED':
        return <span className="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-emerald-100 text-emerald-800">DONE</span>;
      case 'BLOCKED':
        return <span className="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-rose-100 text-rose-800">BLOCKED</span>;
      case 'CANCELLED':
        return <span className="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-neutral-100 text-neutral-500">CANCELLED</span>;
      default:
        return <span className="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-amber-100 text-amber-800">ASSIGNED</span>;
    }
  };

  const getRoomStatusBadge = (status?: string | null) => {
    if (!status) return <span className="text-neutral-400">-</span>;
    const s = status.toUpperCase();
    if (s === 'VACANT_CLEAN' || s === 'INSPECTED') {
      return <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-emerald-100 text-emerald-900">{s}</span>;
    }
    if (s === 'CLEANING') {
      return <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-blue-100 text-blue-900">{s}</span>;
    }
    if (s === 'VACANT_DIRTY' || s === 'OCCUPIED_DIRTY') {
      return <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-100 text-amber-900">{s}</span>;
    }
    return <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-neutral-100 text-neutral-700">{s}</span>;
  };

  return (
    <div className="space-y-5">
      {/* Top Banner / Operational Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-neutral-200 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-neutral-900">Housekeeping & Operasional Harian</h1>
            <span className="px-2 py-0.5 text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full">
              Authoritative HK Domain
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-0.5">
            Pusat manajemen kesiapan kamar, alur turnover, inspeksi checkout, dan checklist kebersihan.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-neutral-300 bg-white text-neutral-800 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
          />
          <button
            type="button"
            onClick={() => fetchDailyOperations(true)}
            disabled={isRefreshing}
            className="p-2 text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors cursor-pointer"
            title="Segarkan Data"
          >
            <svg className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          {onNavigateToSettings && (
            <button
              type="button"
              onClick={() => onNavigateToSettings('housekeeping')}
              className="px-3 py-1.5 text-xs font-semibold text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
              title="Buka Pengaturan Housekeeping di Manajemen → Pengaturan"
            >
              <svg className="w-3.5 h-3.5 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Pengaturan Modul ↗
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="px-3.5 py-1.5 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            + Buat Tugas
          </button>
        </div>
      </div>

      {/* Daily Operational Metric Cards */}
      {metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <button
            type="button"
            onClick={() => setMetricFilter(metricFilter === 'DIRTY' ? null : 'DIRTY')}
            className={`p-3 rounded-xl border text-left transition-all ${
              metricFilter === 'DIRTY'
                ? 'bg-amber-100/70 border-amber-500 ring-2 ring-amber-400'
                : 'bg-white border-neutral-200 hover:border-amber-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Kamar Kotor</div>
            <div className="text-xl font-bold text-amber-700 mt-1">{metrics.dirty}</div>
            <div className="text-[10px] text-neutral-400 mt-0.5">Vacant/Occupied Dirty</div>
          </button>

          <button
            type="button"
            onClick={() => setMetricFilter(metricFilter === 'CLEANING' ? null : 'CLEANING')}
            className={`p-3 rounded-xl border text-left transition-all ${
              metricFilter === 'CLEANING'
                ? 'bg-blue-100/70 border-blue-500 ring-2 ring-blue-400'
                : 'bg-white border-neutral-200 hover:border-blue-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Sedang Dibersihkan</div>
            <div className="text-xl font-bold text-blue-700 mt-1">{metrics.cleaning}</div>
            <div className="text-[10px] text-neutral-400 mt-0.5">In Progress HK</div>
          </button>

          <button
            type="button"
            onClick={() => setMetricFilter(metricFilter === 'WAITING_INSPECTION' ? null : 'WAITING_INSPECTION')}
            className={`p-3 rounded-xl border text-left transition-all ${
              metricFilter === 'WAITING_INSPECTION'
                ? 'bg-indigo-100/70 border-indigo-500 ring-2 ring-indigo-400'
                : 'bg-white border-neutral-200 hover:border-indigo-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Menunggu Inspeksi</div>
            <div className="text-xl font-bold text-indigo-700 mt-1">{metrics.waiting_inspection}</div>
            <div className="text-[10px] text-neutral-400 mt-0.5">Supervisor Check</div>
          </button>

          <button
            type="button"
            onClick={() => setMetricFilter(metricFilter === 'READY' ? null : 'READY')}
            className={`p-3 rounded-xl border text-left transition-all ${
              metricFilter === 'READY'
                ? 'bg-emerald-100/70 border-emerald-500 ring-2 ring-emerald-400'
                : 'bg-white border-neutral-200 hover:border-emerald-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Kamar Siap Huni</div>
            <div className="text-xl font-bold text-emerald-700 mt-1">{metrics.ready}</div>
            <div className="text-[10px] text-neutral-400 mt-0.5">Clean / Inspected</div>
          </button>

          <button
            type="button"
            onClick={() => setMetricFilter(metricFilter === 'CHECKOUT_CHECK' ? null : 'CHECKOUT_CHECK')}
            className={`p-3 rounded-xl border text-left transition-all ${
              metricFilter === 'CHECKOUT_CHECK'
                ? 'bg-purple-100/70 border-purple-500 ring-2 ring-purple-400'
                : 'bg-white border-neutral-200 hover:border-purple-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Checkout Check</div>
            <div className="text-xl font-bold text-purple-700 mt-1">{metrics.checkout_check}</div>
            <div className="text-[10px] text-neutral-400 mt-0.5">Minibar & Room Check</div>
          </button>

          <button
            type="button"
            onClick={() => setMetricFilter(metricFilter === 'TURNOVER' ? null : 'TURNOVER')}
            className={`p-3 rounded-xl border text-left transition-all ${
              metricFilter === 'TURNOVER'
                ? 'bg-red-100/70 border-red-500 ring-2 ring-red-400'
                : 'bg-white border-neutral-200 hover:border-red-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Priority Turnover</div>
            <div className="text-xl font-bold text-red-700 mt-1">{metrics.priority_turnover}</div>
            <div className="text-[10px] text-neutral-400 mt-0.5">CO + Arrival Hari Ini</div>
          </button>

          <button
            type="button"
            onClick={() => setMetricFilter(metricFilter === 'OVERDUE' ? null : 'OVERDUE')}
            className={`p-3 rounded-xl border text-left transition-all ${
              metricFilter === 'OVERDUE'
                ? 'bg-rose-100/70 border-rose-500 ring-2 ring-rose-400'
                : 'bg-white border-neutral-200 hover:border-rose-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Terlambat (Overdue)</div>
            <div className="text-xl font-bold text-rose-700 mt-1">{metrics.overdue}</div>
            <div className="text-[10px] text-neutral-400 mt-0.5">Lewat Batas Waktu</div>
          </button>
        </div>
      )}

      {/* Main Tabs Navigation */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden shadow-xs">
        <div className="border-b border-neutral-200 bg-neutral-50/70 px-4 pt-3 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => {
                setActiveTab('room_operations');
                setMetricFilter(null);
              }}
              className={`px-3 py-2 text-xs font-bold border-b-2 transition-all whitespace-nowrap ${
                activeTab === 'room_operations'
                  ? 'border-emerald-700 text-emerald-800 bg-white rounded-t-lg'
                  : 'border-transparent text-neutral-600 hover:text-neutral-900'
              }`}
            >
              Operasional Kamar
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('checkout_inspection');
                setMetricFilter(null);
              }}
              className={`px-3 py-2 text-xs font-bold border-b-2 transition-all whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === 'checkout_inspection'
                  ? 'border-emerald-700 text-emerald-800 bg-white rounded-t-lg'
                  : 'border-transparent text-neutral-600 hover:text-neutral-900'
              }`}
            >
              Checkout Inspection
              {metrics && metrics.checkout_check > 0 && (
                <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-purple-600 text-white">
                  {metrics.checkout_check}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('service_requests');
                setMetricFilter(null);
              }}
              className={`px-3 py-2 text-xs font-bold border-b-2 transition-all whitespace-nowrap ${
                activeTab === 'service_requests'
                  ? 'border-emerald-700 text-emerald-800 bg-white rounded-t-lg'
                  : 'border-transparent text-neutral-600 hover:text-neutral-900'
              }`}
            >
              Service Requests (FO)
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('department_tasks');
                setMetricFilter(null);
              }}
              className={`px-3 py-2 text-xs font-bold border-b-2 transition-all whitespace-nowrap ${
                activeTab === 'department_tasks'
                  ? 'border-emerald-700 text-emerald-800 bg-white rounded-t-lg'
                  : 'border-transparent text-neutral-600 hover:text-neutral-900'
              }`}
            >
              Department Tasks
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('history');
                setMetricFilter(null);
              }}
              className={`px-3 py-2 text-xs font-bold border-b-2 transition-all whitespace-nowrap cursor-pointer ${
                activeTab === 'history'
                  ? 'border-emerald-700 text-emerald-800 bg-white rounded-t-lg'
                  : 'border-transparent text-neutral-600 hover:text-neutral-900'
              }`}
            >
              Riwayat (History)
            </button>
          </div>

          {/* Search & Filter Bar for List Views */}
          <div className="flex flex-wrap items-center gap-2 pb-2">
            {activeTab === 'history' ? (
              <>
                <div className="flex items-center gap-1 bg-neutral-100 p-1 rounded-lg">
                  {[
                    { id: 'today', label: 'Hari Ini' },
                    { id: 'yesterday', label: 'Kemarin' },
                    { id: '7days', label: '7 Hari' },
                    { id: '30days', label: '30 Hari' },
                    { id: 'this_month', label: 'Bulan Ini' },
                    { id: 'all', label: 'Semua' }
                  ].map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setHistoryPreset(p.id as any)}
                      className={`px-2.5 py-1 rounded text-[11px] font-semibold transition ${
                        historyPreset === p.id
                          ? 'bg-[#1b4332] text-white shadow-xs'
                          : 'text-neutral-600 hover:text-neutral-900'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-1.5 text-xs text-neutral-600 cursor-pointer ml-2">
                  <input
                    type="checkbox"
                    checked={includeArchived}
                    onChange={(e) => setIncludeArchived(e.target.checked)}
                    className="w-3.5 h-3.5 rounded text-[#1b4332] focus:ring-[#1b4332]"
                  />
                  <span>Tampilkan Data Diarsipkan</span>
                </label>
              </>
            ) : null}

            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Cari kamar / judul / PIC..."
              className="text-xs px-2.5 py-1.5 rounded-lg border border-neutral-300 bg-white w-44 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
            />
            {activeTab !== 'history' && (
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="text-xs px-2 py-1.5 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              >
                <option value="ALL">Semua Status</option>
                <option value="ASSIGNED">ASSIGNED</option>
                <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
                <option value="IN_PROGRESS">IN PROGRESS</option>
                <option value="DONE">DONE</option>
              </select>
            )}
          </div>
        </div>

        {/* Operational Tasks Table */}
        <div className="overflow-x-auto">
          {errorMsg && (
            <div className="p-4 bg-red-50 text-red-700 text-xs border-b border-red-200">
              {errorMsg}
            </div>
          )}

            {isLoading ? (
              <div className="p-12 text-center text-xs text-neutral-500">
                Memuat data operasional...
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="p-12 text-center text-xs text-neutral-500">
                Tidak ada tugas housekeeping pada tampilan ini.
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-neutral-50 border-b border-neutral-200 text-neutral-600 font-bold uppercase tracking-wider text-[10px]">
                    <th className="py-2.5 px-3">Kamar</th>
                    <th className="py-2.5 px-3">Status Kamar</th>
                    <th className="py-2.5 px-3">Tugas</th>
                    <th className="py-2.5 px-3">Checklist</th>
                    <th className="py-2.5 px-3">Status Tugas</th>
                    <th className="py-2.5 px-3">Prioritas</th>
                    <th className="py-2.5 px-3">Petugas (PIC)</th>
                    <th className="py-2.5 px-3">Durasi</th>
                    <th className="py-2.5 px-3">Next Arrival</th>
                    <th className="py-2.5 px-3 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 text-neutral-800">
                  {filteredTasks.map((t) => {
                    const durationStr = getRunningDuration(t.started_at);
                    return (
                      <tr
                        key={t.id}
                        className={`hover:bg-neutral-50/80 transition-colors ${
                          t.priority === 'TURNOVER' ? 'bg-red-50/30' : ''
                        }`}
                      >
                        {/* Room Number */}
                        <td className="py-2.5 px-3 font-bold text-neutral-900 whitespace-nowrap">
                          {t.room_number ? (
                            <span className="px-2 py-0.5 rounded bg-neutral-800 text-white font-mono text-xs">
                              {t.room_number}
                            </span>
                          ) : (
                            <span className="text-neutral-400 italic">Non-Kamar</span>
                          )}
                        </td>

                        {/* Room Physical Status */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {getRoomStatusBadge(t.room_status)}
                        </td>

                        {/* Task Title & Type */}
                        <td className="py-2.5 px-3">
                          <div className="font-semibold text-neutral-900">{t.title}</div>
                          <div className="text-[10px] text-neutral-500 mt-0.5 flex items-center gap-1.5">
                            <span>{t.task_type}</span>
                            {t.inspection_result && (
                              <span className={`px-1 rounded text-[9px] font-bold ${
                                t.inspection_result === 'CLEAR' || t.inspection_result === 'PASS'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-rose-100 text-rose-800'
                              }`}>
                                {t.inspection_result}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Checklist Summary */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {t.checklist_summary && t.checklist_summary.total > 0 ? (
                            <div className="flex items-center gap-1.5">
                              <span className={`font-mono font-semibold ${
                                t.checklist_summary.completed === t.checklist_summary.total
                                  ? 'text-emerald-700'
                                  : 'text-neutral-700'
                              }`}>
                                {t.checklist_summary.completed}/{t.checklist_summary.total}
                              </span>
                              {t.checklist_summary.required_total > 0 && t.checklist_summary.required_completed < t.checklist_summary.required_total && (
                                <span className="text-[9px] px-1 bg-amber-100 text-amber-800 rounded font-semibold">
                                  {t.checklist_summary.required_total - t.checklist_summary.required_completed} wajib
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-neutral-400 text-[10px]">-</span>
                          )}
                        </td>

                        {/* Task Status */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {getStatusBadge(t.status)}
                        </td>

                        {/* Priority */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {getPriorityBadge(t.priority)}
                        </td>

                        {/* PIC Assignee */}
                        <td className="py-2.5 px-3 text-neutral-700 whitespace-nowrap">
                          {t.assigned_user_name_snapshot || <span className="text-neutral-400 italic">Belum ditugaskan</span>}
                        </td>

                        {/* Duration */}
                        <td className="py-2.5 px-3 text-neutral-600 whitespace-nowrap font-mono">
                          {t.status === 'IN_PROGRESS' ? (
                            <span className="text-blue-700 font-bold">{durationStr || '< 1m'}</span>
                          ) : t.completed_at ? (
                            <span className="text-neutral-500">Selesai</span>
                          ) : (
                            '-'
                          )}
                        </td>

                        {/* Next Arrival */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {t.next_arrival ? (
                            <div>
                              <span className="font-semibold text-red-900 block text-[11px]">
                                {t.next_arrival.guest_name}
                              </span>
                              <span className="text-[10px] text-red-700">
                                Check-in {t.next_arrival.expected_arrival_time || '14:00'}
                              </span>
                            </div>
                          ) : (
                            <span className="text-neutral-400">-</span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-1.5">
                          {activeTab === 'history' ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleOpenHistoryEdit(t)}
                                className="px-2.5 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded border border-emerald-200"
                              >
                                Koreksi Riwayat
                              </button>
                              {t.is_archived ? (
                                <button
                                  type="button"
                                  onClick={() => handleUnarchiveTask(t)}
                                  className="px-2 py-1 text-[11px] font-semibold text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded"
                                >
                                  Batal Arsip
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleArchiveTask(t)}
                                  className="px-2 py-1 text-[11px] font-semibold text-amber-700 bg-amber-50 hover:bg-amber-100 rounded border border-amber-200"
                                >
                                  Arsipkan
                                </button>
                              )}
                            </>
                          ) : null}

                          {t.status === 'ASSIGNED' && (
                            <button
                              type="button"
                              onClick={() => handleAcknowledge(t)}
                              className="px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded border border-indigo-200"
                            >
                              Terima
                            </button>
                          )}

                          {t.status === 'ACKNOWLEDGED' && (
                            <button
                              type="button"
                              onClick={() => handleStart(t)}
                              className="px-2.5 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200"
                            >
                              Mulai
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => openTaskDrawer(t)}
                            className="px-2.5 py-1 text-[11px] font-semibold text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded"
                          >
                            Rincian & Checklist
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

      {/* Slide-over Detail Drawer */}
      {selectedTask && (
        <HousekeepingTaskDetailDrawer
          task={selectedTask}
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
          onAcknowledge={handleAcknowledge}
          onStart={handleStart}
          onToggleChecklistItem={handleToggleChecklistItem}
          onComplete={handleComplete}
          isSubmitting={isActionSubmitting}
        />
      )}

      {/* Create Task Modal */}
      <CreateTaskModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleCreateTask}
        rooms={rooms}
        templates={templates}
      />

      {/* Safe History Correction Modal */}
      {historyEditTask && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-neutral-200 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <div>
                <h3 className="font-bold text-sm text-neutral-900">
                  Koreksi Riwayat Tugas {historyEditTask.task_number}
                </h3>
                <p className="text-xs text-neutral-500">
                  Kamar {historyEditTask.room_number || 'Non-Kamar'} &bull; {historyEditTask.task_type}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryEditTask(null)}
                className="text-neutral-400 hover:text-neutral-600 text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSaveHistoryEdit} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-neutral-700 mb-1">Catatan Tugas / Operasional:</label>
                <textarea
                  rows={2}
                  value={historyEditForm.notes}
                  onChange={(e) => setHistoryEditForm(p => ({ ...p, notes: e.target.value }))}
                  className="w-full p-2.5 rounded-xl border border-neutral-300 text-xs focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              {historyEditTask.task_type === 'CHECKOUT_ROOM_CHECK' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-neutral-700 mb-1">Hasil Pemeriksaan:</label>
                    <select
                      value={historyEditForm.inspection_result}
                      onChange={(e) => setHistoryEditForm(p => ({ ...p, inspection_result: e.target.value }))}
                      className="w-full p-2 rounded-xl border border-neutral-300 text-xs focus:ring-1 focus:ring-emerald-500"
                    >
                      <option value="CLEAR">CLEAR (Kamar Aman)</option>
                      <option value="ISSUE_FOUND">ISSUE_FOUND (Ada Temuan)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-neutral-700 mb-1">Estimasi Charge (Rp):</label>
                    <input
                      type="number"
                      value={historyEditForm.damage_charge_estimate}
                      onChange={(e) => setHistoryEditForm(p => ({ ...p, damage_charge_estimate: e.target.value }))}
                      className="w-full p-2 rounded-xl border border-neutral-300 text-xs focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>
              )}

              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl space-y-1.5">
                <label className="block font-bold text-amber-900">
                  Alasan Perubahan / Koreksi (Wajib untuk Audit Log):
                </label>
                <input
                  type="text"
                  required
                  placeholder="Contoh: Koreksi catatan minibar / salah input PIC"
                  value={historyEditForm.reason}
                  onChange={(e) => setHistoryEditForm(p => ({ ...p, reason: e.target.value }))}
                  className="w-full p-2 rounded-lg border border-amber-300 bg-white text-xs text-neutral-800 placeholder:text-neutral-400 focus:ring-1 focus:ring-amber-500"
                />
              </div>

              <div className="flex gap-2 pt-2 justify-end">
                <button
                  type="button"
                  onClick={() => setHistoryEditTask(null)}
                  className="px-4 py-2 rounded-xl text-neutral-600 bg-neutral-100 hover:bg-neutral-200 font-semibold"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isHistorySaving}
                  className="px-4 py-2 rounded-xl text-white bg-[#1b4332] hover:bg-[#143225] font-semibold shadow"
                >
                  {isHistorySaving ? 'Menyimpan...' : 'Simpan Koreksi & Audit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
