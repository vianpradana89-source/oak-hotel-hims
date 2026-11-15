import React, { useState } from 'react';
import { OccupancySection } from '../OccupancySection';
import type { OccupancyPeriodPreset } from '../occupancyReportingTypes';
import { formatInclusiveRangeDisplay } from './laporanPeriods';
import type { PeriodPreset, PeriodRange } from './laporanPeriods';

export interface LaporanTabKinerjaKamarProps {
  propertyId: number | null;
  occupancyRefreshTrigger: number;
  period: PeriodPreset;
  range: PeriodRange | null;
  customStart: string;
  customEnd: string;
}

function mapPeriodPreset(p: PeriodPreset): OccupancyPeriodPreset {
  switch (p) {
    case 'today': return 'today';
    case 'yesterday': return 'yesterday';
    case 'last7': return '7days';
    case 'this_month': return 'this_month';
    case 'last_month': return 'last_month';
    case 'custom': return 'custom';
    default: return 'today';
  }
}

/**
 * Tab "Kinerja Kamar": full occupancy KPI cards, ADR/RevPAR/ALOS financials
 * card, daily trend table, and per-room-type breakdown.
 *
 * The period state is owned by the parent (LaporanWorkspace) via `period` /
 * `customStart` / `customEnd` so all 7 tabs share one global period filter.
 * Internally, OccupancySection is driven in "controlled" mode with
 * `hidePeriodSelector` so it does not render a second selector.
 */
export const LaporanTabKinerjaKamar: React.FC<LaporanTabKinerjaKamarProps> = ({
  propertyId,
  occupancyRefreshTrigger,
  period,
  range,
  customStart,
  customEnd,
}) => {
  const occPeriod = mapPeriodPreset(period);
  const [localCustomStart, setLocalCustomStart] = useState(customStart);
  const [localCustomEnd, setLocalCustomEnd] = useState(customEnd);

  // Keep local in sync with parent when parent changes
  React.useEffect(() => {
    setLocalCustomStart(customStart);
    setLocalCustomEnd(customEnd);
  }, [customStart, customEnd]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
          Kinerja Kamar & Occupancy
        </div>
        <p className="text-xs text-slate-500 mt-0.5">
          {range ? formatInclusiveRangeDisplay(range.start, range.end) : 'Kinerja kapasitas dan occupancy'}
        </p>
      </div>
      <OccupancySection
        propertyId={propertyId}
        refreshTrigger={occupancyRefreshTrigger}
        controlled={{
          period: occPeriod,
          customStart: localCustomStart,
          customEnd: localCustomEnd,
          onPeriodChange: () => {
            /* parent owns period; no-op here */
          },
          onCustomStartChange: setLocalCustomStart,
          onCustomEndChange: setLocalCustomEnd,
        }}
        hidePeriodSelector
      />
    </div>
  );
};
