import React, { useState, useEffect, useRef, useCallback } from 'react';
import { hotelDateFromInstant } from '../calendar/calendarDates.ts';
import type {
  OccupancyReportData,
  OccupancyPeriodPreset,
  OccupancyErrorPayload,
} from './occupancyReportingTypes.ts';
import {
  buildOccupancyQueryConfig,
  formatDateIndonesian,
  formatInclusivePeriodDisplay,
  getKpiLabels,
} from './occupancyDateHelpers.ts';

interface OccupancySectionProps {
  propertyId: number | null;
  refreshTrigger?: number;
}

export const OccupancySection: React.FC<OccupancySectionProps> = ({
  propertyId,
  refreshTrigger = 0,
}) => {
  const [period, setPeriod] = useState<OccupancyPeriodPreset>('today');
  const todayHotelDate = hotelDateFromInstant(new Date());

  const [customStart, setCustomStart] = useState<string>(todayHotelDate);
  const [customEnd, setCustomEnd] = useState<string>(todayHotelDate);

  const [data, setData] = useState<OccupancyReportData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<OccupancyErrorPayload | null>(null);

  const [showDailyTable, setShowDailyTable] = useState<boolean>(true);
  const [showRoomTypeTable, setShowRoomTypeTable] = useState<boolean>(true);

  const requestVersionRef = useRef<number>(0);

  const fetchOccupancy = useCallback(
    async (targetPropId: number | null) => {
      if (!targetPropId) {
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }

      const queryConfig = buildOccupancyQueryConfig(
        period,
        targetPropId,
        todayHotelDate,
        customStart,
        customEnd
      );

      if (!queryConfig) {
        return;
      }

      const currentVersion = ++requestVersionRef.current;
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/reports/occupancy?${queryConfig.urlParams}`);
        const json = await res.json().catch(() => null);

        if (currentVersion !== requestVersionRef.current) return;

        if (res.ok && json && json.status === 'SUCCESS' && json.data) {
          setData(json.data);
          setError(null);
        } else {
          setData(null);
          setError({
            code: json?.code || (res.status === 409 ? 'CAPACITY_HISTORY_UNAVAILABLE' : 'ERROR'),
            message: json?.message || 'Gagal memuat data occupancy',
            details: json?.details,
          });
        }
      } catch (err: any) {
        if (currentVersion !== requestVersionRef.current) return;
        setData(null);
        setError({
          code: 'NETWORK_ERROR',
          message: err?.message || 'Gagal terhubung ke server',
        });
      } finally {
        if (currentVersion === requestVersionRef.current) {
          setLoading(false);
        }
      }
    },
    [period, customStart, customEnd, todayHotelDate]
  );

  // Trigger fetch when propertyId, period, custom dates, or refreshTrigger changes
  useEffect(() => {
    if (propertyId === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    void fetchOccupancy(propertyId);
  }, [propertyId, period, customStart, customEnd, refreshTrigger, fetchOccupancy]);

  const isSingleDay = data ? data.nights === 1 : period === 'today' || (period === 'custom' && customStart === customEnd);
  const kpiLabels = getKpiLabels(isSingleDay);

  const renderPeriodSelector = () => (
    <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
      <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1 rounded-lg">
        <button
          type="button"
          onClick={() => setPeriod('today')}
          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
            period === 'today'
              ? 'bg-white text-emerald-800 shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
          }`}
        >
          Hari Ini
        </button>
        <button
          type="button"
          onClick={() => setPeriod('7days')}
          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
            period === '7days'
              ? 'bg-white text-emerald-800 shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
          }`}
        >
          7 Hari
        </button>
        <button
          type="button"
          onClick={() => setPeriod('this_month')}
          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
            period === 'this_month'
              ? 'bg-white text-emerald-800 shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
          }`}
        >
          Bulan Ini
        </button>
        <button
          type="button"
          onClick={() => setPeriod('custom')}
          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
            period === 'custom'
              ? 'bg-white text-emerald-800 shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
          }`}
        >
          Kustom
        </button>
      </div>

      {period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex items-center gap-1">
            <span className="text-slate-500 font-medium">Dari:</span>
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-xs bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-500 font-medium">Sampai:</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="border border-slate-300 rounded px-2 py-1 text-xs bg-white focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
            />
          </div>
        </div>
      )}

      {data && (
        <div className="text-xs text-slate-600 font-medium ml-auto bg-slate-50 px-2.5 py-1 rounded-md border border-slate-200/80">
          {formatInclusivePeriodDisplay(data.start_date, data.end_date, data.nights)}
        </div>
      )}
    </div>
  );

  const renderError = () => {
    if (!error) return null;

    if (error.code === 'CAPACITY_HISTORY_UNAVAILABLE') {
      const firstCovered = error.details?.first_covered_date;
      const lastCovered = error.details?.last_covered_date;

      return (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-900 text-sm">
          <div className="flex items-center gap-2 font-bold text-amber-800 mb-1">
            <span>⚠️</span> Data Kapasitas Kamar Belum Tersedia
          </div>
          <p className="text-xs text-amber-700">
            Data kapasitas kamar belum tersedia untuk periode yang dipilih.
          </p>
          {firstCovered && lastCovered && (
            <p className="text-xs text-amber-800 mt-2 font-semibold">
              Periode data tersedia: {formatDateIndonesian(firstCovered)} – {formatDateIndonesian(lastCovered)}
            </p>
          )}
        </div>
      );
    }

    if (error.code === 'OCCUPANCY_INTEGRITY_VIOLATION') {
      return (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-900 text-sm">
          <div className="flex items-center gap-2 font-bold text-red-800 mb-1">
            <span>🚫</span> Inkonsistensi Data Inventory Terdeteksi
          </div>
          <p className="text-xs text-red-700">
            Data occupancy tidak dapat dihitung karena ditemukan inkonsistensi inventory.
          </p>
        </div>
      );
    }

    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-900 text-sm">
        <div className="flex items-center gap-2 font-bold text-red-800 mb-1">
          <span>⚠️</span> Gagal Memuat Data Kinerja Kamar
        </div>
        <p className="text-xs text-red-700">{error.message}</p>
      </div>
    );
  };

  const renderKpiCards = () => {
    if (!data) return null;
    const { totals } = data;

    return (
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {/* Occupancy */}
        <div className="col-span-2 md:col-span-4 lg:col-span-1 bg-emerald-900 text-white border border-emerald-950 rounded-xl p-4 shadow-sm">
          <div className="text-[11px] uppercase font-bold text-emerald-200 tracking-wide">
            {kpiLabels.occupancy}
          </div>
          <div className="text-3xl font-extrabold mt-1 text-emerald-100">
            {Number(totals.occupancy_pct || 0).toFixed(2)}%
          </div>
          <div className="text-[10px] text-emerald-300 mt-1">Berdasarkan kamar sellable</div>
        </div>

        {/* Total Gross Rooms */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="text-[11px] uppercase font-bold text-slate-500 tracking-wide">
            {kpiLabels.gross}
          </div>
          <div className="text-2xl font-bold text-slate-800 mt-1">
            {totals.gross_room_nights}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">Kapasitas fisik hotel</div>
        </div>

        {/* Sellable Rooms */}
        <div className="bg-white border border-emerald-200 rounded-xl p-4 shadow-sm bg-emerald-50/20">
          <div className="text-[11px] uppercase font-bold text-emerald-800 tracking-wide">
            {kpiLabels.sellable}
          </div>
          <div className="text-2xl font-bold text-emerald-900 mt-1">
            {totals.sellable_room_nights}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">Fisik dikurangi blokir</div>
        </div>

        {/* Sold Room Nights */}
        <div className="bg-white border border-blue-200 rounded-xl p-4 shadow-sm bg-blue-50/20">
          <div className="text-[11px] uppercase font-bold text-blue-800 tracking-wide">
            {kpiLabels.sold}
          </div>
          <div className="text-2xl font-bold text-blue-900 mt-1">
            {totals.sold_room_nights}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">Reservasi aktif terisi</div>
        </div>

        {/* Available Room Nights */}
        <div className="bg-white border border-teal-200 rounded-xl p-4 shadow-sm bg-teal-50/20">
          <div className="text-[11px] uppercase font-bold text-teal-800 tracking-wide">
            {kpiLabels.available}
          </div>
          <div className="text-2xl font-bold text-teal-900 mt-1">
            {totals.available_room_nights}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">Sisa sellable belum terjual</div>
        </div>

        {/* OOO */}
        <div className="bg-white border border-rose-200 rounded-xl p-4 shadow-sm bg-rose-50/20">
          <div className="text-[11px] uppercase font-bold text-rose-800 tracking-wide">
            {kpiLabels.ooo}
          </div>
          <div className="text-2xl font-bold text-rose-900 mt-1">
            {totals.ooo_room_nights}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">Blokir kerusakan/renovasi</div>
        </div>

        {/* OOS */}
        <div className="bg-white border border-amber-200 rounded-xl p-4 shadow-sm bg-amber-50/20">
          <div className="text-[11px] uppercase font-bold text-amber-800 tracking-wide">
            {kpiLabels.oos}
          </div>
          <div className="text-2xl font-bold text-amber-900 mt-1">
            {totals.oos_room_nights}
          </div>
          <div className="text-[10px] text-slate-400 mt-1">Blokir operasional minor</div>
        </div>
      </div>
    );
  };

  const renderDailyTable = () => {
    if (!data || !data.daily || data.daily.length === 0) return null;

    return (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setShowDailyTable((prev) => !prev)}
          className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200 text-left text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <span>Tren Kinerja Harian ({data.daily.length} Hari)</span>
          <span className="text-slate-400">{showDailyTable ? '▲ Tutup' : '▼ Tampilkan'}</span>
        </button>

        {showDailyTable && (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="min-w-full text-xs divide-y divide-slate-200">
              <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3 text-left bg-slate-100">Tanggal</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Gross</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">OOO</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">OOS</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Sellable</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Terjual</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Tersedia</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Occupancy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {data.daily.map((day) => (
                  <tr key={day.date} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-2 px-3 font-semibold text-slate-900">
                      {formatDateIndonesian(day.date)}
                    </td>
                    <td className="py-2 px-3 text-right">{day.gross_room_nights}</td>
                    <td className="py-2 px-3 text-right text-rose-700">{day.ooo_room_nights}</td>
                    <td className="py-2 px-3 text-right text-amber-700">{day.oos_room_nights}</td>
                    <td className="py-2 px-3 text-right font-semibold text-emerald-800">{day.sellable_room_nights}</td>
                    <td className="py-2 px-3 text-right font-semibold text-blue-800">{day.sold_room_nights}</td>
                    <td className="py-2 px-3 text-right text-slate-800">{day.available_room_nights}</td>
                    <td className="py-2 px-3 text-right font-bold text-slate-900">
                      {Number(day.occupancy_pct || 0).toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderRoomTypeBreakdown = () => {
    if (!data || !data.room_types || data.room_types.length === 0) return null;

    return (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setShowRoomTypeTable((prev) => !prev)}
          className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200 text-left text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <span>Occupancy per Tipe Kamar ({data.room_types.length} Tipe)</span>
          <span className="text-slate-400">{showRoomTypeTable ? '▲ Tutup' : '▼ Tampilkan'}</span>
        </button>

        {showRoomTypeTable && (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="min-w-full text-xs divide-y divide-slate-200">
              <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3 text-left bg-slate-100">Tipe Kamar</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Gross</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Diblokir</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Sellable</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Terjual</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Tersedia</th>
                  <th className="py-2.5 px-3 text-right bg-slate-100">Occupancy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium text-slate-700">
                {data.room_types.map((rt) => (
                  <tr key={rt.room_type_id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-2.5 px-3 text-slate-900">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{rt.room_type_name}</span>
                        <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded font-mono">
                          {rt.room_type_code}
                        </span>
                        {rt.is_active_current === false && (
                          <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded font-semibold">
                            Nonaktif
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right">{rt.gross_room_nights}</td>
                    <td className="py-2.5 px-3 text-right text-rose-700">{rt.blocked_room_nights}</td>
                    <td className="py-2.5 px-3 text-right font-semibold text-emerald-800">{rt.sellable_room_nights}</td>
                    <td className="py-2.5 px-3 text-right font-semibold text-blue-800">{rt.sold_room_nights}</td>
                    <td className="py-2.5 px-3 text-right text-slate-800">{rt.available_room_nights}</td>
                    <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                      {Number(rt.occupancy_pct || 0).toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Kinerja Kamar & Occupancy
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Kinerja kapasitas dan occupancy berdasarkan periode tanggal hotel
          </p>
        </div>
        {loading && (
          <div className="text-xs text-emerald-700 font-semibold flex items-center gap-1.5">
            <span className="animate-spin">⟳</span> Memuat data...
          </div>
        )}
      </div>

      {renderPeriodSelector()}
      {renderError()}
      {renderKpiCards()}
      {renderDailyTable()}
      {renderRoomTypeBreakdown()}
    </div>
  );
};
