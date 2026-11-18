export type MainNavKey =
  | 'Kalender'
  | 'Transaksi'
  | 'Dokumen & Print'
  | 'Housekeeping'
  | 'HRD'
  | 'POS'
  | 'Mobile Portal'
  | 'Employee Mobile'
  | 'Laporan'
  | 'Akuntansi'
  | 'Daftar Purchase Order'
  | 'Master Kamar'
  | 'Master Produk'
  | 'Penerimaan Barang'
  | 'Produk & Inventori'
  | 'Analisis Food Cost'
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
  children?: NavItemDef[];
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
