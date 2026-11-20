import React, { useEffect, useState } from 'react';
import {
  CupSoda,
  Droplets,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Check,
  X,
  Settings,
  Zap,
  AlertCircle,
  Package
} from 'lucide-react';
import type {
  HousekeepingTaskRecord,
  HkTaskPriority,
  HkTaskStatus,
  HkInspectionResult,
  HkIssueType,
  TaskChecklistItem
} from './housekeepingTypes';
import { authenticatedFetch as authFetch } from '../../lib/authenticatedFetch';
import { MinibarCheckoutConfirmationCard, type MinibarItemEntry } from './MinibarCheckoutConfirmationCard';

interface HousekeepingTaskDetailDrawerProps {
  task: HousekeepingTaskRecord;
  isOpen: boolean;
  onClose: () => void;
  onAcknowledge: (task: HousekeepingTaskRecord) => Promise<void>;
  onStart: (task: HousekeepingTaskRecord) => Promise<void>;
  onToggleChecklistItem: (task: HousekeepingTaskRecord, item: TaskChecklistItem, isCompleted: boolean) => Promise<void>;
  onBulkToggleCategory?: (task: HousekeepingTaskRecord, categoryName: string, items: TaskChecklistItem[], isCompleted: boolean) => Promise<void>;
  categoryBulkCheckEnabled?: boolean;
  onComplete: (
    task: HousekeepingTaskRecord,
    payload: {
      completion_note?: string;
      inspection_result?: HkInspectionResult;
      issue_type?: HkIssueType;
      issue_note?: string;
      estimated_charge?: number;
      minibar_items?: Array<{ menu_item_id: number; quantity: number; unit_price?: number }>;
      complimentary_items?: Array<{ menu_item_id: number; quantity: number }>;
      stocked_minibar_items?: Array<{ menu_item_id: number; quantity: number; unit_price?: number }>;
    }
  ) => Promise<void>;
  isSubmitting?: boolean;
}

