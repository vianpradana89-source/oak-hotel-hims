/**
 * MINIBAR HK → FO → FOLIO — Domain Types (Tahap A: Foundation)
 *
 * Hanya tipe dan kontrak domain, selaras 1:1 dengan DDL aktual pada
 * backend/src/db/migrations/minibar_hk_billing_v1.ts (T1–T10):
 * nama field (camelCase dari nama kolom snake_case), tipe, nullability,
 * dan nilai status/event sesuai named CHECK DDL.
 * Belum ada service operasional, endpoint, UI, atau logika billing.
 */

// ─── Enum / union (nilai persis CHECK DDL) ──────────────────────────────────

/** T3 ck_mb_event_source_type: source_type IN (...) */
export type MinibarEventSourceType = 'REPORT' | 'RESTOCK' | 'VERIFICATION';

/** T3 ck_mb_event_type: 8 nilai event_type (append-only ledger) */
export type MinibarEventType =
  | 'EXPLICIT_CHECKIN'
  | 'ADDED_TO_ROOM'
  | 'REMOVED_FROM_ROOM'
  | 'DAMAGED_RECORDED'
  | 'LOST_RECORDED'
  | 'CONSUMPTION_CONFIRMED'
  | 'CORRECTION_RECORDED'
  | 'INSPECTION_SNAPSHOT';

/** T2 ck_mb_baseline_source_type */
export type MinibarBaselineSourceType =
  | 'EXPLICIT_CHECKIN'
  | 'MANUAL_VERIFICATION'
  | 'EXPLICIT_RESTOCK';

/** T4 CHECK anonim: status IN ('DRAFT','SUBMITTED','SUPERSEDED') */
export type MinibarReportStatus = 'DRAFT' | 'SUBMITTED' | 'SUPERSEDED';

/** T5 ck_mb_line_baseline_status */
export type MinibarLineBaselineStatus = 'VERIFIED' | 'UNKNOWN' | 'PENDING_VERIFICATION';

/** T5 ck_mb_line_surplus_status (nullable; NULL = belum ada surplus) */
export type MinibarLineSurplusStatus = 'NONE' | 'UNVERIFIED' | 'VERIFIED';

/** T5 ck_mb_line_billing_status */
export type MinibarLineBillingStatus = 'PENDING' | 'NOT_BILLED' | 'BILLED' | 'VOIDED' | 'CORRECTED';

/** T6 ck_mb_conf_billing_status */
export type MinibarBillingStatus = 'POSTED' | 'NOT_BILLED' | 'VOIDED' | 'CORRECTED';

// ─── T1: Standar minibar per room type ───────────────────────────────────────

export interface RoomTypeMinibarStandard {
  id?: number;
  propertyId: number;
  roomTypeId: number;
  menuItemId: number;
  /** Jumlah standar per stay (konfigurasi, bukan baseline otomatis). */
  standardQty: number;
  notes?: string | null;
  isActive: boolean;
}

// ─── T2: Baseline verification ──────────────────────────────────��────────────
// Verifikasi berikutnya = baris baru; baris lama (anchor) tidak ditimpa.
// Tidak ada UNIQUE per scope → beberapa record per scope sah.

export interface MinibarBaselineVerification {
  id?: number;
  propertyId: number;
  reservationId: number;
  roomId: number;
  menuItemId: number;
  /** Qty terverifikasi manual pada anchor. */
  verifiedQty: number;
  sourceType: MinibarBaselineSourceType;
  /** ID sumber (task / restock / verification record). NOT NULL. */
  sourceId: number;
  verifiedBy: string | null;
  /** TIMESTAMPTZ DEFAULT NOW() */
  verifiedAt?: string;
  notes?: string | null;
}

// ─── T3: Event stay (append-only) ────────────────────────────────────────────

export interface MinibarStayEvent {
  id?: number;
  propertyId: number;
  reservationId: number;
  roomId: number;
  menuItemId: number;
  eventType: MinibarEventType;
  /**
   * Delta bertanda sesuai ck_mb_event_delta_sign:
   *  ADDED_TO_ROOM              → > 0
   *  REMOVED_FROM_ROOM / DAMAGED_RECORDED / LOST_RECORDED /
   *  CONSUMPTION_CONFIRMED      → < 0
   *  INSPECTION_SNAPSHOT / EXPLICIT_CHECKIN → = 0
   *  CORRECTION_RECORDED        → <> 0
   */
  quantityDelta: number;
  sourceType: MinibarEventSourceType;
  /** ID sumber (report / restock / verification). NOT NULL. */
  sourceId: number;
  /** TIMESTAMPTZ DEFAULT NOW() */
  eventAt?: string;
  notes?: string | null;
  createdAt?: string;
}

// ─── T4: Inspection report (header) ─────────────────────────────────────────

