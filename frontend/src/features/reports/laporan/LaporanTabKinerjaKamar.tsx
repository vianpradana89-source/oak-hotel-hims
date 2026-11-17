import React, { useState } from 'react';
import { OccupancySection, type OccupancySubView } from '../OccupancySection';
import type { OccupancyPeriodPreset } from '../occupancyReportingTypes';
import type { PeriodPreset, PeriodRange } from './laporanPeriods';

export interface LaporanTabKinerjaKamarProps {
  propertyId: number | null;
  occupancyRefreshTrigger: number;
  period: PeriodPreset;
  range: PeriodRange | null;
  customStart: string;
  customEnd: string;
  subView?: OccupancySubView;
}

function mapPeriodPreset(p: PeriodPreset): OccupancyPeriodPreset {
  switch (p) {
    case 'today': return 'today';
    case 'yesterday': return 'yesterday';
    case 'last7': return '7days';
    case 'this_month': return 'this_month';
    case 'last_month': return 'last_month';
    case 'all_time': return 'this_month';
    case 'custom': return 'custom';
    default: return 'today';
  }
}

export const LaporanTabKinerjaKamar: React.FC<LaporanTabKinerjaKamarProps> = ({
  propertyId,
  occupancyRefreshTrigger,
  period,
  customStart,
  customEnd,
  subView = 'all',
}) => {
  const occPeriod = mapPeriodPreset(period);
  const [localCustomStart, setLocalCustomStart] = useState(customStart);
  const [localCustomEnd, setLocalCustomEnd] = useState(customEnd);

  React.useEffect(() => {
    setLocalCustomStart(customStart);
    setLocalCustomEnd(customEnd);
  }, [customStart, customEnd]);

  return (
    <div className="space-y-4">
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
        subView={subView}
      />
    </div>
  );
};
