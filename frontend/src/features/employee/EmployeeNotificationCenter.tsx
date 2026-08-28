import React, { useState, useEffect } from 'react';

const Bell = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>
);
const AlertTriangle = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);
const Clock = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const Info = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
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

interface NotificationItem {
  id: string;
  type: 'CHECKOUT_REQUEST' | 'TASK_ASSIGNED' | 'INSPECTION_RESULT' | 'GENERAL';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  priority?: 'NORMAL' | 'URGENT';
}

interface EmployeeNotificationCenterProps {
  propertyId: number;
  employeeName: string;
  onSelectTask?: (taskId: number) => void;
}

export const EmployeeNotificationCenter: React.FC<EmployeeNotificationCenterProps> = ({
  propertyId,
  employeeName
}) => {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Poll or load notifications
  const loadNotifications = async () => {
    try {
      setLoading(true);
      // Fetch urgent checkout tasks & recent assignments for this property
      const res = await fetch(`/api/housekeeping/tasks?property_id=${propertyId}`);
      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        const tasks = data.data || [];
        const items: NotificationItem[] = [];

        // Check for active checkout requests
        const checkoutTasks = tasks.filter(
          (t: any) => t.task_type === 'CHECKOUT_ROOM_CHECK' && t.status !== 'DONE' && !t.is_archived
        );
        checkoutTasks.forEach((t: any) => {
          items.push({
            id: `chk-${t.id}`,
            type: 'CHECKOUT_REQUEST',
            title: `Pemeriksaan Kamar ${t.room_number || ''}`,
            message: `Front Office meminta pemeriksaan checkout untuk kamar ${t.room_number || ''}.`,
            timestamp: t.created_at,
            read: false,
            priority: 'URGENT'
          });
        });

        // Check for urgent dirty rooms
        const urgentDirty = tasks.filter(
          (t: any) => (t.priority === 'URGENT' || t.priority === 'HIGH') && t.status === 'ASSIGNED' && !t.is_archived
        );
        urgentDirty.forEach((t: any) => {
          items.push({
            id: `task-${t.id}`,
            type: 'TASK_ASSIGNED',
            title: `Tugas Prioritas Tinggi: Kamar ${t.room_number || ''}`,
            message: `Kamar ${t.room_number || ''} (${t.room_type_name || ''}) ditugaskan dengan prioritas tinggi.`,
            timestamp: t.created_at,
            read: false,
            priority: 'URGENT'
          });
        });

        // Add welcome / status notification
        items.push({
          id: 'welcome-01',
          type: 'GENERAL',
          title: 'Sistem Terhubung',
          message: `Selamat bertugas ${employeeName}. Notifikasi operasional hotel akan muncul di sini secara real-time.`,
          timestamp: new Date().toISOString(),
          read: true,
          priority: 'NORMAL'
        });

        setNotifications(items);
      }
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadNotifications();
  }, [propertyId, employeeName]);

  const markAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  return (
    <div className="space-y-4 pb-20">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-serif font-bold text-base text-white">Pusat Notifikasi</h3>
          <p className="text-xs text-white/60">Pemberitahuan tugas & permintaan operasional</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadNotifications}
            className="p-2 rounded-xl bg-[#1b4332] border border-white/10 text-[#d4af37] hover:bg-[#245741]"
            title="Perbarui"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={markAllRead}
            className="text-xs text-[#d4af37] hover:underline px-2 py-1"
          >
            Tandai Semua Dibaca
          </button>
        </div>
      </div>

      {notifications.length === 0 ? (
        <div className="py-12 bg-[#1b4332]/40 rounded-2xl border border-white/5 text-center p-6 space-y-2">
          <Bell className="w-10 h-10 text-[#d4af37]/40 mx-auto" />
          <p className="text-white font-medium text-sm">Tidak Ada Notifikasi Baru</p>
          <p className="text-xs text-white/50">Semua tugas dan pemberitahuan telah Anda tangani.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {notifications.map(item => (
            <div
              key={item.id}
              className={`p-3.5 rounded-2xl border transition-all ${
                item.priority === 'URGENT'
                  ? 'bg-gradient-to-r from-rose-950/40 to-[#1b4332] border-rose-500/40'
                  : item.read
                  ? 'bg-[#1b4332]/60 border-white/5 opacity-80'
                  : 'bg-[#1b4332] border-[#d4af37]/30'
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    item.type === 'CHECKOUT_REQUEST'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : item.type === 'TASK_ASSIGNED'
                      ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  }`}
                >
                  {item.type === 'CHECKOUT_REQUEST' ? (
                    <ShieldAlert className="w-4 h-4" />
                  ) : item.type === 'TASK_ASSIGNED' ? (
                    <AlertTriangle className="w-4 h-4" />
                  ) : (
                    <Info className="w-4 h-4" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <h4 className="text-xs font-semibold text-white truncate">{item.title}</h4>
                    {item.priority === 'URGENT' && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-500/30 text-rose-300 shrink-0">
                        URGENT
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-white/80 leading-relaxed mb-1.5">{item.message}</p>
                  <p className="text-[10px] text-white/40 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    <span>{new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB</span>
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
