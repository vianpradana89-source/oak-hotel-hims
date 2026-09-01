/**
 * OAK HIMS Design Tokens & Semantic System
 *
 * Official Visual Foundation:
 * - Warm Off-White / Ivory: Application background
 * - Pure White: Primary surfaces / Cards
 * - Deep Charcoal / Slate: Sidebar navigation & primary text
 * - Forest Green: Primary operational accent
 * - Muted Gold: OAK brand / Premium accent
 * - Slate / Gray: Secondary text & neutral borders
 * - Emerald / Amber / Rose / Blue: Semantic operational statuses
 *
 * Typography scale defined in tailwind.config.js (canonical source).
 * These TypeScript tokens are reference metadata for type-safe consumers.
 */

export const OAK_COLORS = {
  bg: '#f7f6f2', // Warm Ivory / Off-White
  surface: '#ffffff',
  surfaceSubtle: '#faf9f6',
  sidebar: '#131b24', // Deep Charcoal
  sidebarHover: '#1c2633',
  sidebarActive: '#223040',
  primary: '#1b4332', // Forest Green
  primaryHover: '#143527',
  primaryLight: '#eaf2ec',
  brandGold: '#c5a880', // Muted Gold
  brandGoldHover: '#b3956d',
  brandGoldLight: '#fbf7ee',
  charcoal: '#1e293b',
  textMuted: '#64748b',
  border: '#e2e8f0',
  borderSubtle: '#edf2f7',
  // Semantic status colors
  success: '#10b981',
  successLight: '#ecfdf5',
  warning: '#f59e0b',
  warningLight: '#fffbeb',
  danger: '#ef4444',
  dangerLight: '#fef2f2',
  info: '#3b82f6',
  infoLight: '#eff6ff',
} as const;

export type StatusCategory =
  | 'reservation'
  | 'room'
  | 'payment'
  | 'payment_transaction'
  | 'housekeeping';

export interface SemanticStatusStyle {
  label: string;
  bgClass: string;
  textClass: string;
  borderClass: string;
  dotClass: string;
}

/**
 * Standardized semantic status mappings for OAK HIMS
 */
export const STATUS_STYLES: Record<string, SemanticStatusStyle> = {
  // Reservation lifecycle
  BOOKED: {
    label: 'Booked',
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-700',
    borderClass: 'border-blue-200',
    dotClass: 'bg-blue-500',
  },
  CHECKED_IN: {
    label: 'Checked In',
    bgClass: 'bg-emerald-50',
    textClass: 'text-emerald-700',
    borderClass: 'border-emerald-200',
    dotClass: 'bg-emerald-500',
  },
  CHECKED_OUT: {
    label: 'Checked Out',
    bgClass: 'bg-slate-100',
    textClass: 'text-slate-600',
    borderClass: 'border-slate-300',
    dotClass: 'bg-slate-400',
  },
  CANCELLED: {
    label: 'Cancelled',
    bgClass: 'bg-rose-50',
    textClass: 'text-rose-700',
    borderClass: 'border-rose-200',
    dotClass: 'bg-rose-500',
  },

  // Payment overall status
  PAID: {
    label: 'Lunas',
    bgClass: 'bg-emerald-50',
    textClass: 'text-emerald-700',
    borderClass: 'border-emerald-200',
    dotClass: 'bg-emerald-500',
  },
  PARTIAL: {
    label: 'Sebagian',
    bgClass: 'bg-amber-50',
    textClass: 'text-amber-700',
    borderClass: 'border-amber-200',
    dotClass: 'bg-amber-500',
  },
  UNPAID: {
    label: 'Belum Bayar',
    bgClass: 'bg-rose-50',
    textClass: 'text-rose-700',
    borderClass: 'border-rose-200',
    dotClass: 'bg-rose-500',
  },

  // Payment Transaction Status
  SUCCESS: {
    label: 'Valid',
    bgClass: 'bg-emerald-50',
    textClass: 'text-emerald-700',
    borderClass: 'border-emerald-200',
    dotClass: 'bg-emerald-500',
  },
  CORRECTED: {
    label: 'Dikoreksi',
    bgClass: 'bg-amber-50',
    textClass: 'text-amber-700',
    borderClass: 'border-amber-200',
    dotClass: 'bg-amber-500',
  },
  VOIDED: {
    label: 'Dibatalkan (Void)',
    bgClass: 'bg-rose-50',
    textClass: 'text-rose-700',
    borderClass: 'border-rose-200',
    dotClass: 'bg-rose-500',
  },
  REVERSAL: {
    label: 'Reversal',
    bgClass: 'bg-purple-50',
    textClass: 'text-purple-700',
    borderClass: 'border-purple-200',
    dotClass: 'bg-purple-500',
  },

  // Room / Housekeeping status
  VACANT_CLEAN: {
    label: 'Vacant Clean',
    bgClass: 'bg-emerald-50',
    textClass: 'text-emerald-700',
    borderClass: 'border-emerald-200',
    dotClass: 'bg-emerald-500',
  },
  VACANT_DIRTY: {
    label: 'Vacant Dirty',
    bgClass: 'bg-amber-50',
    textClass: 'text-amber-700',
    borderClass: 'border-amber-200',
    dotClass: 'bg-amber-500',
  },
  OCCUPIED_CLEAN: {
    label: 'Occupied Clean',
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-700',
    borderClass: 'border-blue-200',
    dotClass: 'bg-blue-500',
  },
  OCCUPIED_DIRTY: {
    label: 'Occupied Dirty',
    bgClass: 'bg-orange-50',
    textClass: 'text-orange-700',
    borderClass: 'border-orange-200',
    dotClass: 'bg-orange-500',
  },
  OUT_OF_ORDER: {
    label: 'Out of Order',
    bgClass: 'bg-rose-50',
    textClass: 'text-rose-700',
    borderClass: 'border-rose-200',
    dotClass: 'bg-rose-500',
  },
  OUT_OF_SERVICE: {
    label: 'Out of Service',
    bgClass: 'bg-slate-100',
    textClass: 'text-slate-600',
    borderClass: 'border-slate-300',
    dotClass: 'bg-slate-400',
  },
};

