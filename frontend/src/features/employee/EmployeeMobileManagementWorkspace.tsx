import React from 'react';

interface EmployeeMobileManagementWorkspaceProps {
  propertyId: number;
  propertyName?: string;
  onOpenMobilePortal?: () => void;
}

export const EmployeeMobileManagementWorkspace: React.FC<EmployeeMobileManagementWorkspaceProps> = ({
  propertyName,
  onOpenMobilePortal
}) => {
  const mobilePortalUrl = `${window.location.origin}/employee`;
  const hkPortalUrl = `${window.location.origin}/housekeeping`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-[#1b4332]/10 text-[#1b4332] border border-[#1b4332]/20">
              MANAJEMEN
            </span>
            <h1 className="text-xl font-bold font-serif text-slate-900">
              Employee Mobile — Administrasi & Pengaturan Portal Karyawan
            </h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Pengaturan tautan akses portal mobile kru operasional (Housekeeping, Front Office, F&B) untuk {propertyName || 'OAK Hotel'}.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onOpenMobilePortal && (
            <button
              type="button"
              onClick={onOpenMobilePortal}
              className="px-4 py-2.5 rounded-xl bg-[#1b4332]/10 hover:bg-[#1b4332]/20 text-[#1b4332] text-xs font-bold border border-[#1b4332]/30 transition flex items-center gap-2 cursor-pointer"
            >
              <svg className="w-4 h-4 text-[#1b4332]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span>Pratinjau Desktop</span>
            </button>
          )}
          <a
            href="/housekeeping"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2.5 rounded-xl bg-[#1b4332] hover:bg-[#143326] text-white text-xs font-bold transition shadow-xs flex items-center gap-2 cursor-pointer"
          >
            <svg className="w-4 h-4 text-[#d4af37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            <span>Buka Housekeeping Mobile</span>
          </a>
          <a
            href="/employee"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold border border-slate-300 transition flex items-center gap-2 cursor-pointer"
          >
            <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            <span>Buka Mobile Portal Global</span>
          </a>
        </div>
      </div>

      {/* Grid of Workstream Features */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-[#1b4332]">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 className="font-bold text-sm text-slate-900">Workstream 1: Cleaning</h3>
          <p className="text-xs text-slate-600 leading-relaxed">
            Kamar fisik yang membutuhkan pembersihan operasional (VACANT_DIRTY). Terintegrasi langsung dengan status operasional kamar dan invariant 1 task aktif per kamar.
          </p>
          <div className="pt-2 border-t border-slate-100 text-[11px] text-emerald-800 font-semibold">
            ✓ Otomatis muncul saat kamar kotor
          </div>
        </div>

        <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-3">
          <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <h3 className="font-bold text-sm text-slate-900">Workstream 2: Checkout</h3>
          <p className="text-xs text-slate-600 leading-relaxed">
            Permintaan pemeriksaan kamar saat tamu checkout dari Front Office. Dilengkapi checklist konfigurasi cepat dan pelaporan temuan minibar/kerusakan.
          </p>
          <div className="pt-2 border-t border-slate-100 text-[11px] text-amber-800 font-semibold">
            ✓ Notifikasi instan ke Dashboard FO (HK AMAN / TEMUAN)
          </div>
        </div>

        <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-700">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h3 className="font-bold text-sm text-slate-900">Workstream 3: Task (Manual)</h3>
          <p className="text-xs text-slate-600 leading-relaxed">
            Tugas operasional manajemen (HOD / Supervisor, GM, Owner) seperti deep clean, persiapan event, pengecekan linen, dan maintenance ringan.
          </p>
          <div className="pt-2 border-t border-slate-100 text-[11px] text-indigo-800 font-semibold">
            ✓ Otoritas pembuat tugas tervalidasi di backend
          </div>
        </div>
      </div>

      {/* Access URL Cards */}
      <div className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-4">
        <h3 className="font-bold text-sm text-slate-900">Tautan Akses Cepat Smartphone Kru</h3>
        <p className="text-xs text-slate-500">
          Kru hotel dapat mengakses portal melalui browser handphone tanpa instalasi aplikasi native:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <div className="font-bold text-slate-900">Portal Housekeeping Langsung:</div>
            <div className="p-2 rounded-lg bg-white border border-slate-300 font-mono text-[11px] text-slate-700 break-all select-all">
              {hkPortalUrl}
            </div>
            <p className="text-[11px] text-slate-500">
              Khusus petugas kamar & supervisor Housekeeping.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <div className="font-bold text-slate-900">Portal Global Mobile Karyawan:</div>
            <div className="p-2 rounded-lg bg-white border border-slate-300 font-mono text-[11px] text-slate-700 break-all select-all">
              {mobilePortalUrl}
            </div>
            <p className="text-[11px] text-slate-500">
              Absensi, Jadwal Shift, Notifikasi, dan Menu Departemen.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
