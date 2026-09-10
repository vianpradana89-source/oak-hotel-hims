/**
 * PRECHECKIN-GATE-1C: Canonical Pre-checkin UI Helpers & Contract
 *
 * Single source of truth for pre-checkin readiness:
 * - Authoritative readiness: precheckin_eligibility.eligible === true
 * - Fail-closed: missing, undefined, or failed eligibility is NOT ready
 * - Canonical requirement labels matching backend checkinGateService
 */

export interface PrecheckinMissingRequirement {
  code: string;
  label?: string;
}

export interface PrecheckinEligibilityData {
  eligible?: boolean;
  guest_name_ok?: boolean;
  guest_phone_ok?: boolean;
  identity_ok?: boolean;
  payment_ok?: boolean;
  payment_evidence_ok?: boolean;
  guarantee_ok?: boolean;
  room_ready_ok?: boolean;
  missing?: PrecheckinMissingRequirement[];
}

export const CANONICAL_CHECKIN_REQUIREMENT_LABELS: Record<string, string> = {
  PRIMARY_GUEST_NAME_MISSING: 'Nama tamu menginap belum lengkap',
  PRIMARY_GUEST_PHONE_MISSING: 'No. telepon tamu menginap belum lengkap',
  IDENTITY_DOCUMENT_MISSING: 'Dokumen identitas tamu belum tersedia',
  PAYMENT_MISSING: 'Pembayaran belum tercatat',
  PAYMENT_EVIDENCE_MISSING: 'Bukti pembayaran belum tersedia',
  GUARANTEE_MISSING: 'Jaminan belum ditambahkan',
  ROOM_NOT_READY: 'Kamar belum siap',
  PRECHECKIN_EVALUATION_FAILED: 'Kesiapan check-in belum dapat diverifikasi',
};

export function getMissingRequirementLabel(req: PrecheckinMissingRequirement): string {
  if (req.label && req.label.trim().length > 0) {
    return req.label;
  }
  return CANONICAL_CHECKIN_REQUIREMENT_LABELS[req.code] || req.code;
}

export function evaluatePrecheckinReadiness(data: any): {
  isCheckinEligible: boolean;
  missingRequirements: PrecheckinMissingRequirement[];
  precheckinEligibility: PrecheckinEligibilityData | null;
} {
  const precheckinEligibility: PrecheckinEligibilityData | null = data?.precheckin_eligibility ?? null;
  // Fail-closed: strict check on eligible === true
  const isCheckinEligible = precheckinEligibility?.eligible === true;
  const missingRequirements: PrecheckinMissingRequirement[] = precheckinEligibility?.missing ?? [];

  return {
    isCheckinEligible,
    missingRequirements,
    precheckinEligibility,
  };
}
