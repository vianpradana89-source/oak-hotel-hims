import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, Image as ImageIcon, Pencil, Trash2 } from 'lucide-react';
import { authenticatedFetch } from '../../../lib/authenticatedFetch';
import { PaymentProofModal } from '../../transactions/PaymentProofModal';
import { PurchaseItemsSummaryModal } from '../../transactions/PurchaseItemsSummaryModal';
import { buildTransactionAttachmentFilePath } from '../../common/securePrivateMedia';
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
import { downloadAssetsXlsx, parseUploadedAssetsFile } from './xlsxAsetUtils';
import {
  AddAssetModal,
  AddBankModal,
  AddPayableOrReceivableModal,
  AssetPhotoQuickModal,
  CoaAccountModal,
  ConfirmDeleteModal,
  InvestorTransferModal,
  SettlePaymentModal,
} from './akuntansiModals';
import type { DailyOperationsData } from './useDailyOperations';
import type {
  AccountingPayableItem,
  AccountingReceivableItem,
  AnalyticsHubData,
  CoaAccountItem,
  FinancialsData,
  FixedAssetItem,
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
  | 'data_ppn'
  | 'data_service_charge';

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
  { value: 'data_service_charge', label: 'Data Service Charge', icon: <IconBadgePercent className="w-3.5 h-3.5" /> },
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
  const [serviceSourceFilter, setServiceSourceFilter] = useState<'ALL' | 'KAMAR' | 'POS'>('ALL');

  // Modals
  const [coaModalItem, setCoaModalItem] = useState<CoaAccountItem | null | undefined>(undefined);
  const [showAddBankModal, setShowAddBankModal] = useState(false);
  const [showInvestorTransferModal, setShowInvestorTransferModal] = useState(false);
  const [showAddAssetModal, setShowAddAssetModal] = useState(false);
  const [editingAssetItem, setEditingAssetItem] = useState<FixedAssetItem | null>(null);
  const [quickPhotoAsset, setQuickPhotoAsset] = useState<FixedAssetItem | null>(null);
  const [showAddPayableModal, setShowAddPayableModal] = useState(false);
  const [showAddReceivableModal, setShowAddReceivableModal] = useState(false);

  // Asset filter, sort, & search state
  const [assetSearch, setAssetSearch] = useState('');
  const [assetCategoryFilter, setAssetCategoryFilter] = useState('ALL');
  const [assetLocationFilter, setAssetLocationFilter] = useState('ALL');
  const [assetBrandFilter, setAssetBrandFilter] = useState('ALL');
  const [assetSortBy, setAssetSortBy] = useState<
    'NEWEST' | 'CATEGORY' | 'LOCATION' | 'BRAND' | 'NAME' | 'VALUE_DESC'
  >('NEWEST');

  // Settle modal state (Gambar 2 reference popup)
  const [settleModalState, setSettleModalState] = useState<{
    mode: 'PAYABLE' | 'RECEIVABLE';
    item: AccountingPayableItem | AccountingReceivableItem;
  } | null>(null);

  // Payables extras: Popover, Summary modal, Proof modal
  const [activeBankPopoverPayable, setActiveBankPopoverPayable] = useState<AccountingPayableItem | null>(null);
  const [bankPopoverPos, setBankPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [bankCopiedField, setBankCopiedField] = useState<string | null>(null);
  const [selectedSummaryPayable, setSelectedSummaryPayable] = useState<AccountingPayableItem | null>(null);
  const [selectedProofModal, setSelectedProofModal] = useState<{ filePath: string; title: string } | null>(null);

  const handleCopyText = async (fieldKey: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setBankCopiedField(fieldKey);
      setTimeout(() => setBankCopiedField(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleOpenBankPopover = (item: AccountingPayableItem, e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const popoverWidth = 280;
    let left = rect.left + window.scrollX;
    if (left + popoverWidth > window.innerWidth - 16) {
      left = window.innerWidth - popoverWidth - 16;
    }
    setBankPopoverPos({
      top: rect.bottom + window.scrollY + 6,
      left: Math.max(16, left),
    });
    setActiveBankPopoverPayable(item);
  };

  useEffect(() => {
    if (!activeBankPopoverPayable) return;
    const handleDown = (e: MouseEvent) => {
      const el = document.getElementById('payable-bank-popover');
      if (el && !el.contains(e.target as Node)) {
        setActiveBankPopoverPayable(null);
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [activeBankPopoverPayable]);

  // Confirm delete modal state
  const [confirmDeleteState, setConfirmDeleteState] = useState<{
    title: string;
    description: string;
    endpoint: string;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // XLSX Import ref & state
  const assetFileInputRef = useRef<HTMLInputElement | null>(null);
  const [importingXlsx, setImportingXlsx] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);

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

  // Filtered Service Charge rows
  const filteredServiceChargeRows = useMemo(() => {
    const rows = subledger?.service_charge_summary?.rows || [];
    if (serviceSourceFilter === 'ALL') return rows;
    return rows.filter((r) => r.source === serviceSourceFilter);
  }, [subledger, serviceSourceFilter]);

  // Asset filter options & filtered/sorted assets
  const assetCategoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of subledger?.fixed_assets.items || []) {
      if (a.category && a.category.trim()) set.add(a.category.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [subledger]);

  const assetLocationOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of subledger?.fixed_assets.items || []) {
      const loc = (a.storage_location || '').trim();
      if (loc && loc !== '-') set.add(loc);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [subledger]);

  const assetBrandOptions = useMemo(() => {
    const set = new Set<string>();
    for (const a of subledger?.fixed_assets.items || []) {
      const br = (a.brand || '').trim();
      if (br && br !== '-') set.add(br);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [subledger]);

  const filteredAndSortedAssets = useMemo(() => {
    const items = subledger?.fixed_assets.items || [];
    const q = assetSearch.trim().toLowerCase();
    const filtered = items.filter((a) => {
      if (assetCategoryFilter !== 'ALL' && a.category !== assetCategoryFilter) return false;
      if (
        assetLocationFilter !== 'ALL' &&
        (a.storage_location || '-') !== assetLocationFilter
      ) {
        return false;
      }
      if (assetBrandFilter !== 'ALL' && (a.brand || '-') !== assetBrandFilter) return false;
      if (!q) return true;
      const codeStr = (a.asset_code || `AST-${String(a.id).padStart(4, '0')}`).toLowerCase();
      return (
        codeStr.includes(q) ||
        (a.asset_name || '').toLowerCase().includes(q) ||
        (a.brand || '').toLowerCase().includes(q) ||
        (a.serial_number || '').toLowerCase().includes(q) ||
        (a.storage_location || '').toLowerCase().includes(q) ||
        (a.category || '').toLowerCase().includes(q) ||
        (a.notes || '').toLowerCase().includes(q)
      );
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (assetSortBy === 'CATEGORY') {
        return (a.category || '').localeCompare(b.category || '') || b.id - a.id;
      }
      if (assetSortBy === 'LOCATION') {
        return (
          (a.storage_location || '-').localeCompare(b.storage_location || '-') || b.id - a.id
        );
      }
      if (assetSortBy === 'BRAND') {
        return (a.brand || '-').localeCompare(b.brand || '-') || b.id - a.id;
      }
      if (assetSortBy === 'NAME') {
        return (a.asset_name || '').localeCompare(b.asset_name || '') || b.id - a.id;
      }
      if (assetSortBy === 'VALUE_DESC') {
        return Number(b.current_value || 0) - Number(a.current_value || 0) || b.id - a.id;
      }
      return b.id - a.id;
    });
    return sorted;
  }, [
    subledger,
    assetSearch,
    assetCategoryFilter,
    assetLocationFilter,
    assetBrandFilter,
    assetSortBy,
  ]);

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

  const executeConfirmDelete = async () => {
    if (!confirmDeleteState) return;
    setDeleteBusy(true);
    try {
      const res = await authenticatedFetch(confirmDeleteState.endpoint, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        alert(json.message || 'Gagal menghapus data');
      } else {
        setConfirmDeleteState(null);
        onRetry();
      }
    } catch (err: any) {
      alert(err.message || 'Gagal menghapus data');
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleExportAssetsXlsx = () => {
    const items = subledger?.fixed_assets.items || [];
    downloadAssetsXlsx(`Data_Aset_Tetap_HIMS_${endDate}.xlsx`, items);
  };

  const handleImportAssetsFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImportingXlsx(true);
    setImportNotice(null);
    try {
      const parsedRows = await parseUploadedAssetsFile(file);
      if (parsedRows.length === 0) {
        throw new Error(
          'Tidak ditemukan baris aset yang valid di dalam file. Pastikan kolom pertama berisi Nama Aset.'
        );
      }
      const res = await authenticatedFetch('/api/reports/accounting/assets/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: propertyId,
          items: parsedRows,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status === 'ERROR') {
        throw new Error(json.message || 'Gagal mengimpor file XLSX');
      }
      setImportNotice(`Berhasil mengimpor ${json.imported_count || parsedRows.length} data aset tetap.`);
      onRetry();
    } catch (err: any) {
      alert(err.message || 'Gagal membaca/mengimpor file XLSX');
    } finally {
      setImportingXlsx(false);
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
            <div className="overflow-auto max-h-[calc(100vh-270px)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-3 font-semibold w-12 bg-[#123524]">#</th>
                    <th className="py-3 px-3 font-semibold bg-[#123524]">BID / No. Ref</th>
                    <th className="py-3 px-3 font-semibold bg-[#123524]">Tanggal</th>
                    <th className="py-3 px-3 font-semibold bg-[#123524]">Keterangan</th>
                    <th className="py-3 px-3 font-semibold bg-[#123524]">Metode Bayar</th>
                    <th className="py-3 px-3 font-semibold text-right bg-[#123524]">Uang Masuk</th>
                    <th className="py-3 px-3 font-semibold text-right bg-[#123524]">Uang Keluar</th>
                    <th className="py-3 px-3 font-semibold text-right bg-[#123524]">Saldo</th>
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
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition cursor-pointer"
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
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
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
            <div className="overflow-auto max-h-[calc(100vh-270px)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Supplier</th>
                    <th className="py-3 px-3 font-semibold text-center bg-[#123524]">Rekening Supplier</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Transaksi</th>
                    <th className="py-3 px-3 font-semibold text-center bg-[#123524]">Lokasi Gudang</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Total</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Sudah Bayar</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Sisa</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Jatuh Tempo</th>
                    <th className="py-3 px-3 font-semibold text-center bg-[#123524]">Bukti Bayar</th>
                    <th className="py-3 px-4 font-semibold text-center bg-[#123524]">Status</th>
                    <th className="py-3 px-4 font-semibold text-center bg-[#123524]">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredPayables.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="py-10 text-center text-slate-400">
                        Tidak ada data hutang pada filter ini.
                      </td>
                    </tr>
                  ) : (
                    filteredPayables.map((item) => (
                      <tr key={item.id} className="hover:bg-emerald-50/30 transition">
                        {/* 1. Supplier */}
                        <td className="py-3 px-4 font-bold text-slate-900">
                          {item.supplier_name}
                          <div className="text-[10px] font-normal text-slate-400">
                            {item.source === 'HIMS_PURCHASE' ? 'Pembelian HIMS' : 'Hutang Manual'}
                          </div>
                        </td>
                        {/* 2. Rekening Supplier (kiri Transaksi) */}
                        <td className="py-3 px-3 text-center">
                          <button
                            type="button"
                            onClick={(e) => handleOpenBankPopover(item, e)}
                            onMouseEnter={(e) => handleOpenBankPopover(item, e)}
                            className="inline-flex items-center justify-center p-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 transition-colors cursor-pointer"
                            title="Lihat Rekening, Kontak & Salin Info Supplier"
                          >
                            <IconCreditCard className="w-4 h-4" />
                          </button>
                        </td>
                        {/* 3. Transaksi (klik untuk popup rincian pembelian) */}
                        <td className="py-3 px-4 font-semibold">
                          <button
                            type="button"
                            onClick={() => setSelectedSummaryPayable(item)}
                            className="text-emerald-800 hover:text-emerald-950 hover:underline font-bold text-left cursor-pointer transition-colors"
                            title="Klik untuk melihat ringkasan item pembelian"
                          >
                            {item.transaction_no}
                          </button>
                        </td>
                        {/* 4. Lokasi Gudang (kanan Transaksi, hanya kode) */}
                        <td className="py-3 px-3 text-center whitespace-nowrap">
                          {item.warehouse_code ? (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-slate-100 text-slate-700 border border-slate-200">
                              {item.warehouse_code}
                            </span>
                          ) : (
                            <span className="text-slate-400 text-xs">—</span>
                          )}
                        </td>
                        {/* 5. Total */}
                        <td className="py-3 px-4 text-right font-bold text-slate-800">
                          {formatIdr(item.total_amount)}
                        </td>
                        {/* 6. Sudah Bayar */}
                        <td className="py-3 px-4 text-right font-semibold text-emerald-700">
                          {formatIdr(item.paid_amount)}
                        </td>
                        {/* 7. Sisa */}
                        <td className="py-3 px-4 text-right font-bold text-rose-600">
                          {formatIdr(item.remaining_amount)}
                        </td>
                        {/* 8. Jatuh Tempo */}
                        <td className="py-3 px-4 text-slate-600 whitespace-nowrap">
                          {formatMediumDateId(item.due_date)}
                        </td>
                        {/* 9. Bukti Bayar (kanan Jatuh Tempo, kiri Status) */}
                        <td className="py-3 px-3 text-center whitespace-nowrap">
                          {item.payment_proof_attachment ? (
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedProofModal({
                                  filePath: buildTransactionAttachmentFilePath(
                                    item.raw_id,
                                    item.payment_proof_attachment!.id
                                  ),
                                  title: `Bukti Bayar — ${item.transaction_no}`,
                                })
                              }
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors cursor-pointer"
                              title="Lihat Bukti Bayar"
                            >
                              <svg className="w-3 h-3 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                              <span>Bukti</span>
                            </button>
                          ) : item.proof_url ? (
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedProofModal({
                                  filePath: item.proof_url!,
                                  title: `Bukti Bayar — ${item.transaction_no}`,
                                })
                              }
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors cursor-pointer"
                              title="Lihat Bukti Bayar"
                            >
                              <svg className="w-3 h-3 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                              <span>Bukti</span>
                            </button>
                          ) : (
                            <span className="text-slate-400 text-xs">—</span>
                          )}
                        </td>
                        {/* 10. Status */}
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
                        {/* 11. Aksi */}
                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            {item.status !== 'PAID' && (
                              <button
                                type="button"
                                onClick={() => setSettleModalState({ mode: 'PAYABLE', item })}
                                title="Lunasi Hutang"
                                className="w-8 h-8 rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 inline-flex items-center justify-center transition cursor-pointer"
                              >
                                <CheckCircle2 className="w-4 h-4" />
                              </button>
                            )}
                            {item.source === 'MANUAL' && (
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmDeleteState({
                                    title: 'Hapus Data Hutang',
                                    description: `Apakah Anda yakin ingin menghapus data hutang "${item.supplier_name}" (${item.transaction_no}) sebesar ${formatIdr(item.total_amount)}?`,
                                    endpoint: `/api/reports/accounting/payables/${encodeURIComponent(item.id)}`,
                                  })
                                }
                                title="Hapus Hutang"
                                className="w-8 h-8 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 inline-flex items-center justify-center transition cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
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
                    <td colSpan={4} className="py-3 px-4">
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
                    <td colSpan={4} />
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
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition cursor-pointer"
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
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
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
            <div className="overflow-auto max-h-[calc(100vh-270px)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Pelanggan</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Transaksi</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Total</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Sudah Terima</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Sisa</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Jatuh Tempo</th>
                    <th className="py-3 px-4 font-semibold text-center bg-[#123524]">Status</th>
                    <th className="py-3 px-4 font-semibold text-center bg-[#123524]">Aksi</th>
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
                                type="button"
                                onClick={() => setSettleModalState({ mode: 'RECEIVABLE', item })}
                                title="Terima Pembayaran Piutang"
                                className="w-8 h-8 rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 inline-flex items-center justify-center transition cursor-pointer"
                              >
                                <CheckCircle2 className="w-4 h-4" />
                              </button>
                            )}
                            {item.source === 'MANUAL' && (
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmDeleteState({
                                    title: 'Hapus Data Piutang',
                                    description: `Apakah Anda yakin ingin menghapus piutang "${item.customer_name}" (${item.transaction_no}) sebesar ${formatIdr(item.total_amount)}?`,
                                    endpoint: `/api/reports/accounting/receivables/${encodeURIComponent(item.id)}`,
                                  })
                                }
                                title="Hapus Piutang"
                                className="w-8 h-8 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 inline-flex items-center justify-center transition cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
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
          8. SUB-VIEW: ASET (Daftar Aset Tetap + Lokasi Penyimpanan + Export/Import XLSX)
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
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={assetFileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleImportAssetsFileChange}
                className="hidden"
              />
              <button
                type="button"
                disabled={importingXlsx}
                onClick={() => assetFileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-emerald-800/30 bg-white hover:bg-emerald-50 text-[#123524] text-xs font-bold shadow-xs transition disabled:opacity-50 cursor-pointer"
              >
                <IconFileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                {importingXlsx ? 'Mengimpor...' : 'Import XLSX'}
              </button>
              <button
                type="button"
                onClick={handleExportAssetsXlsx}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-emerald-800/30 bg-white hover:bg-emerald-50 text-[#123524] text-xs font-bold shadow-xs transition cursor-pointer"
              >
                <IconDownload className="w-3.5 h-3.5 text-emerald-700" />
                Export XLSX
              </button>
              <button
                type="button"
                onClick={() => setShowAddAssetModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition cursor-pointer"
              >
                + Tambah Aset
              </button>
            </div>
          </div>

          {importNotice && (
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-semibold flex items-center justify-between">
              <span>{importNotice}</span>
              <button
                type="button"
                onClick={() => setImportNotice(null)}
                className="text-emerald-700 hover:text-emerald-950 font-bold"
              >
                Tutup
              </button>
            </div>
          )}

          {/* Toolbar Filter, Sort & Search Aset */}
          <div className="bg-white rounded-xl border border-slate-200 p-3.5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
            <div className="relative lg:col-span-1">
              <IconSearch className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={assetSearch}
                onChange={(e) => setAssetSearch(e.target.value)}
                placeholder="Cari kode, nama, merek, no seri..."
                className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-800"
              />
            </div>

            <div>
              <select
                value={assetCategoryFilter}
                onChange={(e) => setAssetCategoryFilter(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-700 font-medium"
              >
                <option value="ALL">Semua Kategori</option>
                {assetCategoryOptions.map((cat) => (
                  <option key={cat} value={cat}>
                    Kategori: {cat}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <select
                value={assetLocationFilter}
                onChange={(e) => setAssetLocationFilter(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-700 font-medium"
              >
                <option value="ALL">Semua Lokasi Penyimpanan</option>
                {assetLocationOptions.map((loc) => (
                  <option key={loc} value={loc}>
                    Lokasi: {loc}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <select
                value={assetBrandFilter}
                onChange={(e) => setAssetBrandFilter(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-700 font-medium"
              >
                <option value="ALL">Semua Merek</option>
                {assetBrandOptions.map((br) => (
                  <option key={br} value={br}>
                    Merek: {br}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <select
                value={assetSortBy}
                onChange={(e) => setAssetSortBy(e.target.value as any)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-700 font-bold"
              >
                <option value="NEWEST">Urutkan: Terbaru</option>
                <option value="CATEGORY">Urutkan: Kategori (A-Z)</option>
                <option value="LOCATION">Urutkan: Lokasi Penyimpanan (A-Z)</option>
                <option value="BRAND">Urutkan: Merek (A-Z)</option>
                <option value="NAME">Urutkan: Nama Barang (A-Z)</option>
                <option value="VALUE_DESC">Urutkan: Nilai Saat Ini Tertinggi</option>
              </select>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            {(subledger?.fixed_assets.items || []).length === 0 ? (
              <div className="py-14 text-center">
                <IconPackage className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                <div className="text-sm font-bold text-slate-600">Belum ada data aset</div>
                <p className="text-xs text-slate-400 mt-1">
                  Klik tombol &ldquo;+ Tambah Aset&rdquo; atau &ldquo;Import XLSX&rdquo; untuk mencatat inventaris & aset tetap hotel.
                </p>
              </div>
            ) : filteredAndSortedAssets.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-400">
                Tidak ada aset yang cocok dengan filter atau pencarian saat ini.
              </div>
            ) : (
              <div className="overflow-auto max-h-[calc(100vh-270px)]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-20">
                    <tr className="bg-[#123524] text-white text-left">
                      <th className="py-3 px-3.5 font-semibold bg-[#123524]">Kode Aset</th>
                      <th className="py-3 px-3 font-semibold text-center bg-[#123524]">Foto/Gambar</th>
                      <th className="py-3 px-3.5 font-semibold bg-[#123524]">Nama Barang</th>
                      <th className="py-3 px-3.5 font-semibold bg-[#123524]">Merek</th>
                      <th className="py-3 px-3.5 font-semibold bg-[#123524]">No. Seri</th>
                      <th className="py-3 px-3.5 font-semibold bg-[#123524]">Lokasi Penyimpanan</th>
                      <th className="py-3 px-3.5 font-semibold text-right bg-[#123524]">Harga Beli</th>
                      <th className="py-3 px-3.5 font-semibold text-right bg-[#123524]">Nilai Saat Ini</th>
                      <th className="py-3 px-3 font-semibold text-center bg-[#123524]">Depresiasi</th>
                      <th className="py-3 px-3.5 font-semibold bg-[#123524]">Catatan</th>
                      <th className="py-3 px-3.5 font-semibold text-center bg-[#123524]">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredAndSortedAssets.map((asset) => (
                      <tr key={asset.id} className="hover:bg-emerald-50/30 transition">
                        <td className="py-3 px-3.5 font-mono text-[11px] font-bold text-[#123524]">
                          <div>{asset.asset_code || `AST-${String(asset.id).padStart(4, '0')}`}</div>
                          <div className="font-sans text-[10px] font-normal text-slate-400">
                            {formatMediumDateId(asset.purchase_date)}
                          </div>
                          <div className="mt-1">
                            <span className="inline-block px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-sans font-semibold text-[10px]">
                              {asset.category}
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <button
                            type="button"
                            onClick={() => setQuickPhotoAsset(asset)}
                            title={
                              asset.photo_data_url
                                ? 'Klik untuk lihat / ganti foto aset'
                                : 'Klik untuk upload foto atau buka kamera'
                            }
                            className="w-11 h-11 rounded-xl border border-dashed border-slate-300 hover:border-emerald-700 bg-slate-50/70 inline-flex items-center justify-center overflow-hidden transition cursor-pointer group mx-auto"
                          >
                            {asset.photo_data_url ? (
                              <img
                                src={asset.photo_data_url}
                                alt={asset.asset_name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <ImageIcon className="w-5 h-5 text-slate-400 group-hover:text-emerald-800 transition" />
                            )}
                          </button>
                        </td>
                        <td className="py-3 px-3.5 font-bold text-slate-900">{asset.asset_name}</td>
                        <td className="py-3 px-3.5 font-medium text-slate-700">
                          {asset.brand || '-'}
                        </td>
                        <td className="py-3 px-3.5 font-mono text-[11px] text-slate-700">
                          {asset.serial_number || '-'}
                        </td>
                        <td className="py-3 px-3.5 font-medium text-slate-700">
                          {asset.storage_location || '-'}
                        </td>
                        <td className="py-3 px-3.5 text-right font-semibold text-slate-700">
                          {formatIdr(asset.purchase_price)}
                        </td>
                        <td className="py-3 px-3.5 text-right font-extrabold text-emerald-800">
                          {formatIdr(asset.current_value)}
                        </td>
                        <td className="py-3 px-3 text-center text-slate-600">
                          {asset.depreciation_rate}% / thn
                        </td>
                        <td className="py-3 px-3.5 text-slate-500">{asset.notes || '-'}</td>
                        <td className="py-3 px-3.5 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditingAssetItem(asset)}
                              title="Edit Aset"
                              className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 inline-flex items-center justify-center transition cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmDeleteState({
                                  title: 'Hapus Aset Tetap',
                                  description: `Apakah Anda yakin ingin menghapus aset tetap "${asset.asset_name}" (${asset.category})?`,
                                  endpoint: `/api/reports/accounting/assets/${asset.id}`,
                                })
                              }
                              title="Hapus Aset"
                              className="w-8 h-8 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 inline-flex items-center justify-center transition cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
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
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 text-xs font-bold transition cursor-pointer"
              >
                Transfer Investor
              </button>
              <button
                onClick={() => setShowAddBankModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition cursor-pointer"
              >
                + Tambah Bank
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-auto max-h-[calc(100vh-270px)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Nama Bank</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">No. Rekening</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Atas Nama</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Saldo</th>
                    <th className="py-3 px-4 font-semibold text-center bg-[#123524]">Sumber</th>
                    <th className="py-3 px-4 font-semibold text-center bg-[#123524]">Aksi</th>
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
                            type="button"
                            onClick={() =>
                              setConfirmDeleteState({
                                title: 'Hapus Rekening Bank Manual',
                                description: `Apakah Anda yakin ingin menghapus rekening bank manual "${bank.bank_name}"?`,
                                endpoint: `/api/reports/accounting/banks/${bank.manual_id}`,
                              })
                            }
                            title="Hapus Rekening Bank Manual"
                            className="w-8 h-8 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 inline-flex items-center justify-center transition cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
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
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#123524] hover:bg-emerald-950 text-[#E6C786] text-xs font-bold shadow-xs transition cursor-pointer"
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
            <div className="overflow-auto max-h-[calc(100vh-270px)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Nomor Akun</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Nama Akun</th>
                    <th className="py-3 px-4 font-semibold text-center bg-[#123524]">Klasifikasi</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Saldo Awal</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Saldo Akhir (Live HIMS)</th>
                    <th className="py-3 px-4 font-semibold text-center bg-[#123524]">Aksi</th>
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
                            type="button"
                            onClick={() => setCoaModalItem(acc)}
                            title="Edit Akun / Saldo Awal"
                            className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 inline-flex items-center justify-center transition cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {!acc.is_system && (
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmDeleteState({
                                  title: 'Hapus Akun COA',
                                  description: `Apakah Anda yakin ingin menghapus akun "${acc.account_number} - ${acc.account_name}"?`,
                                  endpoint: `/api/reports/accounting/coa/${acc.id}`,
                                })
                              }
                              title="Hapus Akun COA"
                              className="w-8 h-8 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 inline-flex items-center justify-center transition cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
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
            <div className="overflow-auto max-h-[calc(100vh-270px)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Tanggal</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">No. Referensi / BID</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Sumber</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Pelanggan / Supplier</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">DPP</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">PPN</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Total Nilai</th>
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
          12. SUB-VIEW: DATA SERVICE CHARGE (Rekap Service Charge Kamar & POS)
         ===================================================================== */}
      {subView === 'data_service_charge' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">
                Data Service Charge (
                {subledger?.service_charge_summary?.service_percentage ??
                  analytics?.pricing_settings?.service_charge_percent ??
                  0}
                %)
              </h2>
              <p className="text-xs text-slate-500">
                Rekapitulasi Service Charge dari transaksi Kamar, Folio Stay Charges, dan Resto/POS.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-500">Service Charge Kamar</div>
              <div className="text-xl font-extrabold text-emerald-800 mt-1">
                {formatIdr(subledger?.service_charge_summary?.room_service_total || 0)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-500">Service Charge POS / Resto</div>
              <div className="text-xl font-extrabold text-emerald-700 mt-1">
                {formatIdr(subledger?.service_charge_summary?.pos_service_total || 0)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-500">Jumlah Transaksi</div>
              <div className="text-xl font-extrabold text-slate-900 mt-1">
                {formatNumber(filteredServiceChargeRows.length)}
              </div>
            </div>
            <div className="bg-[#FDFBF7] border border-[#E6C786] rounded-xl p-4">
              <div className="text-xs font-semibold text-[#123524]">Total Service Charge Terkumpul</div>
              <div className="text-xl font-extrabold text-[#123524] mt-1">
                {formatIdr(subledger?.service_charge_summary?.total_service_charge || 0)}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-1.5">
            {(
              [
                { key: 'ALL', label: 'Semua Sumber' },
                { key: 'KAMAR', label: 'Kamar' },
                { key: 'POS', label: 'POS / Resto' },
              ] as const
            ).map((f) => (
              <button
                key={f.key}
                onClick={() => setServiceSourceFilter(f.key)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  serviceSourceFilter === f.key
                    ? 'bg-[#123524] text-[#E6C786]'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="overflow-auto max-h-[calc(100vh-270px)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-20">
                  <tr className="bg-[#123524] text-white text-left">
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Tanggal</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">No. Referensi / BID</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Sumber</th>
                    <th className="py-3 px-4 font-semibold bg-[#123524]">Tamu / Pelanggan</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">DPP / Subtotal</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Service Charge</th>
                    <th className="py-3 px-4 font-semibold text-right bg-[#123524]">Total Nilai</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredServiceChargeRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-10 text-center text-slate-400">
                        Tidak ada baris Service Charge tercatat pada filter/periode ini.
                      </td>
                    </tr>
                  ) : (
                    filteredServiceChargeRows.map((row) => (
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
                          {formatIdr(row.service_amount)}
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
      {(showAddAssetModal || editingAssetItem) && (
        <AddAssetModal
          propertyId={propertyId}
          defaultDate={endDate}
          initialAsset={editingAssetItem}
          categories={subledger?.fixed_assets.categories}
          onClose={() => {
            setShowAddAssetModal(false);
            setEditingAssetItem(null);
          }}
          onSaved={onRetry}
        />
      )}
      {quickPhotoAsset && (
        <AssetPhotoQuickModal
          propertyId={propertyId}
          asset={quickPhotoAsset}
          onClose={() => setQuickPhotoAsset(null)}
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
      {settleModalState && (
        <SettlePaymentModal
          mode={settleModalState.mode}
          propertyId={propertyId}
          item={settleModalState.item}
          onClose={() => setSettleModalState(null)}
          onSaved={onRetry}
        />
      )}
      {confirmDeleteState && (
        <ConfirmDeleteModal
          title={confirmDeleteState.title}
          description={confirmDeleteState.description}
          busy={deleteBusy}
          onCancel={() => setConfirmDeleteState(null)}
          onConfirm={executeConfirmDelete}
        />
      )}

      {/* Popover Rekening & Info Supplier */}
      {activeBankPopoverPayable && (
        <div
          id="payable-bank-popover"
          style={{
            position: 'absolute',
            top: `${bankPopoverPos.top}px`,
            left: `${bankPopoverPos.left}px`,
            zIndex: 60,
          }}
          className="bg-white rounded-xl shadow-xl border border-slate-200 p-3.5 w-72 text-xs text-slate-800 animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100">
            <div className="font-bold text-slate-900 truncate">
              {activeBankPopoverPayable.supplier_name}
            </div>
            <button
              type="button"
              onClick={() => setActiveBankPopoverPayable(null)}
              className="text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer"
            >
              ✕
            </button>
          </div>

          <div className="space-y-2.5">
            <div>
              <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 block">Rekening Bank</span>
              {activeBankPopoverPayable.bank_account ? (
                <div className="mt-0.5">
                  <div className="font-medium text-slate-800">
                    {activeBankPopoverPayable.bank_name || 'Bank'}
                    {activeBankPopoverPayable.bank_holder ? ` a.n ${activeBankPopoverPayable.bank_holder}` : ''}
                  </div>
                  <div className="flex items-center justify-between gap-1.5 mt-1 bg-slate-50 p-1.5 rounded-lg border border-slate-200">
                    <span className="font-mono font-bold text-slate-900 text-xs">
                      {activeBankPopoverPayable.bank_account}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopyText('bank', activeBankPopoverPayable.bank_account!)}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold transition flex items-center gap-1 cursor-pointer ${
                        bankCopiedField === 'bank'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                      }`}
                    >
                      {bankCopiedField === 'bank' ? (
                        <>
                          <Check className="w-3 h-3" />
                          <span>Tersalin</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Salin</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <span className="text-slate-400 italic text-[11px]">Belum diatur</span>
              )}
            </div>

            <div>
              <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 block">Email Supplier</span>
              {activeBankPopoverPayable.supplier_email ? (
                <div className="flex items-center justify-between gap-1.5 mt-1 bg-slate-50 p-1.5 rounded-lg border border-slate-200">
                  <span className="font-medium text-slate-800 text-xs truncate max-w-[170px]" title={activeBankPopoverPayable.supplier_email}>
                    {activeBankPopoverPayable.supplier_email}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopyText('email', activeBankPopoverPayable.supplier_email!)}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition flex items-center gap-1 cursor-pointer ${
                      bankCopiedField === 'email'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                    }`}
                  >
                    {bankCopiedField === 'email' ? (
                      <>
                        <Check className="w-3 h-3" />
                        <span>Tersalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Salin</span>
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <span className="text-slate-400 italic text-[11px]">Belum diatur</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Ringkasan Item Transaksi */}
      {selectedSummaryPayable && (
        <PurchaseItemsSummaryModal
          payableId={selectedSummaryPayable.id}
          transactionNo={selectedSummaryPayable.transaction_no}
          supplierName={selectedSummaryPayable.supplier_name}
          onClose={() => setSelectedSummaryPayable(null)}
        />
      )}

      {/* Modal Preview Bukti Bayar */}
      {selectedProofModal && (
        <PaymentProofModal
          filePath={selectedProofModal.filePath}
          title={selectedProofModal.title}
          onClose={() => setSelectedProofModal(null)}
        />
      )}
    </div>
  );
};
