import React, { useState } from 'react';
import { LaporanPeriodFilter } from './LaporanPeriodFilter';
import { LaporanTabKeseluruhan, type KeseluruhanSubView } from './LaporanTabKeseluruhan';
import { LaporanTabKinerjaKamar } from './LaporanTabKinerjaKamar';
import {
  LaporanTabPenjualan,
  SALES_MODE_OPTIONS,
  type SalesReportMode,
} from './LaporanTabPenjualan';
import { LaporanTabPembelian } from './LaporanTabPembelian';
import { LaporanTabPemasukan } from './LaporanTabPemasukan';
import { LaporanTabPengeluaran } from './LaporanTabPengeluaran';
import { LaporanTabMetodeBayar } from './LaporanTabMetodeBayar';
import { useLaporanWorkspace } from './useLaporanWorkspace';
import { useDailyOperations } from './useDailyOperations';
import { downloadExportXml, buildLaporanSheets } from './exportLaporan';
import { formatInclusiveRangeDisplay } from './laporanPeriods';
import { LaporanDropdown } from './laporanUi';
import type { OccupancySubView } from '../OccupancySection';
import {
  IconBarChart3,
  IconBedDouble,
  IconBuilding2,
  IconCreditCard,
  IconDollarSign,
  IconDownload,
  IconLayoutGrid,
  IconScale,
  IconShoppingCart,
  IconTrendingDown,
  IconTrendingUp,
  IconWallet,
} from './LaporanIcons';

export type LaporanTabKey =
  | 'keseluruhan'
  | 'kinerja_kamar'
  | 'penjualan'
  | 'pembelian'
  | 'pemasukan'
  | 'pengeluaran'
  | 'metode_bayar';

const TABS: { key: LaporanTabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'keseluruhan', label: 'Keseluruhan', icon: <IconLayoutGrid className="w-3.5 h-3.5" /> },
  { key: 'kinerja_kamar', label: 'Kinerja Kamar & Okupansi', icon: <IconBuilding2 className="w-3.5 h-3.5" /> },
  { key: 'penjualan', label: 'Penjualan', icon: <IconDollarSign className="w-3.5 h-3.5" /> },
  { key: 'pembelian', label: 'Pembelian', icon: <IconShoppingCart className="w-3.5 h-3.5" /> },
  { key: 'pemasukan', label: 'Pemasukan', icon: <IconTrendingUp className="w-3.5 h-3.5" /> },
  { key: 'pengeluaran', label: 'Pengeluaran', icon: <IconTrendingDown className="w-3.5 h-3.5" /> },
  { key: 'metode_bayar', label: 'Metode Bayar', icon: <IconCreditCard className="w-3.5 h-3.5" /> },
];

const KESELURUHAN_SUBVIEW_OPTIONS: {
  value: KeseluruhanSubView;
  label: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'ringkasan',
    label: 'Ringkasan Keseluruhan',
    icon: <IconLayoutGrid className="w-3.5 h-3.5" />,
  },
  {
    value: 'laba_rugi',
    label: 'Laporan Laba / Rugi',
    icon: <IconBarChart3 className="w-3.5 h-3.5" />,
  },
  {
    value: 'arus_kas',
    label: 'Laporan Arus Kas',
    icon: <IconWallet className="w-3.5 h-3.5" />,
  },
  {
    value: 'neraca',
    label: 'Laporan Neraca',
    icon: <IconScale className="w-3.5 h-3.5" />,
  },
];

const KINERJA_SUBVIEW_OPTIONS: {
  value: OccupancySubView;
  label: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'all',
    label: 'Semua Kinerja Kamar & Okupansi',
    icon: <IconBuilding2 className="w-3.5 h-3.5" />,
  },
  {
    value: 'kpi_fin',
    label: 'Ringkasan KPI & Metrik Finansial (ADR/RevPAR)',
    icon: <IconBarChart3 className="w-3.5 h-3.5" />,
  },
  {
    value: 'daily_trend',
    label: 'Tren Kinerja Harian',
    icon: <IconTrendingUp className="w-3.5 h-3.5" />,
  },
  {
    value: 'room_types',
    label: 'Occupancy per Tipe Kamar',
    icon: <IconBedDouble className="w-3.5 h-3.5" />,
  },
];

export interface LaporanWorkspaceProps {
  propertyId: number | null;
}

