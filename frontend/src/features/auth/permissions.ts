import type { MainNavKey } from '../shell/shellTypes';

export type StandardRole =
  | 'Super Admin'
  | 'General Manager'
  | 'Front Office'
  | 'Housekeeping'
  | 'Accounting'
  | 'POS / Resto'
  | 'Crew';

export const STANDARD_ROLE_LIST: StandardRole[] = [
  'Super Admin',
  'General Manager',
  'Front Office',
  'Housekeeping',
  'Accounting',
  'POS / Resto',
  'Crew'
];

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

export interface MenuItemMeta {
  key: MainNavKey;
  label: string;
  group: 'Front Office' | 'Departemen' | 'Manajemen' | 'Operasional';
  description: string;
}

export const SYSTEM_AVAILABLE_MENUS: MenuItemMeta[] = [
  {
    key: 'Kalender',
    label: 'Kalender & Kamar',
    group: 'Front Office',
    description: 'Visual Tape Chart, ketersediaan kamar harian, dan alur pergerakan tamu.'
  },
  {
    key: 'Transaksi',
    label: 'Transaksi & Folio',
    group: 'Front Office',
    description: 'Billing reservasi, split folio, pelunasan pembayaran, deposit, dan void.'
  },
  {
    key: 'Pelanggan',
    label: 'Tamu / CRM',
    group: 'Front Office',
    description: 'Database profil tamu, riwayat kunjungan, preferensi khusus, dan status VIP.'
  },
  {
    key: 'Housekeeping',
    label: 'Housekeeping Board',
    group: 'Departemen',
    description: 'Status kebersihan kamar, task assignment, checklist inspeksi, dan temuan.'
  },
  {
    key: 'HRD',
    label: 'HRD & Karyawan',
    group: 'Departemen',
    description: 'Manajemen data staf hotel, absensi GPS, akun login, dan matriks hak akses role.'
  },
  {
    key: 'POS',
    label: 'Kasir POS & Resto',
    group: 'Departemen',
    description: 'Pemesanan makanan & minuman, kasir restoran, dan integrasi bill-to-room.'
  },
  {
    key: 'Master Kamar',
    label: 'Master Kamar',
    group: 'Manajemen',
    description: 'Konfigurasi 9 tipe kamar, 23 kamar fisik, kapasitas ranjang, dan harga dasar.'
  },
  {
    key: 'Master Produk',
    label: 'Master Produk & Menu',
    group: 'Manajemen',
    description: 'Katalog item F&B, harga jual produk restoran, dan kategori menu.'
  },
  {
    key: 'Laporan',
    label: 'Laporan & Okupansi',
    group: 'Manajemen',
    description: 'Laporan tingkat hunian (okupansi), statistik revenue, dan audit harian.'
  },
  {
    key: 'Employee Mobile',
    label: 'Employee Mobile Portal',
    group: 'Operasional',
    description: 'Portal mandiri staf untuk absensi selfie, tugas housekeeping, dan mobile task.'
  },
  {
    key: 'Pengaturan',
    label: 'Pengaturan Properti',
    group: 'Manajemen',
    description: 'Identitas hotel, branding, konfigurasi durasi day use, dan kebijakan properti.'
  }
];

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

export function getEffectiveRolePermissions(
  roleName?: string | null,
  customMap?: Record<string, string[]> | null
): MainNavKey[] {
  const norm = normalizeRole(roleName);
  if (norm === 'Super Admin') {
    return SYSTEM_AVAILABLE_MENUS.map((m) => m.key);
  }

  if (customMap && Array.isArray(customMap[norm])) {
    return customMap[norm] as MainNavKey[];
  }

  return ROLE_PERMISSIONS[norm] || ROLE_PERMISSIONS['Crew'] || [];
}

export function isMenuAllowedForRole(
  menuKey: MainNavKey,
  roleName?: string | null,
  customMap?: Record<string, string[]> | null
): boolean {
  const allowed = getEffectiveRolePermissions(roleName, customMap);
  return allowed.includes(menuKey);
}

export function getDefaultMenuForRole(
  roleName?: string | null,
  customMap?: Record<string, string[]> | null
): MainNavKey {
  const allowed = getEffectiveRolePermissions(roleName, customMap);
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

