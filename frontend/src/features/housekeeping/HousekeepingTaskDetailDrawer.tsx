import React, { useState } from 'react';
import type {
  HousekeepingTaskRecord,
  HkTaskPriority,
  HkTaskStatus,
  HkInspectionResult,
  HkIssueType,
  TaskChecklistItem
} from './housekeepingTypes';

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

  if (!isOpen) return null;

  const isComplete = task.status === 'DONE' || task.status === 'VERIFIED' || task.status === 'CANCELLED';

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
      const chargeNum = estimatedCharge ? Number(estimatedCharge) : undefined;
      await onComplete(task, {
        completion_note: completionNote || undefined,
        inspection_result: inspectionResult,
        issue_type: inspectionResult === 'ISSUE_FOUND' ? issueType : undefined,
        issue_note: inspectionResult === 'ISSUE_FOUND' ? issueNote : undefined,
        estimated_charge: chargeNum
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
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-xs transition-opacity" onClick={onClose} />

      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-white shadow-2xl flex flex-col">
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
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Body Content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {errorMsg && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg flex items-start gap-2">
                <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>{errorMsg}</div>
              </div>
            )}

            {/* Next Arrival Context */}
            {task.next_arrival && (
              <div className="p-3 bg-amber-50/80 border border-amber-200 rounded-lg">
                <div className="text-xs font-bold text-amber-900 flex items-center gap-1.5 mb-1">
                  <svg className="w-4 h-4 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
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
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-lg border transition-colors cursor-pointer ${
                              isAllSecCompleted
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                                : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-100'
                            }`}
                          >
                            {isAllSecCompleted ? '✓ Semua Dicentang' : '✓ Checklist Semua'}
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

            {/* In-Progress Operational Actions Form */}
            {task.status === 'IN_PROGRESS' && (
              <div className="space-y-4 pt-2 border-t border-neutral-200">
                <h3 className="text-sm font-bold text-neutral-900">Penyelesaian Tugas</h3>

                {/* Final Inspection Form */}
                {task.task_type === 'FINAL_INSPECTION' && (
                  <div className="space-y-3 p-3 bg-indigo-50/60 border border-indigo-200 rounded-lg">
                    <div className="text-xs font-bold text-indigo-900">Keputusan Inspeksi Supervisor</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setInspectionResult('PASS')}
                        className={`p-2.5 text-xs font-semibold rounded-lg border text-center transition-all ${
                          inspectionResult === 'PASS'
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                            : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        ✓ Lolos (Inspected)
                      </button>
                      <button
                        type="button"
                        onClick={() => setInspectionResult('RETURN_TO_CLEANING')}
                        className={`p-2.5 text-xs font-semibold rounded-lg border text-center transition-all ${
                          inspectionResult === 'RETURN_TO_CLEANING'
                            ? 'bg-rose-600 text-white border-rose-600 shadow-xs'
                            : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        ✕ Perlu Perbaikan (Rework)
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

                {/* Checkout Inspection Form */}
                {task.task_type === 'CHECKOUT_ROOM_CHECK' && (
                  <div className="space-y-3 p-3 bg-amber-50/60 border border-amber-200 rounded-lg">
                    <div className="text-xs font-bold text-amber-900">Hasil Pemeriksaan Kamar Checkout</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setInspectionResult('CLEAR')}
                        className={`p-2.5 text-xs font-semibold rounded-lg border text-center transition-all ${
                          inspectionResult === 'CLEAR'
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                            : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        ✓ Kamar Aman (Clear)
                      </button>
                      <button
                        type="button"
                        onClick={() => setInspectionResult('ISSUE_FOUND')}
                        className={`p-2.5 text-xs font-semibold rounded-lg border text-center transition-all ${
                          inspectionResult === 'ISSUE_FOUND'
                            ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                            : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                        }`}
                      >
                        ⚠ Ada Temuan (Issue)
                      </button>
                    </div>

                    {inspectionResult === 'ISSUE_FOUND' && (
                      <div className="space-y-2 pt-1">
                        <div>
                          <label className="text-xs font-medium text-neutral-700 block mb-1">Tipe Temuan</label>
                          <select
                            value={issueType}
                            onChange={(e) => setIssueType(e.target.value as HkIssueType)}
                            className="w-full text-xs p-2 rounded border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                          >
                            <option value="MINIBAR">Minibar Consumed</option>
                            <option value="DAMAGE">Kerusakan Kamar (Damage)</option>
                            <option value="LINEN">Noda Linen / Towel Rusak</option>
                            <option value="MISSING_HOTEL_ITEM">Barang Hotel Hilang</option>
                            <option value="LOST_AND_FOUND">Barang Tamu Tertinggal (Lost & Found)</option>
                            <option value="OTHER">Lainnya</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium text-neutral-700 block mb-1">Rincian Temuan</label>
                          <textarea
                            rows={2}
                            value={issueNote}
                            onChange={(e) => setIssueNote(e.target.value)}
                            placeholder="Contoh: 2 kaleng soda diminum, handuk ada noda permanen..."
                            className="w-full text-xs p-2 rounded border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-neutral-700 block mb-1">Estimasi Biaya / Charge ke Tamu (Rp)</label>
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
          </div>

          {/* Footer Actions */}
          <div className="p-4 border-t border-neutral-200 bg-neutral-50 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-xs font-medium text-neutral-700 bg-white border border-neutral-300 rounded-lg hover:bg-neutral-100"
            >
              Tutup
            </button>

            {task.status === 'ASSIGNED' && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onAcknowledge(task)}
                className="px-4 py-2 text-xs font-semibold text-white bg-indigo-700 rounded-lg hover:bg-indigo-800 transition-colors"
              >
                {isSubmitting ? 'Memproses...' : 'Terima Tugas (Acknowledge)'}
              </button>
            )}

            {task.status === 'ACKNOWLEDGED' && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onStart(task)}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors"
              >
                {isSubmitting ? 'Memproses...' : 'Mulai Pengerjaan'}
              </button>
            )}

            {task.status === 'IN_PROGRESS' && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleCompleteSubmit}
                className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors"
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
