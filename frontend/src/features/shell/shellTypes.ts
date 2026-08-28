import React from 'react';

export type MainNavKey =
  | 'Kalender'
  | 'Transaksi'
  | 'Housekeeping'
  | 'HRD'
  | 'Mobile Portal'
  | 'Employee Mobile'
  | 'Laporan'
  | 'Produk & Inventori'
  | 'Pelanggan'
  | 'Pengaturan';

export interface NavItemDef {
  key: MainNavKey | string;
  label: string;
  icon: React.ReactNode;
  badge?: string | number;
  badgeVariant?: 'neutral' | 'primary' | 'gold' | 'success' | 'warning' | 'danger' | 'info';
  isFunctional: boolean;
  disabledTooltip?: string;
}

export interface NavGroupDef {
  title: string;
  items: NavItemDef[];
}

export interface UserProfileContext {
  name: string;
  email: string;
  role: string;
  avatarInitials: string;
}

export interface ShellPropertyItem {
  id: number;
  name: string;
  code?: string;
  is_active?: boolean;
}
