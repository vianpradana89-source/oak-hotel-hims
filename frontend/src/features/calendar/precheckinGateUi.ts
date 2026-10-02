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

/**
 * Display-only positive labels for rows that are MET (satisfied).
 * Keyed by the same missing-requirement code, phrased affirmatively.
 * These are NOT source-of-truth labels — they are purely presentational
 * and are only used when the row's requirement is satisfied.
 */
export const MET_LABELS: Record<string, string> = {
  PRIMARY_GUEST_NAME_MISSING: 'Nama tamu lengkap',
  PRIMARY_GUEST_PHONE_MISSING: 'No. telepon tersedia',
  IDENTITY_DOCUMENT_MISSING: 'Dokumen identitas tersedia',
  PAYMENT_MISSING: 'Pembayaran tercatat',
  PAYMENT_EVIDENCE_MISSING: 'Bukti pembayaran tersedia',
  GUARANTEE_MISSING: 'Jaminan tersedia',
  ROOM_NOT_READY: 'Kamar siap',
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

/**
 * Requirement codes that always appear as a row for progress display,
 * even when currently satisfied. The set of "met" rows.
 */
const KNOWN_CHECKIN_CODES = [
  'PRIMARY_GUEST_NAME_MISSING',
  'PRIMARY_GUEST_PHONE_MISSING',
  'IDENTITY_DOCUMENT_MISSING',
  'PAYMENT_MISSING',
  'PAYMENT_EVIDENCE_MISSING',
  'GUARANTEE_MISSING',
  'ROOM_NOT_READY',
] as const;

/**
 * Build the display rows for the check-in readiness checklist.
 *
 * Rows = union(KNOWN_CHECKIN_CODES, backend missing codes).
 * - Known codes always show a row (met or not-met).
 * - Any backend missing code that is NOT in the known list (e.g.
 *   PRECHECKIN_EVALUATION_FAILED or any future code) is also shown,
 *   so nothing is silently dropped.
 * - missingRequirements ALWAYS wins: a code present in the missing array is
 *   never "met", even when eligible === true (fail-closed).
 * - A code is "met" when it is not missing AND (eligible === true OR the
 *   corresponding precheckin flag is true).
 * - Codes without a dedicated action handler are not annotated here;
 *   the consumer decides actionability.
 */
export interface CheckinReadinessRow {
  code: string;
  isMet: boolean;
  isMissing: boolean;
  label: string;
  hasKnownAction: boolean;
}

export function buildCheckinReadinessRows(
  precheckinEligibility: PrecheckinEligibilityData | null,
  missingRequirements: PrecheckinMissingRequirement[]
): CheckinReadinessRow[] {
  // Codes the backend reported as missing that are NOT in the known set.
  // These must still be surfaced as rows so they are never silently dropped.
  const missingCodes = missingRequirements
    .map(r => r.code)
    .filter(code => !KNOWN_CHECKIN_CODES.includes(code as any));

  const allCodes = [...new Set<string>([...KNOWN_CHECKIN_CODES, ...missingCodes])];

  // Build the "met" set from canonical boolean flags.
  const metCodes = new Set<string>();
  if (precheckinEligibility?.guest_name_ok === true) metCodes.add('PRIMARY_GUEST_NAME_MISSING');
  if (precheckinEligibility?.guest_phone_ok === true) metCodes.add('PRIMARY_GUEST_PHONE_MISSING');
  if (precheckinEligibility?.identity_ok === true) metCodes.add('IDENTITY_DOCUMENT_MISSING');
  if (precheckinEligibility?.payment_ok === true) metCodes.add('PAYMENT_MISSING');
  if (precheckinEligibility?.payment_evidence_ok === true) metCodes.add('PAYMENT_EVIDENCE_MISSING');
  if (precheckinEligibility?.guarantee_ok === true) metCodes.add('GUARANTEE_MISSING');
  if (precheckinEligibility?.room_ready_ok === true) metCodes.add('ROOM_NOT_READY');

  const isAllMet = precheckinEligibility?.eligible === true;

  // Codes that have a dedicated navigator action in the drawer
  // (name / phone / room / identity / payment / payment evidence / guarantee).
  // Everything else is informational.
  const ACTIONABLE_CODES = new Set([
    'PRIMARY_GUEST_NAME_MISSING',
    'PRIMARY_GUEST_PHONE_MISSING',
    'ROOM_NOT_READY',
    'IDENTITY_DOCUMENT_MISSING',
    'PAYMENT_MISSING',
    'PAYMENT_EVIDENCE_MISSING',
    'GUARANTEE_MISSING',
  ]);

  return allCodes.map(code => {
    const isMissing = missingRequirements.some(r => r.code === code);
    // Fail-closed: missing array always wins. eligible/met flags only matter
    // when the code is NOT missing.
    const isMet = !isMissing && (isAllMet || metCodes.has(code));
    const label = isMet
      ? MET_LABELS[code] || CANONICAL_CHECKIN_REQUIREMENT_LABELS[code] || code
      : missingRequirements.find(r => r.code === code)?.label ||
        CANONICAL_CHECKIN_REQUIREMENT_LABELS[code] ||
        code;
    const hasKnownAction = ACTIONABLE_CODES.has(code);
    return { code, isMet, isMissing, label, hasKnownAction };
  });
}
