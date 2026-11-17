import React, { useMemo, useState } from 'react';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  formatIdr,
  formatNumber,
} from './laporanUi';
import {
  IconBadgePercent,
  IconBarChart3,
  IconBuilding2,
  IconCreditCard,
  IconDownload,
  IconFileSpreadsheet,
  IconLayoutGrid,
  IconPackage,
  IconScale,
  IconSearch,
  IconTrendingDown,
  IconTrendingUp,
  IconWallet,
} from './LaporanIcons';
import { LaporanTabKeseluruhan } from './LaporanTabKeseluruhan';
import { downloadExportXml } from './exportLaporan';
import {
  AddAssetModal,
  AddBankModal,
  AddPayableOrReceivableModal,
  CoaAccountModal,
  InvestorTransferModal,
} from './akuntansiModals';
import type { DailyOperationsData } from './useDailyOperations';
import type {
  AccountingPayableItem,
  AccountingReceivableItem,
  AnalyticsHubData,
  CoaAccountItem,
  FinancialsData,
} from './laporanTypes';

export type AkuntansiSubView =
  | 'transaksi'
  | 'neraca'
  | 'laba_rugi'
  | 'arus_kas'
  | 'jurnal'
  | 'hutang'
  | 'piutang'
  | 'aset'
  | 'list_bank'
  | 'daftar_akun'
  | 'data_ppn';

export const AKUNTANSI_SUBVIEW_OPTIONS: {
  value: AkuntansiSubView;
  label: string;
  icon: React.ReactNode;
}[] = [
  { value: 'transaksi', label: 'Transaksi', icon: <IconLayoutGrid className="w-3.5 h-3.5" /> },
  { value: 'neraca', label: 'Neraca', icon: <IconScale className="w-3.5 h-3.5" /> },
  { value: 'laba_rugi', label: 'Laba Rugi', icon: <IconBarChart3 className="w-3.5 h-3.5" /> },
  { value: 'arus_kas', label: 'Arus Kas', icon: <IconWallet className="w-3.5 h-3.5" /> },
  { value: 'jurnal', label: 'Jurnal', icon: <IconFileSpreadsheet className="w-3.5 h-3.5" /> },
  { value: 'hutang', label: 'Hutang', icon: <IconTrendingDown className="w-3.5 h-3.5" /> },
  { value: 'piutang', label: 'Piutang', icon: <IconTrendingUp className="w-3.5 h-3.5" /> },
  { value: 'aset', label: 'Aset', icon: <IconPackage className="w-3.5 h-3.5" /> },
  { value: 'list_bank', label: 'List Bank', icon: <IconCreditCard className="w-3.5 h-3.5" /> },
  { value: 'daftar_akun', label: 'Daftar Akun', icon: <IconBuilding2 className="w-3.5 h-3.5" /> },
  { value: 'data_ppn', label: 'Data PPN', icon: <IconBadgePercent className="w-3.5 h-3.5" /> },
];

export interface LaporanTabAkuntansiProps {
  propertyId: number;
  startDate: string;
  endDate: string;
  dailyOps: DailyOperationsData | null;
  dailyOpsError: { endpoint: string; message: string } | null;
  financials: FinancialsData | null;
  financialsError: { endpoint: string; message: string } | null;
  analytics: AnalyticsHubData | null;
  loading: boolean;
  onRetry: () => void;
  subView: AkuntansiSubView;
  onChangeSubView: (sv: AkuntansiSubView) => void;
}

const MONTH_SHORT_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function formatMediumDateId(ymd: string | null | undefined): string {
  if (!ymd) return '-';
  const parts = String(ymd).slice(0, 10).split('-');
  if (parts.length !== 3) return String(ymd);
  const day = parseInt(parts[2], 10);
  const monthIdx = parseInt(parts[1], 10) - 1;
  return `${day} ${MONTH_SHORT_ID[monthIdx] || parts[1]} ${parts[0]}`;
}