export function getStatusStyle(status: string | null | undefined): SemanticStatusStyle {
  if (!status) {
    return {
      label: 'Unknown',
      bgClass: 'bg-slate-100',
      textClass: 'text-slate-600',
      borderClass: 'border-slate-200',
      dotClass: 'bg-slate-400',
    };
  }
  const key = String(status).toUpperCase();
  return (
    STATUS_STYLES[key] || {
      label: status,
      bgClass: 'bg-slate-100',
      textClass: 'text-slate-600',
      borderClass: 'border-slate-200',
      dotClass: 'bg-slate-400',
    }
  );
}

/**
 * OAK Typography Scale
 *
 * Canonical Tailwind classes: text-oak-page, text-oak-section, etc.
 * These metadata objects document the scale for TypeScript consumers.
 * The authoritative source is tailwind.config.js fontSize extensions.
 */
export const OAK_FONTS = {
  sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
  mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', 'monospace'],
  serif: ['ui-serif', 'Georgia', 'Cambria', 'Times New Roman', 'Times', 'serif'],
} as const;

export const OAK_FONT_SIZES = {
  page:   { size: '1.5rem',   px: 24, lineHeight: '1.3',  fontWeight: 700, tailwind: 'text-oak-page' },
  section: { size: '1.125rem', px: 18, lineHeight: '1.35', fontWeight: 600, tailwind: 'text-oak-section' },
  card:   { size: '1rem',     px: 16, lineHeight: '1.4',  fontWeight: 600, tailwind: 'text-oak-card' },
  body:   { size: '0.875rem', px: 14, lineHeight: '1.5',  fontWeight: 400, tailwind: 'text-oak-body' },
  label:  { size: '0.8125rem', px: 13, lineHeight: '1.4', fontWeight: 500, tailwind: 'text-oak-label' },
  input:  { size: '0.875rem', px: 14, lineHeight: '1.4',  fontWeight: 400, tailwind: 'text-oak-input' },
  button: { size: '0.875rem', px: 14, lineHeight: '1',    fontWeight: 600, tailwind: 'text-oak-button' },
  th:     { size: '0.8125rem', px: 13, lineHeight: '1',   fontWeight: 600, tailwind: 'text-oak-th' },
  td:     { size: '0.875rem', px: 14, lineHeight: '1.5',  fontWeight: 400, tailwind: 'text-oak-td' },
  caption: { size: '0.75rem',  px: 12, lineHeight: '1.4', fontWeight: 400, tailwind: 'text-oak-caption' },
  badge:  { size: '0.75rem',  px: 12, lineHeight: '1',   fontWeight: 600, tailwind: 'text-oak-badge' },
} as const;
