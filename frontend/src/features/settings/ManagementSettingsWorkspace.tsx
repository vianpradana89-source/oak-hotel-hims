import React, { useState, useEffect, useCallback } from 'react';
import { getFallbackPropertyBranding, type PropertyBrandingConfig } from '../propertySettings/propertyBrandingTypes';
import { PropertyBrandingSettings } from '../propertySettings/PropertyBrandingSettings';
import { HousekeepingSettingsTab } from '../housekeeping/HousekeepingSettingsTab';
import { AttendanceSettingsTab } from './AttendanceSettingsTab';
import { HrdRolePolicyTab } from './HrdRolePolicyTab';
import { FrontOfficeSettingsTab } from './FrontOfficeSettingsTab';
import { PropertyManagementTab } from './PropertyManagementTab';
import { RolePermissionsMatrixTab } from './RolePermissionsMatrixTab';
import type { PropertyHousekeepingSettings, ChecklistTemplate } from '../housekeeping/housekeepingTypes';

export type SettingsCategoryKey =
  | 'property'
  | 'branding'
  | 'housekeeping'
  | 'features'
  | 'hr'
  | 'front_office'
  | 'pos'
  | 'finance'
  | 'purchasing'
  | 'events'
  | 'general_affair'
  | 'marketing'
  | 'users_permissions'
  | 'notifications'
  | 'integrations'
  | 'audit_system';

interface SettingsCategoryDef {
  key: SettingsCategoryKey;
  label: string;
  description: string;
  status: 'ACTIVE' | 'CONFIGURED' | 'ROADMAP';
  badgeLabel?: string;
  isImplemented: boolean;
  icon: (props: { className?: string }) => React.ReactNode;
}

export interface ManagementSettingsWorkspaceProps {
  propertyId: number;
  activeProperty: any;
  activeBranding: PropertyBrandingConfig | null;
  onSaveBranding: (branding: PropertyBrandingConfig) => Promise<void>;
  employees: any[];
  payroll: any[];
  initialCategory?: SettingsCategoryKey;
  apiBaseUrl?: string;
  onSelectProperty?: (propertyId: number) => void;
  onRefreshProperties?: () => void;
  onPermissionsUpdated?: (newMatrixMap: Record<string, string[]>) => void;
}

