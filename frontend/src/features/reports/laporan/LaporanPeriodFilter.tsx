import React from 'react';
import { PERIOD_PRESETS, formatInclusiveRangeDisplay } from './laporanPeriods';
import type { PeriodPreset, PeriodRange } from './laporanPeriods';

export interface LaporanPeriodFilterProps {
  period: PeriodPreset;
  range: PeriodRange | null;
  loading: boolean;
  customStart: string;
  customEnd: string;
  onPeriodChange: (p: PeriodPreset) => void;
  onCustomStartChange: (v: string) => void;
  onCustomEndChange: (v: string) => void;
  onRefresh: () => void;
}

export const LaporanPeriodFilter: React.FC<LaporanPeriodFilterProps> = ({
  period,
  range,
  loading,
  customStart,
  customEnd,
  onPeriodChange,
  onCustomStartChange,
  onCustomEndChange,
  onRefresh,
}) => {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
      <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1 rounded-lg">
        {PERIOD_PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            onClick={() => onPeriodChange(preset.key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              period === preset.key
                ? 'bg-white text-emerald-800 shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3">
        {range ? (
          <div className="text-xs text-slate-600 font-medium bg-slate-50 px-2.5 py-1 rounded-md border border-slate-200/80">
            {formatInclusiveRangeDisplay(range.start, range.end)}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onRefresh}
          className="hotel-action-btn text-xs font-semibold px-3 py-1.5"
          disabled={loading}
        >
          {loading ? 'Memuat...' : '⟳ Segarkan'}
        </button>
      </div>

      {period === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2 text-xs w-full sm:w-auto">
          <div className="flex items-center gap-1">
            <span className="text-slate-500 font-medium">Dari:</span>
            <input
              type="date"
              value={customStart}
              onChange={(e) => onCustomStartChange(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-xs bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-500 font-medium">Sampai:</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => onCustomEndChange(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-xs bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};
