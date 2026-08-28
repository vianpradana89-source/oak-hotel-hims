import React, { useState, useEffect } from 'react';
import type { HousekeepingTaskRecord, TaskChecklistItem, HkFindingType } from '../housekeeping/housekeepingTypes';

const CheckCircle2 = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const AlertTriangle = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);
const Play = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const CheckSquare = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const ShieldAlert = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);
const RefreshCw = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);
const Search = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
);
const BedDouble = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3" />
  </svg>
);
const X = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
  </svg>
);
const Info = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const Plus = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
  </svg>
);
const Clock = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const ChevronDown = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
  </svg>
);
const ChevronUp = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 15l7-7 7 7" />
  </svg>
);
const ClipboardCheck = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
  </svg>
);

interface HousekeepingMobileCrewViewProps {
  propertyId: number;
  crewName: string;
  crewRole?: string;
  onRefreshStats?: () => void;
}

export const HousekeepingMobileCrewView: React.FC<HousekeepingMobileCrewViewProps> = ({
  propertyId,
  crewName,
  onRefreshStats
}) => {
  const [activeTasks, setActiveTasks] = useState<HousekeepingTaskRecord[]>([]);
  const [historyTasks, setHistoryTasks] = useState<HousekeepingTaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeStream, setActiveStream] = useState<'CLEANING' | 'CHECKOUT' | 'TASK' | 'RIWAYAT'>('CLEANING');
  const [searchQuery, setSearchQuery] = useState('');
  const [submittingId, setSubmittingId] = useState<number | null>(null);

  // Group Collapsibles & Secondary Filter
  const [showDoneAccordion, setShowDoneAccordion] = useState(false);
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);
  const [drawerStatusFilter, setDrawerStatusFilter] = useState<string>('ALL');

  // Manual Task Creation Modal
  const [showCreateTaskModal, setShowCreateTaskModal] = useState(false);
  const [createTaskSubmitting, setCreateTaskSubmitting] = useState(false);
  const [newTaskPayload, setNewTaskPayload] = useState({
    title: '',
    description: '',
    room_number: '',
    priority: 'NORMAL',
    assigned_user_name: '',
    due_at: ''
  });

  // Active Task Detail & Modals
  const [selectedTask, setSelectedTask] = useState<HousekeepingTaskRecord | null>(null);
  const [showInspectionModal, setShowInspectionModal] = useState(false);
  const [checklistItems, setChecklistItems] = useState<TaskChecklistItem[]>([]);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [checklistError, setChecklistError] = useState<string | null>(null);

  // Finding Types Catalog (Loaded dynamically from API)
  const [findingTypes, setFindingTypes] = useState<HkFindingType[]>([]);
  const [showFindingModal, setShowFindingModal] = useState(false);
  const [findingPayload, setFindingPayload] = useState<{
    finding_code: string;
    note: string;
    estimated_charge: string;
    photo_url: string;
  }>({
    finding_code: '',
    note: '',
    estimated_charge: '',
    photo_url: ''
  });

  // Fetch Tasks (Active & History)
  const fetchTasks = async () => {
    try {
      setLoading(true);
      const [activeRes, histRes] = await Promise.all([
        fetch(`/api/housekeeping/tasks?property_id=${propertyId}&scope=active`),
        fetch(`/api/housekeeping/tasks?property_id=${propertyId}&scope=history`)
      ]);
      const activeData = await activeRes.json();
      const histData = await histRes.json();

      if (activeRes.ok && activeData.status === 'OK') {
        setActiveTasks(activeData.data || []);
      }
      if (histRes.ok && histData.status === 'OK') {
        setHistoryTasks(histData.data || []);
      }

      if (onRefreshStats) onRefreshStats();
    } catch (err) {
      console.error('Failed to fetch HK tasks for crew:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch Active Finding Types Catalog
  const fetchFindingTypes = async () => {
    try {
      const res = await fetch(`/api/housekeeping/finding-types?property_id=${propertyId}&scope=active`);
      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        const types: HkFindingType[] = data.data || [];
        setFindingTypes(types);
        if (types.length > 0 && !findingPayload.finding_code) {
          setFindingPayload(p => ({ ...p, finding_code: types[0].code }));
        }
      }
    } catch (err) {
      console.error('Failed to fetch finding types:', err);
    }
  };

  useEffect(() => {
    fetchTasks();
    fetchFindingTypes();
  }, [propertyId]);

  // Load Checklist for a task
  const loadChecklist = async (taskId: number) => {
    try {
      setChecklistLoading(true);
      setChecklistError(null);
      const res = await fetch(`/api/housekeeping/tasks/${taskId}/checklist?property_id=${propertyId}`);
      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        setChecklistItems(data.data || []);
      }
    } catch (err) {
      console.error('Failed to load checklist:', err);
    } finally {
      setChecklistLoading(false);
    }
  };

  // Toggle Checklist Item
  const handleToggleChecklistItem = async (itemId: number, currentCompleted: boolean) => {
    if (!selectedTask) return;
    try {
      const res = await fetch(`/api/housekeeping/tasks/${selectedTask.id}/checklist/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          is_completed: !currentCompleted,
          checked_by: crewName
        })
      });
      if (res.ok) {
        setChecklistItems(prev =>
          prev.map(it => (it.id === itemId ? { ...it, is_completed: !currentCompleted, checked_by: crewName } : it))
        );
        setChecklistError(null);
      }
    } catch (err) {
      console.error('Failed to toggle checklist item:', err);
    }
  };

  // Start Task (Mulai Kerjakan)
  const handleStartTask = async (task: HousekeepingTaskRecord) => {
    try {
      setSubmittingId(task.id);
      const res = await fetch(`/api/housekeeping/tasks/${task.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          actor_name: crewName
        })
      });
      if (res.ok) {
        await fetchTasks();
      }
    } catch (err) {
      console.error('Failed to start task:', err);
    } finally {
      setSubmittingId(null);
    }
  };

  // Complete Cleaning Task
  const handleCompleteTask = async (task: HousekeepingTaskRecord) => {
    try {
      setSubmittingId(task.id);
      const res = await fetch(`/api/housekeeping/tasks/${task.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          actor_name: crewName,
          completion_note: 'Selesai dibersihkan oleh mobile crew'
        })
      });
      if (res.ok) {
        setShowInspectionModal(false);
        await fetchTasks();
      }
    } catch (err) {
      console.error('Failed to complete task:', err);
    } finally {
      setSubmittingId(null);
    }
  };

  // Submit Checkout Inspection (Clear / Issue)
  const handleSubmitCheckoutInspection = async (
    task: HousekeepingTaskRecord,
    result: 'CLEAR' | 'ISSUE_FOUND',
    findingCode?: string,
    findingNote?: string,
    charge?: number
  ) => {
    try {
      setSubmittingId(task.id);
      setChecklistError(null);
      const res = await fetch(`/api/housekeeping/checkout-inspections/${task.id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          inspection_result: result,
          inspector_name: crewName,
          issue_type: findingCode,
          issue_note: findingNote,
          estimated_charge: charge || 0
        })
      });
      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        setShowInspectionModal(false);
        setShowFindingModal(false);
        setFindingPayload({
          finding_code: findingTypes[0]?.code || '',
          note: '',
          estimated_charge: '',
          photo_url: ''
        });
        await fetchTasks();
      } else {
        setChecklistError(data.message || 'Gagal mengirim hasil pemeriksaan.');
      }
    } catch (err: any) {
      setChecklistError(err.message || 'Koneksi error saat submit pemeriksaan.');
    } finally {
      setSubmittingId(null);
    }
  };

  // Open Inspection Detail for Checkout Check or Cleaning
  const openTaskInspection = (task: HousekeepingTaskRecord) => {
    setSelectedTask(task);
    loadChecklist(task.id);
    setShowInspectionModal(true);
  };

  // Open Finding Reporter
  const openFindingReporter = (task: HousekeepingTaskRecord) => {
    setSelectedTask(task);
    if (findingTypes.length > 0 && !findingPayload.finding_code) {
      setFindingPayload(p => ({ ...p, finding_code: findingTypes[0].code }));
    }
    setShowFindingModal(true);
  };

  // Checklist Validation Status for Selected Task
  const requiredChecklistItems = checklistItems.filter(it => it.is_required);
  const uncompletedRequiredCount = requiredChecklistItems.filter(it => !it.is_completed).length;
  const isAllRequiredCompleted = uncompletedRequiredCount === 0;

  // Selected Finding Type metadata
  const selectedFindingTypeMeta = findingTypes.find(f => f.code === findingPayload.finding_code);

  // Categorize tasks into explicit streams
  const cleaningTasks = activeTasks.filter(t => t.room_id && t.task_type === 'ROOM_CLEANING');
  const checkoutTasks = activeTasks.filter(t => t.task_type === 'CHECKOUT_ROOM_CHECK');
  const manualTasks = activeTasks.filter(t => t.task_type !== 'ROOM_CLEANING' && t.task_type !== 'CHECKOUT_ROOM_CHECK' && t.task_type !== 'FINAL_INSPECTION' && (t.source_type === 'MANUAL' || t.task_category !== 'ROOM_OPERATIONS'));

  const countCleaning = cleaningTasks.length;
  const countCheckout = checkoutTasks.length;
  const countTask = manualTasks.length;
  const countRiwayat = historyTasks.length;

  const currentStreamTasks = activeStream === 'CLEANING'
    ? cleaningTasks
    : activeStream === 'CHECKOUT'
    ? checkoutTasks
    : activeStream === 'TASK'
    ? manualTasks
    : historyTasks;

  // Filter Tasks for Display
  const filteredTasks = currentStreamTasks.filter(task => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchRoom = (task.room_number || '').toLowerCase().includes(q);
      const matchType = (task.room_type_name || '').toLowerCase().includes(q);
      const matchNumber = (task.task_number || '').toLowerCase().includes(q);
      const matchTitle = (task.title || '').toLowerCase().includes(q);
      if (!matchRoom && !matchType && !matchNumber && !matchTitle) return false;
    }

    if (drawerStatusFilter === 'IN_PROGRESS' && task.status !== 'IN_PROGRESS') return false;
    if (drawerStatusFilter === 'ASSIGNED' && task.status !== 'ASSIGNED' && task.status !== 'ACKNOWLEDGED') return false;

    return true;
  });

  const isUrgentNow = (t: HousekeepingTaskRecord) => {
    return t.status === 'IN_PROGRESS' || t.task_type === 'CHECKOUT_ROOM_CHECK' || t.priority === 'TURNOVER' || t.priority === 'CRITICAL';
  };

  const tasksNow = filteredTasks.filter(isUrgentNow);
  const tasksNext = filteredTasks.filter(t => !isUrgentNow(t));

  const handleCreateManualTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskPayload.title.trim()) return;
    try {
      setCreateTaskSubmitting(true);
      const res = await fetch('/api/housekeeping/manual-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          title: newTaskPayload.title.trim(),
          description: newTaskPayload.description.trim() || undefined,
          room_number: newTaskPayload.room_number.trim() || undefined,
          priority: newTaskPayload.priority,
          assigned_user_name_snapshot: newTaskPayload.assigned_user_name.trim() || undefined,
          due_at: newTaskPayload.due_at || undefined,
          creator_name: crewName || 'Supervisor',
          creator_role: 'Head Department / Supervisor'
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Gagal membuat tugas manual');
      }
      setShowCreateTaskModal(false);
      setNewTaskPayload({
        title: '',
        description: '',
        room_number: '',
        priority: 'NORMAL',
        assigned_user_name: '',
        due_at: ''
      });
      await fetchTasks();
    } catch (err: any) {
      alert(err.message || 'Gagal membuat tugas manual');
    } finally {
      setCreateTaskSubmitting(false);
    }
  };

  const getEmptyStateMessage = () => {
    if (searchQuery) return 'Tidak ada tugas yang sesuai dengan pencarian.';
    if (activeStream === 'CLEANING') return '✓ Tidak ada kamar yang perlu dibersihkan saat ini.';
    if (activeStream === 'CHECKOUT') return '✓ Tidak ada permintaan pemeriksaan checkout.';
    if (activeStream === 'TASK') return '✓ Tidak ada tugas dari atasan saat ini.';
    return 'Belum ada riwayat pekerjaan yang diselesaikan hari ini.';
  };

  const renderTaskCard = (task: HousekeepingTaskRecord) => {
    const isCheckoutCheck = task.task_type === 'CHECKOUT_ROOM_CHECK';
    const isManualTask = activeStream === 'TASK' || (!['ROOM_CLEANING', 'CHECKOUT_ROOM_CHECK'].includes(task.task_type) && task.task_category !== 'ROOM_OPERATIONS');
    const isSubmitting = submittingId === task.id;

    return (
      <div
        key={task.id}
        className={`bg-white border rounded-2xl p-3.5 shadow-2xs transition-all ${
          isCheckoutCheck
            ? 'border-amber-400/80 ring-1 ring-amber-300/40 bg-amber-50/20'
            : isManualTask
            ? 'border-indigo-200 ring-1 ring-indigo-100/60'
            : task.status === 'IN_PROGRESS'
            ? 'border-blue-300 ring-1 ring-blue-200/50 bg-blue-50/10'
            : 'border-neutral-200/90'
        }`}
      >
        {/* Card Header: Room Number, Floor, Type & Priority Badges */}
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-10 h-10 rounded-xl flex flex-col items-center justify-center font-bold shrink-0 shadow-2xs ${
              isCheckoutCheck
                ? 'bg-amber-100 text-amber-900 border border-amber-300'
                : isManualTask
                ? 'bg-indigo-50 text-indigo-900 border border-indigo-200'
                : 'bg-stone-100 text-neutral-800 border border-neutral-200'
            }`}>
              <span className="text-xs font-black leading-tight tracking-tight">{task.room_number || 'TASK'}</span>
              <span className="text-[8px] font-semibold text-neutral-500 uppercase">{task.room_floor ? `Lt ${task.room_floor}` : (isManualTask ? 'MGT' : 'R')}</span>
            </div>
            <div className="truncate">
              <div className="flex items-center gap-1.5">
                <h4 className="text-xs font-bold text-neutral-900 truncate">
                  {task.title || task.room_type_name || 'Tugas Housekeeping'}
                </h4>
              </div>
              <p className="text-[10px] text-neutral-500 truncate font-mono">{task.task_number}</p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 shrink-0">
            {isCheckoutCheck ? (
              <span className="px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-amber-100 text-amber-900 border border-amber-300 flex items-center gap-1 shadow-2xs">
                <AlertTriangle className="w-3 h-3 text-amber-600 shrink-0" />
                CHECKOUT FO
              </span>
            ) : task.priority === 'TURNOVER' ? (
              <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-[#1b4332]/10 text-[#1b4332] border border-[#1b4332]/20">
                TURNOVER
              </span>
            ) : (
              <span
                className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
                  ['CRITICAL', 'HIGH', 'VIP'].includes(task.priority)
                    ? 'bg-rose-100 text-rose-800 border border-rose-200'
                    : 'bg-neutral-100 text-neutral-600 border border-neutral-200'
                }`}
              >
                {task.priority}
              </span>
            )}

            <span
              className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                task.status === 'IN_PROGRESS'
                  ? 'bg-blue-100 text-blue-800'
                  : task.status === 'ASSIGNED' || task.status === 'ACKNOWLEDGED'
                  ? 'bg-amber-50 text-amber-800 border border-amber-200'
                  : 'bg-emerald-100 text-emerald-800'
              }`}
            >
              {task.status === 'IN_PROGRESS' ? 'Sedang Jalan' : task.status === 'ASSIGNED' ? 'Belum Mulai' : task.status}
            </span>
          </div>
        </div>

        {/* Creator Attribution for Management Task */}
        {isManualTask && (
          <div className="mb-2 px-2.5 py-1.5 rounded-lg bg-indigo-50/60 border border-indigo-200/60 text-[11px] text-indigo-950 flex items-center justify-between">
            <span className="font-semibold">
              Dibuat oleh: <strong className="font-bold">{task.requested_by_role_snapshot || 'HOD Housekeeping'}</strong>
            </span>
            <span className="text-[10px] text-indigo-700">{task.requested_by_name_snapshot || 'Management'}</span>
          </div>
        )}

        {/* Task Description if present */}
        {task.description && (
          <p className="text-[11px] text-neutral-600 mb-2 line-clamp-2 bg-neutral-50 p-1.5 rounded-lg">
            {task.description}
          </p>
        )}

        {/* Operational Context (Arrival / FO Request) */}
        {isCheckoutCheck ? (
          <div className="mb-2.5 px-2.5 py-1.5 rounded-lg bg-amber-50/80 border border-amber-200 text-[11px] text-amber-900 flex items-center justify-between">
            <span className="font-semibold flex items-center gap-1">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-700" />
              Diminta Front Office
            </span>
            <span className="text-[10px] font-mono text-amber-800 font-bold">Pemeriksaan Cepat</span>
          </div>
        ) : task.next_arrival ? (
          <div className="mb-2.5 px-2.5 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-900 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
            <span className="truncate">
              Arrival: <strong className="font-semibold">{task.next_arrival.guest_name || 'Tamu Baru'}</strong> (Est 14:00)
            </span>
          </div>
        ) : null}

        {/* Operational Action Area */}
        {isCheckoutCheck ? (
          <div className="pt-2 border-t border-neutral-100 flex items-center gap-2">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => openTaskInspection(task)}
              className="w-full py-2.5 px-3 rounded-xl font-bold text-xs bg-[#1b4332] hover:bg-[#143326] text-white shadow-xs flex items-center justify-center gap-1.5 active:scale-98 transition cursor-pointer"
            >
              <ClipboardCheck className="w-4 h-4 text-[#d4af37]" />
              <span>PERIKSA KAMAR {task.room_number}</span>
            </button>
          </div>
        ) : (
          <div className="pt-2 border-t border-neutral-100">
            {task.status === 'ASSIGNED' || task.status === 'ACKNOWLEDGED' ? (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleStartTask(task)}
                className="w-full py-2 px-3 rounded-xl font-bold text-xs bg-[#1b4332] text-white hover:bg-[#143326] shadow-xs flex items-center justify-center gap-1.5 active:scale-98 transition cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current text-[#d4af37]" />
                <span>{isManualTask ? 'MULAI KERJAKAN' : 'MULAI PEMBERSIHAN'}</span>
              </button>
            ) : task.status === 'IN_PROGRESS' ? (
              <div className="w-full flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => openTaskInspection(task)}
                  className="flex-1 py-2 px-2.5 rounded-xl font-bold text-xs bg-neutral-100 hover:bg-neutral-200 text-neutral-800 border border-neutral-300 flex items-center justify-center gap-1 transition cursor-pointer"
                >
                  <CheckSquare className="w-3.5 h-3.5 text-[#1b4332]" />
                  <span>Checklist</span>
                </button>
                <button
                  type="button"
                  onClick={() => openFindingReporter(task)}
                  className="p-2 rounded-xl bg-amber-50 border border-amber-300 text-amber-800 hover:bg-amber-100 shrink-0 transition cursor-pointer"
                  title="Lapor Temuan"
                >
                  <AlertTriangle className="w-4 h-4 text-amber-700" />
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => handleCompleteTask(task)}
                  className="flex-1 py-2 px-2.5 rounded-xl font-bold text-xs bg-emerald-700 hover:bg-emerald-800 text-white shadow-xs flex items-center justify-center gap-1 active:scale-98 transition cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Selesai</span>
                </button>
              </div>
            ) : (
              <div className="w-full py-1 text-center text-[11px] text-neutral-400">
                Status: {task.status}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3.5 pb-20 max-w-full overflow-x-hidden">
      {/* Title & Quick Refresh */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-extrabold text-neutral-900 tracking-tight flex items-center gap-1.5">
            <BedDouble className="w-5 h-5 text-[#1b4332]" />
            HOUSEKEEPING
          </h2>
          <p className="text-[11px] text-neutral-500">Pekerjaan Operasional Berdasarkan Stream</p>
        </div>
        <button
          onClick={fetchTasks}
          className="p-2 rounded-xl bg-white border border-neutral-300 text-neutral-700 hover:bg-neutral-100 transition shadow-2xs shrink-0 cursor-pointer"
          title="Segarkan Tugas"
        >
          <RefreshCw className={`w-4 h-4 text-[#1b4332] ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 3 Explicit Workstreams Selector (No generic 'Semua') */}
      <div className="space-y-1.5">
        <div className="grid grid-cols-3 gap-1.5 p-1 bg-neutral-200/60 rounded-2xl border border-neutral-300/70">
          <button
            type="button"
            onClick={() => setActiveStream('CLEANING')}
            className={`py-2 px-1 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              activeStream === 'CLEANING'
                ? 'bg-white text-neutral-900 shadow-xs border border-neutral-300/80'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <span>Cleaning</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-extrabold ${
              activeStream === 'CLEANING' ? 'bg-[#1b4332] text-white' : 'bg-neutral-300 text-neutral-700'
            }`}>
              {countCleaning}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveStream('CHECKOUT')}
            className={`py-2 px-1 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              activeStream === 'CHECKOUT'
                ? 'bg-white text-neutral-900 shadow-xs border border-neutral-300/80'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <span>Checkout</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-extrabold ${
              activeStream === 'CHECKOUT' ? 'bg-amber-600 text-white' : 'bg-neutral-300 text-neutral-700'
            }`}>
              {countCheckout}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveStream('TASK')}
            className={`py-2 px-1 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
              activeStream === 'TASK'
                ? 'bg-white text-neutral-900 shadow-xs border border-neutral-300/80'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            <span>Task</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-extrabold ${
              activeStream === 'TASK' ? 'bg-indigo-600 text-white' : 'bg-neutral-300 text-neutral-700'
            }`}>
              {countTask}
            </span>
          </button>
        </div>

        {/* Secondary: Riwayat & Action Bar */}
        <div className="flex items-center justify-between px-1">
          {activeStream === 'TASK' ? (
            <button
              type="button"
              onClick={() => setShowCreateTaskModal(true)}
              className="text-xs font-bold text-[#1b4332] hover:text-[#143326] flex items-center gap-1 py-1 px-2 rounded-lg bg-emerald-50 border border-emerald-200 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>+ Buat Tugas</span>
            </button>
          ) : <div />}

          <button
            type="button"
            onClick={() => setActiveStream(activeStream === 'RIWAYAT' ? 'CLEANING' : 'RIWAYAT')}
            className={`text-xs px-2.5 py-1 rounded-lg font-medium transition flex items-center gap-1 cursor-pointer ${
              activeStream === 'RIWAYAT'
                ? 'bg-neutral-800 text-white font-bold'
                : 'text-neutral-500 hover:text-neutral-800'
            }`}
          >
            <Clock className="w-3 h-3" />
            <span>Riwayat ({countRiwayat})</span>
          </button>
        </div>
      </div>

      {/* Compact Search Bar */}
      <div className="relative">
        <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={`Cari di stream ${activeStream.toLowerCase()}...`}
          className="w-full py-2 pl-9 pr-8 rounded-xl bg-white border border-neutral-300 text-neutral-900 text-xs placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 shadow-2xs"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-700"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Task Content Sections */}
      {loading ? (
        <div className="py-12 text-center text-neutral-500 text-xs">
          <RefreshCw className="w-6 h-6 animate-spin text-[#1b4332] mx-auto mb-2" />
          <span>Memuat tugas operasional...</span>
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="py-10 bg-white rounded-2xl border border-neutral-200 text-center p-6 space-y-2 shadow-2xs">
          <CheckCircle2 className="w-9 h-9 text-emerald-600 mx-auto" />
          <p className="text-neutral-900 font-bold text-sm">Status Bersih</p>
          <p className="text-xs text-neutral-600 font-medium">
            {getEmptyStateMessage()}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Section 1: KERJAKAN SEKARANG */}
          {tasksNow.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] font-extrabold text-amber-800 uppercase tracking-wider flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
                  KERJAKAN SEKARANG ({tasksNow.length})
                </span>
                <span className="text-[10px] text-neutral-500">Prioritas & Sedang Jalan</span>
              </div>
              <div className="space-y-2.5">
                {tasksNow.map(task => renderTaskCard(task))}
              </div>
            </div>
          )}

          {/* Section 2: BERIKUTNYA */}
          {tasksNext.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] font-extrabold text-[#1b4332] uppercase tracking-wider">
                  BERIKUTNYA ({tasksNext.length})
                </span>
                <span className="text-[10px] text-neutral-500">Antrean Siap Dikerjakan</span>
              </div>
              <div className="space-y-2.5">
                {tasksNext.map(task => renderTaskCard(task))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Section 3: SELESAI HARI INI (Accordion) */}
      <div className="pt-2 border-t border-neutral-200">
        <button
          onClick={() => setShowDoneAccordion(!showDoneAccordion)}
          className="w-full py-2.5 px-3.5 rounded-xl bg-white border border-neutral-200/90 hover:border-neutral-300 flex items-center justify-between text-xs text-neutral-700 shadow-2xs transition cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span className="font-bold text-neutral-900">Selesai Hari Ini ({historyTasks.length})</span>
          </div>
          {showDoneAccordion ? (
            <ChevronUp className="w-4 h-4 text-neutral-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-neutral-400" />
          )}
        </button>

        {showDoneAccordion && (
          <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-emerald-500/40">
            {historyTasks.length === 0 ? (
              <p className="text-xs text-neutral-400 py-2">Belum ada tugas yang diselesaikan hari ini.</p>
            ) : (
              historyTasks.map(t => (
                <div
                  key={t.id}
                  className="p-2.5 rounded-xl bg-white border border-neutral-200 flex items-center justify-between text-xs shadow-2xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-[#1b4332]">Kamar {t.room_number || '-'}</span>
                    <span className="text-neutral-500 text-[11px]">• {t.task_type}</span>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-800 font-bold border border-emerald-200">
                    {t.status}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Filter Drawer / Bottom Sheet */}
      {showFilterDrawer && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end justify-center p-0">
          <div className="w-full max-w-md bg-white border-t border-neutral-200 rounded-t-3xl p-5 text-neutral-900 max-h-[80vh] flex flex-col shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-200">
              <h3 className="font-serif font-bold text-base text-neutral-900">Filter Tambahan</h3>
              <button
                onClick={() => setShowFilterDrawer(false)}
                className="p-1 rounded-full text-neutral-400 hover:text-neutral-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-neutral-700 font-bold mb-1.5">Status Pengerjaan:</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'ALL', label: 'Semua Status' },
                    { id: 'ASSIGNED', label: 'Belum Mulai' },
                    { id: 'IN_PROGRESS', label: 'Sedang Jalan' }
                  ].map(s => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setDrawerStatusFilter(s.id)}
                      className={`py-2 px-2 rounded-xl text-center font-bold transition cursor-pointer ${
                        drawerStatusFilter === s.id
                          ? 'bg-[#1b4332] text-white shadow-xs'
                          : 'bg-neutral-100 text-neutral-700 border border-neutral-200 hover:bg-neutral-200'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowFilterDrawer(false)}
                className="w-full py-2.5 rounded-xl font-bold text-xs bg-[#1b4332] text-white shadow-xs cursor-pointer"
              >
                Terapkan Filter
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Checkout Inspection / Cleaning Checklist Modal (White Surface Detail) */}
      {showInspectionModal && selectedTask && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="w-full max-w-md bg-white border-t sm:border border-neutral-200 rounded-t-3xl sm:rounded-2xl p-5 text-neutral-900 max-h-[88vh] flex flex-col shadow-2xl animate-in slide-in-from-bottom duration-200">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-50 text-[#1b4332] border border-emerald-200 flex items-center justify-center font-bold text-sm">
                  {selectedTask.room_number || 'HK'}
                </div>
                <div>
                  <h3 className="font-serif font-bold text-base text-neutral-900 leading-tight">
                    {selectedTask.task_type === 'CHECKOUT_ROOM_CHECK' ? 'Pemeriksaan Checkout' : 'Checklist Kebersihan'}
                  </h3>
                  <p className="text-xs text-neutral-500">
                    Kamar {selectedTask.room_number} • {selectedTask.room_type_name}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowInspectionModal(false)}
                className="p-1.5 rounded-full hover:bg-neutral-100 text-neutral-400 hover:text-neutral-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Checklist Completion Status Banner */}
            <div className="py-2.5 px-3 my-2 rounded-xl bg-neutral-50 border border-neutral-200 flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5">
                <ClipboardCheck className={`w-4 h-4 ${isAllRequiredCompleted ? 'text-emerald-600' : 'text-amber-600'}`} />
                <span className="font-bold text-neutral-800">
                  Butir Wajib: {checklistItems.filter(it => it.is_required && it.is_completed).length} / {requiredChecklistItems.length}
                </span>
              </div>
              {isAllRequiredCompleted ? (
                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                  Lengkap
                </span>
              ) : (
                <span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full">
                  {uncompletedRequiredCount} Belum
                </span>
              )}
            </div>

            {/* Error Banner */}
            {checklistError && (
              <div className="mb-2 p-2.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <span>{checklistError}</span>
              </div>
            )}

            {/* Checklist Items List */}
            <div className="flex-1 overflow-y-auto py-1 space-y-1.5 pr-1">
              {checklistLoading ? (
                <div className="py-8 text-center text-xs text-neutral-500">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-[#1b4332]" />
                  <span>Memuat checklist kamar...</span>
                </div>
              ) : checklistItems.length === 0 ? (
                <div className="text-center py-6 text-xs text-neutral-500 bg-neutral-50 rounded-xl p-4">
                  <Info className="w-6 h-6 text-neutral-400 mx-auto mb-1" />
                  <p className="font-semibold text-neutral-700">Checklist SOP Umum</p>
                  <p className="text-[11px] text-neutral-500 mt-0.5">
                    Lakukan pemeriksaan seluruh item standar kamar sebelum konfirmasi status.
                  </p>
                </div>
              ) : (
                checklistItems.map(item => (
                  <label
                    key={item.id}
                    className={`flex items-center gap-3 p-2.5 rounded-xl border transition cursor-pointer ${
                      item.is_completed
                        ? 'bg-emerald-50/40 border-emerald-200/80'
                        : item.is_required
                        ? 'bg-white border-neutral-300 hover:border-neutral-400'
                        : 'bg-neutral-50/70 border-neutral-200'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={item.is_completed}
                      onChange={() => handleToggleChecklistItem(item.id, item.is_completed)}
                      className="w-5 h-5 rounded border-neutral-300 text-[#1b4332] focus:ring-[#1b4332] cursor-pointer"
                    />
                    <div className="flex-1 text-xs min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <p className={`font-semibold truncate ${item.is_completed ? 'line-through text-neutral-400' : 'text-neutral-900'}`}>
                          {item.label}
                        </p>
                        {item.is_required ? (
                          <span className="text-[9px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.2 rounded shrink-0">
                            Wajib
                          </span>
                        ) : (
                          <span className="text-[9px] text-neutral-400 shrink-0">Opsional</span>
                        )}
                      </div>
                      {item.completed_by_name && (
                        <p className="text-[9px] text-emerald-700 font-medium">✓ Dicek: {item.completed_by_name}</p>
                      )}
                    </div>
                  </label>
                ))
              )}
            </div>

            {/* Bottom Actions for Inspection */}
            <div className="pt-3 border-t border-neutral-200 space-y-2">
              {selectedTask.task_type === 'CHECKOUT_ROOM_CHECK' ? (
                /* 2 Thumb Actions for Checkout Check */
                <div className="space-y-1.5">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={submittingId === selectedTask.id}
                      onClick={() => openFindingReporter(selectedTask)}
                      className="py-3 px-3 rounded-xl font-bold text-xs bg-red-50 border border-red-300 text-red-800 hover:bg-red-100 active:scale-98 transition flex items-center justify-center gap-1.5 shadow-2xs cursor-pointer"
                    >
                      <AlertTriangle className="w-4 h-4 text-red-700" />
                      <span>ADA TEMUAN</span>
                    </button>

                    <button
                      type="button"
                      disabled={submittingId === selectedTask.id || !isAllRequiredCompleted}
                      onClick={() => handleSubmitCheckoutInspection(selectedTask, 'CLEAR')}
                      className={`py-3 px-3 rounded-xl font-bold text-xs shadow-xs flex items-center justify-center gap-1.5 active:scale-98 transition cursor-pointer ${
                        isAllRequiredCompleted
                          ? 'bg-[#1b4332] hover:bg-[#143326] text-white'
                          : 'bg-neutral-200 text-neutral-400 cursor-not-allowed'
                      }`}
                    >
                      {submittingId === selectedTask.id ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4" />
                      )}
                      <span>KAMAR AMAN</span>
                    </button>
                  </div>

                  {!isAllRequiredCompleted && requiredChecklistItems.length > 0 && (
                    <p className="text-[10px] text-amber-700 text-center font-medium">
                      Centang seluruh {requiredChecklistItems.length} butir wajib sebelum menandai Kamar Aman.
                    </p>
                  )}
                </div>
              ) : (
                /* Cleaning Task Complete Action */
                <button
                  type="button"
                  disabled={submittingId === selectedTask.id}
                  onClick={() => handleCompleteTask(selectedTask)}
                  className="w-full py-3 rounded-xl font-bold text-xs bg-emerald-700 hover:bg-emerald-800 text-white shadow-xs transition flex items-center justify-center gap-2 active:scale-98 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Selesai & Tandai Kamar Bersih</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Dynamic Finding Reporter Modal */}
      {showFindingModal && selectedTask && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="w-full max-w-md bg-white border-t sm:border border-neutral-200 rounded-t-3xl sm:rounded-2xl p-5 text-neutral-900 max-h-[90vh] flex flex-col shadow-2xl animate-in slide-in-from-bottom duration-200 space-y-3.5">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-200">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
                <div>
                  <h3 className="font-serif font-bold text-base text-neutral-900">
                    Lapor Temuan Kamar {selectedTask.room_number}
                  </h3>
                  <p className="text-[11px] text-neutral-500">Pilih jenis temuan dari katalog operasional</p>
                </div>
              </div>
              <button
                onClick={() => setShowFindingModal(false)}
                className="p-1.5 rounded-full hover:bg-neutral-100 text-neutral-400 hover:text-neutral-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 text-xs pr-1">
              {/* Dynamic Finding Catalog Chips */}
              <div>
                <label className="block text-neutral-700 font-bold mb-1.5">
                  Jenis Temuan:
                </label>
                {findingTypes.length === 0 ? (
                  <p className="text-neutral-400 text-xs">Memuat katalog jenis temuan...</p>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    {findingTypes.map(f => (
                      <button
                        key={f.code}
                        type="button"
                        onClick={() => setFindingPayload(p => ({ ...p, finding_code: f.code }))}
                        className={`p-2 rounded-xl text-left font-semibold transition cursor-pointer border ${
                          findingPayload.finding_code === f.code
                            ? 'bg-amber-500 text-neutral-950 border-amber-600 shadow-xs'
                            : 'bg-neutral-50 text-neutral-700 border-neutral-200 hover:bg-neutral-100'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="truncate">{f.label}</span>
                          {f.severity === 'CRITICAL' || f.severity === 'HIGH' ? (
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-600 shrink-0 ml-1" />
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Note Input */}
              <div>
                <label className="block text-neutral-700 font-bold mb-1">
                  Keterangan / Deskripsi {selectedFindingTypeMeta?.note_required && <span className="text-red-600">* (Wajib Diisi)</span>}:
                </label>
                <textarea
                  rows={2}
                  value={findingPayload.note}
                  onChange={(e) => setFindingPayload(p => ({ ...p, note: e.target.value }))}
                  placeholder="Contoh: 1 kaleng soda minibar habis, remote TV tidak ada di meja..."
                  className="w-full p-2.5 rounded-xl bg-white border border-neutral-300 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Estimated Charge (Only if allowed by finding type configuration) */}
              {selectedFindingTypeMeta?.estimated_charge_allowed !== false && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-neutral-700 font-bold">
                      Estimasi Biaya / Charge Tamu (Rp - Opsional):
                    </label>
                    <span className="text-[10px] text-neutral-400">Informasi Front Office</span>
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 font-semibold">Rp</span>
                    <input
                      type="number"
                      value={findingPayload.estimated_charge}
                      onChange={(e) => setFindingPayload(p => ({ ...p, estimated_charge: e.target.value }))}
                      placeholder="0"
                      className="w-full py-2 pl-9 pr-3 rounded-xl bg-white border border-neutral-300 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                </div>
              )}

              {/* Financial Authority Disclaimer */}
              <div className="p-2.5 rounded-xl bg-neutral-100 border border-neutral-200 text-[10px] text-neutral-600 leading-relaxed">
                <strong className="font-semibold text-neutral-800">Catatan Otoritas:</strong> Estimasi biaya ini bersifat informasional. Front Office / Kasir tetap menjadi otoritas final dalam penagihan tamu.
              </div>
            </div>

            {/* Modal Actions */}
            <div className="pt-2 border-t border-neutral-200 flex gap-2">
              <button
                type="button"
                onClick={() => setShowFindingModal(false)}
                className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={
                  submittingId === selectedTask.id ||
                  (selectedFindingTypeMeta?.note_required && !findingPayload.note.trim())
                }
                onClick={() =>
                  handleSubmitCheckoutInspection(
                    selectedTask,
                    'ISSUE_FOUND',
                    findingPayload.finding_code,
                    findingPayload.note,
                    findingPayload.estimated_charge ? Number(findingPayload.estimated_charge) : 0
                  )
                }
                className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-700 text-white shadow-xs transition flex items-center justify-center gap-1 cursor-pointer disabled:bg-neutral-300 disabled:cursor-not-allowed"
              >
                <AlertTriangle className="w-4 h-4" />
                <span>Kirim ke Front Office</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 3: Buat Tugas Manual (Management / HOD / Supervisor) */}
      {showCreateTaskModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="w-full max-w-md bg-white border-t sm:border border-neutral-200 rounded-t-3xl sm:rounded-2xl p-5 text-neutral-900 max-h-[90vh] flex flex-col shadow-2xl animate-in slide-in-from-bottom duration-200 space-y-3.5">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-200">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5 text-[#1b4332]" />
                <div>
                  <h3 className="font-serif font-bold text-base text-neutral-900">
                    Buat Tugas Housekeeping
                  </h3>
                  <p className="text-[11px] text-neutral-500">Tugas manual dari Manajemen / HOD / Supervisor</p>
                </div>
              </div>
              <button
                onClick={() => setShowCreateTaskModal(false)}
                className="p-1.5 rounded-full hover:bg-neutral-100 text-neutral-400 hover:text-neutral-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateManualTask} className="flex-1 overflow-y-auto space-y-3 text-xs pr-1">
              <div>
                <label className="block text-neutral-700 font-bold mb-1">
                  Judul Tugas <span className="text-red-600">*</span>:
                </label>
                <input
                  type="text"
                  required
                  value={newTaskPayload.title}
                  onChange={(e) => setNewTaskPayload(p => ({ ...p, title: e.target.value }))}
                  placeholder="Contoh: Tambah Extra Bed Kamar 302, Cek AC Koridor..."
                  className="w-full p-2.5 rounded-xl bg-white border border-neutral-300 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-neutral-700 font-bold mb-1">
                    Kamar (Opsional):
                  </label>
                  <input
                    type="text"
                    value={newTaskPayload.room_number}
                    onChange={(e) => setNewTaskPayload(p => ({ ...p, room_number: e.target.value }))}
                    placeholder="101, 204..."
                    className="w-full p-2.5 rounded-xl bg-white border border-neutral-300 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-neutral-700 font-bold mb-1">
                    Prioritas:
                  </label>
                  <select
                    value={newTaskPayload.priority}
                    onChange={(e) => setNewTaskPayload(p => ({ ...p, priority: e.target.value }))}
                    className="w-full p-2.5 rounded-xl bg-white border border-neutral-300 text-neutral-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="NORMAL">Normal</option>
                    <option value="HIGH">Tinggi</option>
                    <option value="CRITICAL">Kritis / Mendesak</option>
                    <option value="TURNOVER">Turnover</option>
                    <option value="VIP">VIP</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-neutral-700 font-bold mb-1">
                  Deskripsi / Instruksi:
                </label>
                <textarea
                  rows={2}
                  value={newTaskPayload.description}
                  onChange={(e) => setNewTaskPayload(p => ({ ...p, description: e.target.value }))}
                  placeholder="Instruksi detail untuk petugas housekeeping..."
                  className="w-full p-2.5 rounded-xl bg-white border border-neutral-300 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-neutral-700 font-bold mb-1">
                  Ditugaskan Kepada (Opsional):
                </label>
                <input
                  type="text"
                  value={newTaskPayload.assigned_user_name}
                  onChange={(e) => setNewTaskPayload(p => ({ ...p, assigned_user_name: e.target.value }))}
                  placeholder="Nama staf HK atau biarkan kosong"
                  className="w-full p-2.5 rounded-xl bg-white border border-neutral-300 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="pt-2 border-t border-neutral-200 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateTaskModal(false)}
                  className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={createTaskSubmitting || !newTaskPayload.title.trim()}
                  className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-[#1b4332] hover:bg-[#143326] text-white shadow-xs transition flex items-center justify-center gap-1 cursor-pointer disabled:bg-neutral-300 disabled:cursor-not-allowed"
                >
                  <Plus className="w-4 h-4 text-[#d4af37]" />
                  <span>{createTaskSubmitting ? 'Menyimpan...' : 'Buat Tugas'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