export interface MinibarInspectionReport {
  id?: number;
  propertyId: number;
  reservationId: number;
  roomId: number;
  /** housekeeping_tasks.id — NOT NULL, UNIQUE(task_id) (1 report per task). */
  taskId: number;
  hkUserId: string | null;
  hkUserName: string | null;
  /** DDL: DRAFT | SUBMITTED | SUPERSEDED */
  status: MinibarReportStatus;
  submittedAt?: string | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ─── T5: Inspection report line ──────────────────────────────────────────────

export interface MinibarInspectionReportLineInput {
  menuItemId: number;
  /** Hitungan fisik (bukan kalkulasi). NOT NULL, >= 0. */
  countedQty: number;
  /** Klasifikasi konsumsi; qty nullable (hasil turunan boleh NULL saat DRAFT). */
  consumedQty?: number | null;
  damagedQty?: number | null;
  lostQty?: number | null;
  correctionQty?: number | null;
  notes?: string | null;
}

export interface MinibarInspectionReportLine extends MinibarInspectionReportLineInput {
  id?: number;
  reportId: number;
  propertyId: number;
  /**
   * baseline_effective =
   *   verified_qty_pada_anchor
   * + SUM(quantity_delta) where id > anchor_event_id AND id <= cutoff_event_id
   * NULL jika baseline unknown.
   */
  baselineVerificationId: number | null;
  /** Ditentukan backend dari verifikasi (bukan input HK). */
  baselineStatus: MinibarLineBaselineStatus;
  /** verified_qty pada anchor (snapshot). */
  baselineQty: number | null;
  /** Hasil kalkulasi; NULL jika baseline unknown. */
  baselineEffective: number | null;
  /** id minibar_stay_event yang menjadi anchor. */
  anchorEventId: number | null;
  /** id event terakhir yang masuk perhitungan baseline. */
  cutoffEventId: number | null;
  // ── Override field input agar wajib hadir pada record tersimpan (DDL: kolom ada) ──
  /** Klasifikasi konsumsi; nullable sesuai DDL (hasil turunan boleh NULL). */
  consumedQty: number | null;
  damagedQty: number | null;
  lostQty: number | null;
  correctionQty: number | null;
  /** Hasil turunan; nullable. */
  unresolvedQty: number | null;
  /** Surplus; nullable. */
  surplusQty: number | null;
  surplusStatus: MinibarLineSurplusStatus | null;
  /** Snapshot harga (wajib terisi sebelum submit; nullable selama DRAFT). */
  unitPriceSnapshot: number | null;
  /** PENDING selama draft; NOT_BILLED/BILLED/VOIDED/CORRECTED setelah billing. */
  billingStatus: MinibarLineBillingStatus;
  createdAt?: string;
  updatedAt?: string;
}

// ─── T6: Billing confirmation ───────────────────────────────────────────────

export interface MinibarBillingConfirmation {
  id?: number;
  propertyId: number;
  reservationId: number;
  reportLineId: number;
  /** Aktor billing (snapshot; ID mengikuti user existing). */
  billingActorUserId: string | null;
  billingActorNameSnapshot: string | null;
  billingActorRoleSnapshot: string | null;
  /** Qty terkonfirmasi (NOT NULL, >= 0). */
  confirmedConsumedQty: number;
  /** Nominal terkonfirmasi NUMERIC(12,2) (NOT NULL, >= 0). */
  confirmedSubtotal: number;
  /** Alasan reduksi (NOT_BILLED wajib tidak kosong; CHECK ck_mb_conf_not_billed). */
  reductionReason: string | null;
  /** POSTED selama default; NOT_BILLED/VOIDED/CORRECTED sesuai aturan CHECK DDL. */
  billingStatus: MinibarBillingStatus;
  /** Rujukan folio ter-post (NOT NULL saat POSTED). */
  folioEntryId: number | null;
  /** Folio posting pertama saat folioEntryId menunjuk replacement (NOT NULL saat POSTED). */
  originalFolioEntryId: number | null;
  /** Grup koreksi (wajib terisi saat CORRECTED). */
  correctionGroupId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Kalkulasi baseline (helper kontrak) ─────────────────────────────────────

/**
 * Kalkulasi baseline_effective.
 *
 * @param anchorVerifiedQty  verified_qty pada baris anchor (bukan dari quantity_delta)
 * @param eventsInRange      event dengan id > anchor_event_id AND id <= cutoff_event_id,
 *                           scope (property, reservation, room, menu_item) sama
 * @returns baseline_effective, atau null jika input tidak valid
 */
export function calcBaselineEffective(
  anchorVerifiedQty: number,
  eventsInRange: Array<{ quantityDelta: number }>,
): number {
  const deltaSum = eventsInRange.reduce((acc, e) => acc + e.quantityDelta, 0);
  return anchorVerifiedQty + deltaSum;
}

/**
 * Filter event yang masuk range baseline:
 *   scope 4 kolom + anchor_event_id < id <= cutoff_event_id
 */
export function filterBaselineRange(
  events: Array<{
    propertyId: number;
    reservationId: number;
    roomId: number;
    menuItemId: number;
    id: number;
    quantityDelta: number;
  }>,
  scope: { propertyId: number; reservationId: number; roomId: number; menuItemId: number },
  anchorEventId: number,
  cutoffEventId: number,
): Array<{ quantityDelta: number }> {
  return events
    .filter(
      (e) =>
        e.propertyId === scope.propertyId &&
        e.reservationId === scope.reservationId &&
        e.roomId === scope.roomId &&
        e.menuItemId === scope.menuItemId &&
        e.id > anchorEventId &&
        e.id <= cutoffEventId,
    )
    .map((e) => ({ quantityDelta: e.quantityDelta }));
}

// ─── Flag template / task checklist ───────────────────────────────────────────

export interface ChecklistTemplateItemMinibarFlag {
  /**
   * Jika true, item ini membutuhkan report minibar saat task selesai.
   * Field additive pada checklist_template_items.
   */
  requiresMinibarReport: boolean;
}

export interface TaskChecklistItemMinibarFlag {
  /**
   * Snapshot dari template item; flag anti-bypass untuk
   * individual toggle, bulk, dan completion.
   */
  requiresMinibarReport: boolean;
}