export const LaporanTabAkuntansi: React.FC<LaporanTabAkuntansiProps> = ({
  propertyId,
  startDate,
  endDate,
  dailyOps,
  dailyOpsError,
  financials,
  financialsError,
  analytics,
  loading,
  onRetry,
  subView,
  onChangeSubView,
}) => {
  // Search & filter states across sub-views
  const [jurnalSearch, setJurnalSearch] = useState('');
  const [jurnalBadgeFilter, setJurnalBadgeFilter] = useState<string>('ALL');
  const [hutangFilter, setHutangFilter] = useState<'ALL' | 'UNPAID' | 'PARTIAL' | 'PAID'>('ALL');
  const [hutangSearch, setHutangSearch] = useState('');
  const [piutangFilter, setPiutangFilter] = useState<'ALL' | 'UNPAID' | 'PARTIAL' | 'PAID'>('ALL');
  const [piutangSearch, setPiutangSearch] = useState('');
  const [coaSearch, setCoaSearch] = useState('');
  const [ppnSourceFilter, setPpnSourceFilter] = useState<'ALL' | 'KAMAR' | 'POS' | 'PEMBELIAN'>('ALL');

  // Modals
  const [coaModalItem, setCoaModalItem] = useState<CoaAccountItem | null | undefined>(undefined);
  const [showAddBankModal, setShowAddBankModal] = useState(false);
  const [showInvestorTransferModal, setShowInvestorTransferModal] = useState(false);
  const [showAddAssetModal, setShowAddAssetModal] = useState(false);
  const [showAddPayableModal, setShowAddPayableModal] = useState(false);
  const [showAddReceivableModal, setShowAddReceivableModal] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);

  const subledger = analytics?.accounting_subledger;

  // Filtered Journal rows
  const filteredJournalRows = useMemo(() => {
    const rows = subledger?.general_journal.rows || [];
    const q = jurnalSearch.trim().toLowerCase();
    return rows.filter((r) => {
      if (jurnalBadgeFilter !== 'ALL' && r.badge_type !== jurnalBadgeFilter) return false;
      if (!q) return true;
      return (
        r.bid_or_ref.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.payment_method.toLowerCase().includes(q)
      );
    });
  }, [subledger, jurnalSearch, jurnalBadgeFilter]);

  // Filtered Payables
  const filteredPayables = useMemo(() => {
    const items = subledger?.payables.items || [];
    const q = hutangSearch.trim().toLowerCase();
    return items.filter((it) => {
      if (hutangFilter !== 'ALL' && it.status !== hutangFilter) return false;
      if (!q) return true;
      return (
        it.supplier_name.toLowerCase().includes(q) ||
        it.transaction_no.toLowerCase().includes(q) ||
        (it.notes || '').toLowerCase().includes(q)
      );
    });
  }, [subledger, hutangFilter, hutangSearch]);

  // Filtered Receivables
  const filteredReceivables = useMemo(() => {
    const items = subledger?.receivables.items || [];
    const q = piutangSearch.trim().toLowerCase();
    return items.filter((it) => {
      if (piutangFilter !== 'ALL' && it.status !== piutangFilter) return false;
      if (!q) return true;
      return (
        it.customer_name.toLowerCase().includes(q) ||
        it.transaction_no.toLowerCase().includes(q) ||
        (it.room_summary || '').toLowerCase().includes(q) ||
        (it.notes || '').toLowerCase().includes(q)
      );
    });
  }, [subledger, piutangFilter, piutangSearch]);

  // Filtered COA
  const filteredCoa = useMemo(() => {
    const items = subledger?.coa_accounts || [];
    const q = coaSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (c) =>
        c.account_number.toLowerCase().includes(q) ||
        c.account_name.toLowerCase().includes(q) ||
        c.classification.toLowerCase().includes(q)
    );
  }, [subledger, coaSearch]);

  // Filtered PPN rows
  const filteredPpnRows = useMemo(() => {
    const rows = subledger?.ppn_summary.rows || [];
    if (ppnSourceFilter === 'ALL') return rows;
    return rows.filter((r) => r.source === ppnSourceFilter);
  }, [subledger, ppnSourceFilter]);

  if (loading && !analytics && !financials) {
    return <LoadingState label="Memuat data akuntansi OAK HIMS..." />;
  }
  if (!analytics && (dailyOpsError || financialsError)) {
    return (
      <ErrorState
        message={(dailyOpsError || financialsError)!.message}
        onRetry={onRetry}
      />
    );
  }
  if (!analytics) {
    return <EmptyState title="Belum ada data akuntansi" message="Pilih periode untuk memuat laporan akuntansi." />;
  }

  // Delegate Neraca, Laba Rugi, Arus Kas to LaporanTabKeseluruhan which already renders the full statements
  if (subView === 'neraca' || subView === 'laba_rugi' || subView === 'arus_kas') {
    return (
      <LaporanTabKeseluruhan
        dailyOps={dailyOps}
        dailyOpsError={dailyOpsError}
        financials={financials}
        financialsError={financialsError}
        analytics={analytics}
        loading={loading}
        onRetry={onRetry}
        subView={subView}
      />
    );
  }

  const handleSettlePayable = async (item: AccountingPayableItem) => {
    setBusyActionId(item.id);
    try {
      const res = await fetch(`/api/reports/accounting/payables/${encodeURIComponent(item.id)}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: item.remaining_amount }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        alert(json.message || 'Gagal melunasi hutang');
      } else {
        onRetry();
      }
    } catch (err: any) {
      alert(err.message || 'Gagal melunasi hutang');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleDeletePayable = async (item: AccountingPayableItem) => {
    if (!window.confirm(`Hapus hutang ${item.supplier_name} (${item.transaction_no})?`)) return;
    setBusyActionId(item.id);
    try {
      const res = await fetch(`/api/reports/accounting/payables/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        alert(json.message || 'Gagal menghapus hutang');
      } else {
        onRetry();
      }
    } catch (err: any) {
      alert(err.message || 'Gagal menghapus hutang');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleSettleReceivable = async (item: AccountingReceivableItem) => {
    if (item.source === 'HIMS_RESERVATION') {
      alert(
        `Piutang Reservasi ${item.transaction_no} (${item.customer_name}) terhubung langsung dengan Folio Kamar.\n\nSilakan lunasi melalui menu Transaksi & Folio -> Sheet Piutang agar pembayaran masuk ke Folio dan otomatis berpindah ke Sheet Selesai.`
      );
      return;
    }
    setBusyActionId(item.id);
    try {
      const res = await fetch(`/api/reports/accounting/receivables/${encodeURIComponent(item.id)}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: item.remaining_amount }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        alert(json.message || 'Gagal memproses pelunasan piutang');
      } else {
        onRetry();
      }
    } catch (err: any) {
      alert(err.message || 'Gagal memproses pelunasan piutang');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleDeleteReceivable = async (item: AccountingReceivableItem) => {
    if (!window.confirm(`Hapus piutang ${item.customer_name} (${item.transaction_no})?`)) return;
    setBusyActionId(item.id);
    try {
      const res = await fetch(`/api/reports/accounting/receivables/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        alert(json.message || 'Gagal menghapus piutang');
      } else {
        onRetry();
      }
    } catch (err: any) {
      alert(err.message || 'Gagal menghapus piutang');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleDeleteAsset = async (assetId: number, assetName: string) => {
    if (!window.confirm(`Hapus aset tetap "${assetName}"?`)) return;
    try {
      const res = await fetch(`/api/reports/accounting/assets/${assetId}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        alert(json.message || 'Gagal menghapus aset');
      } else {
        onRetry();
      }
    } catch (err: any) {
      alert(err.message || 'Gagal menghapus aset');
    }
  };

  const handleDeleteManualBank = async (manualId: number, bankName: string) => {
    if (!window.confirm(`Hapus rekening bank manual "${bankName}"?`)) return;
    try {
      const res = await fetch(`/api/reports/accounting/banks/${manualId}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        alert(json.message || 'Gagal menghapus rekening bank');
      } else {
        onRetry();
      }
    } catch (err: any) {
      alert(err.message || 'Gagal menghapus rekening bank');
    }
  };

  const handleDeleteCoa = async (coa: CoaAccountItem) => {
    if (coa.is_system) return;
    if (!window.confirm(`Hapus akun COA "${coa.account_number} - ${coa.account_name}"?`)) return;
    try {
      const res = await fetch(`/api/reports/accounting/coa/${coa.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        alert(json.message || 'Gagal menghapus akun COA');
      } else {
        onRetry();
      }
    } catch (err: any) {
      alert(err.message || 'Gagal menghapus akun COA');
    }
  };

  const handleExportJurnalExcel = () => {
    const headerRow = [
      '#',
      'BID / No. Ref',
      'Kategori',
      'Tanggal',
      'Keterangan',
      'Metode Bayar',
      'Uang Masuk',
      'Uang Keluar',
      'Saldo',
    ];
    const dataRows = filteredJournalRows.map((r) => [
      r.row_no,
      r.bid_or_ref,
      r.badge_type,
      r.tx_datetime,
      r.description,
      r.payment_method,
      r.cash_in,
      r.cash_out,
      r.running_balance,
    ]);
    downloadExportXml(`Jurnal_Umum_${startDate}_${endDate}.xls`, [
      {
        name: 'Jurnal Umum',
        rows: [headerRow, ...dataRows],
      },
    ]);
  };

  const pl = analytics.accounting_statements?.profit_loss;
  const bs = analytics.accounting_statements?.balance_sheet;
  const cf = analytics.accounting_statements?.cash_flow;

  return (
    <div className="space-y-5">
      {/* =====================================================================
          1. SUB-VIEW: TRANSAKSI (Ikhtisar Akuntansi Terintegrasi HIMS)
         ===================================================================== */}
      {subView === 'transaksi' && (
        <div className="space-y-5">
          <div className="bg-linear-to-r from-[#123524] via-[#1B4332] to-[#123524] rounded-2xl p-6 text-white shadow-md border border-emerald-800/40 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-[#E6C786]/20 text-[#E6C786] border border-[#E6C786]/40">
                Pusat Akuntansi Terintegrasi OAK HIMS
              </span>
              <h2 className="text-xl font-bold mt-2 text-[#FDFBF7]">
                Ikhtisar Transaksi & Buku Besar Akuntansi
              </h2>
              <p className="text-xs text-emerald-100/80 mt-1">
                Seluruh angka dihitung otomatis 100% dari transaksi real HIMS (Penjualan Kamar, POS, Pembelian, Pengeluaran, Sheet Piutang, & Aset).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => onChangeSubView('jurnal')}
                className="px-3.5 py-2 rounded-xl bg-[#E6C786] text-[#123524] text-xs font-bold hover:bg-[#d8b774] transition shadow-xs"
              >
                Buka Jurnal Umum →
              </button>
              <button
                onClick={() => onChangeSubView('neraca')}
                className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold border border-white/20 transition"
              >
                Lihat Neraca
              </button>
            </div>
          </div>

          {/* 4 Main Financial Pillar Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div
              onClick={() => onChangeSubView('laba_rugi')}
              className="cursor-pointer bg-white rounded-xl p-4 border border-slate-200/80 shadow-xs hover:border-emerald-700/40 transition"
            >
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>TOTAL PENDAPATAN (LABA RUGI)</span>
                <IconTrendingUp className="w-4 h-4 text-emerald-700" />
              </div>
              <div className="text-xl font-extrabold text-emerald-800 mt-2">
                {formatIdr(pl?.revenue.total_revenue || 0)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 flex items-center justify-between">
                <span>Laba Bersih:</span>
                <span className="font-bold text-slate-800">{formatIdr(pl?.net_profit || 0)}</span>
              </div>
            </div>

            <div
              onClick={() => onChangeSubView('arus_kas')}
              className="cursor-pointer bg-white rounded-xl p-4 border border-slate-200/80 shadow-xs hover:border-emerald-700/40 transition"
            >
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>SALDO KAS AKHIR (ARUS KAS)</span>
                <IconWallet className="w-4 h-4 text-emerald-700" />
              </div>
              <div className="text-xl font-extrabold text-slate-900 mt-2">
                {formatIdr(cf?.closing_cash_balance || 0)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 flex items-center justify-between">
                <span>Perubahan Kas Periode:</span>
                <span className="font-bold text-emerald-700">{formatIdr(cf?.net_cash_change || 0)}</span>
              </div>
            </div>

            <div
              onClick={() => onChangeSubView('piutang')}
              className="cursor-pointer bg-white rounded-xl p-4 border border-slate-200/80 shadow-xs hover:border-amber-600/40 transition"
            >
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>PIUTANG AKTIF (SHEET PIUTANG)</span>
                <IconTrendingUp className="w-4 h-4 text-amber-600" />
              </div>
              <div className="text-xl font-extrabold text-amber-700 mt-2">
                {formatIdr(subledger?.receivables.unpaid_total || 0)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 flex items-center justify-between">
                <span>Tagihan Belum Diterima:</span>
                <span className="font-bold text-slate-800">
                  {formatNumber(subledger?.receivables.unpaid_count || 0)} transaksi
                </span>
              </div>
            </div>

            <div
              onClick={() => onChangeSubView('hutang')}
              className="cursor-pointer bg-white rounded-xl p-4 border border-slate-200/80 shadow-xs hover:border-rose-600/40 transition"
            >
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>HUTANG USAHA BELUM LUNAS</span>
                <IconTrendingDown className="w-4 h-4 text-rose-600" />
              </div>
              <div className="text-xl font-extrabold text-rose-700 mt-2">
                {formatIdr(subledger?.payables.unpaid_total || 0)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 flex items-center justify-between">
                <span>Tagihan Supplier:</span>
                <span className="font-bold text-slate-800">
                  {formatNumber(subledger?.payables.unpaid_count || 0)} transaksi
                </span>
              </div>
            </div>
          </div>

          {/* Quick Navigation Grid for All 11 Sub-Menus */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-xs">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Modul Buku Besar & Sub-Ledger Akuntansi</h3>
                <p className="text-xs text-slate-500">
                  Klik salah satu modul untuk membuka rincian laporan atau mengelola data akuntansi.
                </p>
              </div>
              <span className="text-xs font-semibold text-emerald-800 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-200">
                Total Aset Neraca: {formatIdr(bs?.assets.total_assets || 0)}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {AKUNTANSI_SUBVIEW_OPTIONS.filter((o) => o.value !== 'transaksi').map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onChangeSubView(opt.value)}
                  className="flex items-center gap-3 p-3.5 rounded-xl border border-slate-200 hover:border-[#123524] hover:bg-emerald-50/40 text-left transition group"
                >
                  <div className="w-9 h-9 rounded-lg bg-[#123524]/10 text-[#123524] group-hover:bg-[#123524] group-hover:text-[#E6C786] flex items-center justify-center transition">
                    {opt.icon}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-800 group-hover:text-[#123524]">
                      {opt.label}
                    </div>
                    <div className="text-[11px] text-slate-500">Buka modul →</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          5. SUB-VIEW: JURNAL (Jurnal Umum — Kronologi Uang Masuk, Keluar & Saldo)
         ===================================================================== */}
      {subView === 'jurnal' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-700" />
                Jurnal Umum
              </h2>
              <p className="text-xs text-slate-500">
                Kronologi transaksi uang masuk, uang keluar, dan saldo berjalan dari seluruh aktivitas HIMS ({startDate} s/d {endDate}).
              </p>
            </div>
            <button
              onClick={handleExportJurnalExcel}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition"
            >
              <IconDownload className="w-3.5 h-3.5" />
              Export Excel
            </button>
          </div>

          {/* 4 Summary Cards matching ANKA reference in OAK Emerald/Gold */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-emerald-800">Total Uang Masuk</div>
              <div className="text-xl font-extrabold text-emerald-700 mt-1">
                {formatIdr(subledger?.general_journal.total_in || 0)}
              </div>
            </div>
            <div className="bg-rose-50/70 border border-rose-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-rose-800">Total Uang Keluar</div>
              <div className="text-xl font-extrabold text-rose-600 mt-1">
                {formatIdr(subledger?.general_journal.total_out || 0)}
              </div>
            </div>
            <div className="bg-[#FDFBF7] border border-[#E6C786] rounded-xl p-4">
              <div className="text-xs font-semibold text-[#123524]">Saldo Akhir</div>
              <div className="text-xl font-extrabold text-[#123524] mt-1">
                {formatIdr(subledger?.general_journal.closing_balance || 0)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-500">Jumlah Transaksi</div>
              <div className="text-xl font-extrabold text-slate-900 mt-1">
                {formatNumber(filteredJournalRows.length)}
              </div>
            </div>
          </div>

          {/* Search & Category Filter */}
          <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="relative flex-1">
              <IconSearch className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={jurnalSearch}
                onChange={(e) => setJurnalSearch(e.target.value)}
                placeholder="Cari BID, nomor transaksi, atau keterangan..."
                className="w-full pl-9 pr-4 py-2 text-xs rounded-lg border border-slate-200 focus:outline-hidden focus:ring-2 focus:ring-emerald-700"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(['ALL', 'Penjualan', 'Pemasukan', 'Pengeluaran', 'Pembelian', 'Transfer Investor'] as const).map(
                (cat) => (
                  <button
                    key={cat}
                    onClick={() => setJurnalBadgeFilter(cat)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                      jurnalBadgeFilter === cat
                        ? 'bg-[#123524] text-[#E6C786]'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {cat === 'ALL' ? 'Semua' : cat}
                  </button>
                )
              )}
            </div>
          </div>

          {/* Journal Table */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-3 font-semibold w-12">#</th>
                    <th className="py-3 px-3 font-semibold">BID / No. Ref</th>
                    <th className="py-3 px-3 font-semibold">Tanggal</th>
                    <th className="py-3 px-3 font-semibold">Keterangan</th>
                    <th className="py-3 px-3 font-semibold">Metode Bayar</th>
                    <th className="py-3 px-3 font-semibold text-right">Uang Masuk</th>
                    <th className="py-3 px-3 font-semibold text-right">Uang Keluar</th>
                    <th className="py-3 px-3 font-semibold text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredJournalRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-400">
                        Belum ada transaksi jurnal pada periode ini.
                      </td>
                    </tr>
                  ) : (
                    filteredJournalRows.map((row, idx) => {
                      const badgeColor =
                        row.badge_type === 'Penjualan'
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          : row.badge_type === 'Pemasukan'
                          ? 'bg-teal-50 text-teal-800 border-teal-200'
                          : row.badge_type === 'Pembelian'
                          ? 'bg-amber-50 text-amber-800 border-amber-200'
                          : row.badge_type === 'Transfer Investor'
                          ? 'bg-purple-50 text-purple-800 border-purple-200'
                          : 'bg-rose-50 text-rose-800 border-rose-200';
                      return (
                        <tr key={row.id} className="hover:bg-emerald-50/30 transition">
                          <td className="py-3 px-3 text-slate-500 font-medium">{idx + 1}</td>
                          <td className="py-3 px-3">
                            <div className="font-bold text-slate-800">{row.bid_or_ref}</div>
                            <span
                              className={`inline-block mt-0.5 px-2 py-0.2 rounded-md text-[10px] font-semibold border ${badgeColor}`}
                            >
                              {row.badge_type}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-slate-600 whitespace-nowrap">{row.tx_datetime}</td>
                          <td className="py-3 px-3 text-slate-800 font-medium">{row.description}</td>
                          <td className="py-3 px-3">
                            <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-semibold text-[11px]">
                              {row.payment_method}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right font-bold text-emerald-700 whitespace-nowrap">
                            {row.cash_in > 0 ? formatIdr(row.cash_in) : '-'}
                          </td>
                          <td className="py-3 px-3 text-right font-bold text-rose-600 whitespace-nowrap">
                            {row.cash_out > 0 ? formatIdr(row.cash_out) : '-'}
                          </td>
                          <td className="py-3 px-3 text-right font-extrabold text-slate-900 whitespace-nowrap">
                            {formatIdr(row.running_balance)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          6. SUB-VIEW: HUTANG (Semua Hutang — Pembelian HIMS + Hutang Manual)
         ===================================================================== */}
      {subView === 'hutang' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">Semua Hutang</h2>
              <p className="text-xs text-slate-500">
                Terintegrasi otomatis dengan Transaksi Pembelian HIMS & pencatatan hutang usaha manual.
              </p>
            </div>
            <button
              onClick={() => setShowAddPayableModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition"
            >
              + Tambah Hutang
            </button>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { key: 'ALL', label: 'Semua' },
                  { key: 'UNPAID', label: 'Belum Bayar' },
                  { key: 'PARTIAL', label: 'Sebagian' },
                  { key: 'PAID', label: 'Lunas' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setHutangFilter(tab.key)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
                    hutangFilter === tab.key
                      ? 'bg-[#123524] text-[#E6C786]'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-72">
              <IconSearch className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={hutangSearch}
                onChange={(e) => setHutangSearch(e.target.value)}
                placeholder="Cari supplier atau transaksi..."
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-200"
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold">Supplier</th>
                    <th className="py-3 px-4 font-semibold">Transaksi</th>
                    <th className="py-3 px-4 font-semibold text-right">Total</th>
                    <th className="py-3 px-4 font-semibold text-right">Sudah Bayar</th>
                    <th className="py-3 px-4 font-semibold text-right">Sisa</th>
                    <th className="py-3 px-4 font-semibold">Jatuh Tempo</th>
                    <th className="py-3 px-4 font-semibold text-center">Status</th>
                    <th className="py-3 px-4 font-semibold text-center">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredPayables.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-400">
                        Tidak ada data hutang pada filter ini.
                      </td>
                    </tr>
                  ) : (
                    filteredPayables.map((item) => (
                      <tr key={item.id} className="hover:bg-emerald-50/30 transition">
                        <td className="py-3 px-4 font-bold text-slate-900">
                          {item.supplier_name}
                          <div className="text-[10px] font-normal text-slate-400">
                            {item.source === 'HIMS_PURCHASE' ? 'Pembelian HIMS' : 'Hutang Manual'}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-semibold text-emerald-800">{item.transaction_no}</td>
                        <td className="py-3 px-4 text-right font-bold text-slate-800">
                          {formatIdr(item.total_amount)}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold text-emerald-700">
                          {formatIdr(item.paid_amount)}
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-rose-600">
                          {formatIdr(item.remaining_amount)}
                        </td>
                        <td className="py-3 px-4 text-slate-600">{formatMediumDateId(item.due_date)}</td>
                        <td className="py-3 px-4 text-center">
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                              item.status === 'PAID'
                                ? 'bg-emerald-100 text-emerald-800'
                                : item.status === 'PARTIAL'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {item.status === 'PAID'
                              ? 'Lunas'
                              : item.status === 'PARTIAL'
                              ? 'Sebagian'
                              : 'Belum Bayar'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            {item.status !== 'PAID' && (
                              <button
                                disabled={busyActionId === item.id}
                                onClick={() => handleSettlePayable(item)}
                                className="px-2.5 py-1 rounded-md bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-bold disabled:opacity-50"
                              >
                                Lunasi
                              </button>
                            )}
                            {item.source === 'MANUAL' && (
                              <button
                                disabled={busyActionId === item.id}
                                onClick={() => handleDeletePayable(item)}
                                className="px-2.5 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-semibold"
                              >
                                Hapus
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr className="bg-emerald-950/5 font-extrabold text-slate-900 border-t border-slate-200">
                    <td colSpan={2} className="py-3 px-4">
                      Total ({filteredPayables.length} transaksi)
                    </td>
                    <td className="py-3 px-4 text-right">
                      {formatIdr(filteredPayables.reduce((s, i) => s + i.total_amount, 0))}
                    </td>
                    <td className="py-3 px-4 text-right text-emerald-700">
                      Dibayar: {formatIdr(filteredPayables.reduce((s, i) => s + i.paid_amount, 0))}
                    </td>
                    <td className="py-3 px-4 text-right text-rose-600">
                      Belum dibayar: {formatIdr(filteredPayables.reduce((s, i) => s + i.remaining_amount, 0))}
                    </td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          7. SUB-VIEW: PIUTANG (Semua Piutang — Sheet Piutang Reservasi + Manual)
         ===================================================================== */}
      {subView === 'piutang' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">Semua Piutang</h2>
              <p className="text-xs text-slate-500">
                Otomatis menarik seluruh reservasi Check-Out yang belum lunas dari Sheet Piutang HIMS & piutang manual.
              </p>
            </div>
            <button
              onClick={() => setShowAddReceivableModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition"
            >
              + Tambah Piutang
            </button>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { key: 'ALL', label: 'Semua' },
                  { key: 'UNPAID', label: 'Belum Terima' },
                  { key: 'PARTIAL', label: 'Sebagian' },
                  { key: 'PAID', label: 'Lunas' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setPiutangFilter(tab.key)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
                    piutangFilter === tab.key
                      ? 'bg-[#123524] text-[#E6C786]'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-72">
              <IconSearch className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={piutangSearch}
                onChange={(e) => setPiutangSearch(e.target.value)}
                placeholder="Cari pelanggan atau transaksi..."
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-200"
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold">Pelanggan</th>
                    <th className="py-3 px-4 font-semibold">Transaksi</th>
                    <th className="py-3 px-4 font-semibold text-right">Total</th>
                    <th className="py-3 px-4 font-semibold text-right">Sudah Terima</th>
                    <th className="py-3 px-4 font-semibold text-right">Sisa</th>
                    <th className="py-3 px-4 font-semibold">Jatuh Tempo</th>
                    <th className="py-3 px-4 font-semibold text-center">Status</th>
                    <th className="py-3 px-4 font-semibold text-center">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredReceivables.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-10 text-center text-slate-400">
                        Tidak ada data piutang pada filter ini.
                      </td>
                    </tr>
                  ) : (
                    filteredReceivables.map((item) => (
                      <tr key={item.id} className="hover:bg-emerald-50/30 transition">
                        <td className="py-3 px-4 font-bold text-slate-900">
                          {item.customer_name}
                          {item.room_summary && (
                            <div className="text-[10px] font-normal text-slate-500">{item.room_summary}</div>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-bold text-emerald-800">{item.transaction_no}</div>
                          <span className="text-[10px] text-slate-400">
                            {item.source === 'HIMS_RESERVATION' ? 'Sheet Piutang HIMS' : 'Piutang Manual'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-slate-800">
                          {formatIdr(item.total_amount)}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold text-emerald-700">
                          {formatIdr(item.paid_amount)}
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-rose-600">
                          {formatIdr(item.remaining_amount)}
                        </td>
                        <td className="py-3 px-4 text-slate-600">{formatMediumDateId(item.due_date)}</td>
                        <td className="py-3 px-4 text-center">
                          <span
                            className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${
                              item.status === 'PAID'
                                ? 'bg-emerald-100 text-emerald-800'
                                : item.status === 'PARTIAL'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {item.status === 'PAID'
                              ? 'Lunas'
                              : item.status === 'PARTIAL'
                              ? 'Sebagian'
                              : 'Belum Terima'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            {item.status !== 'PAID' && (
                              <button
                                disabled={busyActionId === item.id}
                                onClick={() => handleSettleReceivable(item)}
                                className="px-2.5 py-1 rounded-md bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-bold disabled:opacity-50"
                              >
                                {item.source === 'HIMS_RESERVATION' ? 'Info Folio' : 'Terima'}
                              </button>
                            )}
                            {item.source === 'MANUAL' && (
                              <button
                                disabled={busyActionId === item.id}
                                onClick={() => handleDeleteReceivable(item)}
                                className="px-2.5 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-semibold"
                              >
                                Hapus
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr className="bg-emerald-950/5 font-extrabold text-slate-900 border-t border-slate-200">
                    <td colSpan={2} className="py-3 px-4">
                      Total
                    </td>
                    <td className="py-3 px-4 text-right">
                      {formatIdr(filteredReceivables.reduce((s, i) => s + i.total_amount, 0))}
                    </td>
                    <td className="py-3 px-4 text-right text-emerald-700">
                      Diterima: {formatIdr(filteredReceivables.reduce((s, i) => s + i.paid_amount, 0))}
                    </td>
                    <td className="py-3 px-4 text-right text-rose-600">
                      Belum diterima: {formatIdr(filteredReceivables.reduce((s, i) => s + i.remaining_amount, 0))}
                    </td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          8. SUB-VIEW: ASET (Daftar Aset Tetap — Terintegrasi ke COA 12000 & Neraca)
         ===================================================================== */}
      {subView === 'aset' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
                Aset
                <span className="text-xs font-semibold text-slate-500">
                  ({subledger?.fixed_assets.active_count || 0} aktif · Total nilai:{' '}
                  <strong className="text-emerald-800">
                    {formatIdr(subledger?.fixed_assets.active_total_value || 0)}
                  </strong>
                  )
                </span>
              </h2>
              <p className="text-xs text-slate-500">
                Total nilai aset aktif otomatis mengisi akun <code className="font-bold">12000 - Aset Tetap</code> di Daftar Akun (COA) dan Laporan Neraca.
              </p>
            </div>
            <button
              onClick={() => setShowAddAssetModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition"
            >
              + Tambah Aset
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            {(subledger?.fixed_assets.items || []).length === 0 ? (
              <div className="py-14 text-center">
                <IconPackage className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                <div className="text-sm font-bold text-slate-600">Belum ada data aset</div>
                <p className="text-xs text-slate-400 mt-1">
                  Klik tombol &ldquo;+ Tambah Aset&rdquo; untuk mencatat inventaris & aset tetap hotel.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#123524] text-white text-left">
                      <th className="py-3 px-4 font-semibold">Nama Aset</th>
                      <th className="py-3 px-4 font-semibold">Kategori</th>
                      <th className="py-3 px-4 font-semibold">Tanggal Beli</th>
                      <th className="py-3 px-4 font-semibold text-right">Harga Beli</th>
                      <th className="py-3 px-4 font-semibold text-right">Nilai Saat Ini</th>
                      <th className="py-3 px-4 font-semibold text-center">Depresiasi</th>
                      <th className="py-3 px-4 font-semibold">Catatan</th>
                      <th className="py-3 px-4 font-semibold text-center">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(subledger?.fixed_assets.items || []).map((asset) => (
                      <tr key={asset.id} className="hover:bg-emerald-50/30 transition">
                        <td className="py-3 px-4 font-bold text-slate-900">{asset.asset_name}</td>
                        <td className="py-3 px-4">
                          <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold text-[11px]">
                            {asset.category}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-600">{formatMediumDateId(asset.purchase_date)}</td>
                        <td className="py-3 px-4 text-right font-semibold text-slate-700">
                          {formatIdr(asset.purchase_price)}
                        </td>
                        <td className="py-3 px-4 text-right font-extrabold text-emerald-800">
                          {formatIdr(asset.current_value)}
                        </td>
                        <td className="py-3 px-4 text-center text-slate-600">
                          {asset.depreciation_rate}% / thn
                        </td>
                        <td className="py-3 px-4 text-slate-500">{asset.notes || '-'}</td>
                        <td className="py-3 px-4 text-center">
                          <button
                            onClick={() => handleDeleteAsset(asset.id, asset.asset_name)}
                            className="px-2.5 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-semibold"
                          >
                            Hapus
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          9. SUB-VIEW: LIST BANK (Rekening Auto Metode Bayar HIMS + Manual + Transfer Investor)
         ===================================================================== */}
      {subView === 'list_bank' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">List Bank</h2>
              <p className="text-xs text-slate-500">
                Saldo otomatis dari metode pembayaran HIMS dikurangi Transfer Investor, ditambah rekening manual.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowInvestorTransferModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 text-xs font-bold transition"
              >
                Transfer Investor
              </button>
              <button
                onClick={() => setShowAddBankModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition"
              >
                + Tambah Bank
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold">Nama Bank</th>
                    <th className="py-3 px-4 font-semibold">No. Rekening</th>
                    <th className="py-3 px-4 font-semibold">Atas Nama</th>
                    <th className="py-3 px-4 font-semibold text-right">Saldo</th>
                    <th className="py-3 px-4 font-semibold text-center">Sumber</th>
                    <th className="py-3 px-4 font-semibold text-center">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(subledger?.bank_list || []).map((bank) => (
                    <tr key={bank.id} className="hover:bg-emerald-50/30 transition">
                      <td className="py-3.5 px-4 font-bold text-slate-900 flex items-center gap-2">
                        <span>{bank.bank_name}</span>
                        {bank.source_type === 'AUTO' && (
                          <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-bold">
                            Auto
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-slate-600">{bank.account_number}</td>
                      <td className="py-3.5 px-4 text-slate-600">{bank.account_holder}</td>
                      <td className="py-3.5 px-4 text-right font-extrabold text-emerald-700">
                        {formatIdr(bank.balance)}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-semibold">
                          {bank.source_type === 'AUTO' ? 'Metode Bayar' : 'Rekening Manual'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        {bank.source_type === 'MANUAL' && bank.manual_id ? (
                          <button
                            onClick={() => handleDeleteManualBank(bank.manual_id!, bank.bank_name)}
                            className="px-2.5 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-semibold"
                          >
                            Hapus
                          </button>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Riwayat Transfer ke Investor */}
          {(subledger?.investor_transfers || []).length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              <div className="px-4 py-3 bg-[#FDFBF7] border-b border-slate-200 flex items-center justify-between">
                <h3 className="text-xs font-extrabold text-[#123524] uppercase tracking-wider">
                  Riwayat Transfer ke Investor
                </h3>
                <span className="text-xs font-bold text-rose-700">
                  Total Periode Ini: {formatIdr(subledger?.period_investor_transfers || 0)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600 text-left">
                      <th className="py-2.5 px-4 font-semibold">Tanggal</th>
                      <th className="py-2.5 px-4 font-semibold">Nama Investor</th>
                      <th className="py-2.5 px-4 font-semibold">Dari Akun</th>
                      <th className="py-2.5 px-4 font-semibold">Keterangan</th>
                      <th className="py-2.5 px-4 font-semibold text-right">Jumlah</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(subledger?.investor_transfers || []).map((tr) => (
                      <tr key={tr.id}>
                        <td className="py-2.5 px-4 text-slate-600">{formatMediumDateId(tr.transfer_date)}</td>
                        <td className="py-2.5 px-4 font-bold text-slate-800">{tr.investor_name}</td>
                        <td className="py-2.5 px-4 font-semibold text-emerald-800">{tr.source_account}</td>
                        <td className="py-2.5 px-4 text-slate-500">{tr.notes || '-'}</td>
                        <td className="py-2.5 px-4 text-right font-bold text-rose-600">
                          {formatIdr(tr.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          10. SUB-VIEW: DAFTAR AKUN (Chart of Accounts — COA)
         ===================================================================== */}
      {subView === 'daftar_akun' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">
                Daftar Akun (Chart of Accounts)
              </h2>
              <p className="text-xs text-slate-500">
                Saldo tiap akun terhubung langsung dengan Kas & Bank, Sheet Piutang, Persediaan, Aset Tetap, Hutang Usaha, dan Neraca.
              </p>
            </div>
            <button
              onClick={() => setCoaModalItem(null)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition"
            >
              + Tambah Akun
            </button>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-3">
            <div className="relative">
              <IconSearch className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={coaSearch}
                onChange={(e) => setCoaSearch(e.target.value)}
                placeholder="Cari nama atau nomor akun..."
                className="w-full pl-9 pr-4 py-2 text-xs rounded-lg border border-slate-200"
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold">Nomor Akun</th>
                    <th className="py-3 px-4 font-semibold">Nama Akun</th>
                    <th className="py-3 px-4 font-semibold text-center">Klasifikasi</th>
                    <th className="py-3 px-4 font-semibold text-right">Saldo Awal</th>
                    <th className="py-3 px-4 font-semibold text-right">Saldo Akhir (Live HIMS)</th>
                    <th className="py-3 px-4 font-semibold text-center">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredCoa.map((acc) => (
                    <tr key={acc.account_number} className="hover:bg-emerald-50/30 transition">
                      <td className="py-3.5 px-4 font-bold text-slate-700">{acc.account_number}</td>
                      <td className="py-3.5 px-4 font-bold text-emerald-900">{acc.account_name}</td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-[11px] font-semibold">
                          {acc.classification}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right text-slate-500 font-medium">
                        {formatIdr(acc.opening_balance)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-extrabold text-slate-900">
                        {formatIdr(acc.current_balance)}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => setCoaModalItem(acc)}
                            className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold"
                          >
                            Edit Saldo Awal
                          </button>
                          {!acc.is_system && (
                            <button
                              onClick={() => handleDeleteCoa(acc)}
                              className="px-2.5 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-semibold"
                            >
                              Hapus
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          11. SUB-VIEW: DATA PPN (Rekap Pajak PPN Keluaran Kamar & POS vs PPN Masukan)
         ===================================================================== */}
      {subView === 'data_ppn' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">
                Data PPN ({subledger?.ppn_summary.tax_percentage || 11}%)
              </h2>
              <p className="text-xs text-slate-500">
                Rekapitulasi Pajak Pertambahan Nilai (PPN) dari transaksi Kamar, Resto/POS, dan Pembelian.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-500">PPN Penjualan Kamar</div>
              <div className="text-xl font-extrabold text-emerald-800 mt-1">
                {formatIdr(subledger?.ppn_summary.room_tax_total || 0)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-500">PPN Penjualan POS</div>
              <div className="text-xl font-extrabold text-emerald-700 mt-1">
                {formatIdr(subledger?.ppn_summary.pos_tax_total || 0)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-500">PPN Masukan (Pembelian)</div>
              <div className="text-xl font-extrabold text-amber-700 mt-1">
                {formatIdr(subledger?.ppn_summary.purchase_tax_total || 0)}
              </div>
            </div>
            <div className="bg-[#FDFBF7] border border-[#E6C786] rounded-xl p-4">
              <div className="text-xs font-semibold text-[#123524]">Total PPN Keluaran Bersih</div>
              <div className="text-xl font-extrabold text-[#123524] mt-1">
                {formatIdr(subledger?.ppn_summary.net_ppn_payable || 0)}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-1.5">
            {(
              [
                { key: 'ALL', label: 'Semua Sumber' },
                { key: 'KAMAR', label: 'Kamar' },
                { key: 'POS', label: 'POS / Resto' },
                { key: 'PEMBELIAN', label: 'Pembelian' },
              ] as const
            ).map((f) => (
              <button
                key={f.key}
                onClick={() => setPpnSourceFilter(f.key)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition ${
                  ppnSourceFilter === f.key
                    ? 'bg-[#123524] text-[#E6C786]'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold">Tanggal</th>
                    <th className="py-3 px-4 font-semibold">No. Referensi / BID</th>
                    <th className="py-3 px-4 font-semibold">Sumber</th>
                    <th className="py-3 px-4 font-semibold">Pelanggan / Supplier</th>
                    <th className="py-3 px-4 font-semibold text-right">DPP</th>
                    <th className="py-3 px-4 font-semibold text-right">PPN</th>
                    <th className="py-3 px-4 font-semibold text-right">Total Nilai</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredPpnRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400">
                        Tidak ada baris PPN tercatat pada filter/periode ini.
                      </td>
                    </tr>
                  ) : (
                    filteredPpnRows.map((row) => (
                      <tr key={row.id} className="hover:bg-emerald-50/30 transition">
                        <td className="py-3 px-4 text-slate-600">{formatMediumDateId(row.tx_date)}</td>
                        <td className="py-3 px-4 font-bold text-slate-800">{row.ref_no}</td>
                        <td className="py-3 px-4">
                          <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-bold">
                            {row.source}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-medium text-slate-800">{row.party_name}</td>
                        <td className="py-3 px-4 text-right text-slate-600">{formatIdr(row.dpp_amount)}</td>
                        <td className="py-3 px-4 text-right font-bold text-emerald-700">
                          {formatIdr(row.ppn_amount)}
                        </td>
                        <td className="py-3 px-4 text-right font-extrabold text-slate-900">
                          {formatIdr(row.total_amount)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          INTERACTIVE MODALS
         ===================================================================== */}
      {coaModalItem !== undefined && (
        <CoaAccountModal
          propertyId={propertyId}
          initial={coaModalItem}
          onClose={() => setCoaModalItem(undefined)}
          onSaved={onRetry}
        />
      )}
      {showAddBankModal && (
        <AddBankModal
          propertyId={propertyId}
          onClose={() => setShowAddBankModal(false)}
          onSaved={onRetry}
        />
      )}
      {showInvestorTransferModal && (
        <InvestorTransferModal
          propertyId={propertyId}
          banks={subledger?.bank_list || []}
          defaultDate={endDate}
          onClose={() => setShowInvestorTransferModal(false)}
          onSaved={onRetry}
        />
      )}
      {showAddAssetModal && (
        <AddAssetModal
          propertyId={propertyId}
          defaultDate={endDate}
          onClose={() => setShowAddAssetModal(false)}
          onSaved={onRetry}
        />
      )}
      {showAddPayableModal && (
        <AddPayableOrReceivableModal
          mode="PAYABLE"
          propertyId={propertyId}
          onClose={() => setShowAddPayableModal(false)}
          onSaved={onRetry}
        />
      )}
      {showAddReceivableModal && (
        <AddPayableOrReceivableModal
          mode="RECEIVABLE"
          propertyId={propertyId}
          onClose={() => setShowAddReceivableModal(false)}
          onSaved={onRetry}
        />
      )}
    </div>
  );
};
