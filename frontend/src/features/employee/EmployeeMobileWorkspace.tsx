import React, { useState, useEffect } from 'react';
import { AttendanceGateScreen } from './AttendanceGateScreen';
import { HousekeepingMobileCrewView } from './HousekeepingMobileCrewView';
import { EmployeeNotificationCenter } from './EmployeeNotificationCenter';
import type { EmployeeAttendanceStatus } from './attendanceTypes';

const Home = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
  </svg>
);
const ClipboardList = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
  </svg>
);
const Building2 = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
  </svg>
);
const Bell = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>
);
const User = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </svg>
);
const LogOut = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
  </svg>
);
const CheckCircle2 = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const RefreshCw = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);
const Sparkles = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
  </svg>
);
const ChevronRight = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
  </svg>
);

interface EmployeeMobileWorkspaceProps {
  propertyId: number;
  propertyName?: string;
  isPreview?: boolean;
  initialTab?: 'HOME' | 'TASKS' | 'DEPT' | 'NOTIF' | 'PROFILE';
  currentUser?: {
    id?: number;
    name: string;
    role: string;
    department?: string;
  };
  onBackToDesktop?: () => void;
  onLogout?: () => void;
}

export const EmployeeMobileWorkspace: React.FC<EmployeeMobileWorkspaceProps> = ({
  propertyId,
  propertyName = 'OAK Hotel Grand',
  isPreview = false,
  initialTab = 'TASKS',
  currentUser = { name: 'Staff Housekeeping', role: 'Staff', department: 'Housekeeping' },
  onBackToDesktop,
  onLogout
}) => {
  const [activeTab, setActiveTab] = useState<'HOME' | 'TASKS' | 'DEPT' | 'NOTIF' | 'PROFILE'>(initialTab);

  // Attendance Gate State
  const [attendanceGateOpen, setAttendanceGateOpen] = useState(false);
  const [attendanceStatus, setAttendanceStatus] = useState<EmployeeAttendanceStatus | null>(null);
  const [attendanceLoading, setAttendanceLoading] = useState(!isPreview);

  // Live WIB Clock
  const [currentTimeWib, setCurrentTimeWib] = useState<string>('');

  // Clock Out Modal State
  const [showClockOutModal, setShowClockOutModal] = useState(false);
  const [clockOutSubmitting, setClockOutSubmitting] = useState(false);
  const [clockOutReason, setClockOutReason] = useState('');
  const [clockOutSuccess, setClockOutSuccess] = useState(false);

  // Task statistics for summary
  const [taskStats, setTaskStats] = useState<{
    assigned: number;
    in_progress: number;
    done_today: number;
    checkout_urgent: number;
  }>({
    assigned: 0,
    in_progress: 0,
    done_today: 0,
    checkout_urgent: 0
  });

  // WIB Live Clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const formatted = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(now);
      setCurrentTimeWib(formatted + ' WIB');
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch Attendance Status & Check Gate (Skipped in Preview Mode)
  const fetchAttendanceStatus = async () => {
    if (isPreview) {
      setAttendanceLoading(false);
      setAttendanceGateOpen(false);
      return;
    }
    try {
      setAttendanceLoading(true);
      const url = `/api/attendance/status?property_id=${propertyId}${currentUser.id ? `&employee_id=${currentUser.id}` : ''}&role=${encodeURIComponent(currentUser.role)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        const attData: EmployeeAttendanceStatus = data.data;
        setAttendanceStatus(attData);

        if (attData.attendance_required && !attData.has_checked_in) {
          setAttendanceGateOpen(true);
        } else {
          setAttendanceGateOpen(false);
        }
      }
    } catch (err) {
      console.error('Failed to check attendance gate:', err);
    } finally {
      setAttendanceLoading(false);
    }
  };

  // Fetch task statistics
  const fetchTaskStats = async () => {
    try {
      const [activeRes, histRes] = await Promise.all([
        fetch(`/api/housekeeping/tasks?property_id=${propertyId}&scope=active`),
        fetch(`/api/housekeeping/tasks?property_id=${propertyId}&scope=history`)
      ]);
      const activeData = await activeRes.json();
      const histData = await histRes.json();

      const activeTasks = activeRes.ok && activeData.status === 'OK' ? (activeData.data || []) : [];
      const historyTasks = histRes.ok && histData.status === 'OK' ? (histData.data || []) : [];

      const assigned = activeTasks.filter((t: any) => t.status === 'ASSIGNED' || t.status === 'ACKNOWLEDGED').length;
      const in_progress = activeTasks.filter((t: any) => t.status === 'IN_PROGRESS').length;
      const done_today = historyTasks.length;
      const checkout_urgent = activeTasks.filter((t: any) => t.task_type === 'CHECKOUT_ROOM_CHECK').length;

      setTaskStats({ assigned, in_progress, done_today, checkout_urgent });
    } catch (err) {
      console.error('Failed to fetch task stats:', err);
    }
  };

  useEffect(() => {
    fetchAttendanceStatus();
    fetchTaskStats();
  }, [propertyId, currentUser.id, currentUser.role]);

  // Handle Clock-Out (Absen Pulang)
  const handleClockOut = async () => {
    try {
      setClockOutSubmitting(true);
      const formData = new FormData();
      formData.append('property_id', String(propertyId));
      if (currentUser.id) formData.append('employee_id', String(currentUser.id));
      formData.append('employee_name', currentUser.name);
      formData.append('department', currentUser.department || 'Housekeeping');
      formData.append('attendance_type', 'CHECK_OUT');
      if (clockOutReason.trim()) formData.append('reason', clockOutReason.trim());

      const res = await fetch('/api/attendance/check-out', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (res.ok && data.status === 'OK') {
        setClockOutSuccess(true);
        setTimeout(() => {
          setShowClockOutModal(false);
          setClockOutSuccess(false);
          fetchAttendanceStatus();
        }, 1500);
      } else {
        alert(data.message || 'Gagal melakukan absen pulang');
      }
    } catch (err: any) {
      alert(err.message || 'Koneksi error saat absen pulang');
    } finally {
      setClockOutSubmitting(false);
    }
  };

  if (attendanceLoading && !attendanceStatus) {
    return (
      <div className="min-h-screen bg-stone-50 text-neutral-800 flex flex-col items-center justify-center p-6">
        <RefreshCw className="w-8 h-8 animate-spin text-[#1b4332] mb-3" />
        <p className="text-xs font-semibold text-neutral-600">Memuat OAK Mobile Portal...</p>
      </div>
    );
  }

  if (attendanceGateOpen) {
    return (
      <AttendanceGateScreen
        propertyId={propertyId}
        employeeId={currentUser.id}
        employeeName={currentUser.name}
        employeeDepartment={currentUser.department || 'Housekeeping'}
        employeeRole={currentUser.role}
        onAttendanceSuccess={() => {
          setAttendanceGateOpen(false);
          fetchAttendanceStatus();
          fetchTaskStats();
        }}
        onBypassForTesting={() => {
          setAttendanceGateOpen(false);
        }}
      />
    );
  }

  const activeTaskCount = taskStats.assigned + taskStats.in_progress;

  return (
    <div className="min-h-screen bg-stone-50 text-neutral-900 flex flex-col justify-between max-w-md mx-auto select-none shadow-xl">
      {/* Mode Pratinjau Banner */}
      {isPreview && (
        <div className="bg-amber-500 text-neutral-950 px-3 py-1.5 text-[11px] font-bold text-center flex items-center justify-between border-b border-amber-600 shadow-xs">
          <div className="flex items-center gap-1.5">
            <span className="bg-black/20 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-extrabold">MODE PRATINJAU</span>
            <span>Pratinjau Manajemen (Tidak Mengubah Status Absensi)</span>
          </div>
          {onBackToDesktop && (
            <button
              type="button"
              onClick={onBackToDesktop}
              className="text-[10px] underline hover:text-white font-semibold cursor-pointer"
            >
              Kembali
            </button>
          )}
        </div>
      )}

      {/* Compact Top Header (Dark Charcoal with Gold/Green Accent) */}
      <header className="sticky top-0 z-40 bg-[#1c2321] border-b border-neutral-800 px-3.5 py-2.5 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          {/* Left: Brand & Department Title */}
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-[#1b4332] text-[#d4af37] border border-[#d4af37]/30 flex items-center justify-center font-serif font-bold text-xs shrink-0 shadow-xs">
              {currentUser.name.charAt(0).toUpperCase()}
            </div>
            <div className="truncate">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-[#d4af37]">OAK HIMS</span>
                <span className="text-neutral-500 text-[10px]">•</span>
                <span className="text-xs font-bold text-white truncate">Housekeeping</span>
              </div>
              <p className="text-[10px] text-neutral-400 truncate">
                {currentUser.name} • {propertyName}
              </p>
            </div>
          </div>

          {/* Right: Quick Actions & Notifications */}
          <div className="flex items-center gap-1.5 shrink-0">
            {onBackToDesktop && !isPreview && (
              <button
                type="button"
                onClick={onBackToDesktop}
                className="px-2 py-1 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-300 hover:text-white text-[10px] font-semibold cursor-pointer"
              >
                Tutup
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveTab('NOTIF')}
              className="relative p-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-300 hover:text-white cursor-pointer"
              title="Notifikasi"
            >
              <Bell className="w-4 h-4" />
              {taskStats.checkout_urgent > 0 && (
                <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-rose-500 text-white text-[8px] font-bold flex items-center justify-center animate-pulse">
                  {taskStats.checkout_urgent}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Tab Content */}
      <main className="flex-1 p-3.5 overflow-y-auto">
        {activeTab === 'HOME' && (
          <div className="space-y-3.5 pb-20">
            {/* Welcome Summary Card (White Surface) */}
            <div className="bg-white border border-neutral-200/90 rounded-2xl p-4 shadow-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-[#1b4332] uppercase tracking-wider bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100">
                  Ringkasan Shift
                </span>
                <span className="text-[10px] font-mono text-neutral-500">
                  {currentTimeWib}
                </span>
              </div>
              <h3 className="font-serif font-bold text-base text-neutral-900 mb-1">
                Halo, {currentUser.name}
              </h3>
              <p className="text-xs text-neutral-600 leading-relaxed mb-3">
                {activeTaskCount > 0
                  ? `Terdapat ${activeTaskCount} tugas kamar aktif yang perlu dikerjakan hari ini.`
                  : 'Seluruh tugas kamar aktif hari ini telah selesai dibersihkan.'}
              </p>

              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-800 font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>
                  {attendanceStatus?.has_checked_in ? 'Absen Masuk: Terverifikasi' : 'Belum Absen'}
                </span>
              </div>
            </div>

            {/* Quick Metrics */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-white border border-neutral-200/90 rounded-xl p-2.5 shadow-2xs">
                <span className="text-lg font-bold text-amber-600">{taskStats.assigned}</span>
                <p className="text-[10px] font-medium text-neutral-500 mt-0.5">Antrean</p>
              </div>
              <div className="bg-white border border-neutral-200/90 rounded-xl p-2.5 shadow-2xs">
                <span className="text-lg font-bold text-blue-600">{taskStats.in_progress}</span>
                <p className="text-[10px] font-medium text-neutral-500 mt-0.5">Sedang Jalan</p>
              </div>
              <div className="bg-white border border-neutral-200/90 rounded-xl p-2.5 shadow-2xs">
                <span className="text-lg font-bold text-emerald-700">{taskStats.done_today}</span>
                <p className="text-[10px] font-medium text-neutral-500 mt-0.5">Selesai</p>
              </div>
            </div>

            {/* Quick Action Shortcuts */}
            <div className="space-y-2">
              <h4 className="text-[11px] font-bold text-neutral-500 uppercase tracking-wider px-1">
                Akses Operasional
              </h4>
              <button
                type="button"
                onClick={() => setActiveTab('TASKS')}
                className="w-full p-3.5 rounded-2xl bg-white border border-neutral-200/90 hover:border-[#1b4332]/40 flex items-center justify-between shadow-xs transition group text-left cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-50 text-[#1b4332] border border-emerald-200 flex items-center justify-center shrink-0">
                    <ClipboardList className="w-4.5 h-4.5" />
                  </div>
                  <div>
                    <p className="font-bold text-xs text-neutral-900">Buka Daftar Tugas Housekeeping</p>
                    <p className="text-[11px] text-neutral-500">Mulai pembersihan & verifikasi checkout</p>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-neutral-400 group-hover:text-neutral-700" />
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('NOTIF')}
                className="w-full p-3.5 rounded-2xl bg-white border border-neutral-200/90 hover:border-amber-400/40 flex items-center justify-between shadow-xs transition group text-left cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 flex items-center justify-center shrink-0">
                    <Bell className="w-4.5 h-4.5" />
                  </div>
                  <div>
                    <p className="font-bold text-xs text-neutral-900">Notifikasi & Permintaan FO</p>
                    <p className="text-[11px] text-neutral-500">Pemeriksaan checkout express & pesan tamu</p>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-neutral-400 group-hover:text-neutral-700" />
              </button>
            </div>
          </div>
        )}

        {activeTab === 'TASKS' && (
          <HousekeepingMobileCrewView
            propertyId={propertyId}
            crewName={currentUser.name}
            crewRole={currentUser.role}
            onRefreshStats={fetchTaskStats}
          />
        )}

        {activeTab === 'DEPT' && (
          <div className="space-y-3.5 pb-20">
            <div>
              <h3 className="font-serif font-bold text-base text-neutral-900">Departemen Hotel</h3>
              <p className="text-xs text-neutral-500">Pilih modul operasional sesuai peran kerja</p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setActiveTab('TASKS')}
                className="p-3.5 rounded-2xl bg-white border-2 border-[#1b4332] flex flex-col items-center text-center shadow-xs cursor-pointer"
              >
                <div className="w-10 h-10 rounded-xl bg-emerald-50 text-[#1b4332] flex items-center justify-center mb-2">
                  <Sparkles className="w-5 h-5" />
                </div>
                <h4 className="font-bold text-xs text-neutral-900">Housekeeping</h4>
                <p className="text-[10px] font-semibold text-emerald-700 mt-0.5">Aktif (Crew View)</p>
              </button>

              <div className="p-3.5 rounded-2xl bg-neutral-100/70 border border-neutral-200 flex flex-col items-center text-center opacity-70">
                <div className="w-10 h-10 rounded-xl bg-white text-neutral-400 flex items-center justify-center mb-2">
                  <Building2 className="w-5 h-5" />
                </div>
                <h4 className="font-semibold text-xs text-neutral-600">Maintenance</h4>
                <p className="text-[10px] text-neutral-400 mt-0.5">Segera Hadir</p>
              </div>

              <div className="p-3.5 rounded-2xl bg-neutral-100/70 border border-neutral-200 flex flex-col items-center text-center opacity-70">
                <div className="w-10 h-10 rounded-xl bg-white text-neutral-400 flex items-center justify-center mb-2">
                  <Building2 className="w-5 h-5" />
                </div>
                <h4 className="font-semibold text-xs text-neutral-600">Food & Beverage</h4>
                <p className="text-[10px] text-neutral-400 mt-0.5">Segera Hadir</p>
              </div>

              <div className="p-3.5 rounded-2xl bg-neutral-100/70 border border-neutral-200 flex flex-col items-center text-center opacity-70">
                <div className="w-10 h-10 rounded-xl bg-white text-neutral-400 flex items-center justify-center mb-2">
                  <Building2 className="w-5 h-5" />
                </div>
                <h4 className="font-semibold text-xs text-neutral-600">Front Office</h4>
                <p className="text-[10px] text-neutral-400 mt-0.5">Desktop PMS</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'NOTIF' && (
          <EmployeeNotificationCenter
            propertyId={propertyId}
            employeeName={currentUser.name}
          />
        )}

        {activeTab === 'PROFILE' && (
          <div className="space-y-3.5 pb-20">
            {/* Profile Card (White Surface) */}
            <div className="bg-white border border-neutral-200/90 rounded-2xl p-4 shadow-xs text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-[#1b4332] text-[#d4af37] font-serif font-bold text-xl mx-auto flex items-center justify-center shadow-xs">
                {currentUser.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <h3 className="font-serif font-bold text-base text-neutral-900">{currentUser.name}</h3>
                <p className="text-xs font-semibold text-[#1b4332]">{currentUser.department || 'Housekeeping'} • {currentUser.role}</p>
                <p className="text-[11px] text-neutral-500">{propertyName}</p>
              </div>

              {/* Attendance Status Summary */}
              <div className="p-3 rounded-xl bg-neutral-50 border border-neutral-200 text-left text-xs space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-neutral-600 font-medium">Status Absen Masuk:</span>
                  <span className="text-emerald-700 font-bold">
                    {attendanceStatus?.has_checked_in ? '✓ Sudah Masuk' : 'Belum Absen'}
                  </span>
                </div>
                {attendanceStatus?.today_check_in && (
                  <div className="flex items-center justify-between text-[11px] text-neutral-500">
                    <span>Waktu Masuk:</span>
                    <span className="font-mono text-neutral-800 font-semibold">
                      {new Date(attendanceStatus.today_check_in.server_recorded_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-neutral-600 font-medium">Status Absen Pulang:</span>
                  <span className="text-amber-700 font-bold">
                    {attendanceStatus?.has_checked_out ? '✓ Sudah Pulang' : 'Belum Pulang'}
                  </span>
                </div>
              </div>

              {/* Clock Out Action */}
              <button
                type="button"
                onClick={() => setShowClockOutModal(true)}
                className="w-full py-2.5 px-4 rounded-xl font-bold text-xs bg-amber-500 hover:bg-amber-600 text-neutral-950 shadow-xs transition flex items-center justify-center gap-2 cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>ABSEN PULANG (CLOCK-OUT)</span>
              </button>
            </div>

            {/* Desktop Mode & Logout */}
            <div className="space-y-2">
              {onBackToDesktop && (
                <button
                  type="button"
                  onClick={onBackToDesktop}
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-white border border-neutral-300 text-neutral-800 hover:bg-neutral-100 transition shadow-2xs cursor-pointer"
                >
                  Beralih ke Tampilan Desktop PMS
                </button>
              )}
              {onLogout && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 transition cursor-pointer"
                >
                  Keluar Akun (Logout)
                </button>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Clock Out Modal */}
      {showClockOutModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="w-full max-w-sm bg-white border-t sm:border border-neutral-200 rounded-t-3xl sm:rounded-2xl p-5 text-neutral-900 shadow-xl space-y-4">
            <div className="text-center space-y-1">
              <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mx-auto mb-2">
                <LogOut className="w-6 h-6" />
              </div>
              <h3 className="font-serif font-bold text-base text-neutral-900">Konfirmasi Absen Pulang</h3>
              <p className="text-xs text-neutral-500">Apakah Anda telah menyelesaikan seluruh shift kerja hari ini?</p>
            </div>

            {clockOutSuccess ? (
              <div className="py-4 text-center text-emerald-700 font-bold text-sm flex items-center justify-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <span>Absen Pulang Berhasil Dicatat!</span>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-neutral-700">Catatan / Keterangan (Opsional):</label>
                  <input
                    type="text"
                    value={clockOutReason}
                    onChange={(e) => setClockOutReason(e.target.value)}
                    placeholder="Contoh: Selesai shift sore, handover ke crew malam"
                    className="w-full py-2 px-3 rounded-xl bg-white border border-neutral-300 text-neutral-900 text-xs placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowClockOutModal(false)}
                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition cursor-pointer"
                  >
                    Batal
                  </button>
                  <button
                    type="button"
                    disabled={clockOutSubmitting}
                    onClick={handleClockOut}
                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-600 text-neutral-950 shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {clockOutSubmitting ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <LogOut className="w-4 h-4" />
                    )}
                    <span>Absen Pulang</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Bottom 5-Tab Touch-friendly Navigation (Compact Charcoal Bar) */}
      <nav className="sticky bottom-0 z-40 bg-[#1c2321] border-t border-neutral-800 px-2 py-1.5 shadow-2xl">
        <div className="grid grid-cols-5 gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('HOME')}
            className={`flex flex-col items-center justify-center py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'HOME'
                ? 'text-[#d4af37] font-bold'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Home className="w-4.5 h-4.5" />
            <span className="text-[9px] mt-0.5">Beranda</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('TASKS')}
            className={`relative flex flex-col items-center justify-center py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'TASKS'
                ? 'text-[#d4af37] font-bold'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <ClipboardList className="w-4.5 h-4.5" />
            <span className="text-[9px] mt-0.5">Tugas</span>
            {activeTaskCount > 0 && (
              <span className="absolute top-0.5 right-3 w-2 h-2 rounded-full bg-[#d4af37]" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('DEPT')}
            className={`flex flex-col items-center justify-center py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'DEPT'
                ? 'text-[#d4af37] font-bold'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Building2 className="w-4.5 h-4.5" />
            <span className="text-[9px] mt-0.5">Departemen</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('NOTIF')}
            className={`relative flex flex-col items-center justify-center py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'NOTIF'
                ? 'text-[#d4af37] font-bold'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Bell className="w-4.5 h-4.5" />
            <span className="text-[9px] mt-0.5">Notifikasi</span>
            {taskStats.checkout_urgent > 0 && (
              <span className="absolute top-0.5 right-3 w-2 h-2 rounded-full bg-rose-500 animate-ping" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('PROFILE')}
            className={`flex flex-col items-center justify-center py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'PROFILE'
                ? 'text-[#d4af37] font-bold'
                : 'text-neutral-400 hover:text-white'
            }`}
          >
            <User className="w-4.5 h-4.5" />
            <span className="text-[9px] mt-0.5">Profil</span>
          </button>
        </div>
      </nav>
    </div>
  );
};
