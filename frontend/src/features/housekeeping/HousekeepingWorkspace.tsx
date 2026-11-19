import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Check,
  Play,
  ClipboardCheck,
  Ban,
  Unlock,
  Pencil,
  Archive,
  RotateCcw,
  Wrench,
  Plus,
  RefreshCw,
  Settings
} from 'lucide-react';
import type {
  HousekeepingTaskRecord,
  HousekeepingDailyMetrics,
  HousekeepingTab,
  ChecklistTemplate,
  TaskChecklistItem,
  PropertyHousekeepingSettings,
  HkInspectionResult,
  HkIssueType,
  HkTaskCategory,
  HkTaskPriority,
  HkTaskStatus
} from './housekeepingTypes';
import { HousekeepingTaskDetailDrawer } from './HousekeepingTaskDetailDrawer';
import { CreateTaskModal } from './CreateTaskModal';
import { MaintenanceIssuesModal } from './MaintenanceIssuesModal';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { useAuth } from '../auth/AuthContext';

export interface HkRoomBlockRecord {
  id: number;
  property_id: number;
  room_id: number;
  room_number: string;
  room_type_id: number;
  room_type_code?: string;
  room_type_name?: string;
  block_type: 'OUT_OF_ORDER' | 'OUT_OF_SERVICE';
  start_date: string;
  end_date: string;
  duration_days: number;
  reason?: string | null;
  status: 'ACTIVE' | 'RELEASED' | 'CANCELLED';
  created_by?: string | null;
  created_at?: string | null;
  released_by?: string | null;
  released_at?: string | null;
  current_room_status?: string | null;
}

export type MetricCardKey =
  | 'DIRTY'
  | 'CLEANING'
  | 'WAITING_INSPECTION'
  | 'READY'
  | 'CHECKOUT_CHECK'
  | 'MAINTENANCE'
  | 'TURNOVER'
  | 'OVERDUE';

export interface MetricCardDef {
  key: MetricCardKey;
  label: string;
  sublabel: string;
  countKey: keyof HousekeepingDailyMetrics;
  activeClass: string;
  hoverClass: string;
  textClass: string;
}

export const DEFAULT_METRIC_CARDS: MetricCardDef[] = [
  {
    key: 'CHECKOUT_CHECK',
    label: 'Checkout Check',
    sublabel: 'Minibar & Room Check',
    countKey: 'checkout_check',
    activeClass: 'bg-purple-100/70 border-purple-500 ring-2 ring-purple-400',
    hoverClass: 'bg-white border-neutral-200 hover:border-purple-300',
    textClass: 'text-purple-700'
  },
  {
    key: 'DIRTY',
    label: 'Kamar Kotor',
    sublabel: 'Vacant/Occupied Dirty',
    countKey: 'dirty',
    activeClass: 'bg-amber-100/70 border-amber-500 ring-2 ring-amber-400',
    hoverClass: 'bg-white border-neutral-200 hover:border-amber-300',
    textClass: 'text-amber-700'
  },
  {
    key: 'CLEANING',
    label: 'Sedang Dibersihkan',
    sublabel: 'In Progress HK',
    countKey: 'cleaning',
    activeClass: 'bg-blue-100/70 border-blue-500 ring-2 ring-blue-400',
    hoverClass: 'bg-white border-neutral-200 hover:border-blue-300',
    textClass: 'text-blue-700'
  },
  {
    key: 'WAITING_INSPECTION',
    label: 'Menunggu Inspeksi',
    sublabel: 'Supervisor Check',
    countKey: 'waiting_inspection',
    activeClass: 'bg-indigo-100/70 border-indigo-500 ring-2 ring-indigo-400',
    hoverClass: 'bg-white border-neutral-200 hover:border-indigo-300',
    textClass: 'text-indigo-700'
  },
  {
    key: 'READY',
    label: 'Kamar Siap Huni',
    sublabel: 'Clean / Inspected',
    countKey: 'ready',
    activeClass: 'bg-emerald-100/70 border-emerald-500 ring-2 ring-emerald-400',
    hoverClass: 'bg-white border-neutral-200 hover:border-emerald-300',
    textClass: 'text-emerald-700'
  },
  {
    key: 'MAINTENANCE',
    label: 'Kamar Maintenance',
    sublabel: 'Kendala & Kerusakan',
    countKey: 'maintenance',
    activeClass: 'bg-amber-100/80 border-amber-600 ring-2 ring-amber-400',
    hoverClass: 'bg-white border-neutral-200 hover:border-amber-400',
    textClass: 'text-amber-800'
  },
  {
    key: 'TURNOVER',
    label: 'Priority Turnover',
    sublabel: 'CO + Arrival Hari Ini',
    countKey: 'priority_turnover',
    activeClass: 'bg-red-100/70 border-red-500 ring-2 ring-red-400',
    hoverClass: 'bg-white border-neutral-200 hover:border-red-300',
    textClass: 'text-red-700'
  },
  {
    key: 'OVERDUE',
    label: 'Terlambat (Overdue)',
    sublabel: 'Lewat Batas Waktu',
    countKey: 'overdue',
    activeClass: 'bg-rose-100/70 border-rose-500 ring-2 ring-rose-400',
    hoverClass: 'bg-white border-neutral-200 hover:border-rose-300',
    textClass: 'text-rose-700'
  }
];