export const LaporanWorkspace: React.FC<LaporanWorkspaceProps> = ({ propertyId }) => {
  const [activeTab, setActiveTab] = useState<LaporanTabKey>('keseluruhan');
  const [keseluruhanSubView, setKeseluruhanSubView] = useState<KeseluruhanSubView>('ringkasan');
  const [kinerjaSubView, setKinerjaSubView] = useState<OccupancySubView>('all');
  const [penjualanSubView, setPenjualanSubView] =
    useState<SalesReportMode>('rincian_penjualan');

  const workspace = useLaporanWorkspace(propertyId);
  const {
    analytics,
    financials,
    analyticsError,
    financialsError,
    loading,
    period,
    range,
    customStart,
    customEnd,
    setCustomStart,
    setCustomEnd,
    setPeriod,
    refresh,
    todayHotelDate,
    lastReloadToken,
  } = workspace;

  const dailyHotelDate = range ? range.start : todayHotelDate;
  const { dailyOps, dailyKpis, dailyOpsError, loading: dailyLoading } = useDailyOperations(
    propertyId,
    dailyHotelDate,
    lastReloadToken
  );

  const loadingAll = loading || dailyLoading;

  const onRetry = () => {
    refresh();
  };

  const handleSelectTab = (tabKey: LaporanTabKey) => {
    setActiveTab(tabKey);
    if (analyticsError || financialsError || dailyOpsError) {
      refresh();
    }
  };

  const handleExport = () => {
    if (!range) return;
    const rangeLabel = formatInclusiveRangeDisplay(range.start, range.end);
    const sheets = buildLaporanSheets({
      rangeLabel,
      dailyOps,
      dailyKpis,
      financials,
      analytics,
    });
    downloadExportXml(`Laporan_HIMS_${range.start}_sd_${range.end}.xls`, sheets);
  };

  const renderFilterLeftSlot = () => {
    if (activeTab === 'keseluruhan') {
      return (
        <LaporanDropdown<KeseluruhanSubView>
          value={keseluruhanSubView}
          options={KESELURUHAN_SUBVIEW_OPTIONS}
          onChange={setKeseluruhanSubView}
          variant="primary"
        />
      );
    }
    if (activeTab === 'kinerja_kamar') {
      return (
        <LaporanDropdown<OccupancySubView>
          value={kinerjaSubView}
          options={KINERJA_SUBVIEW_OPTIONS}
          onChange={setKinerjaSubView}
          variant="primary"
        />
      );
    }
    if (activeTab === 'penjualan') {
      return (
        <LaporanDropdown<SalesReportMode>
          value={penjualanSubView}
          options={SALES_MODE_OPTIONS}
          onChange={setPenjualanSubView}
          variant="primary"
        />
      );
    }
    return null;
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'keseluruhan':
        return (
          <LaporanTabKeseluruhan
            dailyOps={dailyOps}
            dailyOpsError={dailyOpsError}
            financials={financials}
            financialsError={financialsError}
            analytics={analytics}
            loading={loadingAll}
            onRetry={onRetry}
            subView={keseluruhanSubView}
          />
        );
      case 'kinerja_kamar':
        return (
          <LaporanTabKinerjaKamar
            propertyId={propertyId}
            occupancyRefreshTrigger={lastReloadToken}
            period={period}
            range={range}
            customStart={customStart}
            customEnd={customEnd}
            subView={kinerjaSubView}
          />
        );
      case 'penjualan':
        return (
          <LaporanTabPenjualan
            data={analytics}
            financials={financials}
            loading={loading}
            error={analyticsError}
            onRetry={onRetry}
            subView={penjualanSubView}
            onSubViewChange={setPenjualanSubView}
          />
        );
      case 'pembelian':
        return (
          <LaporanTabPembelian
            data={analytics}
            financials={financials}
            loading={loading}
            error={analyticsError}
            onRetry={onRetry}
          />
        );
      case 'pemasukan':
        return (
          <LaporanTabPemasukan
            data={financials}
            loading={loading}
            error={financialsError}
            onRetry={onRetry}
          />
        );
      case 'pengeluaran':
        return (
          <LaporanTabPengeluaran
            data={financials}
            loading={loading}
            error={financialsError}
            onRetry={onRetry}
          />
        );
      case 'metode_bayar':
        return (
          <LaporanTabMetodeBayar
            data={financials}
            loading={loading}
            error={financialsError}
            onRetry={onRetry}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="laporan-workspace space-y-4 min-w-0">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-emerald-800 font-bold">
            Laporan & Analitik Operasional
          </div>
          <h3 className="text-xl font-bold text-gray-900 mt-0.5">Laporan</h3>
          <p className="text-xs text-gray-500 mt-1">
            {range
              ? formatInclusiveRangeDisplay(range.start, range.end)
              : 'Pilih periode untuk memuat laporan'}
            {propertyId ? '' : ' — pilih properti dulu'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={!range}
            className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-xs disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 cursor-pointer"
          >
            <IconDownload className="w-3.5 h-3.5 text-slate-600" />
            <span>Export Excel</span>
          </button>
        </div>
      </div>

      {/* Tab bar with Lucide SVG Icons */}
      <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1.5 rounded-xl border border-slate-200/80">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => handleSelectTab(t.key)}
            className={`px-3.5 py-2 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTab === t.key
                ? 'bg-emerald-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/70'
            }`}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Global period filter + Left Mode Selector */}
      <LaporanPeriodFilter
        period={period}
        range={range}
        loading={loadingAll}
        customStart={customStart}
        customEnd={customEnd}
        onPeriodChange={setPeriod}
        onCustomStartChange={setCustomStart}
        onCustomEndChange={setCustomEnd}
        onRefresh={refresh}
        leftSlot={renderFilterLeftSlot()}
      />

      {/* Active tab */}
      {renderTab()}
    </div>
  );
};
