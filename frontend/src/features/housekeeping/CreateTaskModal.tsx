import React, { useState } from 'react';
import type {
  HkTaskCategory,
  HkTaskType,
  HkTaskPriority,
  ChecklistTemplate
} from './housekeepingTypes';

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    task_category: HkTaskCategory;
    task_type: HkTaskType;
    room_number?: string;
    title: string;
    description?: string;
    priority: HkTaskPriority;
    assigned_user_name_snapshot?: string;
    template_code?: string;
  }) => Promise<void>;
  rooms: Array<{ id: number; room_number: string }>;
  templates: ChecklistTemplate[];
  initialCategory?: HkTaskCategory;
}

export const CreateTaskModal: React.FC<CreateTaskModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  rooms,
  templates,
  initialCategory = 'ROOM_OPERATIONS'
}) => {
  const [taskCategory, setTaskCategory] = useState<HkTaskCategory>(initialCategory);
  const [taskType, setTaskType] = useState<HkTaskType>('ROOM_CLEANING');
  const [roomNumber, setRoomNumber] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<HkTaskPriority>('NORMAL');
  const [assigneeName, setAssigneeName] = useState('');
  const [templateCode, setTemplateCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const taskTitle = title.trim() || (
      taskType === 'ROOM_CLEANING' ? `Pembersihan Kamar ${roomNumber}` :
      taskType === 'CHECKOUT_ROOM_CHECK' ? `Pemeriksaan Checkout Kamar ${roomNumber}` :
      taskType === 'FINAL_INSPECTION' ? `Inspeksi Akhir Kamar ${roomNumber}` :
      taskType === 'GUEST_SERVICE_DELIVERY' ? `Pengantaran Layanan Tamu Kamar ${roomNumber}` :
      'Tugas Housekeeping'
    );

    setIsSubmitting(true);
    try {
      await onSubmit({
        task_category: taskCategory,
        task_type: taskType,
        room_number: roomNumber || undefined,
        title: taskTitle,
        description: description.trim() || undefined,
        priority,
        assigned_user_name_snapshot: assigneeName.trim() || undefined,
        template_code: templateCode || undefined
      });
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Gagal membuat tugas');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-neutral-900/50 backdrop-blur-xs transition-opacity" onClick={onClose} />

      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden border border-neutral-200">
          <div className="px-6 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
            <h2 className="text-base font-bold text-neutral-900">Buat Tugas Housekeeping Baru</h2>
            <button
              onClick={onClose}
              className="p-1 text-neutral-400 hover:text-neutral-700 rounded-md"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {errorMsg && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg">
                {errorMsg}
              </div>
            )}

            {/* Category selection */}
            <div>
              <label className="text-xs font-semibold text-neutral-700 block mb-1">Kategori Tugas</label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setTaskCategory('ROOM_OPERATIONS');
                    setTaskType('ROOM_CLEANING');
                  }}
                  className={`py-2 px-2 text-xs font-medium rounded-lg border text-center transition-all ${
                    taskCategory === 'ROOM_OPERATIONS'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-600 font-bold'
                      : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                  }`}
                >
                  Operasional Kamar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTaskCategory('SERVICE_REQUEST');
                    setTaskType('GUEST_SERVICE_DELIVERY');
                  }}
                  className={`py-2 px-2 text-xs font-medium rounded-lg border text-center transition-all ${
                    taskCategory === 'SERVICE_REQUEST'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-600 font-bold'
                      : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                  }`}
                >
                  Layanan FO / Tamu
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTaskCategory('DEPARTMENT_TASK');
                    setTaskType('GENERAL_HK_REQUEST');
                  }}
                  className={`py-2 px-2 text-xs font-medium rounded-lg border text-center transition-all ${
                    taskCategory === 'DEPARTMENT_TASK'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-600 font-bold'
                      : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'
                  }`}
                >
                  Tugas Departemen
                </button>
              </div>
            </div>

            {/* Type selection */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-neutral-700 block mb-1">Tipe Tugas</label>
                <select
                  value={taskType}
                  onChange={(e) => setTaskType(e.target.value as HkTaskType)}
                  className="w-full text-xs p-2 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                >
                  {taskCategory === 'ROOM_OPERATIONS' && (
                    <>
                      <option value="ROOM_CLEANING">Room Cleaning</option>
                      <option value="STAYOVER_CLEANING">Stayover Cleaning</option>
                      <option value="CHECKOUT_ROOM_CHECK">Checkout Room Check</option>
                      <option value="FINAL_INSPECTION">Final Inspection</option>
                      <option value="DEEP_CLEAN">Deep Clean</option>
                      <option value="VIP_ROOM_PREPARATION">VIP Room Preparation</option>
                      <option value="TURNDOWN_SERVICE">Turndown Service</option>
                    </>
                  )}
                  {taskCategory === 'SERVICE_REQUEST' && (
                    <>
                      <option value="GUEST_SERVICE_DELIVERY">Guest Service Delivery</option>
                      <option value="DELIVERY_SUPPORT">Delivery Support</option>
                    </>
                  )}
                  {taskCategory === 'DEPARTMENT_TASK' && (
                    <>
                      <option value="GENERAL_HK_REQUEST">General HK Request</option>
                      <option value="INTERNAL_SUPPORT">Internal Support</option>
                    </>
                  )}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-neutral-700 block mb-1">Kamar (Opsional)</label>
                <select
                  value={roomNumber}
                  onChange={(e) => setRoomNumber(e.target.value)}
                  className="w-full text-xs p-2 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="">-- Pilih Kamar --</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.room_number}>
                      Kamar {r.room_number}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Priority & Assignee */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-neutral-700 block mb-1">Prioritas</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as HkTaskPriority)}
                  className="w-full text-xs p-2 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="NORMAL">Normal</option>
                  <option value="HIGH">High</option>
                  <option value="CRITICAL">Critical</option>
                  <option value="TURNOVER">Turnover (Arrival Hari Ini)</option>
                  <option value="VIP">VIP</option>
                  <option value="LOW">Low</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-neutral-700 block mb-1">Petugas (PIC)</label>
                <input
                  type="text"
                  value={assigneeName}
                  onChange={(e) => setAssigneeName(e.target.value)}
                  placeholder="Nama staff..."
                  className="w-full text-xs p-2 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </div>

            {/* Title & Description */}
            <div>
              <label className="text-xs font-semibold text-neutral-700 block mb-1">Judul Tugas</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Kosongkan untuk judul otomatis..."
                className="w-full text-xs p-2 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-neutral-700 block mb-1">Deskripsi / Catatan Tambahan</label>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Instruksi khusus atau barang yang diantar..."
                className="w-full text-xs p-2 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
              />
            </div>

            {/* Template Selection */}
            {templates.length > 0 && (
              <div>
                <label className="text-xs font-semibold text-neutral-700 block mb-1">Template Checklist</label>
                <select
                  value={templateCode}
                  onChange={(e) => setTemplateCode(e.target.value)}
                  className="w-full text-xs p-2 rounded-lg border border-neutral-300 bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="">Gunakan Template Default</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.code}>
                      {t.name} ({t.items?.length || 0} items)
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="pt-4 border-t border-neutral-200 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-neutral-700 bg-white border border-neutral-300 rounded-lg hover:bg-neutral-100"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-5 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors shadow-xs"
              >
                {isSubmitting ? 'Menyimpan...' : 'Buat Tugas'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
