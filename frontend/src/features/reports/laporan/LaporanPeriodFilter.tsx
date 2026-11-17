import React from 'react';
import {
  PERIOD_PRESETS,
  formatPeriodDropdownButtonLabel,
} from './laporanPeriods';
import type { PeriodPreset, PeriodRange } from './laporanPeriods';
import { LaporanDropdown } from './laporanUi';
import { IconCalendar, IconDownload, IconRefreshCw } from './LaporanIcons';

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
  onExport?: () => void;
  leftSlot?: React.ReactNode;
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
  onExport,
  leftSlot,
}) => {
  const buttonLabel = formatPeriodDropdownButtonLabel(period, range);

  const dropdownOptions = PERIOD_PRESETS.map((p) => ({
    value: p.key,
    label: p.label,
  }));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
      <div className="flex flex-wrap items-center gap-2.5">
        {leftSlot ?? null}
      </div>

      <div className="flex flex-wrap items-center gap-2 ml-auto">
        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-xs bg-white border border-slate-300 rounded-lg px-2.5 py-1 shadow-xs">
            <div className="flex items-center gap-1">
              <span className="text-slate-500 font-medium">Dari:</span>
              <input
                type="date"
                value={customStart}
                onChange={(e) => onCustomStartChange(e.target.value)}
                className="border border-slate-200 rounded px-1.5 py-0.5 text-xs bg-slate-50 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-500 font-medium">Sampai:</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => onCustomEndChange(e.target.value)}
                className="border border-slate-200 rounded px-1.5 py-0.5 text-xs bg-slate-50 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
              />
            </div>
          </div>
        )}

        <LaporanDropdown<PeriodPreset>
          value={period}
          options={dropdownOptions}
          onChange={onPeriodChange}
          buttonLabel={buttonLabel}
          leadingIcon={<IconCalendar className="w-3.5 h-3.5" />}
          variant="primary"
          align="right"
        />

        <button
          type="button"
          onClick={onRefresh}
          className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-xs disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
          disabled={loading}
          title="Segarkan Data"
        >
          <IconRefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-700' : 'text-slate-600'}`} />
          <span>{loading ? 'Memuat...' : 'Segarkan'}</span>
        </button>

        {onExport && (
          <button
            type="button"
            onClick={onExport}
            disabled={!range}
            className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-xs disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 cursor-pointer"
          >
            <IconDownload className="w-3.5 h-3.5 text-slate-600" />
            <span>Export</span>
          </button>
        )}
      </div>
    </div>
  );
};
