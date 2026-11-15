import type { EffectiveAccessResponse } from '../auth/accessControl';

export interface MasterProductCapabilities {
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canToggleStatus: boolean;
  canManageCategory: boolean;
  canDeleteCategory: boolean;
}

/**
 * Capability UI Master Produk mengikuti KEBIJAKAN PERMISSION EFEKTIF yang sama
 * dengan enforcement backend (`Master Produk` → inventory.*), bukan asumsi
 * nama role. UI tidak boleh mengizinkan mutasi yang backend akan tolak.
 *
 * Pemetaan sumber kebenaran (backend RESOURCE_PERMISSION_KEYS):
 *   - view   = inventory.view
 *   - edit   = inventory.create / inventory.edit
 *   - delete = inventory.delete
 *
 * Tumpang-tindih aksi pada endpoint Master Produk (action → permission keys,
 * ANY antar key — sesuai backend RESOURCE_PERMISSION_KEYS):
 *   - POST item                              → 'edit' (inventory.create ATAU
 *                                              inventory.edit; TIDAK wajib
 *                                              inventory.create)
 *   - POST kategori                         → 'edit' (sama)
 *   - PUT kategori (rename)                → 'edit' (sama)
 *   - PATCH item (termasuk is_active)      → 'edit'
 *   - DELETE kategori                      → 'delete' (hanya inventory.delete)
 *
 * canCreate = allowed('Master Produk', 'edit') — SAMA persis dengan kebijakan
 * backend create-ATAU-edit. TIDAK menambah syarat granular ekstra: sel
 * effective sudah merupakan gabungan create/edit; fallback granular hanya
 * dipakai bila sel effective belum tersedia. Platform super admin selalu
 * diberi izin (ditangani di `allowed`).
 *
 * @param effective        grid akses efektif dari /api/access-control/me
 * @param granular         daftar permission granular aktif (fallback)
 * @param hasPermission    predikat `key in granular`
 */
export function getMasterProductCapabilities(
  effective: EffectiveAccessResponse | null,
  _granular: string[] | undefined,
  hasPermission: (key: string) => boolean,
): MasterProductCapabilities {
  const allowed = (resource: string, action: 'view' | 'edit' | 'delete'): boolean => {
    if (effective?.is_platform_super_admin) return true;
    const cell = effective?.effective?.[resource]?.[action];
    if (cell) return cell.allowed;
    // Fallback granular (bila grid efektif belum termuat):
    const keys: Record<string, string[]> = {
      view: ['inventory.view'],
      edit: ['inventory.create', 'inventory.edit'],
      delete: ['inventory.delete'],
    };
    return keys[action].some((k) => hasPermission(k));
  };

  const view = allowed('Master Produk', 'view');
  // canCreate mengikuti allowed('Master Produk','edit') — SAMA dengan kebijakan
  // backend create ATAU edit. Tidak menambah syarat granular ekstra: sel
  // effective sudah merupakan gabungan create/edit. Fallback granular di
  // `allowed` hanya aktif bila sel effective belum tersedia.
  const canCreate = allowed('Master Produk', 'edit');
  const canEdit = allowed('Master Produk', 'edit');
  const canToggleStatus = canEdit; // ubah is_active = edit item
  const canManageCategory = canCreate || canEdit; // tambah/rename kategori
  const canDeleteCategory = allowed('Master Produk', 'delete');

  return {
    canView: view,
    canCreate,
    canEdit,
    canToggleStatus,
    canManageCategory,
    canDeleteCategory,
  };
}
