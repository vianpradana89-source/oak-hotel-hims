import React, { useEffect, useState } from 'react';
import { formatHotelBusinessDate } from './hotelDateDisplay';
import type { ShellPropertyItem, UserProfileContext } from './shellTypes';
import { OakLogo } from '../../design-system/OakLogo';

export interface GlobalOperationsBarProps {
  activeProperty: ShellPropertyItem | null;
  properties: ShellPropertyItem[];
  onSelectProperty: (propertyId: number) => void;
  onToggleSidebar: () => void;
  isSidebarCollapsed: boolean;
  currentUser?: UserProfileContext;
  onOpenPos?: () => void;
  onLogout?: () => void;
  propertyBranding?: {
    displayName?: string;
    logoUrl?: string | null;
  } | null;
}

export const GlobalOperationsBar: React.FC<GlobalOperationsBarProps> = ({
  activeProperty,
  properties,
  onSelectProperty,
  onToggleSidebar,
  isSidebarCollapsed,
  currentUser = {
    name: 'Vian Pradana',
    email: 'vian.pradana89@gmail.com',
    role: 'Owner',
    avatarInitials: 'VP',
  },
  onOpenPos,
  onLogout,
  propertyBranding,
}) => {
  const [currentDateTime, setCurrentDateTime] = useState(() => formatHotelBusinessDate());
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchNotice, setShowSearchNotice] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  // Update clock every minute
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentDateTime(formatHotelBusinessDate());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const displayPropertyName = propertyBranding?.displayName || activeProperty?.name || 'OAK HIMS';

  return (
    <header className="h-12 bg-[#131b24] text-slate-100 border-b border-slate-800 px-3 sm:px-4 flex items-center justify-between gap-3 shrink-0 select-none z-30 shadow-xs">
      {/* Left section: Sidebar toggle + Active property & Live business date */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer shrink-0"
          title={isSidebarCollapsed ? 'Buka Sidebar' : 'Ciutkan Sidebar'}
          aria-label="Toggle Sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Brand mark on mobile when sidebar is hidden */}
        <div className="lg:hidden flex items-center">
          <OakLogo variant="compact" size={28} customLogoUrl={propertyBranding?.logoUrl} />
        </div>

        {/* Active Property & Business Date Context */}
        <div className="hidden sm:flex items-center gap-2.5 min-w-0 border-l border-slate-700/60 pl-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" title="Sistem Aktif" />
            <span className="text-sm font-bold text-slate-100 tracking-tight truncate max-w-[140px] md:max-w-[200px]">
              {displayPropertyName}
            </span>
          </div>

          <span className="text-slate-600">·</span>

          <span className="text-xs font-medium text-slate-300 tracking-wide truncate">
            {currentDateTime}
          </span>
        </div>
      </div>

      {/* Center section: Shell-level Search (Explicitly documented as unavailable / prepared) */}
      <div className="flex-1 max-w-md mx-2 hidden md:block relative">
        <div className="relative flex items-center">
          <div className="absolute left-3 text-slate-400 pointer-events-none flex items-center">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            value={searchQuery}
            onFocus={() => setShowSearchNotice(true)}
            onBlur={() => setTimeout(() => setShowSearchNotice(false), 250)}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari tamu, BID, kamar... (Segera Hadir)"
            className="w-full h-8 pl-8 pr-12 text-xs bg-slate-900/90 text-slate-200 placeholder:text-slate-400 rounded-lg border border-slate-700/80 focus:outline-none focus:border-amber-500/70 focus:ring-1 focus:ring-amber-500/40 transition-colors"
          />
          <kbd className="absolute right-2 text-[10px] font-semibold text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">
            Ctrl K
          </kbd>
        </div>

        {/* Informative notice on search boundary */}
        {showSearchNotice && (
          <div className="absolute top-10 left-0 right-0 bg-[#1e293b] text-slate-200 text-xs p-2.5 rounded-lg border border-slate-700 shadow-xl z-50">
            <div className="flex items-center gap-2 text-amber-400 font-semibold mb-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Pencarian Global Terpadu (Segera Hadir)
            </div>
            <p className="text-[11px] text-slate-300">
              Pengindeksan global untuk pencarian lintas tamu, booking ID, nomor kamar, dan nomor HP sedang disiapkan pada backend.
            </p>
          </div>
        )}
      </div>

      {/* Right section: Property Switcher, POS quick link, Notifications, User profile */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Multi-Property Switcher Dropdown */}
        {properties.length > 1 && (
          <div className="relative">
            <select
              value={activeProperty?.id ?? ''}
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id) onSelectProperty(id);
              }}
              className="h-8 text-xs bg-slate-800 hover:bg-slate-750 text-slate-200 font-medium px-2.5 pr-7 rounded-lg border border-slate-700/80 focus:outline-none focus:border-amber-500/70 cursor-pointer appearance-none"
              title="Ganti Properti Aktif"
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id} className="bg-slate-900 text-slate-200">
                  {p.name}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        )}

        {/* Quick Action: POS */}
        {onOpenPos && (
          <button
            type="button"
            onClick={onOpenPos}
            className="hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg transition-colors cursor-pointer"
            title="Buka Point of Sale"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            <span>POS</span>
          </button>
        )}

        {/* Notification Bell */}
        <button
          type="button"
          className="relative p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          title="Notifikasi & Perhatian"
          aria-label="Notifications"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400" />
        </button>

        {/* User Profile Context & Popup */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 p-1 pl-1.5 text-xs text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <div className="w-6 h-6 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center justify-center font-bold text-xs">
              {currentUser.avatarInitials || 'VP'}
            </div>
            <span className="hidden md:inline-block font-medium truncate max-w-[100px]">
              {currentUser.name}
            </span>
            <svg className="w-3.5 h-3.5 text-slate-400 hidden md:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* User Profile Popup Menu */}
          {showUserMenu && (
            <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-xl border border-slate-200 py-2 text-slate-800 z-50 animate-in fade-in-0 duration-150">
              <div className="px-3 py-2 border-b border-slate-100">
                <p className="text-xs font-bold text-slate-900">{currentUser.name}</p>
                <p className="text-xs text-slate-500 truncate">{currentUser.email}</p>
                <span className="inline-block mt-1 text-xs font-semibold px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded">
                  {currentUser.role}
                </span>
              </div>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowUserMenu(false)}
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Profil Pengguna
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowUserMenu(false);
                    if (onLogout) onLogout();
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-2 cursor-pointer"
                >
                  <svg className="w-4 h-4 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Keluar (Logout)
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
