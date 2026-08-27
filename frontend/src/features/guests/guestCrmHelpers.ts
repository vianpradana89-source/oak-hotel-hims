import type {
  BehavioralSegment,
  Guest,
  VipStatus
} from './guestTypes';

/**
 * Calculates days between two date strings (YYYY-MM-DD).
 * Positive if dateB > dateA.
 */
export function calculateDaysBetween(dateStrA: string, dateStrB: string): number {
  if (!dateStrA || !dateStrB) return 0;
  const a = new Date(dateStrA.slice(0, 10) + 'T00:00:00Z');
  const b = new Date(dateStrB.slice(0, 10) + 'T00:00:00Z');
  const diffTime = b.getTime() - a.getTime();
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Derives the operational behavioral segment for a guest based on their visit history.
 * Note: This is an advisory display classification and is distinct from authoritative vip_status.
 */
export function deriveBehavioralSegment(
  guest: Guest,
  hotelDateStr: string = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })
): 'BARU' | 'REPEAT' | 'TIDAK_AKTIF' | 'REGULER' {
  const visitCount = Number(guest.visit_count || 0);

  if (visitCount >= 2) {
    return 'REPEAT';
  }

  if (guest.first_stay) {
    const daysSinceFirst = calculateDaysBetween(guest.first_stay, hotelDateStr);
    if (daysSinceFirst >= 0 && daysSinceFirst <= 30) {
      return 'BARU';
    }
  }

  if (guest.last_stay) {
    const daysSinceLast = calculateDaysBetween(guest.last_stay, hotelDateStr);
    if (daysSinceLast >= 90) {
      return 'TIDAK_AKTIF';
    }
  }

  return 'REGULER';
}

/**
 * Filters a list of guests by behavioral or VIP segment.
 */
export function filterGuestsBySegment(
  guests: Guest[],
  segment: BehavioralSegment,
  hotelDateStr: string = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })
): Guest[] {
  if (!Array.isArray(guests)) return [];
  if (segment === 'SEMUA') return guests;

  if (segment === 'VIP') {
    return guests.filter((g) => g.vip_status === 'VIP');
  }

  if (segment === 'VVIP') {
    return guests.filter((g) => g.vip_status === 'VVIP');
  }

  if (segment === 'REPEAT') {
    return guests.filter((g) => Number(g.visit_count || 0) >= 2);
  }

  if (segment === 'BARU') {
    return guests.filter((g) => deriveBehavioralSegment(g, hotelDateStr) === 'BARU');
  }

  if (segment === 'TIDAK_AKTIF') {
    return guests.filter((g) => deriveBehavioralSegment(g, hotelDateStr) === 'TIDAK_AKTIF');
  }

  return guests;
}

/**
 * Filters guests matching a search query across name, phone, email, and preferred name.
 */
export function filterGuestsBySearch(guests: Guest[], query: string): Guest[] {
  if (!Array.isArray(guests)) return [];
  const q = (query || '').trim().toLowerCase();
  if (!q) return guests;

  return guests.filter((g) => {
    const nameMatch = g.full_name?.toLowerCase().includes(q);
    const prefMatch = g.preferred_name?.toLowerCase().includes(q);
    const phoneMatch = g.phone?.toLowerCase().includes(q);
    const emailMatch = g.email?.toLowerCase().includes(q);
    return Boolean(nameMatch || prefMatch || phoneMatch || emailMatch);
  });
}

/**
 * Paginates an array of guests.
 */
export function paginateGuests(
  guests: Guest[],
  page: number,
  pageSize: number
): {
  items: Guest[];
  total: number;
  totalPages: number;
  startRecord: number;
  endRecord: number;
} {
  const total = guests.length;
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (safePage - 1) * safePageSize;
  const items = guests.slice(startIndex, startIndex + safePageSize);
  const startRecord = total === 0 ? 0 : startIndex + 1;
  const endRecord = Math.min(startIndex + safePageSize, total);

  return {
    items,
    total,
    totalPages,
    startRecord,
    endRecord
  };
}

/**
 * Formats standard date string to Indonesian visual format (DD/MM/YYYY).
 */
export function formatDateIndonesian(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    const raw = dateStr.slice(0, 10);
    const parts = raw.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return raw;
  } catch {
    return String(dateStr);
  }
}