const METRIC_CARD_MAP = new Map<MetricCardKey, MetricCardDef>(
  DEFAULT_METRIC_CARDS.map((c) => [c.key, c])
);

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
  const { user } = useAuth();
  const currentUserName = user?.full_name || user?.username || 'Staff';
  const currentUserRole = user?.role || 'Staff';
  const currentUserId = user?.id;

  const [activeTab, setActiveTab] = useState<HousekeepingTab>('room_operations');
  const [dateStr, setDateStr] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [metrics, setMetrics] = useState<HousekeepingDailyMetrics | null>(null);
  const [tasks, setTasks] = useState<HousekeepingTaskRecord[]>([]);
  const [dailyRooms, setDailyRooms] = useState<Array<any>>([]);
  const [historyTasks, setHistoryTasks] = useState<HousekeepingTaskRecord[]>([]);
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [rooms, setRooms] = useState<Array<{ id: number; room_number: string; status?: string; room_type_name?: string }>>([]);
  const [staffList, setStaffList] = useState<Array<{ id?: number | null; name: string; role?: string }>>([]);
  const [roomBlocks, setRoomBlocks] = useState<HkRoomBlockRecord[]>([]);
  const [hkSettings, setHkSettings] = useState<PropertyHousekeepingSettings | null>(null);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filter & Search
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [metricFilter, setMetricFilter] = useState<string | null>(null);
  const [isMaintenanceModalOpen, setIsMaintenanceModalOpen] = useState<boolean>(false);

  // OO (Out of Order / Out of Service) Modal State
  const [isOoModalOpen, setIsOoModalOpen] = useState<boolean>(false);
  const [ooForm, setOoForm] = useState<{
    room_id: string;
    block_type: 'OUT_OF_ORDER' | 'OUT_OF_SERVICE';
    start_date: string;
    end_date: string;
    reason: string;
    created_by: string;
  }>(() => {
    const today = new Date().toISOString().slice(0, 10);
    const tmr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return {
      room_id: '',
      block_type: 'OUT_OF_ORDER',
      start_date: today,
      end_date: tmr,
      reason: '',
      created_by: ''
    };
  });
  const [isOoSubmitting, setIsOoSubmitting] = useState<boolean>(false);
  const [ooErrorMsg, setOoErrorMsg] = useState<string | null>(null);

  // Release OO Modal State
  const [releaseBlockTarget, setReleaseBlockTarget] = useState<HkRoomBlockRecord | null>(null);
  const [releaseTargetRoomStatus, setReleaseTargetRoomStatus] = useState<'VACANT_DIRTY' | 'VACANT_CLEAN'>('VACANT_DIRTY');
  const [releaseReason, setReleaseReason] = useState<string>('');
  const [isReleasingBlock, setIsReleasingBlock] = useState<boolean>(false);

  // Metric Cards Custom Order State
  const [cardOrder, setCardOrder] = useState<MetricCardKey[]>(() => {
    try {
      const saved = localStorage.getItem('oak_hk_metric_cards_order_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === DEFAULT_METRIC_CARDS.length) {
          const validKeys = new Set(DEFAULT_METRIC_CARDS.map((c) => c.key));
          if (parsed.every((k: string) => validKeys.has(k as MetricCardKey))) {
            return parsed as MetricCardKey[];
          }
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_METRIC_CARDS.map((c) => c.key);
  });

  const [isReorderMode, setIsReorderMode] = useState<boolean>(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const handleMoveCard = (index: number, direction: 'left' | 'right') => {
    const targetIndex = direction === 'left' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= cardOrder.length) return;
    const newOrder = [...cardOrder];
    const temp = newOrder[index];
    newOrder[index] = newOrder[targetIndex];
    newOrder[targetIndex] = temp;
    setCardOrder(newOrder);
    try {
      localStorage.setItem('oak_hk_metric_cards_order_v1', JSON.stringify(newOrder));
    } catch {
      // ignore
    }
  };

  const handleResetCardOrder = () => {
    const defaultOrder = DEFAULT_METRIC_CARDS.map((c) => c.key);
    setCardOrder(defaultOrder);
    try {
      localStorage.removeItem('oak_hk_metric_cards_order_v1');
    } catch {
      // ignore
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDraggedIndex(null);
      return;
    }
    const newOrder = [...cardOrder];
    const [draggedItem] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(dropIndex, 0, draggedItem);
    setCardOrder(newOrder);
    setDraggedIndex(null);
    try {
      localStorage.setItem('oak_hk_metric_cards_order_v1', JSON.stringify(newOrder));
    } catch {
      // ignore
    }
  };

  // Drawer & Modal State
  const [selectedTask, setSelectedTask] = useState<HousekeepingTaskRecord | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [isActionSubmitting, setIsActionSubmitting] = useState<boolean>(false);

  // History Tab Specific States
  const [historyPreset, setHistoryPreset] = useState<'today' | 'yesterday' | 'custom' | '7days' | '30days' | 'this_month' | 'all'>('today');
  const [includeArchived, setIncludeArchived] = useState<boolean>(false);
  const [historyEditTask, setHistoryEditTask] = useState<HousekeepingTaskRecord | null>(null);
  const [historyEditForm, setHistoryEditForm] = useState<{
    notes: string;
    inspection_result: string;
    damage_charge_estimate: string;
    reason: string;
    assigned_user_name_snapshot: string;
  }>({
    notes: '',
    inspection_result: 'CLEAR',
    damage_charge_estimate: '0',
    reason: '',
    assigned_user_name_snapshot: ''
  });
  const [isHistorySaving, setIsHistorySaving] = useState<boolean>(false);

  // Date Presets & Helpers
  const todayStr = useMemo(() => {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, []);

  const yesterdayStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, []);

  const handleSelectDate = (newDate: string) => {
    setDateStr(newDate);
    if (newDate === todayStr) {
      setHistoryPreset('today');
    } else if (newDate === yesterdayStr) {
      setHistoryPreset('yesterday');
    } else {
      setHistoryPreset('custom');
    }
  };

  // Fetch room operational blocks (OO / OOS)
  const fetchRoomBlocks = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/room-blocks?property_id=${propertyId}&status=ALL`);
      if (res.ok) {
        const json = await res.json();
        setRoomBlocks(json.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch HK room blocks:', err);
    }
  }, [apiBaseUrl, propertyId]);

  // Fetch daily operations & tasks
  const fetchDailyOperations = useCallback(async (isBackground = false) => {
    if (!isBackground) setIsLoading(true);
    else setIsRefreshing(true);
    setErrorMsg(null);

    try {
      const [res] = await Promise.all([
        authenticatedFetch(`${apiBaseUrl}/housekeeping/daily-operations?property_id=${propertyId}&date=${dateStr}`),
        fetchRoomBlocks()
      ]);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal memuat operasional housekeeping');
      }
      const json = await res.json();
      if (json.status === 'OK' && json.data) {
        setMetrics(json.data.metrics);
        setTasks(json.data.tasks || []);
        if (Array.isArray(json.data.rooms)) {
          setDailyRooms(json.data.rooms);
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Terjadi kesalahan sistem');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [apiBaseUrl, propertyId, dateStr, fetchRoomBlocks]);

  // Fetch templates, rooms & staff for task creation & PIC assignment
  const fetchTemplatesAndRooms = useCallback(async () => {
    try {
      const [tplRes, roomRes, staffRes] = await Promise.all([
        authenticatedFetch(`${apiBaseUrl}/housekeeping/templates?property_id=${propertyId}`),
        authenticatedFetch(`${apiBaseUrl}/rooms?property_id=${propertyId}&is_active=true`),
        authenticatedFetch(`${apiBaseUrl}/housekeeping/staff?property_id=${propertyId}`)
      ]);

      if (tplRes.ok) {
        const tplJson = await tplRes.json();
        setTemplates(tplJson.data || []);
      }
      if (roomRes.ok) {
        const roomJson = await roomRes.json();
        setRooms(roomJson.data || []);
      }
      if (staffRes.ok) {
        const staffJson = await staffRes.json();
        setStaffList(staffJson.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch templates/rooms/staff:', err);
    }
  }, [apiBaseUrl, propertyId]);

  // Fetch housekeeping settings (for category bulk check, etc.)
  const fetchSettings = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/settings?property_id=${propertyId}`);
      if (res.ok) {
        const json = await res.json();
        if (json.data) {
          setHkSettings(json.data);
        }
      }
    } catch (err) {
      console.error('Failed to fetch housekeeping settings:', err);
    }
  }, [apiBaseUrl, propertyId]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Fetch history tasks
  const fetchHistory = useCallback(async (preset = historyPreset, incArchived = includeArchived, customDate = dateStr) => {
    try {
      let queryParam = '';
      if (preset === 'custom' && customDate) {
        queryParam = `&start_date=${customDate}&end_date=${customDate}`;
      } else if (preset === 'today') {
        queryParam = `&preset=today`;
      } else if (preset === 'yesterday') {
        queryParam = `&preset=yesterday`;
      } else if (preset && preset !== 'all') {
        queryParam = `&preset=${preset}`;
      }
      const url = `${apiBaseUrl}/housekeeping/history?property_id=${propertyId}${queryParam}${incArchived ? '&include_archived=true' : ''}`;
      const res = await authenticatedFetch(url);
      if (res.ok) {
        const json = await res.json();
        setHistoryTasks(json.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch HK history:', err);
    }
  }, [apiBaseUrl, propertyId, historyPreset, includeArchived, dateStr]);

  useEffect(() => {
    fetchDailyOperations();
    fetchTemplatesAndRooms();
  }, [fetchDailyOperations, fetchTemplatesAndRooms]);

  useEffect(() => {
    if (activeTab === 'history') {
      fetchHistory(historyPreset, includeArchived, dateStr);
      fetchRoomBlocks();
    }
  }, [activeTab, historyPreset, includeArchived, dateStr, fetchHistory, fetchRoomBlocks]);

  // History Actions: Safe Edit, Archive, Unarchive
  const handleOpenHistoryEdit = (task: HousekeepingTaskRecord) => {
    setHistoryEditTask(task);
    setHistoryEditForm({
      notes: task.notes || '',
      inspection_result: task.inspection_result || 'CLEAR',
      damage_charge_estimate: String(task.damage_charge_estimate || 0),
      reason: '',
      assigned_user_name_snapshot:
        task.assigned_user_name_snapshot && !['HOUSEKEEPING STAFF', 'STAFF', 'SYSTEM'].includes(task.assigned_user_name_snapshot.toUpperCase())
          ? task.assigned_user_name_snapshot
          : currentUserName
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
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${historyEditTask.id}/history-edit`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          actor_id: currentUserId,
          actor_name: currentUserName,
          actor_role: currentUserRole,
          reason: historyEditForm.reason.trim(),
          notes: historyEditForm.notes.trim(),
          assigned_user_name_snapshot: historyEditForm.assigned_user_name_snapshot.trim() || currentUserName,
          inspection_result: historyEditForm.inspection_result,
          damage_charge_estimate: Number(historyEditForm.damage_charge_estimate) || 0
        })
      });

      if (res.ok) {
        setHistoryEditTask(null);
        await fetchHistory(historyPreset, includeArchived);
        await fetchDailyOperations(true);
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
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          archived_by: currentUserName,
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
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/unarchive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          unarchived_by: currentUserName
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

  // Assign PIC inline
  const handleAssignPic = async (task: HousekeepingTaskRecord, newPicName: string) => {
    if (!task.id || task.id < 0) return;
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/assign`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          assigned_user_name_snapshot: newPicName || null,
          actor_name: currentUserName
        })
      });
      if (res.ok) {
        await fetchDailyOperations(true);
        if (activeTab === 'history') await fetchHistory(historyPreset, includeArchived);
      }
    } catch (err) {
      console.error('Failed to assign PIC:', err);
    }
  };

  // Ensure dirty room task exists and open drawer / start
  const handleEnsureDirtyRoomTask = async (roomId: number, autoStart = false) => {
    setIsActionSubmitting(true);
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/ensure-dirty-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          room_id: roomId,
          actor_id: currentUserId,
          actor_name: currentUserName,
          actor_role: currentUserRole
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal menyiapkan tugas pembersihan kamar');
      }
      const json = await res.json();
      const task: HousekeepingTaskRecord = json.data;
      if (autoStart && task && task.id) {
        await handleStart(task);
      } else if (task && task.id) {
        await fetchDailyOperations(true);
        // Load full checklist items for drawer
        const detailRes = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}?property_id=${propertyId}`);
        if (detailRes.ok) {
          const detailJson = await detailRes.json();
          setSelectedTask(detailJson.data || task);
        } else {
          setSelectedTask(task);
        }
        setIsDrawerOpen(true);
      }
    } catch (err: any) {
      alert(err.message || 'Gagal membuka tugas pembersihan kamar');
    } finally {
      setIsActionSubmitting(false);
    }
  };

  // Open Set Kamar OO Modal
  const handleOpenOoModal = (roomId?: number) => {
    const start = dateStr || todayStr;
    const nextDay = new Date(new Date(`${start}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
    setOoForm({
      room_id: roomId ? String(roomId) : '',
      block_type: 'OUT_OF_ORDER',
      start_date: start,
      end_date: nextDay,
      reason: '',
      created_by: currentUserName
    });
    setOoErrorMsg(null);
    setIsOoModalOpen(true);
  };

  const handleSubmitOoBlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setOoErrorMsg(null);
    if (!ooForm.room_id) {
      setOoErrorMsg('Silakan pilih nomor kamar terlebih dahulu.');
      return;
    }
    if (!ooForm.reason.trim()) {
      setOoErrorMsg('Alasan / kendala penetapan OO wajib diisi.');
      return;
    }
    setIsOoSubmitting(true);
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/room-blocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          room_id: Number(ooForm.room_id),
          block_type: ooForm.block_type,
          start_date: ooForm.start_date,
          end_date: ooForm.end_date,
          reason: ooForm.reason.trim(),
          created_by: ooForm.created_by.trim() || currentUserName
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menetapkan kamar OO.');
      }
      setIsOoModalOpen(false);
      await fetchDailyOperations(true);
      await fetchTemplatesAndRooms();
    } catch (err: any) {
      setOoErrorMsg(err.message || 'Gagal menetapkan kamar OO.');
    } finally {
      setIsOoSubmitting(false);
    }
  };

  const handleConfirmReleaseOoBlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!releaseBlockTarget) return;
    setIsReleasingBlock(true);
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/room-blocks/${releaseBlockTarget.id}/release`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          released_by: currentUserName,
          target_room_status: releaseTargetRoomStatus,
          reason: releaseReason.trim() || 'Selesai perbaikan / dilepas dari Housekeeping'
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.message || 'Gagal melepas status OO kamar.');
      }
      setReleaseBlockTarget(null);
      setReleaseReason('');
      await fetchDailyOperations(true);
      await fetchTemplatesAndRooms();
    } catch (err: any) {
      alert(err.message || 'Gagal melepas status OO kamar.');
    } finally {
      setIsReleasingBlock(false);
    }
  };

  const activeRoomBlocks = useMemo(
    () => roomBlocks.filter((b) => b.status === 'ACTIVE'),
    [roomBlocks]
  );

  // Filter tasks based on activeTab, metricFilter, statusFilter, and searchTerm
  const filteredTasks = useMemo(() => {
    const isTerminalStatus = (s?: string | null) =>
      s === 'DONE' || s === 'VERIFIED' || s === 'CANCELLED';

    let source: HousekeepingTaskRecord[] = [];
    if (activeTab === 'history') {
      source = [...historyTasks];
    } else {
      // Active operational tabs: exclude terminal tasks unless user explicitly filtered status === 'DONE'
      const activePool = statusFilter === 'DONE'
        ? tasks.filter((t) => t.status === 'DONE' || t.status === 'VERIFIED')
        : tasks.filter((t) => !isTerminalStatus(t.status));

      if (activeTab === 'room_operations') {
        // Deduplicate active ROOM_CLEANING tasks per room_id so 1 dirty room = 1 row
        const byRoomCleaning = new Map<number, HousekeepingTaskRecord>();
        const otherOps: HousekeepingTaskRecord[] = [];
        for (const t of activePool) {
          if (t.task_category !== 'ROOM_OPERATIONS') continue;
          if (t.task_type === 'ROOM_CLEANING' && t.room_id) {
            const rid = Number(t.room_id);
            const existing = byRoomCleaning.get(rid);
            if (!existing) {
              byRoomCleaning.set(rid, t);
            } else {
              const rank = (s: string) => (s === 'IN_PROGRESS' ? 1 : s === 'ACKNOWLEDGED' ? 2 : s === 'ASSIGNED' ? 3 : 4);
              if (rank(t.status) < rank(existing.status)) {
                byRoomCleaning.set(rid, t);
              }
            }
          } else {
            otherOps.push(t);
          }
        }
        source = [...Array.from(byRoomCleaning.values()), ...otherOps];

        // Ensure every physical room in VACANT_DIRTY / OCCUPIED_DIRTY / DIRTY (or READY / MAINTENANCE when selected) has a row
        const roomPool = dailyRooms.length > 0 ? dailyRooms : rooms;
        const roomsWithActiveRow = new Set<number>(
          source.filter((t) => t.room_id).map((t) => Number(t.room_id))
        );

        for (const r of roomPool) {
          const rid = Number(r.id);
          const rStatus = String(r.status || '').toUpperCase();
          const isDirtyRoom = rStatus === 'VACANT_DIRTY' || rStatus === 'OCCUPIED_DIRTY' || rStatus === 'DIRTY';
          const isCleaningRoom = rStatus === 'CLEANING';
          const isReadyRoom = rStatus === 'VACANT_CLEAN' || rStatus === 'INSPECTED';
          const isMaintRoom = rStatus === 'OUT_OF_ORDER' || rStatus === 'OUT_OF_SERVICE' || rStatus === 'MAINTENANCE' || rStatus === 'REPAIR' || Boolean(r.active_block) || Boolean(r.has_active_finding);

          if (!roomsWithActiveRow.has(rid)) {
            if (isDirtyRoom || isCleaningRoom || (metricFilter === 'READY' && isReadyRoom) || (metricFilter === 'MAINTENANCE' && isMaintRoom)) {
              source.push({
                id: -rid,
                property_id: propertyId,
                task_number: `ROOM-${r.room_number}`,
                room_id: rid,
                room_number: String(r.room_number),
                room_status: r.status || 'VACANT_DIRTY',
                room_type_name: r.room_type_name || null,
                task_category: 'ROOM_OPERATIONS',
                task_type: 'ROOM_CLEANING',
                title: isDirtyRoom
                  ? `Pembersihan Kamar ${r.room_number}`
                  : isReadyRoom
                  ? `Kamar ${r.room_number} Siap Huni (${rStatus})`
                  : isMaintRoom
                  ? `Kamar ${r.room_number} Maintenance / ${r.active_block?.block_type || rStatus}`
                  : `Operasional Kamar ${r.room_number}`,
                description: r.active_block?.reason || null,
                priority: 'NORMAL',
                status: isReadyRoom ? ('DONE' as HkTaskStatus) : ('ASSIGNED' as HkTaskStatus),
                assigned_department: 'Housekeeping',
                assigned_user_name_snapshot: isReadyRoom
                  ? (r.last_cleaned_by_name || r.last_inspected_by_name || null)
                  : currentUserName,
                cleaned_by_name: r.last_cleaned_by_name || null,
                inspected_by_name: r.last_inspected_by_name || null,
                last_cleaned_at: r.last_cleaned_at || null,
                last_inspected_at: r.last_inspected_at || null,
                source_type: 'ROOM',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              } as HousekeepingTaskRecord);
            }
          }
        }
      } else if (activeTab === 'checkout_inspection') {
        source = activePool.filter((t) => t.task_type === 'CHECKOUT_ROOM_CHECK');
      } else if (activeTab === 'service_requests') {
        source = activePool.filter((t) => t.task_category === 'SERVICE_REQUEST');
      } else if (activeTab === 'department_tasks') {
        source = activePool.filter((t) => t.task_category === 'DEPARTMENT_TASK');
      }
    }

    // Metric card filter if active
    if (metricFilter && activeTab !== 'history') {
      const now = new Date();
      if (metricFilter === 'DIRTY') {
        source = source.filter(
          (t) =>
            (t.room_status === 'VACANT_DIRTY' || t.room_status === 'OCCUPIED_DIRTY' || t.room_status === 'DIRTY') &&
            t.task_type === 'ROOM_CLEANING'
        );
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
      } else if (metricFilter === 'MAINTENANCE') {
        const blockedRoomIds = new Set(activeRoomBlocks.map((b) => Number(b.room_id)));
        source = source.filter(
          (t) =>
            t.room_status === 'OUT_OF_SERVICE' ||
            t.room_status === 'OUT_OF_ORDER' ||
            t.room_status === 'MAINTENANCE' ||
            t.room_status === 'REPAIR' ||
            (t.room_id && blockedRoomIds.has(Number(t.room_id)))
        );
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
  }, [tasks, dailyRooms, rooms, historyTasks, activeTab, metricFilter, statusFilter, searchTerm, propertyId, currentUserName, activeRoomBlocks]);

  // Actions
  const handleAcknowledge = async (task: HousekeepingTaskRecord) => {
    if (task.id < 0 && task.room_id) {
      await handleEnsureDirtyRoomTask(Number(task.room_id), false);
      return;
    }
    setIsActionSubmitting(true);
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/acknowledge`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          actor_id: currentUserId,
          actor_name: currentUserName,
          actor_role: currentUserRole
        })
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
    if (task.id < 0 && task.room_id) {
      await handleEnsureDirtyRoomTask(Number(task.room_id), true);
      return;
    }
    setIsActionSubmitting(true);
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/start`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          actor_id: currentUserId,
          actor_name: currentUserName,
          actor_role: currentUserRole
        })
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
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/checklist-items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          is_completed: isCompleted,
          actor_id: currentUserId,
          actor_name: currentUserName,
          actor_role: currentUserRole
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

  const handleBulkToggleCategory = async (
    task: HousekeepingTaskRecord,
    categoryName: string,
    items: TaskChecklistItem[],
    isCompleted: boolean
  ) => {
    try {
      const itemIds = items.map((i) => i.id);
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/checklist/bulk-category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          category: categoryName,
          item_ids: itemIds,
          is_completed: isCompleted,
          actor_id: currentUserId,
          actor_name: currentUserName,
          actor_role: currentUserRole
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal memperbarui checklist kategori');
      }
      const data = await res.json();
      const updatedRows: TaskChecklistItem[] = data.data?.updated_items || [];
      const updatedMap = new Map<number, TaskChecklistItem>(updatedRows.map((r) => [r.id, r]));

      setSelectedTask((prev) => {
        if (!prev) return null;
        const newItems = (prev.checklist_items || []).map((i) => updatedMap.get(i.id) || i);
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
      minibar_items?: Array<{ menu_item_id: number; quantity: number; unit_price?: number }>;
      complimentary_items?: Array<{ menu_item_id: number; quantity: number }>;
    }
  ) => {
    setIsActionSubmitting(true);
    try {
      const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks/${task.id}/complete`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          ...payload,
          actor_id: currentUserId,
          actor_name: currentUserName,
          actor_role: currentUserRole
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
    const res = await authenticatedFetch(`${apiBaseUrl}/housekeeping/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_id: propertyId,
        ...payload,
        assigned_user_name_snapshot: payload.assigned_user_name_snapshot || currentUserName,
        requested_by_user_id: currentUserId,
        requested_by_name: currentUserName,
        requested_by_role: currentUserRole
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Gagal membuat tugas');
    }
    await fetchDailyOperations(true);
  };

  const openTaskDrawer = async (task: HousekeepingTaskRecord) => {
    if (task.id < 0 && task.room_id) {
      await handleEnsureDirtyRoomTask(Number(task.room_id), false);
      return;
    }
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
    if (s === 'VACANT_CLEAN' || s === 'INSPECTED' || s === 'OCCUPIED_CLEAN') {
      return <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-emerald-100 text-emerald-900">{s}</span>;
    }
    if (s === 'CLEANING') {
      return <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-blue-100 text-blue-900">{s}</span>;
    }
    if (s === 'VACANT_DIRTY' || s === 'OCCUPIED_DIRTY' || s === 'DIRTY') {
      return <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-100 text-amber-900">{s}</span>;
    }
    if (s === 'OUT_OF_ORDER' || s === 'OUT_OF_SERVICE') {
      return <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-rose-100 text-rose-900 border border-rose-200">{s === 'OUT_OF_ORDER' ? 'OO (OUT OF ORDER)' : 'OOS (OUT OF SERVICE)'}</span>;
    }
    return <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-neutral-100 text-neutral-700">{s}</span>;
  };

  const ooDurationDays = useMemo(() => {
    if (!ooForm.start_date || !ooForm.end_date) return 0;
    const s = new Date(`${ooForm.start_date}T00:00:00Z`).getTime();
    const e = new Date(`${ooForm.end_date}T00:00:00Z`).getTime();
    return Math.max(0, Math.round((e - s) / 86400000));
  }, [ooForm.start_date, ooForm.end_date]);

  return (
    <div className="space-y-5">
      {/* Top Banner / Operational Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-neutral-200 shadow-xs">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-bold text-neutral-900">Housekeeping & Operasional Harian</h1>
            <span className="px-2 py-0.5 text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full">
              Authoritative HK Domain
            </span>
            <span className="px-2 py-0.5 text-[11px] font-semibold bg-neutral-100 text-neutral-700 border border-neutral-200 rounded-full">
              Petugas Aktif: {currentUserName}
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-0.5">
            Pusat manajemen kesiapan kamar, alur turnover, inspeksi checkout, checklist kebersihan, dan blokir kamar OO.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Quick Date Control */}
          <div className="flex items-center gap-1 bg-neutral-100 p-1 rounded-lg border border-neutral-200">
            <button
              type="button"
              onClick={() => handleSelectDate(todayStr)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition flex items-center gap-1 cursor-pointer ${
                dateStr === todayStr
                  ? 'bg-[#1b4332] text-white shadow-xs'
                  : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-200/70'
              }`}
            >
              <span>Hari Ini</span>
            </button>
            <button
              type="button"
              onClick={() => handleSelectDate(yesterdayStr)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition flex items-center gap-1 cursor-pointer ${
                dateStr === yesterdayStr
                  ? 'bg-[#1b4332] text-white shadow-xs'
                  : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-200/70'
              }`}
            >
              <span>Kemarin</span>
            </button>
            <div className="relative flex items-center">
              <div className="absolute left-2.5 text-neutral-500 pointer-events-none">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <input
                type="date"
                value={dateStr}
                onChange={(e) => handleSelectDate(e.target.value)}
                className={`pl-8 pr-2.5 py-1 text-xs font-semibold rounded-md border transition cursor-pointer ${
                  dateStr !== todayStr && dateStr !== yesterdayStr
                    ? 'bg-[#1b4332] text-white border-[#1b4332]'
                    : 'bg-white text-neutral-800 border-neutral-300 hover:border-neutral-400'
                }`}
                title="Pencarian Tanggal Manual"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              fetchDailyOperations(true);
              if (activeTab === 'history') fetchHistory(historyPreset, includeArchived, dateStr);
            }}
            disabled={isRefreshing}
            className="p-2 text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors cursor-pointer border border-neutral-200"
            title="Segarkan Data"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          {onNavigateToSettings && (
            <button
              type="button"
              onClick={() => onNavigateToSettings('housekeeping')}
              className="px-3 py-1.5 text-xs font-semibold text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
              title="Buka Pengaturan Housekeeping di Manajemen → Pengaturan"
            >
              <Settings className="w-3.5 h-3.5 text-neutral-500" />
              Pengaturan Modul ↗
            </button>
          )}
          <button
            type="button"
            onClick={() => handleOpenOoModal()}
            className="px-3 py-1.5 text-xs font-bold text-rose-800 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
            title="Tetapkan Kamar Out of Order (OO) / Out of Service (OOS) terintegrasi dengan Kalender & Laporan"
          >
            <Ban className="w-3.5 h-3.5 text-rose-700" />
            Set Kamar OO
          </button>
          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="px-3.5 py-1.5 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors flex items-center gap-1.5 shadow-xs cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Buat Tugas
          </button>
        </div>
      </div>

      {/* Daily Operational Metric Cards & Position Customizer */}
      {metrics && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-neutral-700">Ringkasan Status Kamar</span>
              {isReorderMode && (
                <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md flex items-center gap-1">
                  Mode Atur Posisi: Geser dengan tombol ◀ / ▶ atau seret (drag & drop)
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {isReorderMode && (
                <button
                  type="button"
                  onClick={handleResetCardOrder}
                  className="px-2 py-1 text-xs text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors cursor-pointer border border-neutral-200"
                  title="Kembalikan ke urutan standar"
                >
                  Reset ke Default
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsReorderMode(!isReorderMode)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer border ${
                  isReorderMode
                    ? 'bg-emerald-700 text-white border-emerald-800 shadow-xs'
                    : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50'
                }`}
                title="Atur Urutan dan Posisi Kartu Metrik"
              >
                {isReorderMode ? 'Selesai Atur' : 'Atur Posisi Kartu'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {cardOrder.map((key, index) => {
              const def = METRIC_CARD_MAP.get(key);
              if (!def) return null;
              const countVal = metrics[def.countKey] ?? 0;
              const isActive = metricFilter === def.key;

              return (
                <div
                  key={def.key}
                  draggable={isReorderMode}
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={() => setDraggedIndex(null)}
                  className={`relative rounded-xl border transition-all ${
                    isReorderMode
                      ? 'cursor-grab active:cursor-grabbing hover:shadow-md select-none bg-white border-amber-400 ring-1 ring-amber-300'
                      : isActive
                      ? def.activeClass
                      : def.hoverClass
                  } ${draggedIndex === index ? 'opacity-40 scale-95 border-dashed border-2 border-amber-600' : ''}`}
                >
                  {isReorderMode ? (
                    <div className="p-2.5 flex flex-col justify-between h-full">
                      <div className="flex items-center justify-between pb-1 border-b border-neutral-100">
                        <span className="text-[10px] font-bold text-neutral-400 bg-neutral-100 px-1.5 py-0.5 rounded">
                          #{index + 1}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => handleMoveCard(index, 'left')}
                            className="p-1 rounded hover:bg-neutral-200 disabled:opacity-20 text-neutral-700 cursor-pointer disabled:cursor-not-allowed"
                            title="Geser ke kiri"
                          >
                            ◀
                          </button>
                          <button
                            type="button"
                            disabled={index === cardOrder.length - 1}
                            onClick={() => handleMoveCard(index, 'right')}
                            className="p-1 rounded hover:bg-neutral-200 disabled:opacity-20 text-neutral-700 cursor-pointer disabled:cursor-not-allowed"
                            title="Geser ke kanan"
                          >
                            ▶
                          </button>
                        </div>
                      </div>
                      <div className="pt-2">
                        <div className="text-[11px] font-bold text-neutral-800 uppercase tracking-wider">{def.label}</div>
                        <div className={`text-xl font-bold ${def.textClass} mt-0.5`}>{countVal}</div>
                        <div className="text-[10px] text-neutral-400 mt-0.5">{def.sublabel}</div>
                      </div>
                      <div className="mt-2 pt-1 text-[9px] text-amber-700/80 font-medium text-center bg-amber-50/80 rounded py-0.5">
                        ⋮⋮ Tarik (Drag)
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (def.key === 'MAINTENANCE') {
                          setIsMaintenanceModalOpen(true);
                        }
                        setMetricFilter(isActive ? null : def.key);
                      }}
                      className="w-full h-full p-3 text-left cursor-pointer rounded-xl group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">{def.label}</div>
                        {def.key === 'MAINTENANCE' && (
                          <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity text-amber-700 font-bold">
                            Buka ↗
                          </span>
                        )}
                      </div>
                      <div className={`text-xl font-bold ${def.textClass} mt-1`}>{countVal}</div>
                      <div className="text-[10px] text-neutral-400 mt-0.5">{def.sublabel}</div>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Active OO / Out of Order Rooms Panel (Integrated with Kalender & Kamar) */}
      {activeRoomBlocks.length > 0 && activeTab !== 'history' && (
        <div className="bg-rose-50/60 border border-rose-200 rounded-xl p-3.5 shadow-xs space-y-2.5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-rose-100 text-rose-700">
                <Ban className="w-4 h-4" />
              </span>
              <div>
                <h3 className="text-xs font-bold text-rose-950">
                  Kamar Status OO / Out of Order Aktif ({activeRoomBlocks.length} Kamar)
                </h3>
                <p className="text-[11px] text-rose-700">
                  Kamar di bawah ini sedang diblokir pada Kalender &amp; Kamar (Tape Chart) dan mengurangi kapasitas jual.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleOpenOoModal()}
              className="px-2.5 py-1 text-[11px] font-bold text-rose-800 bg-white hover:bg-rose-100 border border-rose-300 rounded-lg flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Tambah Kamar OO
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {activeRoomBlocks.map((b) => (
              <div
                key={b.id}
                className="bg-white border border-rose-200 rounded-lg p-2.5 flex items-center justify-between gap-2 shadow-2xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="px-2 py-0.5 rounded bg-neutral-900 text-white font-mono text-xs font-bold">
                      {b.room_number}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800">
                      {b.block_type === 'OUT_OF_ORDER' ? 'OO' : 'OOS'}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      Number(b.duration_days) > 1 ? 'bg-rose-600 text-white' : 'bg-neutral-100 text-neutral-700'
                    }`}>
                      {b.duration_days} Hari
                    </span>
                  </div>
                  <div className="text-[11px] font-semibold text-neutral-800 mt-1 truncate" title={b.reason || ''}>
                    {b.reason || 'Pemeliharaan / Perbaikan Kamar'}
                  </div>
                  <div className="text-[10px] text-neutral-500 mt-0.5">
                    {b.start_date} s/d {b.end_date} &bull; PIC: {b.created_by || currentUserName}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setReleaseBlockTarget(b);
                    setReleaseTargetRoomStatus('VACANT_DIRTY');
                    setReleaseReason('');
                  }}
                  className="p-2 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 shrink-0 cursor-pointer"
                  title="Lepas Status OO (Kamar Selesai Perbaikan)"
                >
                  <Unlock className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
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
            {activeTab === 'history' && (
              <label className="flex items-center gap-1.5 text-xs text-neutral-600 cursor-pointer mr-1">
                <input
                  type="checkbox"
                  checked={includeArchived}
                  onChange={(e) => setIncludeArchived(e.target.checked)}
                  className="w-3.5 h-3.5 rounded text-[#1b4332] focus:ring-[#1b4332]"
                />
                <span>Tampilkan Data Diarsipkan</span>
              </label>
            )}

            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Cari kamar / judul / PIC..."
              className="text-xs px-2.5 py-1.5 rounded-lg border border-neutral-300 bg-white w-48 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
            />
            {activeTab !== 'history' && (
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500 cursor-pointer"
              >
                <option value="ALL">Semua Status Aktif</option>
                <option value="ASSIGNED">ASSIGNED</option>
                <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
                <option value="IN_PROGRESS">IN PROGRESS</option>
                <option value="DONE">SELESAI (DONE)</option>
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
              Tidak ada tugas housekeeping aktif pada tampilan ini.
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
                  {metricFilter === 'READY' ? (
                    <>
                      <th className="py-2.5 px-3 text-emerald-800">Room Attendant</th>
                      <th className="py-2.5 px-3 text-amber-800">Room Inspector</th>
                    </>
                  ) : metricFilter === 'CLEANING' || metricFilter === 'WAITING_INSPECTION' || metricFilter === 'CHECKOUT_CHECK' || activeTab === 'checkout_inspection' ? (
                    <th className="py-2.5 px-3">Room Attendant</th>
                  ) : (
                    <th className="py-2.5 px-3">Room Attendant / PIC</th>
                  )}
                  <th className="py-2.5 px-3">Durasi</th>
                  <th className="py-2.5 px-3">Next Arrival</th>
                  <th className="py-2.5 px-3 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 text-neutral-800">
                {filteredTasks.map((t) => {
                  const durationStr = getRunningDuration(t.started_at);
                  const isReadyView = metricFilter === 'READY';
                  const isWaitingInspView = metricFilter === 'WAITING_INSPECTION';

                  const targetRoom = t.room_id ? dailyRooms.find((r) => Number(r.id) === Number(t.room_id)) : undefined;
                  const rawPic = t.assigned_user_name_snapshot?.trim() || '';
                  const isGenericPic = !rawPic || ['HOUSEKEEPING STAFF', 'STAFF', 'SYSTEM', 'SYSTEM (DIRTY EVENT)', 'SYSTEM (CHECKOUT TRIGGER)'].includes(rawPic.toUpperCase());
                  const displayPic = isGenericPic ? currentUserName : rawPic;

                  // Attendant & Inspector Resolution
                  const roomAttendant = (t.cleaned_by_name && t.cleaned_by_name.trim())
                    || (targetRoom?.last_cleaned_by_name && targetRoom.last_cleaned_by_name.trim())
                    || (!isReadyView && !isGenericPic ? rawPic : (isReadyView ? '-' : currentUserName));

                  const roomInspector = (t.inspected_by_name && t.inspected_by_name.trim())
                    || (targetRoom?.last_inspected_by_name && targetRoom.last_inspected_by_name.trim())
                    || (t.task_type === 'FINAL_INSPECTION' && t.status === 'DONE' && !isGenericPic ? rawPic : '-');

                  const activeBlockForRoom = t.room_id ? activeRoomBlocks.find((b) => Number(b.room_id) === Number(t.room_id)) : undefined;

                  return (
                    <tr
                      key={t.id}
                      onClick={() => openTaskDrawer(t)}
                      className={`hover:bg-neutral-50/80 transition-colors cursor-pointer ${
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
                        {getRoomStatusBadge(activeBlockForRoom ? activeBlockForRoom.block_type : t.room_status)}
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

                      {/* Attendant & Inspector / PIC Assignee */}
                      {isReadyView ? (
                        <>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            {roomAttendant !== '-' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 font-semibold text-xs">
                                <span>🧹</span> {roomAttendant}
                              </span>
                            ) : (
                              <span className="text-neutral-400 italic text-xs">-</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            {roomInspector !== '-' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-900 font-semibold text-xs">
                                <span>🔍</span> {roomInspector}
                              </span>
                            ) : (
                              <span className="text-neutral-400 italic text-xs">-</span>
                            )}
                          </td>
                        </>
                      ) : isWaitingInspView ? (
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {roomAttendant !== '-' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 font-semibold text-xs">
                              <span>🧹</span> {roomAttendant}
                            </span>
                          ) : (
                            <span className="font-semibold text-neutral-800">{displayPic}</span>
                          )}
                        </td>
                      ) : (
                        <td
                          className="py-2.5 px-3 text-neutral-800 whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {t.id > 0 ? (
                            <select
                              value={displayPic}
                              onChange={(e) => handleAssignPic(t, e.target.value)}
                              className="text-xs font-semibold text-neutral-800 bg-neutral-50 hover:bg-white border border-neutral-200 rounded-md px-2 py-1 focus:outline-hidden focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                              title="Pilih / Ubah Petugas (Room Attendant)"
                            >
                              <option value={displayPic}>{displayPic}</option>
                              {currentUserName !== displayPic && (
                                <option value={currentUserName}>{currentUserName} (Saya)</option>
                              )}
                              {staffList
                                .filter((st) => st.name !== displayPic && st.name !== currentUserName)
                                .map((st, idx) => (
                                  <option key={`${st.name}-${idx}`} value={st.name}>
                                    {st.name}
                                  </option>
                                ))}
                            </select>
                          ) : (
                            <span className="font-semibold text-neutral-800">{displayPic}</span>
                          )}
                        </td>
                      )}

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

                      {/* Actions (Lucide Icons) */}
                      <td
                        className="py-2.5 px-3 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center justify-end gap-1">
                          {activeTab === 'history' ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleOpenHistoryEdit(t)}
                                className="p-1.5 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer"
                                title="Edit / Koreksi Riwayat"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              {t.is_archived ? (
                                <button
                                  type="button"
                                  onClick={() => handleUnarchiveTask(t)}
                                  className="p-1.5 text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded-lg border border-neutral-200 cursor-pointer"
                                  title="Batal Arsip / Pulihkan"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleArchiveTask(t)}
                                  className="p-1.5 text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg border border-amber-200 cursor-pointer"
                                  title="Arsipkan Tugas"
                                >
                                  <Archive className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </>
                          ) : (
                            <>
                              {t.status === 'ASSIGNED' && t.task_type !== 'FINAL_INSPECTION' && (
                                <button
                                  type="button"
                                  onClick={() => handleAcknowledge(t)}
                                  className="p-1.5 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-200 cursor-pointer"
                                  title="Terima Tugas (Acknowledge)"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {(t.status === 'ASSIGNED' || t.status === 'ACKNOWLEDGED') && t.task_type !== 'FINAL_INSPECTION' && (
                                <button
                                  type="button"
                                  onClick={() => handleStart(t)}
                                  className="p-1.5 text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 cursor-pointer"
                                  title="Mulai Pengerjaan (Start Cleaning)"
                                >
                                  <Play className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {t.room_id && (
                                activeBlockForRoom ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setReleaseBlockTarget(activeBlockForRoom);
                                      setReleaseTargetRoomStatus('VACANT_DIRTY');
                                      setReleaseReason('');
                                    }}
                                    className="p-1.5 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer"
                                    title="Lepas Status Kamar OO (Selesai Perbaikan)"
                                  >
                                    <Unlock className="w-3.5 h-3.5" />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenOoModal(Number(t.room_id))}
                                    className="p-1.5 text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200 cursor-pointer"
                                    title="Set Kamar OO (Out of Order / Out of Service)"
                                  >
                                    <Ban className="w-3.5 h-3.5" />
                                  </button>
                                )
                              )}
                            </>
                          )}

                          <button
                            type="button"
                            onClick={() => openTaskDrawer(t)}
                            className="p-1.5 text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-lg border border-neutral-200 cursor-pointer"
                            title="Buka Rincian & Checklist"
                          >
                            <ClipboardCheck className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* OO History Section inside Riwayat Tab */}
        {activeTab === 'history' && (
          <div className="border-t border-neutral-200 bg-rose-50/30 p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Wrench className="w-4 h-4 text-rose-700" />
                <h3 className="text-xs font-bold text-neutral-900">
                  Riwayat Kamar OO / Out of Order ({roomBlocks.length} Catatan)
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-600 text-white">
                  OO &gt; 1 Hari: {roomBlocks.filter((b) => Number(b.duration_days) > 1).length}
                </span>
              </div>
              <span className="text-[11px] text-neutral-500">
                Terintegrasi otomatis dengan Kalender &amp; Laporan Kinerja Kamar
              </span>
            </div>

            {roomBlocks.length === 0 ? (
              <div className="p-6 text-center text-xs text-neutral-500 bg-white rounded-xl border border-neutral-200">
                Belum ada riwayat kamar OO / Out of Order.
              </div>
            ) : (
              <div className="overflow-x-auto bg-white rounded-xl border border-neutral-200">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-neutral-50 border-b border-neutral-200 text-neutral-600 font-bold uppercase tracking-wider text-[10px]">
                      <th className="py-2.5 px-3">Kamar</th>
                      <th className="py-2.5 px-3">Jenis</th>
                      <th className="py-2.5 px-3">Tanggal Mulai s/d Selesai</th>
                      <th className="py-2.5 px-3 text-right">Durasi</th>
                      <th className="py-2.5 px-3">Alasan / Kendala</th>
                      <th className="py-2.5 px-3">Petugas (PIC)</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {roomBlocks.map((b) => (
                      <tr key={b.id} className="hover:bg-neutral-50/80">
                        <td className="py-2.5 px-3 font-bold">
                          <span className="px-2 py-0.5 rounded bg-neutral-900 text-white font-mono text-xs">
                            {b.room_number}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            b.block_type === 'OUT_OF_ORDER'
                              ? 'bg-rose-100 text-rose-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}>
                            {b.block_type === 'OUT_OF_ORDER' ? 'OO (Out of Order)' : 'OOS (Out of Service)'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-neutral-700 font-medium">
                          {b.start_date} s/d {b.end_date}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className={`px-2 py-0.5 rounded font-bold ${
                            Number(b.duration_days) > 1 ? 'bg-rose-600 text-white' : 'bg-neutral-100 text-neutral-700'
                          }`}>
                            {b.duration_days} Hari
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-neutral-700">{b.reason || '-'}</td>
                        <td className="py-2.5 px-3 text-neutral-700">
                          <div>Dibuat: <strong>{b.created_by || '-'}</strong></div>
                          {b.released_by && <div className="text-[10px] text-emerald-700">Dilepas: {b.released_by}</div>}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            b.status === 'ACTIVE'
                              ? 'bg-red-100 text-red-800'
                              : b.status === 'RELEASED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-neutral-100 text-neutral-500'
                          }`}>
                            {b.status === 'ACTIVE' ? 'AKTIF (OO)' : b.status === 'RELEASED' ? 'SELESAI / DILEPAS' : 'DIBATALKAN'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {b.status === 'ACTIVE' && (
                            <button
                              type="button"
                              onClick={() => {
                                setReleaseBlockTarget(b);
                                setReleaseTargetRoomStatus('VACANT_DIRTY');
                                setReleaseReason('');
                              }}
                              className="p-1.5 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 cursor-pointer"
                              title="Lepas Status OO"
                            >
                              <Unlock className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
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
          onBulkToggleCategory={handleBulkToggleCategory}
          categoryBulkCheckEnabled={Boolean(hkSettings?.housekeeping_category_bulk_check_enabled)}
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
        staffList={staffList}
        defaultAssigneeName={currentUserName}
      />

      {/* Set Kamar OO (Out of Order / Out of Service) Modal */}
      {isOoModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-neutral-200 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-rose-100 text-rose-700">
                  <Ban className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-neutral-900">
                    Set Kamar OO (Out of Order / Out of Service)
                  </h3>
                  <p className="text-xs text-neutral-500">
                    Terintegrasi dengan Kalender &amp; Kamar (Tape Chart) serta Laporan Kinerja Kamar
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsOoModalOpen(false)}
                className="text-neutral-400 hover:text-neutral-600 text-lg leading-none cursor-pointer"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmitOoBlock} className="space-y-3.5 text-xs">
              {ooErrorMsg && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl font-medium">
                  {ooErrorMsg}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-neutral-700 mb-1">Pilih Kamar *</label>
                  <select
                    required
                    value={ooForm.room_id}
                    onChange={(e) => setOoForm((p) => ({ ...p, room_id: e.target.value }))}
                    className="w-full p-2 rounded-xl border border-neutral-300 bg-white focus:ring-1 focus:ring-rose-500"
                  >
                    <option value="">-- Pilih Kamar --</option>
                    {(dailyRooms.length > 0 ? dailyRooms : rooms).map((r: any) => (
                      <option key={r.id} value={r.id}>
                        Kamar {r.room_number} {r.room_type_name ? `(${r.room_type_name})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-neutral-700 mb-1">Jenis Blokir *</label>
                  <select
                    value={ooForm.block_type}
                    onChange={(e) => setOoForm((p) => ({ ...p, block_type: e.target.value as 'OUT_OF_ORDER' | 'OUT_OF_SERVICE' }))}
                    className="w-full p-2 rounded-xl border border-neutral-300 bg-white focus:ring-1 focus:ring-rose-500"
                  >
                    <option value="OUT_OF_ORDER">OO - Out of Order (Kerusakan / Renovasi)</option>
                    <option value="OUT_OF_SERVICE">OOS - Out of Service (Perbaikan Ringan)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-neutral-700 mb-1">Tanggal Mulai OO *</label>
                  <input
                    type="date"
                    required
                    value={ooForm.start_date}
                    onChange={(e) => setOoForm((p) => ({ ...p, start_date: e.target.value }))}
                    className="w-full p-2 rounded-xl border border-neutral-300 bg-white focus:ring-1 focus:ring-rose-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-neutral-700 mb-1">Estimasi Selesai (Release) *</label>
                  <input
                    type="date"
                    required
                    min={ooForm.start_date}
                    value={ooForm.end_date}
                    onChange={(e) => setOoForm((p) => ({ ...p, end_date: e.target.value }))}
                    className="w-full p-2 rounded-xl border border-neutral-300 bg-white focus:ring-1 focus:ring-rose-500"
                  />
                </div>
              </div>

              <div className={`p-2.5 rounded-xl border flex items-center justify-between ${
                ooDurationDays > 1
                  ? 'bg-rose-50 border-rose-200 text-rose-900'
                  : 'bg-neutral-50 border-neutral-200 text-neutral-700'
              }`}>
                <span>
                  Durasi Blokir Kamar: <strong>{ooDurationDays} Hari</strong>
                </span>
                {ooDurationDays > 1 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-600 text-white">
                    Wajib Masuk Laporan (&gt; 1 Hari)
                  </span>
                )}
              </div>

              <div>
                <label className="block font-semibold text-neutral-700 mb-1">Alasan / Kendala Kerusakan *</label>
                <textarea
                  rows={2}
                  required
                  placeholder="Contoh: AC bocor ganti kompresor / perbaikan plafon kamar mandi..."
                  value={ooForm.reason}
                  onChange={(e) => setOoForm((p) => ({ ...p, reason: e.target.value }))}
                  className="w-full p-2.5 rounded-xl border border-neutral-300 focus:ring-1 focus:ring-rose-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-neutral-700 mb-1">Petugas Pelapor (PIC)</label>
                <input
                  type="text"
                  list="hk-oo-staff-list"
                  value={ooForm.created_by}
                  onChange={(e) => setOoForm((p) => ({ ...p, created_by: e.target.value }))}
                  className="w-full p-2 rounded-xl border border-neutral-300 bg-white focus:ring-1 focus:ring-rose-500"
                />
                <datalist id="hk-oo-staff-list">
                  {staffList.map((st, idx) => (
                    <option key={`${st.name}-${idx}`} value={st.name} />
                  ))}
                </datalist>
              </div>

              <div className="flex gap-2 pt-2 justify-end">
                <button
                  type="button"
                  onClick={() => setIsOoModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-neutral-600 bg-neutral-100 hover:bg-neutral-200 font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isOoSubmitting}
                  className="px-4 py-2 rounded-xl text-white bg-rose-700 hover:bg-rose-800 font-semibold shadow cursor-pointer"
                >
                  {isOoSubmitting ? 'Menyimpan...' : 'Tetapkan Kamar OO'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Release Kamar OO Modal */}
      {releaseBlockTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-neutral-200 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <div>
                <h3 className="font-bold text-sm text-neutral-900">
                  Lepas Status OO Kamar {releaseBlockTarget.room_number}
                </h3>
                <p className="text-xs text-neutral-500">
                  {releaseBlockTarget.block_type} &bull; {releaseBlockTarget.start_date} s/d {releaseBlockTarget.end_date} ({releaseBlockTarget.duration_days} Hari)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReleaseBlockTarget(null)}
                className="text-neutral-400 hover:text-neutral-600 text-lg leading-none cursor-pointer"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleConfirmReleaseOoBlock} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-neutral-700 mb-1">Status Kamar Setelah Dilepas:</label>
                <select
                  value={releaseTargetRoomStatus}
                  onChange={(e) => setReleaseTargetRoomStatus(e.target.value as 'VACANT_DIRTY' | 'VACANT_CLEAN')}
                  className="w-full p-2 rounded-xl border border-neutral-300 bg-white focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="VACANT_DIRTY">VACANT_DIRTY (Perlu Dibersihkan Housekeeping)</option>
                  <option value="VACANT_CLEAN">VACANT_CLEAN (Langsung Siap Huni)</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-neutral-700 mb-1">Catatan Penyelesaian (Opsional):</label>
                <input
                  type="text"
                  placeholder="Contoh: Perbaikan AC selesai dan diuji normal"
                  value={releaseReason}
                  onChange={(e) => setReleaseReason(e.target.value)}
                  className="w-full p-2 rounded-xl border border-neutral-300 bg-white focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <div className="flex gap-2 pt-2 justify-end">
                <button
                  type="button"
                  onClick={() => setReleaseBlockTarget(null)}
                  className="px-4 py-2 rounded-xl text-neutral-600 bg-neutral-100 hover:bg-neutral-200 font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={isReleasingBlock}
                  className="px-4 py-2 rounded-xl text-white bg-emerald-700 hover:bg-emerald-800 font-semibold shadow cursor-pointer"
                >
                  {isReleasingBlock ? 'Memproses...' : 'Lepas Status OO'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
                <label className="block font-semibold text-neutral-700 mb-1">Petugas (PIC):</label>
                <input
                  type="text"
                  list="hk-history-edit-staff"
                  value={historyEditForm.assigned_user_name_snapshot}
                  onChange={(e) => setHistoryEditForm(p => ({ ...p, assigned_user_name_snapshot: e.target.value }))}
                  className="w-full p-2 rounded-xl border border-neutral-300 text-xs focus:ring-1 focus:ring-emerald-500"
                />
                <datalist id="hk-history-edit-staff">
                  {staffList.map((st, idx) => (
                    <option key={`${st.name}-${idx}`} value={st.name} />
                  ))}
                </datalist>
              </div>

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

      {/* Maintenance & Room Findings Modal */}
      <MaintenanceIssuesModal
        isOpen={isMaintenanceModalOpen}
        onClose={() => setIsMaintenanceModalOpen(false)}
        propertyId={propertyId}
        apiBaseUrl={apiBaseUrl}
        onRefreshParent={() => fetchDailyOperations(true)}
      />
    </div>
  );
};