export const HousekeepingTaskDetailDrawer: React.FC<HousekeepingTaskDetailDrawerProps> = ({
  task,
  isOpen,
  onClose,
  onAcknowledge,
  onStart,
  onToggleChecklistItem,
  onBulkToggleCategory,
  categoryBulkCheckEnabled = false,
  onComplete,
  isSubmitting = false
}) => {
  const [completionNote, setCompletionNote] = useState('');
  const [inspectionResult, setInspectionResult] = useState<HkInspectionResult>(
    task.inspection_result || (task.task_type === 'CHECKOUT_ROOM_CHECK' ? 'CLEAR' : 'PASS')
  );
  const [issueType, setIssueType] = useState<HkIssueType>(task.issue_type || 'MINIBAR');
  const [issueNote, setIssueNote] = useState(task.issue_note || '');
  const [estimatedCharge, setEstimatedCharge] = useState<string>(
    task.estimated_charge ? String(task.estimated_charge) : ''
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Minibar & Complimentary HKP state
  const [complimentaryDefaults, setComplimentaryDefaults] = useState<any[]>([]);
  const [minibarDefaults, setMinibarDefaults] = useState<any[]>([]);
  const [selectedMinibarItems, setSelectedMinibarItems] = useState<MinibarItemEntry[]>([]);
  const [complimentaryItems, setComplimentaryItems] = useState<MinibarItemEntry[]>([]);
  const [stockedMinibarItems, setStockedMinibarItems] = useState<MinibarItemEntry[]>([]);
  const [lastCheckoutConsumption, setLastCheckoutConsumption] = useState<any | null>(null);
  const [selectedAddCompId, setSelectedAddCompId] = useState<string>('');
  const [selectedAddStockedMinibarId, setSelectedAddStockedMinibarId] = useState<string>('');

  const isCleaningTask =
    task.task_type === 'ROOM_CLEANING' ||
    task.task_type === 'STAYOVER_CLEANING' ||
    task.task_type === 'DEEP_CLEAN' ||
    task.task_type === 'VIP_ROOM_PREPARATION';

  useEffect(() => {
    setInspectionResult(
      task.inspection_result || (task.task_type === 'CHECKOUT_ROOM_CHECK' ? 'CLEAR' : 'PASS')
    );
    setCompletionNote('');
    setIssueType(task.issue_type && task.issue_type !== 'MINIBAR' ? task.issue_type : 'DAMAGE');
    setIssueNote(task.issue_note || '');
    setEstimatedCharge(task.estimated_charge ? String(task.estimated_charge) : '');
    setErrorMsg(null);
    const existingMb = Array.isArray((task as any).minibar_items_json) ? (task as any).minibar_items_json : [];
    setSelectedMinibarItems(existingMb);
  }, [task.id, task.status, task.task_type, task.inspection_result, task.issue_type, task.issue_note, task.estimated_charge]);

  useEffect(() => {
    if (!isOpen || !task.property_id) return;
    if (!isCleaningTask && task.task_type !== 'CHECKOUT_ROOM_CHECK') return;
    let cancelled = false;
    const loadMinibarContext = async () => {
      try {
        const params = new URLSearchParams({
          property_id: String(task.property_id),
          task_id: String(task.id),
        });
        if (task.room_id) params.set('room_id', String(task.room_id));
        if ((task as any).reservation_id) params.set('reservation_id', String((task as any).reservation_id));
        const res = await authFetch(`/api/housekeeping/minibar-catalog?${params.toString()}`);
        const json = await res.json();
        if (!cancelled && res.ok && json?.data) {
          const compDefs = Array.isArray(json.data.complimentary_defaults) ? json.data.complimentary_defaults : [];
          const mbDefs = Array.isArray(json.data.minibar_defaults) ? json.data.minibar_defaults : [];
          setComplimentaryDefaults(compDefs);
          setMinibarDefaults(mbDefs);
          setLastCheckoutConsumption(json.data.last_checkout_consumption || null);

          if (isCleaningTask) {
            setComplimentaryItems(
              compDefs.map((d: any) => ({
                menu_item_id: Number(d.menu_item_id),
                name: String(d.item_name || d.name || ''),
                sku: String(d.sku || ''),
                quantity: Number(d.standard_qty || 2),
                unit_price: 0,
                subtotal: 0,
                base_unit_code: String(d.base_unit_code || 'PCS'),
              }))
            );
            setStockedMinibarItems(
              mbDefs.map((d: any) => ({
                menu_item_id: Number(d.menu_item_id),
                name: String(d.item_name || d.name || ''),
                sku: String(d.sku || ''),
                quantity: Number(d.stocked_qty ?? d.standard_qty ?? 1),
                unit_price: Number(d.unit_price || 0),
                subtotal: Number(d.stocked_qty ?? d.standard_qty ?? 1) * Number(d.unit_price || 0),
                base_unit_code: String(d.base_unit_code || 'PCS'),
              }))
            );
          }
        }
      } catch {
        // non-fatal
      }
    };
    loadMinibarContext();
    return () => {
      cancelled = true;
    };
  }, [isOpen, task.id, task.property_id, task.room_id, task.task_type, isCleaningTask]);

  const handleAdjustMinibarItem = (prod: { menu_item_id: number; name: string; sku?: string; unit_price: number; base_unit_code?: string }, delta: number) => {
    setSelectedMinibarItems((prev) => {
      const existing = prev.find((it) => it.menu_item_id === prod.menu_item_id);
      let next: MinibarItemEntry[];
      if (existing) {
        const nextQty = Math.max(0, existing.quantity + delta);
        next = prev
          .map((it) =>
            it.menu_item_id === prod.menu_item_id
              ? { ...it, quantity: nextQty, subtotal: nextQty * it.unit_price }
              : it
          )
          .filter((it) => it.quantity > 0);
      } else if (delta > 0) {
        next = [
          ...prev,
          {
            menu_item_id: prod.menu_item_id,
            name: prod.name,
            sku: prod.sku || '',
            quantity: delta,
            unit_price: Number(prod.unit_price || 0),
            subtotal: delta * Number(prod.unit_price || 0),
            base_unit_code: prod.base_unit_code || 'PCS',
          },
        ];
      } else {
        next = prev;
      }

      const sumTotal = next.reduce((acc, it) => acc + it.subtotal, 0);
      setEstimatedCharge(sumTotal > 0 ? String(sumTotal) : '');
      if (next.length > 0) {
        setIssueNote(
          `Minibar: ${next.map((it) => `${it.quantity}x ${it.name} (@Rp ${it.unit_price.toLocaleString('id-ID')})`).join(', ')}`
        );
      }
      return next;
    });
  };

  const handleAdjustCompItem = (prod: { menu_item_id: number; name: string; sku?: string; base_unit_code?: string }, delta: number) => {
    setComplimentaryItems((prev) => {
      const existing = prev.find((it) => it.menu_item_id === prod.menu_item_id);
      if (existing) {
        const nextQty = Math.max(0, existing.quantity + delta);
        return prev
          .map((it) => (it.menu_item_id === prod.menu_item_id ? { ...it, quantity: nextQty } : it))
          .filter((it) => it.quantity > 0);
      } else if (delta > 0) {
        return [
          ...prev,
          {
            menu_item_id: prod.menu_item_id,
            name: prod.name,
            sku: prod.sku || '',
            quantity: delta,
            unit_price: 0,
            subtotal: 0,
            base_unit_code: prod.base_unit_code || 'PCS',
          },
        ];
      }
      return prev;
    });
  };

  const handleAdjustStockedMinibarItem = (
    prod: { menu_item_id: number; name: string; sku?: string; unit_price: number; base_unit_code?: string },
    delta: number
  ) => {
    setStockedMinibarItems((prev) => {
      const existing = prev.find((it) => it.menu_item_id === prod.menu_item_id);
      if (existing) {
        const nextQty = Math.max(0, existing.quantity + delta);
        return prev
          .map((it) =>
            it.menu_item_id === prod.menu_item_id
              ? { ...it, quantity: nextQty, subtotal: nextQty * it.unit_price }
              : it
          )
          .filter((it) => it.quantity > 0);
      } else if (delta > 0) {
        return [
          ...prev,
          {
            menu_item_id: prod.menu_item_id,
            name: prod.name,
            sku: prod.sku || '',
            quantity: delta,
            unit_price: Number(prod.unit_price || 0),
            subtotal: delta * Number(prod.unit_price || 0),
            base_unit_code: prod.base_unit_code || 'PCS',
          },
        ];
      }
      return prev;
    });
  };

  if (!isOpen) return null;

  const isComplete = task.status === 'DONE' || task.status === 'VERIFIED' || task.status === 'CANCELLED';
  const isDirectInspectionTask =
    task.task_type === 'FINAL_INSPECTION' || task.task_type === 'CHECKOUT_ROOM_CHECK';
  const canCompleteNow =
    !isComplete && (task.status === 'IN_PROGRESS' || isDirectInspectionTask);

  // Group checklist items by section
  const sections: Record<string, TaskChecklistItem[]> = {};
  for (const item of task.checklist_items || []) {
    const sec = item.section || 'General';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(item);
  }

  const handleCompleteSubmit = async () => {
    setErrorMsg(null);
    try {
      const hasMinibarConsumed =
        task.task_type === 'CHECKOUT_ROOM_CHECK' && selectedMinibarItems.length > 0;
      const minibarTotal = selectedMinibarItems.reduce((sum, it) => sum + Number(it.subtotal || 0), 0);
      const minibarSummary = hasMinibarConsumed
        ? `Minibar: ${selectedMinibarItems.map((it) => `${it.quantity}x ${it.name} (@Rp ${Number(it.unit_price || 0).toLocaleString('id-ID')})`).join(', ')}`
        : '';

      let effectiveInspectionResult = inspectionResult;
      let effectiveIssueType: HkIssueType | undefined =
        inspectionResult === 'ISSUE_FOUND' ? issueType : undefined;
      let effectiveIssueNote: string | undefined =
        inspectionResult === 'ISSUE_FOUND' ? issueNote : undefined;
      let effectiveCharge: number | undefined = estimatedCharge ? Number(estimatedCharge) : undefined;

      if (hasMinibarConsumed) {
        effectiveInspectionResult = 'ISSUE_FOUND';
        if (inspectionResult !== 'ISSUE_FOUND') {
          effectiveIssueType = 'MINIBAR';
          effectiveIssueNote = minibarSummary;
          effectiveCharge = minibarTotal;
        } else {
          // Both physical issue and minibar consumed
          effectiveIssueNote = issueNote
            ? `${minibarSummary} | ${issueNote}`
            : minibarSummary;
          effectiveCharge = (Number(estimatedCharge || 0) || 0) + minibarTotal;
        }
      }

      await onComplete(task, {
        completion_note: completionNote || undefined,
        inspection_result: effectiveInspectionResult,
        issue_type: effectiveIssueType,
        issue_note: effectiveIssueNote,
        estimated_charge: effectiveCharge,
        minibar_items: hasMinibarConsumed
          ? selectedMinibarItems.map((it) => ({
              menu_item_id: it.menu_item_id,
              quantity: it.quantity,
              unit_price: it.unit_price,
            }))
          : undefined,
        complimentary_items: isCleaningTask
          ? complimentaryItems.map((it) => ({
              menu_item_id: it.menu_item_id,
              quantity: it.quantity,
            }))
          : undefined,
        stocked_minibar_items: isCleaningTask
          ? stockedMinibarItems.map((it) => ({
              menu_item_id: it.menu_item_id,
              quantity: it.quantity,
              unit_price: it.unit_price,
            }))
          : undefined,
      });
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal menyelesaikan tugas');
    }
  };

  const getPriorityBadgeClass = (p: HkTaskPriority) => {
    switch (p) {
      case 'CRITICAL':
      case 'TURNOVER':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'VIP':
      case 'HIGH':
        return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'LOW':
        return 'bg-neutral-100 text-neutral-700 border-neutral-200';
      default:
        return 'bg-emerald-50 text-emerald-800 border-emerald-200';
    }
  };

  const getStatusBadgeClass = (s: HkTaskStatus) => {
    switch (s) {
      case 'IN_PROGRESS':
        return 'bg-blue-100 text-blue-800 animate-pulse';
      case 'DONE':
      case 'VERIFIED':
        return 'bg-emerald-100 text-emerald-800';
      case 'BLOCKED':
        return 'bg-rose-100 text-rose-800';
      case 'ACKNOWLEDGED':
        return 'bg-indigo-100 text-indigo-800';
      default:
        return 'bg-amber-100 text-amber-800';
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/50 backdrop-blur-xs transition-opacity animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] bg-white shadow-2xl rounded-2xl border border-neutral-200 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-full flex flex-col max-h-[90vh]">
          {/* Header */}
          <div className="px-5 py-4 border-b border-neutral-200 bg-neutral-50 flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-2 py-0.5 text-xs font-semibold rounded border ${getPriorityBadgeClass(task.priority)}`}>
                  {task.priority}
                </span>
                <span className={`px-2 py-0.5 text-xs font-semibold rounded ${getStatusBadgeClass(task.status)}`}>
                  {task.status}
                </span>
                {task.room_number && (
                  <span className="px-2 py-0.5 text-xs font-bold rounded bg-neutral-800 text-white">
                    Kamar {task.room_number}
                  </span>
                )}
              </div>
              <h2 className="text-base font-bold text-neutral-900 leading-snug">{task.title}</h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                Kategori: <span className="font-medium text-neutral-700">{task.task_category}</span> • Tipe: <span className="font-medium text-neutral-700">{task.task_type}</span>
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-neutral-400 hover:text-neutral-700 rounded-lg hover:bg-neutral-200/60"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body Content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {errorMsg && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>{errorMsg}</div>
              </div>
            )}

            {/* Next Arrival Context */}
            {task.next_arrival && (
              <div className="p-3 bg-amber-50/80 border border-amber-200 rounded-lg">
                <div className="text-xs font-bold text-amber-900 flex items-center gap-1.5 mb-1">
                  <Zap className="w-4 h-4 text-amber-700" />
                  Priority Turnover — Incoming Arrival Hari Ini
                </div>
                <div className="text-xs text-amber-800 space-y-0.5">
                  <p>Tamu: <span className="font-semibold">{task.next_arrival.guest_name}</span></p>
                  <p>Estimasi Check-in: <span className="font-medium">{task.next_arrival.expected_arrival_time || '14:00'}</span> (Res #{task.next_arrival.reservation_id})</p>
                </div>
              </div>
            )}

            {/* Timeline Info */}
            <div className="bg-neutral-50 rounded-lg p-3 border border-neutral-200/80 text-xs text-neutral-600 space-y-1.5">
              <div className="font-semibold text-neutral-800 text-[11px] uppercase tracking-wider mb-1">Informasi & Timeline</div>
              <div className="flex justify-between">
                <span>Dibuat / Request:</span>
                <span className="font-medium text-neutral-800">
                  {task.created_at ? new Date(task.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-'} ({task.requested_by_name_snapshot || 'System'})
                </span>
              </div>
              {task.acknowledged_at && (
                <div className="flex justify-between">
                  <span>Diterima (ACK):</span>
                  <span className="font-medium text-neutral-800">
                    {new Date(task.acknowledged_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )}
              {task.started_at && (
                <div className="flex justify-between">
                  <span>Mulai Pengerjaan:</span>
                  <span className="font-medium text-neutral-800">
                    {new Date(task.started_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )}
              {task.completed_at && (
                <div className="flex justify-between">
                  <span>Selesai:</span>
                  <span className="font-medium text-emerald-800">
                    {new Date(task.completed_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )}
              {task.description && (
                <div className="pt-1.5 border-t border-neutral-200">
                  <span className="text-neutral-500">Catatan/Instruksi:</span>
                  <p className="text-neutral-800 italic mt-0.5">{task.description}</p>
                </div>
              )}
            </div>

            {/* Checklist Section */}
            {task.checklist_items && task.checklist_items.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
                  <h3 className="text-sm font-bold text-neutral-900">Checklist Operasional</h3>
                  <span className="text-xs font-semibold px-2 py-0.5 bg-neutral-100 text-neutral-700 rounded-full">
                    {task.checklist_items.filter(i => i.is_completed).length} / {task.checklist_items.length} Selesai
                  </span>
                </div>

                {Object.entries(sections).map(([secName, items]) => {
                  const secCompleted = items.filter((i) => i.is_completed).length;
                  const isAllSecCompleted = items.length > 0 && secCompleted === items.length;

                  return (
                    <div key={secName} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-wider">{secName}</span>
                          <span className="text-[10px] font-mono text-neutral-400 font-semibold">({secCompleted}/{items.length})</span>
                        </div>
                        {categoryBulkCheckEnabled && !isComplete && (
                          <button
                            type="button"
                            disabled={isSubmitting}
                            onClick={() => onBulkToggleCategory?.(task, secName, items, !isAllSecCompleted)}
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-lg border transition-colors cursor-pointer flex items-center gap-1 ${
                              isAllSecCompleted
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                                : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-100'
                            }`}
                          >
                            <Check className="w-3 h-3" />
                            <span>{isAllSecCompleted ? 'Semua Dicentang' : 'Checklist Semua'}</span>
                          </button>
                        )}
                      </div>
                      <div className="space-y-1.5 bg-neutral-50/60 p-2.5 rounded-lg border border-neutral-200/60">
                        {items.map((item) => (
                          <label
                            key={item.id}
                            className={`flex items-start gap-2.5 p-1.5 rounded transition-colors text-xs cursor-pointer select-none ${
                              item.is_completed ? 'bg-emerald-50/50 text-neutral-700' : 'hover:bg-white text-neutral-900'
                            } ${isComplete ? 'cursor-default pointer-events-none' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={item.is_completed}
                              disabled={isComplete || isSubmitting}
                              onChange={(e) => onToggleChecklistItem(task, item, e.target.checked)}
                              className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-emerald-700 focus:ring-emerald-500"
                            />
                            <div className="flex-1">
                              <span className={item.is_completed ? 'line-through text-neutral-500' : 'font-medium'}>
                                {item.label}
                              </span>
                              {item.is_required && (
                                <span className="text-red-500 ml-1 font-bold" title="Wajib diselesaikan">*</span>
                              )}
                              {item.completed_by_name && item.is_completed && (
                                <span className="text-[10px] text-neutral-400 block">
                                  oleh {item.completed_by_name}
                                </span>
                              )}
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Operational Completion / Inspection Form */}
            {canCompleteNow && (
              <div className="space-y-4 pt-2 border-t border-neutral-200">
                {/* 1. DEDICATED MINIBAR CHECKOUT SECTION (ABOVE PENYELESAIAN TUGAS) */}
                {task.task_type === 'CHECKOUT_ROOM_CHECK' && (
                  <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-300 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="font-bold text-amber-950 flex items-center gap-1.5">
                          <CupSoda className="w-4 h-4 text-amber-700" />
                          <span>Pemeriksaan Konsumsi Minibar Kamar (Gudang HKP)</span>
                        </div>
                        <p className="text-[11px] text-amber-800 mt-0.5">
                          Daftar isi minibar kamar saat dibersihkan. Tekan <strong>+</strong> pada produk yang berkurang/diminum tamu (otomatis ditagihkan ke FO).
                        </p>
                      </div>
                    </div>

                    {minibarDefaults.length === 0 ? (
                      <div className="p-2.5 rounded-lg bg-white/80 border border-amber-200 text-[11px] text-amber-900 flex items-center gap-1.5">
                        <Settings className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                        <span>
                          Belum ada produk yang didaftarkan sebagai <strong>Minibar Berbayar</strong> untuk kamar ini. Klik ikon <strong>Setting</strong> di halaman Housekeeping untuk mengatur standar minibar.
                        </span>
                      </div>
                    ) : (
                      <div className="bg-white rounded-xl border border-amber-200 divide-y divide-neutral-100 overflow-hidden">
                        <div className="px-3 py-1.5 bg-amber-100/60 text-[10px] font-bold text-amber-950 flex items-center justify-between">
                          <span>Produk Minibar &amp; Isi Kamar</span>
                          <span>Jumlah Berkurang (Diminum)</span>
                        </div>
                        {minibarDefaults.map((std: any) => {
                          const consumedEntry = selectedMinibarItems.find(
                            (it) => Number(it.menu_item_id) === Number(std.menu_item_id)
                          );
                          const consumedQty = consumedEntry ? consumedEntry.quantity : 0;
                          const roomStockedQty = Number(std.stocked_qty ?? std.standard_qty ?? 0);
                          const itemName = String(std.item_name || std.name || '');
                          const unitPrice = Number(std.unit_price || 0);

                          return (
                            <div
                              key={std.menu_item_id}
                              className={`px-3 py-2 flex items-center justify-between gap-2 ${
                                consumedQty > 0 ? 'bg-amber-50/70' : 'bg-white'
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="font-bold text-neutral-900 truncate">{itemName}</div>
                                <div className="flex items-center gap-2 text-[10px] mt-0.5 flex-wrap">
                                  <span className="px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold">
                                    Isi Kamar: {roomStockedQty} {std.base_unit_code || 'PCS'}
                                  </span>
                                  <span className="text-neutral-500 font-mono">
                                    @ Rp {unitPrice.toLocaleString('id-ID')}
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleAdjustMinibarItem(
                                      {
                                        menu_item_id: Number(std.menu_item_id),
                                        name: itemName,
                                        sku: std.sku,
                                        unit_price: unitPrice,
                                        base_unit_code: std.base_unit_code,
                                      },
                                      -1
                                    )
                                  }
                                  disabled={consumedQty <= 0}
                                  className="w-6 h-6 rounded border border-neutral-300 bg-neutral-50 hover:bg-neutral-100 font-bold text-neutral-700 disabled:opacity-40 cursor-pointer"
                                >
                                  -
                                </button>
                                <span
                                  className={`w-6 text-center font-bold ${
                                    consumedQty > 0 ? 'text-rose-700' : 'text-neutral-600'
                                  }`}
                                >
                                  {consumedQty}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleAdjustMinibarItem(
                                      {
                                        menu_item_id: Number(std.menu_item_id),
                                        name: itemName,
                                        sku: std.sku,
                                        unit_price: unitPrice,
                                        base_unit_code: std.base_unit_code,
                                      },
                                      1
                                    )
                                  }
                                  className="w-6 h-6 rounded border border-amber-400 bg-amber-50 hover:bg-amber-100 font-bold text-amber-900 cursor-pointer"
                                >
                                  +
                                </button>
                              </div>

                              <div className="w-20 text-right font-mono font-bold text-neutral-900">
                                {consumedQty > 0
                                  ? `Rp ${(consumedQty * unitPrice).toLocaleString('id-ID')}`
                                  : '-'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {selectedMinibarItems.length > 0 && (
                      <div className="px-3 py-2 rounded-lg bg-amber-200/70 border border-amber-300 flex items-center justify-between font-bold text-amber-950">
                        <span>Total Tagihan Minibar Berkurang:</span>
                        <span className="font-mono text-sm">
                          Rp{' '}
                          {selectedMinibarItems
                            .reduce((sum, it) => sum + Number(it.subtotal || 0), 0)
                            .toLocaleString('id-ID')}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* 2. DEDICATED COMPLIMENTARY & MINIBAR RESTOCK SECTION FOR CLEANING TASKS (ABOVE PENYELESAIAN TUGAS) */}
                {isCleaningTask && (
                  <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-3 text-xs">
                    <div>
                      <div className="font-bold text-emerald-950 flex items-center gap-1.5">
                        <Droplets className="w-4 h-4 text-emerald-700" />
                        <span>Pengisian Complimentary &amp; Isi Kulkas Minibar Kamar (Gudang HKP)</span>
                      </div>
                      <p className="text-[11px] text-emerald-800 mt-0.5">
                        Produk yang tampil di bawah sesuai dengan pengaturan <strong>Standar Paket Kamar</strong>. Jumlah minibar yang diisi di sini akan tampil sama persis saat pemeriksaan checkout.
                      </p>
                    </div>

                    {/* Recent Checkout Minibar Consumed Alert (Restock Info) */}
                    {lastCheckoutConsumption &&
                      Array.isArray(lastCheckoutConsumption.items) &&
                      lastCheckoutConsumption.items.length > 0 && (
                        <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-300 space-y-1">
                          <div className="font-bold text-amber-950 text-[11px] flex items-center gap-1.5">
                            <RefreshCw className="w-3.5 h-3.5 text-amber-700" />
                            <span>Info Minibar yang Berkurang Saat Checkout Sebelumnya:</span>
                          </div>
                          <ul className="list-disc list-inside text-[11px] text-amber-900 font-semibold">
                            {lastCheckoutConsumption.items.map((it: any, idx: number) => (
                              <li key={idx}>
                                {it.quantity}x {it.name}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                    {/* Bagian A: Complimentary Items List (ONLY COMPLIMENTARY STANDARDS) */}
                    <div className="bg-white rounded-lg border border-emerald-200 overflow-hidden">
                      <div className="px-2.5 py-1.5 bg-emerald-100/60 border-b border-emerald-200 font-bold text-[11px] text-emerald-950 flex justify-between">
                        <span>1. Produk Complimentary Kamar (Gratis — Potong Stok HKP)</span>
                        <span>Qty Diisi</span>
                      </div>
                      {complimentaryItems.length === 0 ? (
                        <div className="p-2.5 text-center text-neutral-500 text-[11px]">
                          Tidak ada produk complimentary yang dipilih.
                        </div>
                      ) : (
                        <div className="divide-y divide-neutral-100">
                          {complimentaryItems.map((it) => (
                            <div
                              key={it.menu_item_id}
                              className="px-2.5 py-2 flex items-center justify-between gap-2"
                            >
                              <div className="font-bold text-neutral-800 truncate flex-1">{it.name}</div>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleAdjustCompItem(it, -1)}
                                  className="w-6 h-6 rounded border border-neutral-300 bg-neutral-50 font-bold text-neutral-700 cursor-pointer"
                                >
                                  -
                                </button>
                                <span className="w-6 text-center font-bold text-emerald-900">
                                  {it.quantity}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleAdjustCompItem(it, 1)}
                                  className="w-6 h-6 rounded border border-emerald-400 bg-emerald-50 font-bold text-emerald-800 cursor-pointer"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {complimentaryDefaults.some(
                        (c: any) => !complimentaryItems.some((it) => Number(it.menu_item_id) === Number(c.menu_item_id))
                      ) && (
                        <div className="p-2 bg-neutral-50 border-t border-neutral-200">
                          <select
                            value={selectedAddCompId}
                            onChange={(e) => {
                              const pid = Number(e.target.value);
                              const found = complimentaryDefaults.find((c: any) => Number(c.menu_item_id) === pid);
                              if (found) {
                                handleAdjustCompItem(
                                  {
                                    menu_item_id: found.menu_item_id,
                                    name: found.item_name || found.name,
                                    sku: found.sku,
                                    base_unit_code: found.base_unit_code,
                                  },
                                  Number(found.standard_qty || 1)
                                );
                              }
                              setSelectedAddCompId('');
                            }}
                            className="w-full text-[11px] bg-white border border-neutral-300 rounded-lg px-2 py-1 text-neutral-700 cursor-pointer"
                          >
                            <option value="">+ Pilih Produk Complimentary Sesuai Standar Kamar...</option>
                            {complimentaryDefaults
                              .filter(
                                (c: any) =>
                                  !complimentaryItems.some((it) => Number(it.menu_item_id) === Number(c.menu_item_id))
                              )
                              .map((c: any) => (
                                <option key={c.menu_item_id} value={c.menu_item_id}>
                                  {c.item_name || c.name} (Standar: {c.standard_qty} {c.base_unit_code} • Stok HKP: {c.hkp_stock_balance} {c.base_unit_code})
                                </option>
                              ))}
                          </select>
                        </div>
                      )}
                    </div>

                    {/* Bagian B: Isi Kulkas Minibar Berbayar di Kamar Ini (ONLY PAID_MINIBAR STANDARDS) */}
                    <div className="bg-white rounded-lg border border-amber-200 overflow-hidden">
                      <div className="px-2.5 py-1.5 bg-amber-100/60 border-b border-amber-200 font-bold text-[11px] text-amber-950 flex justify-between">
                        <span>2. Isi Kulkas Minibar Berbayar di Kamar Ini</span>
                        <span>Jumlah di Kamar</span>
                      </div>
                      {stockedMinibarItems.length === 0 ? (
                        <div className="p-2.5 text-center text-neutral-500 text-[11px]">
                          Belum ada produk Minibar Berbayar untuk kamar ini.
                        </div>
                      ) : (
                        <div className="divide-y divide-neutral-100">
                          {stockedMinibarItems.map((it) => (
                            <div
                              key={it.menu_item_id}
                              className="px-2.5 py-2 flex items-center justify-between gap-2"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="font-bold text-neutral-800 truncate">{it.name}</div>
                                <div className="text-[10px] text-neutral-500 font-mono">
                                  Harga Tamu: Rp {Number(it.unit_price || 0).toLocaleString('id-ID')}
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleAdjustStockedMinibarItem(it, -1)}
                                  className="w-6 h-6 rounded border border-neutral-300 bg-neutral-50 font-bold text-neutral-700 cursor-pointer"
                                >
                                  -
                                </button>
                                <span className="w-6 text-center font-bold text-amber-900">
                                  {it.quantity}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleAdjustStockedMinibarItem(it, 1)}
                                  className="w-6 h-6 rounded border border-amber-400 bg-amber-50 font-bold text-amber-900 cursor-pointer"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {minibarDefaults.some(
                        (m: any) => !stockedMinibarItems.some((it) => Number(it.menu_item_id) === Number(m.menu_item_id))
                      ) && (
                        <div className="p-2 bg-neutral-50 border-t border-neutral-200">
                          <select
                            value={selectedAddStockedMinibarId}
                            onChange={(e) => {
                              const pid = Number(e.target.value);
                              const found = minibarDefaults.find((c: any) => Number(c.menu_item_id) === pid);
                              if (found) {
                                handleAdjustStockedMinibarItem(
                                  {
                                    menu_item_id: found.menu_item_id,
                                    name: found.item_name || found.name,
                                    sku: found.sku,
                                    unit_price: Number(found.unit_price || 0),
                                    base_unit_code: found.base_unit_code,
                                  },
                                  Number(found.standard_qty || 1)
                                );
                              }
                              setSelectedAddStockedMinibarId('');
                            }}
                            className="w-full text-[11px] bg-white border border-neutral-300 rounded-lg px-2 py-1 text-neutral-700 cursor-pointer"
                          >
                            <option value="">+ Pilih Produk Minibar Sesuai Standar Kamar...</option>
                            {minibarDefaults
                              .filter(
                                (m: any) =>
                                  !stockedMinibarItems.some((it) => Number(it.menu_item_id) === Number(m.menu_item_id))
                              )
                              .map((m: any) => (
                                <option key={m.menu_item_id} value={m.menu_item_id}>
                                  {m.item_name || m.name} — Rp {Number(m.unit_price || 0).toLocaleString('id-ID')} (Standar: {m.standard_qty} {m.base_unit_code})
                                </option>
                              ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <h3 className="text-sm font-bold text-neutral-900">Penyelesaian Tugas</h3>

                {/* Final Inspection Form */}
                {task.task_type === 'FINAL_INSPECTION' && (
                  <div className="space-y-3 p-3 bg-indigo-50/60 border border-indigo-200 rounded-lg">
                    <div className="text-xs font-bold text-indigo-900">Keputusan Inspeksi Supervisor</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setInspectionResult('PASS')}
                        className={`p-2.5 text-xs font-semibold rounded-lg border text-center transition-all flex items-center justify-center gap-1.5 ${
                          inspectionResult === 'PASS'
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                            : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Lolos (Inspected)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setInspectionResult('RETURN_TO_CLEANING')}
                        className={`p-2.5 text-xs font-semibold rounded-lg border text-center transition-all flex items-center justify-center gap-1.5 ${
                          inspectionResult === 'RETURN_TO_CLEANING'
                            ? 'bg-rose-600 text-white border-rose-600 shadow-xs'
                            : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Perlu Perbaikan (Rework)</span>
                      </button>
                    </div>

                    {inspectionResult === 'RETURN_TO_CLEANING' && (
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-rose-900">
                          Alasan Pengembalian / Catatan Perbaikan <span className="text-red-600">*</span>
                        </label>
                        <textarea
                          rows={2}
                          value={completionNote}
                          onChange={(e) => setCompletionNote(e.target.value)}
                          placeholder="Contoh: Bantal belum rapi, debu di meja TV..."
                          className="w-full text-xs p-2 rounded border border-rose-300 focus:outline-hidden focus:ring-1 focus:ring-rose-500 bg-white"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Checkout Inspection Form (Physical Condition) */}
                {task.task_type === 'CHECKOUT_ROOM_CHECK' && (
                  <div className="space-y-3 p-3 bg-amber-50/60 border border-amber-200 rounded-lg">
                    <div className="text-xs font-bold text-amber-900">Kondisi Fisik Kamar Checkout</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setInspectionResult('CLEAR')}
                        className={`p-2.5 text-xs font-semibold rounded-lg border text-center transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                          inspectionResult === 'CLEAR'
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                            : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Fisik Kamar Aman (Clear)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setInspectionResult('ISSUE_FOUND');
                          if (!issueType || issueType === 'MINIBAR') {
                            setIssueType('DAMAGE');
                          }
                        }}
                        className={`p-2.5 text-xs font-semibold rounded-lg border text-center transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                          inspectionResult === 'ISSUE_FOUND'
                            ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                            : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>Ada Temuan Fisik / Kerusakan</span>
                      </button>
                    </div>

                    {inspectionResult === 'ISSUE_FOUND' && (
                      <div className="space-y-2.5 pt-1">
                        <div>
                          <label className="text-xs font-medium text-neutral-700 block mb-1">Tipe Temuan Fisik Kamar</label>
                          <select
                            value={issueType}
                            onChange={(e) => setIssueType(e.target.value as HkIssueType)}
                            className="w-full text-xs p-2 rounded border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                          >
                            <option value="DAMAGE">Kerusakan Kamar (Damage)</option>
                            <option value="LINEN">Noda Linen / Towel Rusak</option>
                            <option value="MISSING_HOTEL_ITEM">Barang Hotel Hilang</option>
                            <option value="LOST_AND_FOUND">Barang Tamu Tertinggal (Lost &amp; Found)</option>
                            <option value="OTHER">Lainnya</option>
                          </select>
                        </div>

                        <div>
                          <label className="text-xs font-medium text-neutral-700 block mb-1">Rincian Temuan</label>
                          <textarea
                            rows={2}
                            value={issueNote}
                            onChange={(e) => setIssueNote(e.target.value)}
                            placeholder="Contoh: Handuk ada noda permanen, remote TV hilang..."
                            className="w-full text-xs p-2 rounded border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-neutral-700 block mb-1">Estimasi Biaya / Denda Kerusakan (Rp)</label>
                          <input
                            type="number"
                            value={estimatedCharge}
                            onChange={(e) => setEstimatedCharge(e.target.value)}
                            placeholder="0"
                            className="w-full text-xs p-2 rounded border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Standard Task Notes */}
                {task.task_type !== 'FINAL_INSPECTION' && task.task_type !== 'CHECKOUT_ROOM_CHECK' && (
                  <div>
                    <label className="text-xs font-medium text-neutral-700 block mb-1">Catatan Penyelesaian</label>
                    <textarea
                      rows={2}
                      value={completionNote}
                      onChange={(e) => setCompletionNote(e.target.value)}
                      placeholder="Catatan tambahan saat pengerjaan selesai..."
                      className="w-full text-xs p-2 rounded border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Read-only Produk Kamar Summary when task has complimentary_restock_meta */}
            {isComplete && task.complimentary_restock_meta && (
              <div className="p-3.5 rounded-xl bg-neutral-50 border border-neutral-200 space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-bold text-neutral-900 flex items-center gap-1.5">
                    <Package className="w-4 h-4 text-[#1b4332]" />
                    <span>Produk Kamar yang Dimasukkan (Complimentary &amp; Minibar)</span>
                  </div>
                  {task.complimentary_restock_meta.processed_by && (
                    <span className="text-[10px] text-neutral-500">
                      Oleh: <strong>{task.complimentary_restock_meta.processed_by}</strong>
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(task.complimentary_restock_meta.complimentary_items || []).map((c, idx) => (
                    <span
                      key={`comp-${idx}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-900 font-semibold text-[11px]"
                    >
                      <Droplets className="w-3 h-3 text-emerald-700" />
                      <span>{c.name}</span>
                      <span className="font-mono font-bold text-emerald-800">&times;{c.quantity}</span>
                    </span>
                  ))}
                  {(task.complimentary_restock_meta.stocked_minibar_items || []).map((m, idx) => (
                    <span
                      key={`mb-${idx}`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-900 font-semibold text-[11px]"
                    >
                      <CupSoda className="w-3 h-3 text-amber-700" />
                      <span>{m.name}</span>
                      <span className="font-mono font-bold text-amber-800">&times;{m.quantity}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* If CHECKOUT_ROOM_CHECK is already DONE and has Minibar issue, show FO Confirmation Card */}
            {isComplete &&
              task.task_type === 'CHECKOUT_ROOM_CHECK' &&
              task.inspection_result === 'ISSUE_FOUND' &&
              (task.issue_type === 'MINIBAR' || selectedMinibarItems.length > 0) && (
                <MinibarCheckoutConfirmationCard
                  propertyId={task.property_id}
                  taskId={task.id}
                  roomId={task.room_id}
                  roomNumber={task.room_number}
                  reservationId={(task as any).reservation_id}
                  initialItems={selectedMinibarItems}
                  initialBillingStatus={(task as any).minibar_billing_status}
                  initialBillingMeta={(task as any).minibar_billing_meta}
                  estimatedCharge={task.estimated_charge}
                  issueNote={task.issue_note}
                />
              )}
          </div>

          {/* Footer Actions */}
          <div className="p-4 border-t border-neutral-200 bg-neutral-50 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-xs font-medium text-neutral-700 bg-white border border-neutral-300 rounded-lg hover:bg-neutral-100 cursor-pointer"
            >
              Tutup
            </button>

            {task.status === 'ASSIGNED' && !isDirectInspectionTask && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onAcknowledge(task)}
                className="px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 transition-colors cursor-pointer"
              >
                {isSubmitting ? 'Memproses...' : 'Terima Tugas (Acknowledge)'}
              </button>
            )}

            {task.status === 'ACKNOWLEDGED' && !isDirectInspectionTask && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onStart(task)}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors cursor-pointer"
              >
                {isSubmitting ? 'Memproses...' : 'Mulai Pengerjaan'}
              </button>
            )}

            {canCompleteNow && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleCompleteSubmit}
                className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors cursor-pointer"
              >
                {isSubmitting ? 'Menyimpan...' : 'Selesaikan Tugas'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
