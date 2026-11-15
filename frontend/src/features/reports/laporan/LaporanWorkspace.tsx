import React, { useState } from 'react';
import { LaporanPeriodFilter } from './LaporanPeriodFilter';
import { LaporanTabKeseluruhan } from './LaporanTabKeseluruhan';
import { LaporanTabKinerjaKamar } from './LaporanTabKinerjaKamar';
import { LaporanTabPenjualan } from './LaporanTabPenjualan';
import { LaporanTabPembelian } from './LaporanTabPembelian';
import { LaporanTabPemasukan } from './LaporanTabPemasukan';
import { LaporanTabPengeluaran } from './LaporanTabPengeluaran';
import { LaporanTabMetodeBayar } from './LaporanTabMetodeBayar';
import { useLaporanWorkspace } from './useLaporanWorkspace';
import { useDailyOperations } from './useDailyOperations';
import { downloadExportXml, buildLaporanSheets } from './exportLaporan';
import { formatInclusiveRangeDisplay } from './laporanPeriods';
// import type { PeriodPreset, PeriodRange } from './laporanPeriods';

export type LaporanTabKey =
  | 'keseluruhan'
  | 'kinerja_kamar'
  | 'penjualan'
  | 'pembelian'
  | 'pemasukan'
  | 'pengeluaran'
  | 'metode_bayar';

const TABS: { key: LaporanTabKey; label: string; icon: string }[] = [
  { key: 'keseluruhan', label: 'Keseluruhan', icon: '◉' },
  { key: 'kinerja_kamar', label: 'Kinerja Kamar', icon: '▦' },
  { key: 'penjualan', label: 'Penjualan', icon: '🛒' },
  { key: 'pembelian', label: 'Pembelian', icon: '📦' },
  { key: 'pemasukan', label: 'Pemasukan', icon: '↓' },
  { key: 'pengeluaran', label: 'Pengeluaran', icon: '↑' },
  { key: 'metode_bayar', label: 'Metode Bayar', icon: '💳' },
];

export interface LaporanWorkspaceProps {
  propertyId: number | null;
}

export const LaporanWorkspace: React.FC<LaporanWorkspaceProps> = ({ propertyId }) => {
  const [activeTab, setActiveTab] = useState<LaporanTabKey>('keseluruhan');
  const [exportOpen, setExportOpen] = useState(false);

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

  // Daily operations + KPIs: use the hotel date of the period start
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
    downloadExportXml(`laporan-${range.start}_${range.end}.xml`, sheets);
    setExportOpen(false);
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
            loading={loadingAll}
            onRetry={onRetry}
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
          />
        );
      case 'penjualan':
        return (
          <LaporanTabPenjualan
            data={analytics}
            loading={loading}
            error={analyticsError}
            onRetry={onRetry}
          />
        );
      case 'pembelian':
        return (
          <LaporanTabPembelian
            data={analytics}
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
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-emerald-800 font-bold">
            Laporan & Analitik Operasional
          </div>
          <h3 className="text-xl font-bold text-gray-900 mt-0.5">Laporan 7-Tab HIMS</h3>
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
            onClick={() => setExportOpen(true)}
            disabled={!range}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ⬇ Export
          </button>
          {exportOpen && range ? (
            <div className="flex items-center gap-2 text-xs bg-white border border-slate-200 rounded-lg px-2 py-1 shadow-sm">
              <span className="text-slate-600">Mengekspor…</span>
              <button type="button" onClick={handleExport} className="text-emerald-700 font-bold">
                OK
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Global period filter */}
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
      />

      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1 rounded-lg">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
              activeTab === t.key
                ? 'bg-white text-emerald-800 shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <span className="mr-1">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Active tab */}
      {renderTab()}
    </div>
  );
};