/**
 * Formats stay period display (e.g. "12/08/2026 – 14/08/2026 (2 malam)").
 */
export function formatStayPeriodDisplay(checkIn: string, checkOut: string): string {
  if (!checkIn || !checkOut) return '—';
  const inFormatted = formatDateIndonesian(checkIn);
  const outFormatted = formatDateIndonesian(checkOut);
  const nights = calculateDaysBetween(checkIn, checkOut);
  return `${inFormatted} – ${outFormatted} (${nights} malam)`;
}

/**
 * Returns OAK style visual badge attributes for VIP statuses.
 */
export function getVipBadgeClass(status: VipStatus): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  switch (status) {
    case 'VVIP':
      return {
        bg: 'bg-amber-100 text-amber-900',
        text: 'text-amber-900 font-semibold',
        border: 'border-amber-300',
        label: 'VVIP'
      };
    case 'VIP':
      return {
        bg: 'bg-emerald-100 text-emerald-900',
        text: 'text-emerald-900 font-medium',
        border: 'border-emerald-300',
        label: 'VIP'
      };
    case 'STANDARD':
    default:
      return {
        bg: 'bg-stone-100 text-stone-700',
        text: 'text-stone-700',
        border: 'border-stone-200',
        label: 'Standard'
      };
  }
}

/**
 * Returns visual badge attributes for behavioral segment tags.
 */
export function getSegmentBadgeClass(segment: string): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  switch (segment) {
    case 'REPEAT':
      return {
        bg: 'bg-indigo-50 text-indigo-700',
        text: 'text-indigo-700',
        border: 'border-indigo-200',
        label: 'Repeat Guest'
      };
    case 'BARU':
      return {
        bg: 'bg-sky-50 text-sky-700',
        text: 'text-sky-700',
        border: 'border-sky-200',
        label: 'Tamu Baru'
      };
    case 'TIDAK_AKTIF':
      return {
        bg: 'bg-stone-100 text-stone-500',
        text: 'text-stone-500',
        border: 'border-stone-200',
        label: 'Dormant (>90 hari)'
      };
    default:
      return {
        bg: 'bg-stone-50 text-stone-600',
        text: 'text-stone-600',
        border: 'border-stone-200',
        label: 'Reguler'
      };
  }
}

/**
 * Returns badge styling for reservation guest roles.
 */
export function getRoleBadgeClass(role: string): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  switch (role) {
    case 'PRIMARY_GUEST':
      return {
        bg: 'bg-emerald-50 text-emerald-800',
        text: 'text-emerald-800 font-semibold',
        border: 'border-emerald-200',
        label: 'Tamu Utama'
      };
    case 'BOOKER':
      return {
        bg: 'bg-blue-50 text-blue-800',
        text: 'text-blue-800 font-medium',
        border: 'border-blue-200',
        label: 'Pemesan (Booker)'
      };
    case 'ADDITIONAL_GUEST':
    default:
      return {
        bg: 'bg-stone-100 text-stone-700',
        text: 'text-stone-700',
        border: 'border-stone-200',
        label: 'Tamu Tambahan'
      };
  }
}

/**
 * Returns relation fidelity badge styling.
 * is_legacy_inferred = true  -> "Data Legacy"
 * is_legacy_inferred = false -> "Relasi Tercatat"
 *
 * IMPORTANT: is_legacy_inferred = false means explicit reservation linkage, NOT identity verification.
 */
export function getRelationFidelityBadgeClass(isLegacyInferred: boolean): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  if (isLegacyInferred) {
    return {
      bg: 'bg-amber-50 text-amber-800',
      text: 'text-amber-800',
      border: 'border-amber-200',
      label: 'Data Legacy'
    };
  }
  return {
    bg: 'bg-stone-50 text-stone-700',
    text: 'text-stone-700',
    border: 'border-stone-200',
    label: 'Relasi Tercatat'
  };
}

/**
 * Returns optional identity verification badge styling.
 * ONLY identity_verified = true renders this badge.
 */
export function getIdentityVerifiedBadgeClass(identityVerified?: boolean): {
  bg: string;
  text: string;
  border: string;
  label: string;
} | null {
  if (!identityVerified) return null;
  return {
    bg: 'bg-emerald-50 text-emerald-800',
    text: 'text-emerald-800',
    border: 'border-emerald-200',
    label: 'Identitas Terverifikasi'
  };
}
