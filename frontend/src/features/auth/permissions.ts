import type { MainNavKey } from '../shell/shellTypes';

export type StandardRole =
  | 'Super Admin'
  | 'General Manager'
  | 'Front Office'
  | 'Housekeeping'
  | 'Accounting'
  | 'POS / Resto'
  | 'Crew';

export function normalizeRole(roleName?: string | null): StandardRole {
  if (!roleName) return 'Crew';
  const r = roleName.trim().toUpperCase().replace(/[\s/_-]+/g, '');
  if (r === 'SUPERADMIN' || r === 'OWNER' || r === 'ADMIN') return 'Super Admin';
  if (r === 'GM' || r === 'GENERALMANAGER' || r === 'MANAGER') return 'General Manager';
  if (r === 'FRONTOFFICE' || r === 'FO' || r === 'RECEPTIONIST') return 'Front Office';
  if (r === 'HOUSEKEEPING' || r === 'HK') return 'Housekeeping';
  if (r === 'ACCOUNTING' || r === 'FINANCE' || r === 'ACCOUNTANT') return 'Accounting';
  if (r === 'POSRESTO' || r === 'POS' || r === 'POSCREW' || r === 'FB' || r === 'FOODANDBEVERAGE' || r === 'RESTO') return 'POS / Resto';
  return 'Crew';
}

export const ROLE_PERMISSIONS: Record<StandardRole, MainNavKey[]> = {
  'Super Admin': [
    'Kalender',
    'Transaksi',
    'Pelanggan',
    'Housekeeping',
    'HRD',
    'POS',
    'Master Kamar',
    'Master Produk',
    'Laporan',
    'Employee Mobile',
    'Pengaturan',
  ],
  'General Manager': [
    'Kalender',
    'Transaksi',
    'Pelanggan',
    'Housekeeping',
    'HRD',
    'POS',
    'Master Kamar',
    'Master Produk',
    'Laporan',
    'Employee Mobile',
    'Pengaturan',
  ],
  'Front Office': [
    'Kalender',
    'Transaksi',
    'Pelanggan',
    'POS',
    'Employee Mobile',
  ],
  'Housekeeping': [
    'Housekeeping',
    'Employee Mobile',
  ],
  'Accounting': [
    'Transaksi',
    'Laporan',
  ],
  'POS / Resto': [
    'POS',
    'Master Produk',
  ],
  'Crew': [
    'Employee Mobile',
  ],
};

export function isMenuAllowedForRole(menuKey: MainNavKey, roleName?: string | null): boolean {
  const norm = normalizeRole(roleName);
  const allowed = ROLE_PERMISSIONS[norm] || ROLE_PERMISSIONS['Crew'] || [];
  return allowed.includes(menuKey);
}

export function getDefaultMenuForRole(roleName?: string | null): MainNavKey {
  const norm = normalizeRole(roleName);
  const allowed = ROLE_PERMISSIONS[norm] || [];
  return allowed[0] || 'Kalender';
}

export const AVAILABLE_ROLE_OPTIONS: { role: StandardRole; description: string; category: string }[] = [
  { role: 'Front Office', description: 'Reservasi, Kalender, Transaksi, dan POS', category: 'OPERATIONAL' },
  { role: 'Housekeeping', description: 'Status Kamar dan Housekeeping Task', category: 'OPERATIONAL' },
  { role: 'Accounting', description: 'Transaksi, Folio, dan Laporan Keuangan', category: 'FINANCE' },
  { role: 'POS / Resto', description: 'Kasir POS dan Manajemen Stok F&B', category: 'OPERATIONAL' },
  { role: 'General Manager', description: 'Akses Penuh Manajemen Hotel', category: 'MANAGEMENT' },
  { role: 'Super Admin', description: 'Akses Penuh & Konfigurasi Sistem', category: 'MANAGEMENT' },
];
