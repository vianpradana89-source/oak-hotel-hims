import React from 'react';
import type { MainNavKey, NavGroupDef, ShellPropertyItem } from './shellTypes';
import type { PropertyBrandingConfig } from '../propertySettings/propertyBrandingTypes';
import { OakLogo } from '../../design-system/OakLogo';
import { Tooltip } from '../../design-system/Tooltip';
import { useAuth } from '../auth/AuthContext';
import { isMenuAllowedForRole } from '../auth/permissions';

export interface AppSidebarProps {
  selectedMenu: MainNavKey;
  onSelectMenu: (menu: MainNavKey) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
  activeProperty: ShellPropertyItem | null;
  propertyBranding?: PropertyBrandingConfig | null;
  featureFlags?: Record<string, boolean>;
  customPermissionsMap?: Record<string, string[]> | null;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  selectedMenu,
  onSelectMenu,
  isCollapsed,
  onToggleCollapse,
  isMobileOpen,
  onCloseMobile,
  activeProperty,
  propertyBranding,
  featureFlags,
  customPermissionsMap,
}) => {
  const { user } = useAuth();
  const isHkEnabled = featureFlags ? featureFlags['housekeeping.enabled'] !== false : true;

  // OAK HIMS Grouped Navigation
  const navGroups: NavGroupDef[] = [
    {
      title: 'Front Office',
      items: [
        {
          key: 'Kalender',
          label: 'Kalender & Kamar',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          ),
        },
        {
          key: 'Transaksi',
          label: 'Transaksi & Folio',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
          ),
        },
        {
          key: 'Pelanggan',
          label: 'Tamu / CRM',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          ),
        },
      ],
    },
    {
      title: 'Departemen',
      items: [
        ...(isHkEnabled
          ? [
              {
                key: 'Housekeeping' as MainNavKey,
                label: 'Housekeeping',
                isFunctional: true,
                icon: (
                  <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                  </svg>
                ),
              },
            ]
          : []),
        {
          key: 'HRD' as MainNavKey,
          label: 'HRD',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          ),
        },
        {
          key: 'POS' as MainNavKey,
          label: 'POS',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          ),
        },
      ],
    },
    {
      title: 'Manajemen',
      items: [
        {
          key: 'Master Kamar' as MainNavKey,
          label: 'Master Kamar',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          ),
        },
        {
          key: 'Master Produk' as MainNavKey,
          label: 'Master Produk',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          ),
        },
        {
          key: 'Laporan',
          label: 'Laporan & Okupansi',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          ),
        },
        {
          key: 'Employee Mobile' as MainNavKey,
          label: 'Employee Mobile',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
            </svg>
          ),
        },
        {
          key: 'Pengaturan',
          label: 'Pengaturan Properti',
          isFunctional: true,
          icon: (
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          ),
        },
      ],
    },
  ];

  const filteredGroups: NavGroupDef[] = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isMenuAllowedForRole(item.key as MainNavKey, user?.role, customPermissionsMap))
    }))
    .filter((group) => group.items.length > 0);

  const renderNavContent = (isDrawer = false) => (
    <div className="flex flex-col h-full select-none">
      {/* Brand Header */}
      <div className={`h-14 flex items-center border-b border-slate-800/80 shrink-0 ${isCollapsed && !isDrawer ? 'justify-center px-2' : 'px-4 justify-between'}`}>
        <div className="min-w-0">
          <OakLogo
            variant={isCollapsed && !isDrawer ? 'compact' : 'full'}
            size={isCollapsed && !isDrawer ? 34 : 32}
            brandTitle={propertyBranding?.displayName || activeProperty?.name || 'OAK HIMS'}
            subtitle={activeProperty ? (propertyBranding?.tagline || 'Hotel Integrated System') : undefined}
            customLogoUrl={isCollapsed && !isDrawer ? propertyBranding?.compactLogoUrl : propertyBranding?.logoUrl}
            accentColor={propertyBranding?.accentColor}
          />
        </div>

        {isDrawer && (
          <button
            type="button"
            onClick={onCloseMobile}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
            aria-label="Tutup Menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Navigation Links */}
      <div className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
        {filteredGroups.map((group) => (
          <div key={group.title} className="space-y-1">
            {(!isCollapsed || isDrawer) && (
              <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {group.title}
              </div>
            )}
            {group.items.map((item) => {
              const isActive = selectedMenu === item.key;
              const buttonElement = (
                <button
                  type="button"
                  key={item.key}
                  data-nav-key={item.key}
                  disabled={!item.isFunctional}
                  onClick={() => {
                    if (item.isFunctional) {
                      onSelectMenu(item.key as MainNavKey);
                      if (isDrawer) onCloseMobile();
                    }
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed text-left relative ${
                    isCollapsed && !isDrawer ? 'justify-center' : ''
                  } ${
                    isActive
                      ? 'bg-gradient-to-r from-[#1b4332] to-[#22543d] text-white font-semibold shadow-xs'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  {/* Active notch indicator */}
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-1 bg-[#d4af37] rounded-r" />
                  )}
                  {item.icon}
                  {(!isCollapsed || isDrawer) && (
                    <span className="truncate flex-1">{item.label}</span>
                  )}
                  {(!isCollapsed || isDrawer) && item.badge && (
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300 font-semibold">
                      {item.badge}
                    </span>
                  )}
                </button>
              );

              if (isCollapsed && !isDrawer) {
                return (
                  <Tooltip key={item.key} content={item.label} position="right">
                    {buttonElement}
                  </Tooltip>
                );
              }

              return buttonElement;
            })}
          </div>
        ))}
      </div>

      {/* Footer Collapse Toggle on Desktop */}
      {!isDrawer && (
        <div className="p-2 border-t border-slate-800/80 shrink-0 hidden lg:block">
          <button
            type="button"
            onClick={onToggleCollapse}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer ${
              isCollapsed ? 'justify-center' : ''
            }`}
            title={isCollapsed ? 'Perluas Sidebar' : 'Ciutkan Sidebar'}
          >
            <svg
              className={`w-4 h-4 transition-transform duration-200 ${isCollapsed ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
            {!isCollapsed && <span className="font-medium">Ciutkan Menu</span>}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={`hidden lg:flex flex-col bg-[#131b24] text-slate-100 border-r border-slate-800 transition-all duration-200 shrink-0 z-20 h-full overflow-hidden ${
          isCollapsed ? 'w-16' : 'w-60'
        }`}
      >
        {renderNavContent(false)}
      </aside>

      {/* Mobile / Tablet Drawer */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity animate-in fade-in-0 duration-200"
            onClick={onCloseMobile}
            aria-hidden="true"
          />

          {/* Drawer Container */}
          <aside className="relative w-64 max-w-[80vw] bg-[#131b24] text-slate-100 h-full shadow-2xl flex flex-col z-10 animate-in slide-in-from-left duration-200">
            {renderNavContent(true)}
          </aside>
        </div>
      )}
    </>
  );
};
