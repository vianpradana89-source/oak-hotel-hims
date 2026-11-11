/**
 * bookingCreatePaymentTypes.ts
 * Shared deps/contracts for UNIT 3B payment adapter (index.ts wiring).
 */

import type { PoolClient } from 'pg';
import type { EvidenceUpload } from '../deposits/depositTypes';

export interface BookingCreateDeps {
  /** receiveDepositInTransaction (Core 2A). */
  receiveDepositInTransaction?: (
    client: PoolClient,
    input: import('../deposits/depositTypes').ReceiveDepositInput,
    owner?: import('./bookingCreatePaymentService').EvidenceRegisteringOwner | undefined
  ) => Promise<any>;
  /** validateEvidenceUpload (evidenceStorageService). */
  validateEvidenceUpload?: (file: {
    mimetype: string;
    size: number;
    originalname: string;
    buffer: Buffer;
  }) => { valid: boolean; error?: string | null; code?: string | null };
  /** Save file (GCS or local). Must be called exactly once per evidence. */
  saveEvidenceFile?: (propertyId: number, file: EvidenceUpload) => Promise<{
    storageKey: string;
    fileSizeBytes: number;
  }>;
  /** Delete saved evidence key (cleanup on failure only). */
  deleteEvidenceFile?: (storageKey: string) => Promise<void>;
  /** getQuickBookingRules (frontOfficeSettingsService). */
  getQuickBookingRules?: (pool: unknown, propertyId: number) => Promise<{
    rules: Record<'WALK_IN' | 'OTA', Record<string, string> | undefined>;
  }>;
}

export interface BookingCreatePaymentContext {
  deps: BookingCreateDeps;
  /** Production pool (for getQuickBookingRules only). */
  pool: unknown;
  savedEvidenceKeys: string[];
}
