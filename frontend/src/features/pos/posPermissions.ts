import type { EffectiveAccessResponse } from '../auth/accessControl';

export interface PosAccess {
  canViewPos: boolean;
  canEditPos: boolean;
}

/**
 * Capability UI POS mengikuti KEBIJAKAN PERMISSION EFEKTIF yang sama
 * dengan enforcement backend (`POS` → pos.*), bukan asumsi nama role.
 *
 * Pemetaan sumber kebenaran (backend RESOURCE_PERMISSION_KEYS,
 * domains/settings/accessControlService.ts):
 *   - view = pos.view
 *   - edit = pos.create ATAU pos.edit
 *
 * Precedence (mirrors backend resolver):
 *   1. Platform Super Admin → always allowed
 *   2. Sel effective grid  → dipakai bila tersedia
 *   3. Fallback granular   → bila sel effective belum termuat
 *
 * PENOLAKAN PERMISSION SAAT RETRY UNRESOLVED (4xx) TIDAK mengubah
 * status unresolved di PosWorkspace — snapshot tetap dipertahankan
 * oleh logic internal PosWorkspace (lihat idempotencySnapshotRef).
 * Helper ini hanya gating UI; tidak dipakai untuk memutuskan nasib snapshot.
 *
 * @param effective        grid akses efektif dari /api/access-control/me
 * @param hasPermission    predikat `key in granularPermissions`
 */
export function getPosAccess(
  effective: EffectiveAccessResponse | null,
  hasPermission: (key: string) => boolean,
): PosAccess {
  const allowed = (resource: string, action: 'view' | 'edit' | 'delete'): boolean => {
    if (effective?.is_platform_super_admin) return true;
    const cell = effective?.effective?.[resource]?.[action];
    if (cell) return cell.allowed;
    // Fallback granular (bila grid efektif belum termuat):
    const keys: Record<string, string[]> = {
      view: ['pos.view'],
      edit: ['pos.create', 'pos.edit'],
      delete: ['pos.delete'],
    };
    return keys[action].some((k) => hasPermission(k));
  };

  const canViewPos = allowed('POS', 'view');
  // "Tambah Order" & "Simpan Pesanan" = aksi edit di policy backend
  // (postcreate/posedit — sel effective sudah gabungan).
  const canEditPos = allowed('POS', 'edit');

  return { canViewPos, canEditPos };
}
