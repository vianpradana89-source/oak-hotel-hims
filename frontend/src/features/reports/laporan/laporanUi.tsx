import React from 'react';

/**
 * Shared visual primitives for the 7-tab Laporan workspace.
 * Follows the OAK visual system: Forest Green / Warm Ivory / Muted Gold,
 * restrained decoration, high readability. No chart library — CSS bars only.
 */

export function formatIdr(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);
}

export function formatNumber(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('id-ID') : '0';
}

type Accent = 'default' | 'emerald' | 'blue' | 'amber' | 'rose' | 'teal' | 'slate';

const ACCENT_STYLES: Record<Accent, { card: string; label: string; value: string; sub: string }> = {
  default: {
    card: 'bg-white border border-slate-200',
    label: 'text-slate-500',
    value: 'text-slate-800',
    sub: 'text-slate-400',
  },
  emerald: {
    card: 'bg-emerald-900 text-white border border-emerald-950',
    label: 'text-emerald-200',
    value: 'text-emerald-50',
    sub: 'text-emerald-300',
  },
  blue: {
    card: 'bg-white border border-blue-200 bg-blue-50/20',
    label: 'text-blue-800',
    value: 'text-blue-900',
    sub: 'text-slate-400',
  },
  amber: {
    card: 'bg-white border border-amber-200 bg-amber-50/20',
    label: 'text-amber-800',
    value: 'text-amber-900',
    sub: 'text-slate-400',
  },
  rose: {
    card: 'bg-white border border-rose-200 bg-rose-50/20',
    label: 'text-rose-800',
    value: 'text-rose-900',
    sub: 'text-slate-400',
  },
  teal: {
    card: 'bg-white border border-teal-200 bg-teal-50/20',
    label: 'text-teal-800',
    value: 'text-teal-900',
    sub: 'text-slate-400',
  },
  slate: {
    card: 'bg-white border border-slate-200',
    label: 'text-slate-500',
    value: 'text-slate-900',
    sub: 'text-slate-400',
  },
};

export interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  sublabel?: string;
  accent?: Accent;
  emphasis?: boolean;
}

export const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  sublabel,
  accent = 'default',
  emphasis = false,
}) => {
  const s = ACCENT_STYLES[accent];
  return (
    <div className={`${s.card} ${emphasis ? 'col-span-2 md:col-span-1' : ''} rounded-xl p-4 shadow-sm`}>
      <div className={`text-[11px] uppercase font-bold tracking-wide ${s.label}`}>{label}</div>
      <div className={`text-2xl font-extrabold mt-1 ${emphasis ? 'text-3xl' : ''} ${s.value}`}>{value}</div>
      {sublabel ? <div className={`text-[10px] mt-1 ${s.sub}`}>{sublabel}</div> : null}
    </div>
  );
};

export const SectionTitle: React.FC<{ title: string; hint?: string; right?: React.ReactNode }> = ({
  title,
  hint,
  right,
}) => (
  <div className="flex items-center justify-between gap-3">
    <div>
      <div className="text-xs font-bold uppercase tracking-wider text-slate-500">{title}</div>
      {hint ? <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div> : null}
    </div>
    {right ?? null}
  </div>
);

export const EmptyState: React.FC<{ title: string; message?: string; icon?: string }> = ({
  title,
  message,
  icon = '◇',
}) => (
  <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 text-center">
    <div className="text-2xl text-slate-300 mb-1">{icon}</div>
    <div className="text-sm font-semibold text-slate-600">{title}</div>
    {message ? <div className="text-xs text-slate-400 mt-1">{message}</div> : null}
  </div>
);

export const LoadingState: React.FC<{ label?: string }> = ({ label = 'Memuat data...' }) => (
  <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 text-center">
    <div className="text-emerald-700 font-semibold text-xs flex items-center justify-center gap-2">
      <span className="animate-spin">⟳</span> {label}
    </div>
  </div>
);

export const ErrorState: React.FC<{ message: string; onRetry?: () => void }> = ({
  message,
  onRetry,
}) => (
  <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-rose-900 text-sm">
    <div className="flex items-center gap-2 font-bold text-rose-800 mb-1">
      <span>⚠️</span> Gagal memuat data
    </div>
    <p className="text-xs text-rose-700">{message}</p>
    {onRetry ? (
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 text-xs font-semibold text-rose-800 underline hover:no-underline"
      >
        Muat ulang
      </button>
    ) : null}
  </div>
);

/**
 * A simple CSS horizontal bar list. Bars are normalized against the max value.
 * Purely presentational — no chart dependency.
 */
export interface BarDatum {
  label: string;
  value: number;
  sublabel?: string;
  colorClass?: string; // tailwind bg-* utility for the bar
}

export const BarList: React.FC<{
  data: BarDatum[];
  emptyMessage?: string;
  valueFormatter?: (v: number) => string;
  maxBars?: number;
}> = ({ data, emptyMessage = 'Belum ada data', valueFormatter, maxBars = 12 }) => {
  if (!data || data.length === 0) {
    return <EmptyState title={emptyMessage} />;
  }
  const fmt = valueFormatter || ((v: number) => formatNumber(v));
  const items = data.slice(0, maxBars);
  const max = Math.max(1, ...items.map((d) => Number(d.value) || 0));
  return (
    <div className="space-y-2.5">
      {items.map((d, i) => {
        const pct = Math.max(2, Math.round(((Number(d.value) || 0) / max) * 100));
        return (
          <div key={`${d.label}-${i}`} className="flex items-center gap-3">
            <div className="w-40 shrink-0 text-xs">
              <div className="font-semibold text-slate-800 truncate">{d.label}</div>
              {d.sublabel ? <div className="text-[10px] text-slate-400 truncate">{d.sublabel}</div> : null}
            </div>
            <div className="flex-1 bg-slate-100 rounded-full h-2.5 overflow-hidden">
              <div
                className={`${d.colorClass || 'bg-emerald-600'} h-full rounded-full transition-all`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="w-24 shrink-0 text-right text-xs font-bold text-slate-700 tabular-nums">
              {fmt(Number(d.value) || 0)}
            </div>
          </div>
        );
      })}
      {data.length > maxBars ? (
        <div className="text-[11px] text-slate-400">+ {data.length - maxBars} lainnya</div>
      ) : null}
    </div>
  );
};