export const ManagementSettingsWorkspace: React.FC<ManagementSettingsWorkspaceProps> = ({
  propertyId,
  activeProperty,
  activeBranding,
  onSaveBranding,
  employees,
  payroll,
  initialCategory = 'housekeeping',
  apiBaseUrl = '/api',
  onSelectProperty,
  onRefreshProperties,
  onPermissionsUpdated
}) => {
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryKey>(initialCategory);
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({});
  const [hkSettings, setHkSettings] = useState<PropertyHousekeepingSettings | null>(null);
  const [hkTemplates, setHkTemplates] = useState<ChecklistTemplate[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [hrSubTab, setHrSubTab] = useState<'STAFF' | 'ATTENDANCE' | 'ROLE_POLICY'>('STAFF');

  // Sync initialCategory if changed externally (e.g. from HK shortcut)
  useEffect(() => {
    if (initialCategory) {
      setActiveCategory(initialCategory);
    }
  }, [initialCategory]);

  // Fetch feature flags, HK settings, and HK templates
  const loadSettingsData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [featuresRes, hkSetRes, hkTplRes] = await Promise.all([
        fetch(`${apiBaseUrl}/properties/${propertyId}/features`),
        fetch(`${apiBaseUrl}/housekeeping/settings?property_id=${propertyId}`),
        fetch(`${apiBaseUrl}/housekeeping/templates?property_id=${propertyId}`)
      ]);

      if (featuresRes.ok) {
        const featJson = await featuresRes.json();
        setFeatureFlags(featJson.data || {});
      }
      if (hkSetRes.ok) {
        const setJson = await hkSetRes.json();
        setHkSettings(setJson.data || null);
      }
      if (hkTplRes.ok) {
        const tplJson = await hkTplRes.json();
        setHkTemplates(tplJson.data || []);
      }
    } catch (err: any) {
      console.error('Failed to load settings data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, propertyId]);

  useEffect(() => {
    loadSettingsData();
  }, [loadSettingsData]);

  // Handle Feature Flag Toggle
  const handleUpdateFeatureFlag = async (featureKey: string, enabled: boolean) => {
    try {
      const res = await fetch(`${apiBaseUrl}/properties/${propertyId}/features/${featureKey}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Gagal mengubah status fitur');
      }
      setFeatureFlags((prev) => ({ ...prev, [featureKey]: enabled }));
      setFeedback({
        type: 'success',
        message: `Status fitur '${featureKey}' berhasil disimpan (${enabled ? 'Aktif' : 'Nonaktif'}).`
      });
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Gagal memperbarui konfigurasi fitur.'
      });
      throw err;
    }
  };

  // Handle Save Housekeeping Operational Settings
  const handleSaveHkSettings = async (patch: Partial<PropertyHousekeepingSettings>) => {
    try {
      const res = await fetch(`${apiBaseUrl}/housekeeping/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          ...patch
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.message || 'Gagal menyimpan pengaturan housekeeping');
      }
      if (json.data) {
        setHkSettings(json.data);
      }
      setFeedback({
        type: 'success',
        message: 'Pengaturan housekeeping berhasil disimpan'
      });
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Gagal menyimpan pengaturan housekeeping'
      });
      throw err;
    }
  };

  const categories: SettingsCategoryDef[] = [
    {
      key: 'housekeeping',
      label: 'Housekeeping',
      description: 'Master toggle, sub-fitur operasional, kebijakan inspeksi, dan checklist template.',
      status: 'ACTIVE',
      badgeLabel: 'Terkonfigurasi',
      isImplemented: true,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
        </svg>
      )
    },
    {
      key: 'features',
      label: 'Modul & Fitur',
      description: 'Matriks kontrol modul sistem, toggle fungsional, dan kesiapan arsitektur multi-tenant.',
      status: 'ACTIVE',
      badgeLabel: 'Authoritative',
      isImplemented: true,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
        </svg>
      )
    },
    {
      key: 'branding',
      label: 'Branding & Tampilan',
      description: 'Logo properti, palet visual, aksen hotel, dan tampilan cetak dokumen.',
      status: 'ACTIVE',
      badgeLabel: 'Aktif',
      isImplemented: true,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
        </svg>
      )
    },
    {
      key: 'property',
      label: 'Properti & Identitas',
      description: 'Profil hotel, kode properti, zona waktu Asia/Jakarta, dan kontak resmi.',
      status: 'ACTIVE',
      badgeLabel: 'Aktif',
      isImplemented: true,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
      )
    },
    {
      key: 'hr',
      label: 'HRD & Karyawan',
      description: 'Daftar staf hotel, jabatan operasional, dan parameter payroll internal.',
      status: 'ACTIVE',
      badgeLabel: `${employees.length} Staf`,
      isImplemented: true,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      )
    },
    {
      key: 'front_office',
      label: 'Front Office',
      description: 'Pengaturan Reservasi Cepat, Master Durasi Day Use, dan alur operasional Front Desk.',
      status: 'ACTIVE',
      badgeLabel: 'Aktif',
      isImplemented: true,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      )
    },
    {
      key: 'pos',
      label: 'POS & F&B',
      description: 'Pengaturan outlet restoran, printer kasir, dan integrasi bill-to-room.',
      status: 'CONFIGURED',
      badgeLabel: 'Terkonfigurasi',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      )
    },
    {
      key: 'finance',
      label: 'Keuangan & Akuntansi',
      description: 'Chart of Accounts, metode pembayaran, pajak PB1 & service charge.',
      status: 'CONFIGURED',
      badgeLabel: 'Terkonfigurasi',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    },
    {
      key: 'events',
      label: 'Events & Banquet',
      description: 'Konfigurasi ruang pertemuan, paket banquet, dan banquet event order (BEO).',
      status: 'ROADMAP',
      badgeLabel: 'Roadmap',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      )
    },
    {
      key: 'purchasing',
      label: 'Purchasing & Gudang',
      description: 'Vendor master, purchase order approval, dan kontrol persediaan.',
      status: 'ROADMAP',
      badgeLabel: 'Roadmap',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      )
    },
    {
      key: 'general_affair',
      label: 'General Affair & Maintenance',
      description: 'Pemeliharaan aset, work order engineering, dan inventaris fasilitas.',
      status: 'ROADMAP',
      badgeLabel: 'Roadmap',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      )
    },
    {
      key: 'marketing',
      label: 'Marketing / CRM',
      description: 'Segmentasi tamu, tier loyalitas, channel manager OTA, dan promo voucher.',
      status: 'CONFIGURED',
      badgeLabel: 'Terkonfigurasi',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
        </svg>
      )
    },
    {
      key: 'users_permissions',
      label: 'Pengguna & Hak Akses',
      description: 'Role-based access control (RBAC), matriks perizinan role, dan user audit log.',
      status: 'ACTIVE',
      badgeLabel: 'Aktif',
      isImplemented: true,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      )
    },
    {
      key: 'notifications',
      label: 'Notifikasi & Alerts',
      description: 'Pengaturan alert operasional, SMS/WA gateway, dan email invoice.',
      status: 'CONFIGURED',
      badgeLabel: 'Terkonfigurasi',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
      )
    },
    {
      key: 'integrations',
      label: 'Integrasi Eksternal',
      description: 'Channel manager, payment gateway QRIS/Virtual Account, dan keycard encoder.',
      status: 'ROADMAP',
      badgeLabel: 'Roadmap',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      )
    },
    {
      key: 'audit_system',
      label: 'Audit & Sistem',
      description: 'Log transaksi, jejak perubahan status kamar, data integrity check, dan database health.',
      status: 'ACTIVE',
      badgeLabel: 'System Active',
      isImplemented: false,
      icon: ({ className }) => (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      )
    }
  ];

  return (
    <div className="space-y-5">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-5 rounded-2xl border border-neutral-200/90 shadow-xs">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-neutral-900 tracking-tight">
              Pusat Pengaturan Properti & Manajemen
            </h1>
            <span className="px-2.5 py-0.5 text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full">
              Authoritative Central Settings
            </span>
          </div>
          <p className="text-xs text-neutral-500 mt-1">
            Satu pusat konfigurasi otoritatif untuk modul, operasional Housekeeping, branding visual, dan parameter properti.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadSettingsData()}
            className="px-3 py-1.5 text-xs font-semibold text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-xl transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <svg className="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Segarkan
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-xl text-xs font-semibold border flex items-center justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-neutral-400 hover:text-neutral-700 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {/* Main Settings Layout: Sidebar Categories + Content Area */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
        {/* Category Navigation Panel */}
        <div className="bg-white rounded-2xl border border-neutral-200/90 p-3 space-y-1 shadow-xs">
          <div className="px-3 py-2 text-[11px] font-bold text-neutral-400 uppercase tracking-wider">
            Kategori Pengaturan
          </div>

          <div className="space-y-1 max-h-[70vh] overflow-y-auto pr-1">
            {categories.map((cat) => {
              const isSelected = activeCategory === cat.key;
              return (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setActiveCategory(cat.key)}
                  className={`w-full text-left p-2.5 rounded-xl transition-all flex items-center justify-between cursor-pointer ${
                    isSelected
                      ? 'bg-emerald-800 text-white shadow-xs font-semibold'
                      : 'hover:bg-neutral-100 text-neutral-700'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <cat.icon className={`w-4 h-4 shrink-0 ${isSelected ? 'text-white' : 'text-neutral-500'}`} />
                    <span className="text-xs truncate">{cat.label}</span>
                  </div>

                  {cat.badgeLabel && (
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${
                        isSelected
                          ? 'bg-emerald-900/60 text-emerald-100'
                          : cat.status === 'ACTIVE'
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : cat.status === 'CONFIGURED'
                          ? 'bg-blue-50 text-blue-700 border border-blue-200'
                          : 'bg-neutral-100 text-neutral-500'
                      }`}
                    >
                      {cat.badgeLabel}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Category Detail / Workspace Content */}
        <div className="lg:col-span-3 space-y-5">
          {/* Active Category: Housekeeping */}
          {activeCategory === 'housekeeping' && (
            <HousekeepingSettingsTab
              propertyId={propertyId}
              settings={hkSettings}
              templates={hkTemplates}
              featureFlags={featureFlags}
              onSaveSettings={handleSaveHkSettings}
              onUpdateFeatureFlag={handleUpdateFeatureFlag}
              isLoading={isLoading}
            />
          )}

          {/* Active Category: Modul & Fitur (Feature Flags Matrix) */}
          {activeCategory === 'features' && (
            <div className="space-y-6">
              <div className="bg-white rounded-2xl border border-neutral-200/90 overflow-hidden shadow-xs">
                <div className="px-5 py-4 bg-neutral-50/80 border-b border-neutral-200/90 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-neutral-900">Matriks Modul & Sub-Fitur Properti</h3>
                    <p className="text-xs text-neutral-500">
                      Authoritative Property Scope: Mengaktifkan atau menonaktifkan kapabilitas domain sistem.
                    </p>
                  </div>
                  <span className="px-2.5 py-0.5 text-xs font-semibold bg-emerald-100 text-emerald-800 rounded-full">
                    Property ID: {propertyId}
                  </span>
                </div>

                <div className="p-5 space-y-6">
                  {/* Module Group: Housekeeping */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between pb-2 border-b border-neutral-200">
                      <div>
                        <div className="text-xs font-bold text-neutral-900 uppercase tracking-wider">
                          Modul Housekeeping & Tata Graha
                        </div>
                        <div className="text-xs text-neutral-500">
                          Operasional kebersihan kamar, turnover, inspeksi, dan alur layanan Front Desk.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleUpdateFeatureFlag('housekeeping.enabled', featureFlags['housekeeping.enabled'] === false)}
                        className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                          featureFlags['housekeeping.enabled'] !== false
                            ? 'bg-emerald-700 text-white'
                            : 'bg-rose-600 text-white'
                        }`}
                      >
                        {featureFlags['housekeeping.enabled'] !== false ? 'MODUL AKTIF' : 'MODUL NONAKTIF'}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                      {[
                        { key: 'housekeeping.room_operations', label: 'Operasi & Pembersihan Kamar', desc: 'Auto-turnover cleaning & stayover tasks' },
                        { key: 'housekeeping.checkout_inspection', label: 'Pemeriksaan Checkout (FO Room Check)', desc: 'Inspeksi minibar/kerusakan saat tamu checkout' },
                        { key: 'housekeeping.final_inspection', label: 'Final Inspeksi Supervisor', desc: 'Verifikasi kesiapan kamar sebelum status INSPECTED' },
                        { key: 'housekeeping.service_requests', label: 'Permintaan Layanan Tamu (FO)', desc: 'Pengantaran amenities & extra items' },
                        { key: 'housekeeping.department_tasks', label: 'Tugas Internal Departemen', desc: 'Tugas housekeeping non-kamar & shifting' },
                      ].map((sub) => {
                        const isEnabled = featureFlags['housekeeping.enabled'] !== false && featureFlags[sub.key] !== false;
                        return (
                          <div
                            key={sub.key}
                            className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${
                              featureFlags['housekeeping.enabled'] === false
                                ? 'bg-neutral-50 border-neutral-200 opacity-60'
                                : isEnabled
                                ? 'bg-emerald-50/40 border-emerald-200'
                                : 'bg-neutral-50 border-neutral-200'
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-bold text-neutral-800">{sub.label}</div>
                              <div className="text-[11px] text-neutral-500 truncate">{sub.desc}</div>
                            </div>
                            <button
                              type="button"
                              disabled={featureFlags['housekeeping.enabled'] === false}
                              onClick={() => handleUpdateFeatureFlag(sub.key, featureFlags[sub.key] === false)}
                              className={`px-2.5 py-1 text-xs font-bold rounded-lg shrink-0 cursor-pointer ${
                                isEnabled
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                  : 'bg-neutral-200 text-neutral-600'
                              }`}
                            >
                              {isEnabled ? 'ON' : 'OFF'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Module Group: Core PMS Modules */}
                  <div className="space-y-3 pt-4 border-t border-neutral-200">
                    <div className="text-xs font-bold text-neutral-900 uppercase tracking-wider">
                      Modul Operasional Utama (Core Modules)
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {[
                        { key: 'front_office.enabled', label: 'Front Office & Reservasi', desc: 'Kalender kamar, check-in, check-out, tape chart' },
                        { key: 'pos.enabled', label: 'Point of Sale (POS)', desc: 'Restoran, kafe, dan room service billing' },
                        { key: 'finance.enabled', label: 'Keuangan & Akuntansi', desc: 'Folio billing, jurnal otomatis, COA' },
                        { key: 'hrd.enabled', label: 'HRD & Payroll', desc: 'Manajemen karyawan & slip gaji' },
                        { key: 'marketing.enabled', label: 'Marketing & CRM', desc: 'Database tamu & loyalty program' },
                      ].map((mod) => {
                        const isEnabled = featureFlags[mod.key] !== false;
                        return (
                          <div
                            key={mod.key}
                            className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${
                              isEnabled ? 'bg-emerald-50/30 border-emerald-200' : 'bg-neutral-50 border-neutral-200'
                            }`}
                          >
                            <div>
                              <div className="text-xs font-bold text-neutral-800">{mod.label}</div>
                              <div className="text-[11px] text-neutral-500">{mod.desc}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleUpdateFeatureFlag(mod.key, !isEnabled)}
                              className={`px-2.5 py-1 text-xs font-bold rounded-lg shrink-0 cursor-pointer ${
                                isEnabled
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                  : 'bg-neutral-200 text-neutral-600'
                              }`}
                            >
                              {isEnabled ? 'ON' : 'OFF'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Module Group: Roadmap Modules */}
                  <div className="space-y-3 pt-4 border-t border-neutral-200">
                    <div className="flex items-center gap-2">
                      <div className="text-xs font-bold text-neutral-500 uppercase tracking-wider">
                        Modul Tambahan & Ekspansi (Roadmap Architecture)
                      </div>
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800 rounded">
                        Persiapan Schema V3
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {[
                        { label: 'Laundry & Linen Wash', key: 'housekeeping.laundry' },
                        { label: 'Linen Inventory Tracking', key: 'housekeeping.linen_inventory' },
                        { label: 'Lost & Found System', key: 'housekeeping.lost_and_found' },
                        { label: 'Events & Banquet (BEO)', key: 'events_banquet.enabled' },
                        { label: 'Purchasing & Logistik', key: 'purchasing.enabled' },
                        { label: 'General Affair Maintenance', key: 'general_affair.enabled' },
                      ].map((item) => (
                        <div key={item.key} className="p-3 bg-neutral-50 rounded-xl border border-dashed border-neutral-300 text-xs flex items-center justify-between">
                          <span className="font-semibold text-neutral-600">{item.label}</span>
                          <span className="text-[10px] px-2 py-0.5 bg-neutral-200 text-neutral-600 rounded">
                            Off (Roadmap)
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Active Category: Branding & Tampilan */}
          {activeCategory === 'branding' && propertyId !== null && (
            <PropertyBrandingSettings
              propertyId={propertyId}
              initialBranding={activeBranding || getFallbackPropertyBranding(propertyId, activeProperty?.name, activeProperty?.property_code)}
              onSaveBranding={onSaveBranding}
            />
          )}

          {/* Active Category: Properti & Identitas */}
          {activeCategory === 'property' && (
            <PropertyManagementTab
              currentPropertyId={propertyId}
              onSelectProperty={onSelectProperty}
              onPropertiesUpdated={() => {
                if (onRefreshProperties) onRefreshProperties();
              }}
              apiBaseUrl={apiBaseUrl}
            />
          )}

          {/* Active Category: HR & Karyawan */}
          {activeCategory === 'hr' && (
            <div className="space-y-4">
              {/* HR Sub-Tabs */}
              <div className="flex items-center gap-2 border-b border-neutral-200 pb-2">
                <button
                  type="button"
                  onClick={() => setHrSubTab('STAFF')}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
                    hrSubTab === 'STAFF'
                      ? 'bg-[#1b4332] text-white shadow'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                  }`}
                >
                  Daftar Staf & Payroll ({employees.length})
                </button>
                <button
                  type="button"
                  onClick={() => setHrSubTab('ATTENDANCE')}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
                    hrSubTab === 'ATTENDANCE'
                      ? 'bg-[#1b4332] text-white shadow'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                  }`}
                >
                  Gerbang Absensi & Lokasi
                </button>
                <button
                  type="button"
                  onClick={() => setHrSubTab('ROLE_POLICY')}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
                    hrSubTab === 'ROLE_POLICY'
                      ? 'bg-[#1b4332] text-white shadow'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                  }`}
                >
                  Account & Role Policy (Owner & GM)
                </button>
              </div>

              {hrSubTab === 'ATTENDANCE' ? (
                <AttendanceSettingsTab propertyId={propertyId} />
              ) : hrSubTab === 'ROLE_POLICY' ? (
                <HrdRolePolicyTab propertyId={propertyId} />
              ) : (
                <div className="bg-white border border-neutral-200/90 rounded-2xl shadow-xs p-5 space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
                    <div>
                      <h3 className="font-bold text-sm text-neutral-900">Daftar Karyawan & Payroll Internal</h3>
                      <p className="text-xs text-neutral-500">Staf terdaftar pada properti ini.</p>
                    </div>
                    <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-full font-semibold">
                      {employees.length} Karyawan
                    </span>
                  </div>

                  <div className="space-y-2">
                    {employees.map((employee: any) => (
                      <div key={employee.id} className="border border-neutral-200/80 rounded-xl p-3 text-xs bg-[#faf9f6] flex items-center justify-between">
                        <div>
                          <div className="font-bold text-neutral-900">{employee.full_name}</div>
                          <div className="text-neutral-500 mt-0.5">{employee.position}</div>
                        </div>
                        <div className="text-right">
                          <span className="text-[11px] text-neutral-400 block">Net payroll:</span>
                          <span className="font-mono font-bold text-neutral-800">
                            Rp {Number(payroll.find((p: any) => p.employee_id === employee.id)?.net_salary || 0).toLocaleString('id-ID')}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Active Category: Front Office */}
          {activeCategory === 'front_office' && (
            <FrontOfficeSettingsTab propertyId={propertyId} apiBaseUrl={apiBaseUrl} />
          )}

          {/* Active Category: Users & Role Permissions Matrix */}
          {activeCategory === 'users_permissions' && (
            <RolePermissionsMatrixTab
              propertyId={propertyId}
              onPermissionsUpdated={onPermissionsUpdated}
            />
          )}

          {/* Other Categories: Roadmap / Configured Placeholders */}
          {!['housekeeping', 'features', 'branding', 'property', 'hr', 'front_office', 'users_permissions'].includes(activeCategory) && (
            <div className="bg-white rounded-2xl border border-neutral-200/90 p-8 text-center space-y-3 shadow-xs">
              <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center mx-auto">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
              </div>
              <h3 className="text-base font-bold text-neutral-900">
                Pengaturan {categories.find((c) => c.key === activeCategory)?.label}
              </h3>
              <p className="text-xs text-neutral-500 max-w-md mx-auto">
                {categories.find((c) => c.key === activeCategory)?.description}
              </p>
              <div className="pt-2">
                <span className="px-3 py-1 text-xs font-semibold bg-neutral-100 text-neutral-600 rounded-full">
                  Status: {categories.find((c) => c.key === activeCategory)?.badgeLabel || 'Roadmap'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
