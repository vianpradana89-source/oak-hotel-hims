/**
 * UI advisory capability mapping for Deposit & Guarantee actions.
 *
 * Backend authorization remains authoritative via requireRole(['Front Office'])
 * in depositRouter.ts and identityCustodyRouter.ts.
 *
 * requireRole behavior (source: authMiddleware.ts:59):
 *   Super Admin  → always bypasses (line 59)
 *   General Manager → always bypasses (line 59)
 *   Front Office → in allowedRoles
 *   All other roles → HTTP 403
 *
 * This helper mirrors that exact behavior for UI gating.
 * It does NOT introduce a false granular RBAC system.
 */

import { normalizeRole } from '../auth/permissions';

export interface DepositGuaranteeCapabilities {
  canViewSummary: boolean;
  canReceiveDeposit: boolean;
  canApplyDeposit: boolean;
  canRefundDeposit: boolean;
  canReverseDeposit: boolean;
  canHoldIdentity: boolean;
  canReturnIdentity: boolean;
}

export function getDepositGuaranteeCapabilities(roleName?: string | null): DepositGuaranteeCapabilities {
  const norm = normalizeRole(roleName);
  switch (norm) {
    case 'Super Admin':
    case 'General Manager':
      return {
        canViewSummary: true,
        canReceiveDeposit: true,
        canApplyDeposit: true,
        canRefundDeposit: true,
        canReverseDeposit: true,
        canHoldIdentity: true,
        canReturnIdentity: true,
      };
    case 'Front Office':
      return {
        canViewSummary: true,
        canReceiveDeposit: true,
        canApplyDeposit: true,
        canRefundDeposit: true,
        canReverseDeposit: true,
        canHoldIdentity: true,
        canReturnIdentity: true,
      };
    default:
      return {
        canViewSummary: false,
        canReceiveDeposit: false,
        canApplyDeposit: false,
        canRefundDeposit: false,
        canReverseDeposit: false,
        canHoldIdentity: false,
        canReturnIdentity: false,
      };
  }
}
