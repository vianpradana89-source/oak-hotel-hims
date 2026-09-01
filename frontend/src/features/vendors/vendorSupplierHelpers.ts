import type { SupplierEntityType, SupplierStatus } from './vendorSupplierTypes';
import { normalizeRole } from '../auth/permissions';

export interface VendorSupplierCapabilities {
  canView: boolean;
  canCreateEdit: boolean;
  canManageStatus: boolean;
  canDelete: boolean;
}

export function getVendorSupplierCapabilities(roleName?: string | null): VendorSupplierCapabilities {
  const norm = normalizeRole(roleName);
  switch (norm) {
    case 'Super Admin':
    case 'General Manager':
      return {
        canView: true,
        canCreateEdit: true,
        canManageStatus: true,
        canDelete: true,
      };
    case 'Accounting':
      return {
        canView: true,
        canCreateEdit: true,
        canManageStatus: true,
        canDelete: false, // delete reserved for GM/Admin
      };
    case 'Front Office':
    case 'POS / Resto':
      return {
        canView: true,
        canCreateEdit: false,
        canManageStatus: false,
        canDelete: false,
      };
    default:
      return {
        canView: false,
        canCreateEdit: false,
        canManageStatus: false,
        canDelete: false,
      };
  }
}

export const STANDARD_CATEGORIES = [
  'Food & Beverage',
  'Amenities & Guest Supplies',
  'Linen & Laundry',
  'Housekeeping & Cleaning Chemical',
  'Maintenance & Engineering',
  'IT, Software & Hardware',
  'ATK & Operasional Kantor',
  'Uniform & Karyawan',
  'Lain-lain'
];

export const STANDARD_DEPARTMENTS = [
  { code: 'FNB', label: 'Food & Beverage' },
  { code: 'HOUSEKEEPING', label: 'Housekeeping' },
  { code: 'MAINTENANCE', label: 'Maintenance / Engineering' },
  { code: 'FRONT_OFFICE', label: 'Front Office' },
  { code: 'ADMIN', label: 'Admin & Umum' },
  { code: 'HRD', label: 'HRD' },
  { code: 'GENERAL', label: 'General / Seluruh Properti' }
];

export function getEntityTypeLabel(entityType?: SupplierEntityType | string | null): string {
  const type = String(entityType || 'SUPPLIER').toUpperCase();
  switch (type) {
    case 'VENDOR':
      return 'Vendor (Jasa)';
    case 'BOTH':
      return 'Keduanya (Barang & Jasa)';
    case 'SUPPLIER':
    default:
      return 'Supplier (Barang)';
  }
}

export function getEntityTypeBadgeClass(entityType?: SupplierEntityType | string | null): string {
  const type = String(entityType || 'SUPPLIER').toUpperCase();
  switch (type) {
    case 'VENDOR':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'BOTH':
      return 'bg-purple-50 text-purple-700 border-purple-200';
    case 'SUPPLIER':
    default:
      return 'bg-amber-50 text-amber-800 border-amber-200';
  }
}

export function getStatusLabel(status?: SupplierStatus | string | null): string {
  const st = String(status || 'ACTIVE').toUpperCase();
  switch (st) {
    case 'BLACKLISTED':
      return 'Diblacklist';
    case 'INACTIVE':
      return 'Nonaktif';
    case 'ACTIVE':
    default:
      return 'Aktif';
  }
}

export function getStatusBadgeClass(status?: SupplierStatus | string | null): string {
  const st = String(status || 'ACTIVE').toUpperCase();
  switch (st) {
    case 'BLACKLISTED':
      return 'bg-rose-100 text-rose-800 border-rose-300 font-semibold';
    case 'INACTIVE':
      return 'bg-slate-100 text-slate-600 border-slate-200';
    case 'ACTIVE':
    default:
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 font-medium';
  }
}

export function formatPaymentTerms(days?: number | null): string {
  const d = Number(days ?? 0);
  if (d <= 0) return 'Cash / Tunai';
  return `${d} Hari (Tempo)`;
}

export function formatDateLocal(dateStr?: string | null): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(d);
  } catch {
    return String(dateStr);
  }
}
