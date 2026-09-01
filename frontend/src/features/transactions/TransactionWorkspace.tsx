import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  TransactionRecord,
  TransactionSummary,
  TransactionSheetCounts,
  CategoryOption,
  DepartmentOption,
  OperationalStatus,
  VerificationStatus,
  ReceivingStatus
} from './transactionDomainTypes';
import { mapToOperationalStatus } from './transactionDomainTypes';
import { fetchTransactionsApi, fetchCategoriesApi, softDeleteTransactionApi } from './transactionClient';
import { VoidTransactionModal } from './VoidTransactionModal';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';
import { PurchaseTransactionEditor } from './PurchaseTransactionEditor';
import { ExpenseTransactionEditor } from './ExpenseTransactionEditor';
import { IncomeTransactionEditor } from './IncomeTransactionEditor';
import { VendorSupplierMasterPage } from '../vendors/VendorSupplierMasterPage';

interface TransactionWorkspaceProps {
  propertyId: number;
  currentStaffName?: string;
  currentUserId?: string | null;
  reservations?: any[];
  reservationLoading?: boolean;
  reservationError?: string | null;
  onRefreshReservations?: (start: string, end: string) => void;
  onCheckIn?: (res: any) => void;
  onCheckout?: (res: any) => void;
  onOpenReservationDetail?: (res: any) => void;
  onEditReservation?: (res: any) => void;
  onMoveReservation?: (res: any) => void;
  onExtendReservation?: (res: any) => void;
  onCancelReservation?: (res: any) => void;
  onViewReservationFolio?: (res: any) => void;
  onViewReservationAudit?: (res: any) => void;
  formatCurrency?: (val: number) => string;
  getPaymentStatusLabel?: (status: string) => string;
  getPaymentBadgeClass?: (status: string) => string;
  onNavigateToReservation?: (reservationId: number) => void;
  onOpenQuickBooking?: () => void;
}

export const TransactionWorkspace: React.FC<TransactionWorkspaceProps> = ({
  propertyId,
  currentStaffName = 'Staff Front Desk',
  currentUserId = null,
  onViewReservationFolio,
  onNavigateToReservation,
  onOpenQuickBooking
}) => {
  const formatIsoDate = (d: Date) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const getDatePresetRange = (preset: 'today' | 'yesterday' | 'this_month' | 'last_month' | 'all_time') => {
    const now = new Date();
    if (preset === 'today') {
      const todayStr = formatIsoDate(now);
      return { start: todayStr, end: todayStr };
    }
    if (preset === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      const yStr = formatIsoDate(y);
      return { start: yStr, end: yStr };
    }
    if (preset === 'this_month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { start: formatIsoDate(firstDay), end: formatIsoDate(lastDay) };
    }
    if (preset === 'last_month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: formatIsoDate(firstDay), end: formatIsoDate(lastDay) };
    }
    return { start: '', end: '' };
  };

  // Editor View Mode (null = table view, 'PURCHASE' | 'EXPENSE' | 'INCOME' = dedicated full editors)
  const [activeEditor, setActiveEditor] = useState<'PURCHASE' | 'EXPENSE' | 'INCOME' | null>(null);

  // LEVEL 1 — TRANSACTION TYPE (Default: SALE)
  const [activeTab, setActiveTab] = useState<'SALE' | 'PURCHASE' | 'EXPENSE' | 'INCOME' | 'ALL'>('SALE');
  const [showVendorSupplierMaster, setShowVendorSupplierMaster] = useState<boolean>(false);

  // LEVEL 2 — DATE PERIOD
  const [datePreset, setDatePreset] = useState<'today' | 'yesterday' | 'this_month' | 'last_month' | 'all_time' | 'custom'>('today');
  const [startDate, setStartDate] = useState<string>(() => getDatePresetRange('today').start);
  const [endDate, setEndDate] = useState<string>(() => getDatePresetRange('today').end);
  const [showCustomDatePicker, setShowCustomDatePicker] = useState<boolean>(false);

  // LEVEL 3 — SEARCH & FILTERS
  const [search, setSearch] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [categoryCode, setCategoryCode] = useState<string>('');
  const [departmentCode, setDepartmentCode] = useState<string>('');
  const [verificationFilter, setVerificationFilter] = useState<string>('');
  const [receivingFilter, setReceivingFilter] = useState<string>('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState<boolean>(false);

  // LEVEL 4 — OPERATIONAL STATUS (Semua, Proses, Selesai, Batal. Default: ALL)
  const [operationalStatus, setOperationalStatus] = useState<OperationalStatus>('ALL');

  // Pagination
  const [page, setPage] = useState<number>(1);
  const pageSize = 25;

  // Search debounce
  const searchTimerRef = useRef<any>(null);
  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(val);
      setPage(1);
    }, 300);
  };

  const handleClearSearch = () => {
    setSearch('');
    setDebouncedSearch('');
    setPage(1);
  };

  // Data states
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [sheetCounts, setSheetCounts] = useState<TransactionSheetCounts>({
    proses: 0,
    selesai: 0,
    batal: 0,
    hapus: 0
  });
  const [summary, setSummary] = useState<TransactionSummary>({
    total_sale: 0,
    total_purchase: 0,
    total_expense: 0,
    total_income: 0,
    count_sale: 0,
    count_purchase: 0,
    count_expense: 0,
    count_income: 0
  });
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Modals & Drawers
  const [voidModalOpen, setVoidModalOpen] = useState<boolean>(false);
  const [selectedTxForVoid, setSelectedTxForVoid] = useState<TransactionRecord | null>(null);
  const [softDeleteModalOpen, setSoftDeleteModalOpen] = useState<boolean>(false);
  const [selectedTxForSoftDelete, setSelectedTxForSoftDelete] = useState<TransactionRecord | null>(null);
  const [deleteReason, setDeleteReason] = useState<string>('');
  const [isSoftDeleting, setIsSoftDeleting] = useState<boolean>(false);
  const [softDeleteError, setSoftDeleteError] = useState<string | null>(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState<boolean>(false);
  const [selectedTxIdForDetail, setSelectedTxIdForDetail] = useState<number | string | null>(null);

  const currentRequestIdRef = useRef<number>(0);

  useEffect(() => {
    fetchCategoriesApi(propertyId)
      .then((data) => {
        setCategories(data.categories || []);
        setDepartments(data.departments || []);
      })
      .catch((err) => {
        console.error('Failed to load transaction categories:', err);
      });
  }, [propertyId]);

  const handleDatePresetChange = (preset: 'today' | 'yesterday' | 'this_month' | 'last_month' | 'all_time') => {
    setDatePreset(preset);
    setShowCustomDatePicker(false);
    const range = getDatePresetRange(preset);
    setStartDate(range.start);
    setEndDate(range.end);
    setPage(1);
  };

  const loadTransactions = useCallback(async () => {
    const reqId = ++currentRequestIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const txTypeParam = activeTab === 'ALL' ? undefined : activeTab;
      const res = await fetchTransactionsApi({
        property_id: propertyId,
        transaction_type: txTypeParam,
        category_code: categoryCode || undefined,
        department_code: departmentCode || undefined,
        verification_status: verificationFilter || undefined,
        receiving_status: receivingFilter || undefined,
        operational_sheet: operationalStatus !== 'ALL' ? operationalStatus : undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        search: debouncedSearch.trim() || undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize
      });

      if (reqId === currentRequestIdRef.current) {
        setTransactions(res.transactions || []);
        setTotalCount(res.total_count || 0);
        if (res.sheet_counts) {
          setSheetCounts(res.sheet_counts);
        }
        setSummary(res.summary || {
          total_sale: 0,
          total_purchase: 0,
          total_expense: 0,
          total_income: 0,
          count_sale: 0,
          count_purchase: 0,
          count_expense: 0,
          count_income: 0
        });
      }
    } catch (err: any) {
      if (reqId === currentRequestIdRef.current) {
        setError(err.message || 'Gagal memuat daftar transaksi');
      }
    } finally {
      if (reqId === currentRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [
    propertyId,
    activeTab,
    categoryCode,
    departmentCode,
    verificationFilter,
    receivingFilter,
    operationalStatus,
    startDate,
    endDate,
    debouncedSearch,
    page
  ]);

  useEffect(() => {
    if (!activeEditor) {
      loadTransactions();
    }
  }, [loadTransactions, activeEditor]);

  useEffect(() => {
    setPage(1);
    setSelectedTxIdForDetail(null);
    setDetailDrawerOpen(false);
    setSelectedTxForVoid(null);
    setVoidModalOpen(false);
    setSelectedTxForSoftDelete(null);
    setSoftDeleteModalOpen(false);
    setActiveEditor(null);
  }, [propertyId]);

  const handleTabChange = (tab: 'SALE' | 'PURCHASE' | 'EXPENSE' | 'INCOME' | 'ALL') => {
    setActiveTab(tab);
    setShowVendorSupplierMaster(false);
    setCategoryCode('');
    setReceivingFilter('');
    setVerificationFilter('');
    if (!['PURCHASE', 'EXPENSE'].includes(tab) && operationalStatus === 'HAPUS') {
      setOperationalStatus('ALL');
    }
    setPage(1);
    setActiveEditor(null);
  };

  const openDetailDrawer = (txId: number | string) => {
    setSelectedTxIdForDetail(txId);
    setDetailDrawerOpen(true);
  };

  const openVoidModal = (tx: TransactionRecord) => {
    setSelectedTxForVoid(tx);
    setVoidModalOpen(true);
  };

  const openSoftDeleteModal = (tx: TransactionRecord) => {
    setSelectedTxForSoftDelete(tx);
    setDeleteReason('');
    setSoftDeleteError(null);
    setSoftDeleteModalOpen(true);
  };

  const handleConfirmSoftDelete = async () => {
    if (!selectedTxForSoftDelete) return;
    if (!deleteReason.trim()) {
      setSoftDeleteError('Alasan hapus wajib diisi');
      return;
    }

    setIsSoftDeleting(true);
    setSoftDeleteError(null);
    try {
      await softDeleteTransactionApi(selectedTxForSoftDelete.id, {
        property_id: propertyId,
        delete_reason: deleteReason.trim(),
        actor_name: currentStaffName,
        actor_user_id: currentUserId || undefined
      });
      setSoftDeleteModalOpen(false);
      setSelectedTxForSoftDelete(null);
      setDeleteReason('');
      loadTransactions();
      if (detailDrawerOpen && selectedTxIdForDetail === selectedTxForSoftDelete.id) {
        setDetailDrawerOpen(false);
      }
    } catch (err: any) {
      setSoftDeleteError(err.message || 'Gagal menghapus draft transaksi');
    } finally {
      setIsSoftDeleting(false);
    }
  };

  const isEligibleForSoftDelete = (t: TransactionRecord) => {
    return (
      !t.deleted_at &&
      ['PURCHASE', 'EXPENSE'].includes(t.transaction_type) &&
      (!t.paid_amount || Number(t.paid_amount) === 0) &&
      t.verification_status !== 'VERIFIED' &&
      t.receiving_status !== 'DITERIMA' &&
      t.receiving_status !== 'DITERIMA_LENGKAP' &&
      !t.reservation_id &&
      !t.booking_id &&
      !t.reversal_of_transaction_id
    );
  };

  const formatIdr = (val: number | undefined | string) => {
    if (val === undefined || val === null) return 'Rp 0';
    const num = Number(val) || 0;
    const isNeg = num < 0;
    return (isNeg ? '- Rp ' : 'Rp ') + Math.abs(num).toLocaleString('id-ID');
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  const getSearchPlaceholder = () => {
    switch (activeTab) {
      case 'SALE':
        return 'Cari BID, No. Transaksi, nama tamu...';
      case 'PURCHASE':
        return 'Cari transaksi, supplier, faktur, item...';
      case 'EXPENSE':
        return 'Cari transaksi, penerima, kategori...';
      case 'INCOME':
        return 'Cari transaksi, pembayar, keterangan...';
      case 'ALL':
      default:
        return 'Cari transaksi, BID, nama pihak, ref...';
    }
  };

  const getSourceBadge = (source: string) => {
    switch (source) {
      case 'ROOM_CHARGE':
        return <span className="inline-flex items-center text-[10px] font-semibold text-emerald-800 bg-emerald-100 px-1.5 py-0.5 rounded">Kamar</span>;
      case 'DAY_USE_ROOM':
        return <span className="inline-flex items-center text-[10px] font-semibold text-cyan-800 bg-cyan-100 px-1.5 py-0.5 rounded">Day Use</span>;
      case 'EXTRA_BED':
      case 'EXTRA_PERSON':
        return <span className="inline-flex items-center text-[10px] font-semibold text-teal-800 bg-teal-100 px-1.5 py-0.5 rounded">Extra Person/Bed</span>;
      case 'POS':
      case 'POS_ORDER':
        return <span className="inline-flex items-center text-[10px] font-semibold text-purple-800 bg-purple-100 px-1.5 py-0.5 rounded">Restoran POS</span>;
      case 'PENALTY':
        return <span className="inline-flex items-center text-[10px] font-semibold text-rose-800 bg-rose-100 px-1.5 py-0.5 rounded">Denda</span>;
      default:
        return <span className="inline-flex items-center text-[10px] font-semibold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">{source}</span>;
    }
  };

  const getActiveTabTotal = () => {
    switch (activeTab) {
      case 'SALE':
        return { total: summary.total_sale, count: summary.count_sale, label: 'Penjualan' };
      case 'PURCHASE':
        return { total: summary.total_purchase, count: summary.count_purchase, label: 'Pembelian' };
      case 'EXPENSE':
        return { total: summary.total_expense, count: summary.count_expense, label: 'Pengeluaran' };
      case 'INCOME':
        return { total: summary.total_income, count: summary.count_income, label: 'Pemasukan' };
      default:
        return {
          total: null,
          count: summary.count_sale + summary.count_purchase + summary.count_expense + summary.count_income,
          label: 'Semua Transaksi'
        };
    }
  };

  const activeStats = getActiveTabTotal();

  // If Dedicated Editor Mode is Active, render Editor
  if (activeEditor === 'PURCHASE') {
    return (
      <PurchaseTransactionEditor
        propertyId={propertyId}
        actorName={currentStaffName}
        onBack={() => setActiveEditor(null)}
        onSuccess={(createdId) => {
          setActiveEditor(null);
          loadTransactions();
          openDetailDrawer(createdId);
        }}
      />
    );
  }

  if (activeEditor === 'EXPENSE') {
    return (
      <ExpenseTransactionEditor
        propertyId={propertyId}
        actorName={currentStaffName}
        onBack={() => setActiveEditor(null)}
        onSuccess={(createdId) => {
          setActiveEditor(null);
          loadTransactions();
          openDetailDrawer(createdId);
        }}
      />
    );
  }

  if (activeEditor === 'INCOME') {
    return (
      <IncomeTransactionEditor
        propertyId={propertyId}
        actorName={currentStaffName}
        onBack={() => setActiveEditor(null)}
        onSuccess={(createdId) => {
          setActiveEditor(null);
          loadTransactions();
          openDetailDrawer(createdId);
        }}
      />
    );
  }

  return (
    <div className="space-y-3.5">
      {/* 1. PAGE HEADER */}
      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs px-5 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 animate-pulse" />
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                Pusat Transaksi
              </h1>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Kelola transaksi penjualan kamar/POS, pembelian vendor, pengeluaran operasional & verifikasi
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {/* Global Vendor/Supplier Master Shortcut */}
            <button
              onClick={() => setShowVendorSupplierMaster(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-300 rounded-xl transition-all shadow-xs cursor-pointer"
              title="Buka direktori master vendor & supplier"
            >
              <span>🏢 Vendor & Supplier</span>
            </button>

            {activeTab === 'PURCHASE' && (
              <button
                onClick={() => setActiveEditor('PURCHASE')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-all shadow-xs cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>+ Catat Pembelian</span>
              </button>
            )}

            {activeTab === 'EXPENSE' && (
              <button
                onClick={() => setActiveEditor('EXPENSE')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-rose-700 hover:bg-rose-800 rounded-xl transition-all shadow-xs cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>+ Catat Pengeluaran</span>
              </button>
            )}

            {activeTab === 'INCOME' && (
              <button
                onClick={() => setActiveEditor('INCOME')}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-teal-700 hover:bg-teal-800 rounded-xl transition-all shadow-xs cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>+ Catat Pemasukan</span>
              </button>
            )}

            {activeTab === 'SALE' && (
              <button
                onClick={() => {
                  if (onOpenQuickBooking) {
                    onOpenQuickBooking();
                  }
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-xl transition-all shadow-xs cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                <span>+ Reservasi Cepat</span>
              </button>
            )}

            {activeTab === 'ALL' && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setActiveEditor('EXPENSE')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl transition-all cursor-pointer"
                >
                  <span>+ Pengeluaran</span>
                </button>
                <button
                  onClick={() => setActiveEditor('PURCHASE')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-all cursor-pointer"
                >
                  <span>+ Pembelian</span>
                </button>
                <button
                  onClick={() => setActiveEditor('INCOME')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-xl transition-all cursor-pointer"
                >
                  <span>+ Pemasukan</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* LEVEL 1 — PRIMARY TABS */}
      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs p-2.5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-1">
            {/* Penjualan */}
            <button
              onClick={() => handleTabChange('SALE')}
              className={`flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'SALE'
                  ? 'bg-emerald-700 text-white shadow-xs'
                  : 'bg-slate-50 text-slate-700 hover:bg-emerald-50 hover:text-emerald-800 border border-slate-200/80'
              }`}
            >
              <span className="uppercase tracking-wider">Penjualan</span>
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  activeTab === 'SALE' ? 'bg-emerald-800 text-emerald-100' : 'bg-slate-200/80 text-slate-600'
                }`}
              >
                {summary.count_sale}
              </span>
            </button>

            {/* Pembelian */}
            <button
              onClick={() => handleTabChange('PURCHASE')}
              className={`flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'PURCHASE'
                  ? 'bg-blue-700 text-white shadow-xs'
                  : 'bg-slate-50 text-slate-700 hover:bg-blue-50 hover:text-blue-800 border border-slate-200/80'
              }`}
            >
              <span className="uppercase tracking-wider">Pembelian</span>
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  activeTab === 'PURCHASE' ? 'bg-blue-800 text-blue-100' : 'bg-slate-200/80 text-slate-600'
                }`}
              >
                {summary.count_purchase}
              </span>
            </button>

            {/* Pengeluaran */}
            <button
              onClick={() => handleTabChange('EXPENSE')}
              className={`flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'EXPENSE'
                  ? 'bg-rose-700 text-white shadow-xs'
                  : 'bg-slate-50 text-slate-700 hover:bg-rose-50 hover:text-rose-800 border border-slate-200/80'
              }`}
            >
              <span className="uppercase tracking-wider">Pengeluaran</span>
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  activeTab === 'EXPENSE' ? 'bg-rose-800 text-rose-100' : 'bg-slate-200/80 text-slate-600'
                }`}
              >
                {summary.count_expense}
              </span>
            </button>

            {/* Pemasukan */}
            <button
              onClick={() => handleTabChange('INCOME')}
              className={`flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                activeTab === 'INCOME'
                  ? 'bg-teal-700 text-white shadow-xs'
                  : 'bg-slate-50 text-slate-700 hover:bg-teal-50 hover:text-teal-800 border border-slate-200/80'
              }`}
            >
              <span className="uppercase tracking-wider">Pemasukan</span>
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  activeTab === 'INCOME' ? 'bg-teal-800 text-teal-100' : 'bg-slate-200/80 text-slate-600'
                }`}
              >
                {summary.count_income}
              </span>
            </button>
          </div>

          <div className="flex items-center justify-end gap-1.5 pt-1 lg:pt-0 lg:pl-2 border-t lg:border-t-0 lg:border-l border-slate-200">
            <button
              onClick={() => handleTabChange('ALL')}
              className={`px-3 py-2 text-xs font-semibold rounded-xl whitespace-nowrap transition-colors cursor-pointer ${
                activeTab === 'ALL'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              Lihat Semua
            </button>
          </div>
        </div>
      </div>

      {showVendorSupplierMaster ? (
        <VendorSupplierMasterPage
          propertyId={propertyId}
          currentStaffName={currentStaffName}
          onBack={() => setShowVendorSupplierMaster(false)}
        />
      ) : (
        /* Main Table Workspace */
        <div className="bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        {/* Toolbar & Filters */}
        <div className="p-4 border-b border-slate-200 space-y-3 bg-slate-50/50">
          {/* LEVEL 2 — DATE PRESETS */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { key: 'today', label: 'Hari Ini' },
                { key: 'yesterday', label: 'Kemarin' },
                { key: 'this_month', label: 'Bulan Ini' },
                { key: 'last_month', label: 'Bulan Lalu' },
                { key: 'all_time', label: 'All Time' }
              ].map((p) => (
                <button
                  key={p.key}
                  onClick={() => handleDatePresetChange(p.key as any)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                    datePreset === p.key
                      ? 'bg-emerald-700 text-white shadow-2xs'
                      : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {p.label}
                </button>
              ))}

              <button
                onClick={() => setShowCustomDatePicker(!showCustomDatePicker)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                  showCustomDatePicker || datePreset === 'custom'
                    ? 'bg-slate-800 text-white border-slate-800'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                }`}
              >
                Kustom...
              </button>
            </div>

            <div className="text-xs text-slate-500 font-medium">
              {activeStats.total !== null ? (
                <>
                  Total {activeStats.label}:{' '}
                  <span className="font-mono font-bold text-slate-900">{formatIdr(activeStats.total)}</span>{' '}
                  <span className="text-slate-400">({activeStats.count} transaksi)</span>
                </>
              ) : (
                <>
                  Total Transaksi:{' '}
                  <span className="font-mono font-bold text-slate-900">{activeStats.count}</span>{' '}
                  <span className="text-slate-400">transaksi</span>
                </>
              )}
            </div>
          </div>

          {/* Custom Date Inputs */}
          {(showCustomDatePicker || datePreset === 'custom') && (
            <div className="flex items-center gap-2 p-2.5 bg-white border border-slate-200 rounded-xl text-xs">
              <span className="text-slate-500 font-medium">Rentang:</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setDatePreset('custom');
                  setPage(1);
                }}
                className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700 font-medium"
              />
              <span className="text-slate-400">s/d</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setDatePreset('custom');
                  setPage(1);
                }}
                className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700 font-medium"
              />
            </div>
          )}

          {/* LEVEL 3 — SEARCH & LEVEL 4 — OPERATIONAL STATUS */}
          <div className="flex flex-col lg:flex-row lg:items-center gap-2.5">
            {/* Search Bar */}
            <div className="relative flex-1">
              <svg className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder={getSearchPlaceholder()}
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-full text-xs bg-white border border-slate-200 rounded-xl pl-9 pr-8 py-2 text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-medium"
              />
              {search && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* LEVEL 4 — OPERATIONAL STATUS PILLS */}
            <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1 shrink-0 overflow-x-auto">
              <span className="text-[11px] font-medium text-slate-400 px-2">Sheet:</span>
              {[
                { key: 'ALL', label: 'Semua', count: null },
                { key: 'PROSES', label: 'Proses', count: sheetCounts.proses },
                { key: 'SELESAI', label: 'Selesai', count: sheetCounts.selesai },
                { key: 'BATAL', label: 'Batal', count: sheetCounts.batal },
                ...(['PURCHASE', 'EXPENSE'].includes(activeTab)
                  ? [{ key: 'HAPUS', label: 'Hapus', count: sheetCounts.hapus ?? 0 }]
                  : [])
              ].map((st) => (
                <button
                  key={st.key}
                  onClick={() => {
                    setOperationalStatus(st.key as OperationalStatus);
                    setPage(1);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                    operationalStatus === st.key
                      ? st.key === 'PROSES'
                        ? 'bg-amber-100 text-amber-800 font-bold'
                        : st.key === 'SELESAI'
                        ? 'bg-emerald-100 text-emerald-800 font-bold'
                        : st.key === 'BATAL'
                        ? 'bg-rose-100 text-rose-800 font-bold'
                        : st.key === 'HAPUS'
                        ? 'bg-slate-700 text-white font-bold'
                        : 'bg-slate-900 text-white font-bold'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <span>{st.label}</span>
                  {st.count !== null && (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                        operationalStatus === st.key
                          ? st.key === 'PROSES'
                            ? 'bg-amber-200/80 text-amber-900'
                            : st.key === 'SELESAI'
                            ? 'bg-emerald-200/80 text-emerald-900'
                            : st.key === 'BATAL'
                            ? 'bg-rose-200/80 text-rose-900'
                            : st.key === 'HAPUS'
                            ? 'bg-slate-800 text-slate-200'
                            : 'bg-slate-800 text-white'
                          : 'bg-slate-200/80 text-slate-600'
                      }`}
                    >
                      {st.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Toggle Advanced Filters */}
            <button
              onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
              className={`px-3 py-2 text-xs font-medium rounded-xl border transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                showAdvancedFilters || categoryCode || departmentCode || verificationFilter || receivingFilter
                  ? 'bg-slate-100 border-slate-300 text-slate-800 font-semibold'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              <span>Filter Lengkap</span>
              {(categoryCode || departmentCode || verificationFilter || receivingFilter) && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
              )}
            </button>
          </div>

          {/* Advanced Filters Drawer */}
          {showAdvancedFilters && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 pt-2 border-t border-slate-200/80">
              {/* Category */}
              <select
                value={categoryCode}
                onChange={(e) => {
                  setCategoryCode(e.target.value);
                  setPage(1);
                }}
                className="text-xs bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-hidden"
              >
                <option value="">Semua Kategori</option>
                {categories
                  .filter((c) => activeTab === 'ALL' || c.type === activeTab)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
              </select>

              {/* Department */}
              <select
                value={departmentCode}
                onChange={(e) => {
                  setDepartmentCode(e.target.value);
                  setPage(1);
                }}
                className="text-xs bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-hidden"
              >
                <option value="">Semua Departemen</option>
                {departments.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>

              {/* Verification Filter */}
              <select
                value={verificationFilter}
                onChange={(e) => {
                  setVerificationFilter(e.target.value);
                  setPage(1);
                }}
                className="text-xs bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-hidden"
              >
                <option value="">Semua Verifikasi</option>
                <option value="UNVERIFIED">Belum Diverifikasi</option>
                <option value="VERIFIED">Terverifikasi</option>
                <option value="REJECTED">Ditolak</option>
              </select>

              {/* Receiving Filter (for Purchase) */}
              <select
                value={receivingFilter}
                onChange={(e) => {
                  setReceivingFilter(e.target.value);
                  setPage(1);
                }}
                className="text-xs bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-hidden"
              >
                <option value="">Semua Status Penerimaan</option>
                <option value="BELUM_DITERIMA">Belum Diterima</option>
                <option value="DITERIMA_SEBAGIAN">Diterima Sebagian</option>
                <option value="DITERIMA">Diterima Lengkap</option>
              </select>
            </div>
          )}
        </div>

        {/* Transaction Table */}
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="py-16 text-center text-slate-400 space-y-2">
              <div className="w-7 h-7 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-xs font-medium">Memuat data transaksi...</p>
            </div>
          ) : error ? (
            <div className="p-6 text-center text-rose-600 text-xs">
              <p className="font-semibold">Terjadi Kesalahan</p>
              <p className="mt-1">{error}</p>
              <button
                onClick={loadTransactions}
                className="mt-3 px-3 py-1.5 bg-rose-50 text-rose-700 rounded-lg font-semibold hover:bg-rose-100 border border-rose-200 cursor-pointer"
              >
                Coba Lagi
              </button>
            </div>
          ) : transactions.length === 0 ? (
            <div className="py-16 text-center text-slate-400 space-y-2">
              <svg className="w-10 h-10 mx-auto text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-sm font-semibold text-slate-600">Tidak ada transaksi pada filter ini.</p>
              <p className="text-xs text-slate-400">
                Ubah tanggal atau gunakan tombol tambah di atas untuk mencatat transaksi baru.
              </p>
            </div>
          ) : (
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="bg-slate-50/90 text-slate-500 font-bold uppercase tracking-wider text-[10px] border-b border-slate-200">
                {operationalStatus === 'HAPUS' ? (
                  <tr>
                    <th className="py-3 px-3">Tanggal</th>
                    <th className="py-3 px-3">No. Transaksi</th>
                    <th className="py-3 px-3">Tipe / Pihak</th>
                    <th className="py-3 px-4">Keterangan</th>
                    <th className="py-3 px-3 text-right">Nominal</th>
                    <th className="py-3 px-3">Dihapus Oleh</th>
                    <th className="py-3 px-3">Tanggal Hapus</th>
                    <th className="py-3 px-4">Alasan Hapus</th>
                    <th className="py-3 px-3 text-center">Aksi</th>
                  </tr>
                ) : (
                  <>
                    {activeTab === 'SALE' && (
                      <tr>
                        <th className="py-3 px-3">Tanggal</th>
                        <th className="py-3 px-3">BID / No. Transaksi</th>
                        <th className="py-3 px-3">Tamu</th>
                        <th className="py-3 px-3">Kamar / Sumber</th>
                        <th className="py-3 px-4">Keterangan</th>
                        <th className="py-3 px-3 text-right">Total</th>
                        <th className="py-3 px-2 text-center">Pembayaran</th>
                        <th className="py-3 px-2 text-center">Status</th>
                        <th className="py-3 px-3 text-center">Aksi</th>
                      </tr>
                    )}

                    {activeTab === 'PURCHASE' && (
                      <tr>
                        <th className="py-3 px-3">Tanggal</th>
                        <th className="py-3 px-3">No. Transaksi</th>
                        <th className="py-3 px-3">Supplier Vendor</th>
                        <th className="py-3 px-3 text-center">Penerimaan</th>
                        <th className="py-3 px-4">Keterangan</th>
                        <th className="py-3 px-3 text-right">Total Tagihan</th>
                        <th className="py-3 px-2 text-center">Verifikasi</th>
                        <th className="py-3 px-2 text-center">Status</th>
                        <th className="py-3 px-3 text-center">Aksi</th>
                      </tr>
                    )}

                    {activeTab === 'EXPENSE' && (
                      <tr>
                        <th className="py-3 px-3">Tanggal</th>
                        <th className="py-3 px-3">No. Transaksi</th>
                        <th className="py-3 px-3">Penerima / Vendor</th>
                        <th className="py-3 px-3">Kategori</th>
                        <th className="py-3 px-4">Keterangan</th>
                        <th className="py-3 px-3 text-right">Nominal</th>
                        <th className="py-3 px-2 text-center">Verifikasi</th>
                        <th className="py-3 px-2 text-center">Status</th>
                        <th className="py-3 px-3 text-center">Aksi</th>
                      </tr>
                    )}

                    {activeTab === 'INCOME' && (
                      <tr>
                        <th className="py-3 px-3">Tanggal</th>
                        <th className="py-3 px-3">No. Transaksi</th>
                        <th className="py-3 px-3">Pelanggan / Pihak</th>
                        <th className="py-3 px-3">Kategori</th>
                        <th className="py-3 px-4">Keterangan</th>
                        <th className="py-3 px-3 text-right">Nominal</th>
                        <th className="py-3 px-2 text-center">Verifikasi</th>
                        <th className="py-3 px-2 text-center">Status</th>
                        <th className="py-3 px-3 text-center">Aksi</th>
                      </tr>
                    )}

                    {activeTab === 'ALL' && (
                      <tr>
                        <th className="py-3 px-3">Tanggal</th>
                        <th className="py-3 px-3">No. Transaksi</th>
                        <th className="py-3 px-3">Tipe</th>
                        <th className="py-3 px-3">Pihak / Tamu</th>
                        <th className="py-3 px-3">Kategori</th>
                        <th className="py-3 px-4">Keterangan</th>
                        <th className="py-3 px-3 text-right">Total</th>
                        <th className="py-3 px-2 text-center">Verifikasi</th>
                        <th className="py-3 px-2 text-center">Status</th>
                        <th className="py-3 px-3 text-center">Aksi</th>
                      </tr>
                    )}
                  </>
                )}
              </thead>
              <tbody className="divide-y divide-slate-100">
                {transactions.map((t) => {
                  const party = t.party_name || t.guest_name_snapshot || t.supplier_name || '-';
                  const op = mapToOperationalStatus(t);

                  const renderVerificationBadge = (vStatus: VerificationStatus | string) => {
                    if (vStatus === 'VERIFIED') {
                      return (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <svg className="w-3 h-3 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          Sah
                        </span>
                      );
                    }
                    if (vStatus === 'REJECTED') {
                      return (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200">
                          <svg className="w-3 h-3 text-rose-600" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                          </svg>
                          Ditolak
                        </span>
                      );
                    }
                    return (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200">
                        <svg className="w-3 h-3 text-amber-600" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                        Belum
                      </span>
                    );
                  };

                  const renderReceivingBadge = (rStatus?: ReceivingStatus | string | null) => {
                    if (rStatus === 'DITERIMA') {
                      return (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          Diterima
                        </span>
                      );
                    }
                    if (rStatus === 'DITERIMA_SEBAGIAN') {
                      return (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                          Sebagian
                        </span>
                      );
                    }
                    return (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-50 text-slate-600 border border-slate-200">
                        Belum
                      </span>
                    );
                  };

                  if (operationalStatus === 'HAPUS' || t.deleted_at) {
                    return (
                      <tr
                        key={t.id}
                        onClick={() => openDetailDrawer(t.id)}
                        className="hover:bg-slate-50/80 transition-colors cursor-pointer opacity-80"
                      >
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-600 line-through">{t.transaction_date}</div>
                          <div className="text-[10px] text-slate-400">
                            {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono font-semibold text-slate-600 whitespace-nowrap">
                          <span className="line-through">{t.transaction_no}</span>
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-700 truncate max-w-[150px]">
                          <div>{party}</div>
                          <div className="text-[10px] text-slate-400 font-normal">{t.transaction_type} • {t.category_name}</div>
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-600" title={t.description}>
                          {t.description}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-slate-500 whitespace-nowrap line-through">
                          {formatIdr(t.net_amount)}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap font-medium text-slate-700">
                          {t.deleted_by_name_snapshot || 'Staff'}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap text-[11px] text-slate-500">
                          {t.deleted_at ? new Date(t.deleted_at).toLocaleString('id-ID') : '-'}
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-700 font-medium italic" title={t.delete_reason || ''}>
                          "{t.delete_reason || '-'}"
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => openDetailDrawer(t.id)}
                            className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                          >
                            Detail
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  if (activeTab === 'SALE') {
                    return (
                      <tr
                        key={t.id}
                        onClick={() => openDetailDrawer(t.id)}
                        className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                      >
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                          <div className="text-[10px] text-slate-400">
                            {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          {t.booking_bid ? (
                            <div>
                              <span className="font-mono font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                                {t.booking_bid}
                              </span>
                              <div className="text-[10px] font-mono text-slate-400 mt-0.5">{t.transaction_no}</div>
                            </div>
                          ) : (
                            <div>
                              <span className="font-mono font-semibold text-slate-800">{t.transaction_no}</span>
                              {t.source_reference && (
                                <div className="text-[10px] font-mono text-slate-400">Ref: {t.source_reference}</div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 max-w-[160px] truncate">
                          <div className="font-semibold text-slate-800 truncate">{party}</div>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="space-y-0.5">
                            {t.room_number_snapshot ? (
                              <div className="font-semibold text-slate-800 text-[11px]">Kamar {t.room_number_snapshot}</div>
                            ) : (
                              <div className="text-[11px] font-medium text-slate-600">{t.category_name}</div>
                            )}
                            <div>{getSourceBadge(t.source_type)}</div>
                          </div>
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-800" title={t.description}>
                          {t.description}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-emerald-800 whitespace-nowrap">
                          {formatIdr(t.net_amount)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">
                            {t.payment_status}
                          </span>
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${op.badgeClass}`}>
                            {op.label}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => openDetailDrawer(t.id)}
                            className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                          >
                            Detail
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  if (activeTab === 'PURCHASE') {
                    return (
                      <tr
                        key={t.id}
                        onClick={() => openDetailDrawer(t.id)}
                        className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                      >
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                          <div className="text-[10px] text-slate-400">
                            {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono font-semibold text-slate-800 whitespace-nowrap">
                          {t.transaction_no}
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-800 truncate max-w-[150px]">
                          <div>{t.supplier_name || t.party_name || '-'}</div>
                          {t.supplier_phone && (
                            <div className="text-[10px] text-slate-400 font-normal">{t.supplier_phone}</div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap">
                          {renderReceivingBadge(t.receiving_status)}
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-800">
                          <div>{t.description}</div>
                          {t.source_reference && (
                            <div className="text-[10px] font-mono text-slate-400">Faktur: {t.source_reference}</div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-slate-800 whitespace-nowrap">
                          {formatIdr(t.net_amount)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          {renderVerificationBadge(t.verification_status)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${op.badgeClass}`}>
                            {op.label}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => openDetailDrawer(t.id)}
                              className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                            >
                              Detail
                            </button>
                            {isEligibleForSoftDelete(t) && (
                              <button
                                onClick={() => openSoftDeleteModal(t)}
                                className="px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                              >
                                Hapus
                              </button>
                            )}
                            {t.transaction_status === 'POSTED' && (
                              <button
                                onClick={() => openVoidModal(t)}
                                className="px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                              >
                                Void
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  if (activeTab === 'EXPENSE') {
                    return (
                      <tr
                        key={t.id}
                        onClick={() => openDetailDrawer(t.id)}
                        className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                      >
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                          <div className="text-[10px] text-slate-400">
                            {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono font-semibold text-slate-800 whitespace-nowrap">
                          {t.transaction_no}
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-800 truncate max-w-[150px]">
                          {party}
                        </td>
                        <td className="py-3 px-3 text-slate-700 truncate max-w-[130px]">
                          <span className="text-[11px] font-medium text-slate-700">{t.category_name}</span>
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-800">
                          <div>{t.description}</div>
                          {t.source_reference && (
                            <div className="text-[10px] font-mono text-slate-400">Ref: {t.source_reference}</div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-rose-800 whitespace-nowrap">
                          {formatIdr(t.net_amount)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          {renderVerificationBadge(t.verification_status)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${op.badgeClass}`}>
                            {op.label}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => openDetailDrawer(t.id)}
                              className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                            >
                              Detail
                            </button>
                            {isEligibleForSoftDelete(t) && (
                              <button
                                onClick={() => openSoftDeleteModal(t)}
                                className="px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                              >
                                Hapus
                              </button>
                            )}
                            {t.transaction_status === 'POSTED' && (
                              <button
                                onClick={() => openVoidModal(t)}
                                className="px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                              >
                                Void
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  if (activeTab === 'INCOME') {
                    return (
                      <tr
                        key={t.id}
                        onClick={() => openDetailDrawer(t.id)}
                        className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                      >
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                          <div className="text-[10px] text-slate-400">
                            {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono font-semibold text-slate-800 whitespace-nowrap">
                          {t.transaction_no}
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-800 truncate max-w-[150px]">
                          <div>{party}</div>
                          {t.phone && <div className="text-[10px] text-slate-400 font-normal">{t.phone}</div>}
                        </td>
                        <td className="py-3 px-3 text-slate-700 truncate max-w-[130px]">
                          <span className="text-[11px] font-medium text-slate-700">{t.category_name}</span>
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-800">
                          <div>{t.description}</div>
                          {t.source_reference && (
                            <div className="text-[10px] font-mono text-slate-400">Ref: {t.source_reference}</div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-teal-800 whitespace-nowrap">
                          {formatIdr(t.net_amount)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          {renderVerificationBadge(t.verification_status)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${op.badgeClass}`}>
                            {op.label}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => openDetailDrawer(t.id)}
                              className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                            >
                              Detail
                            </button>
                            {isEligibleForSoftDelete(t) && (
                              <button
                                onClick={() => openSoftDeleteModal(t)}
                                className="px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                              >
                                Hapus
                              </button>
                            )}
                            {t.transaction_status === 'POSTED' && (
                              <button
                                onClick={() => openVoidModal(t)}
                                className="px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                              >
                                Void
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  // ALL Tab Row
                  return (
                    <tr
                      key={t.id}
                      onClick={() => openDetailDrawer(t.id)}
                      className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                    >
                      <td className="py-3 px-3 whitespace-nowrap">
                        <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                        <div className="text-[10px] text-slate-400">
                          {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono font-semibold text-slate-800 whitespace-nowrap">
                        {t.transaction_no}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                            t.transaction_type === 'SALE'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : t.transaction_type === 'PURCHASE'
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : t.transaction_type === 'EXPENSE'
                              ? 'bg-rose-50 text-rose-700 border-rose-200'
                              : 'bg-teal-50 text-teal-700 border-teal-200'
                          }`}
                        >
                          {t.transaction_type === 'SALE'
                            ? 'Penjualan'
                            : t.transaction_type === 'PURCHASE'
                            ? 'Pembelian'
                            : t.transaction_type === 'EXPENSE'
                            ? 'Pengeluaran'
                            : 'Pemasukan'}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-medium text-slate-800 truncate max-w-[140px]">
                        {party}
                      </td>
                      <td className="py-3 px-3 text-slate-700 truncate max-w-[120px]">
                        <span className="text-[11px] font-medium text-slate-700">{t.category_name}</span>
                      </td>
                      <td className="py-3 px-4 max-w-xs truncate text-slate-800">
                        <div>{t.description}</div>
                        {t.room_number_snapshot && (
                          <span className="text-[10px] text-slate-400">Kmr {t.room_number_snapshot}</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-bold whitespace-nowrap">
                        <span
                          className={
                            t.transaction_type === 'SALE' || t.transaction_type === 'INCOME'
                              ? 'text-emerald-700'
                              : 'text-slate-800'
                          }
                        >
                          {formatIdr(t.net_amount)}
                        </span>
                      </td>
                      <td className="py-3 px-2 text-center whitespace-nowrap">
                        {renderVerificationBadge(t.verification_status)}
                      </td>
                      <td className="py-3 px-2 text-center whitespace-nowrap">
                        <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${op.badgeClass}`}>
                          {op.label}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openDetailDrawer(t.id)}
                            className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                          >
                            Detail
                          </button>
                          {isEligibleForSoftDelete(t) && (
                            <button
                              onClick={() => openSoftDeleteModal(t)}
                              className="px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                            >
                              Hapus
                            </button>
                          )}
                          {t.transaction_status === 'POSTED' && (
                            <button
                              onClick={() => openVoidModal(t)}
                              className="px-2 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                            >
                              Void
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination Footer */}
        {totalPages > 1 && (
          <div className="p-4 border-t border-slate-200 bg-slate-50/70 flex items-center justify-between text-xs text-slate-500">
            <div>
              Menampilkan <strong>{transactions.length}</strong> dari <strong>{totalCount}</strong> transaksi
            </div>
            <div className="flex items-center gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 border border-slate-200 rounded-lg bg-white disabled:opacity-40 hover:bg-slate-100 transition-colors cursor-pointer font-medium"
              >
                Sebelumnya
              </button>
              <span className="px-3 py-1.5 font-semibold text-slate-700">
                Halaman {page} dari {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-1.5 border border-slate-200 rounded-lg bg-white disabled:opacity-40 hover:bg-slate-100 transition-colors cursor-pointer font-medium"
              >
                Selanjutnya
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Void Modal */}
      <VoidTransactionModal
        isOpen={voidModalOpen}
        propertyId={propertyId}
        transaction={selectedTxForVoid}
        currentStaffName={currentStaffName}
        onClose={() => {
          setVoidModalOpen(false);
          setSelectedTxForVoid(null);
        }}
        onSuccess={() => {
          loadTransactions();
        }}
      />

      {/* Soft Delete Modal */}
      {softDeleteModalOpen && selectedTxForSoftDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-150">
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2 text-rose-700 font-bold text-sm">
                <svg className="w-5 h-5 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Hapus Draft Transaksi
              </div>
              <button
                onClick={() => {
                  setSoftDeleteModalOpen(false);
                  setSelectedTxForSoftDelete(null);
                }}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs text-rose-800 space-y-1">
                <p className="font-semibold">Perhatian:</p>
                <p>
                  Draft transaksi <strong className="font-mono">{selectedTxForSoftDelete.transaction_no}</strong> ({formatIdr(selectedTxForSoftDelete.net_amount)}) akan dipindahkan ke sheet <strong>Hapus</strong> dan tidak lagi dihitung dalam total finansial.
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Alasan Hapus <span className="text-rose-500">*</span>
                </label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {['Salah input', 'Duplikat', 'Batal pesanan vendor', 'Draft percobaan'].map((reasonPreset) => (
                    <button
                      key={reasonPreset}
                      type="button"
                      onClick={() => setDeleteReason(reasonPreset)}
                      className="px-2.5 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors cursor-pointer font-medium"
                    >
                      {reasonPreset}
                    </button>
                  ))}
                </div>
                <textarea
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder="Tuliskan alasan penghapusan draft..."
                  rows={3}
                  className="w-full text-xs border border-slate-200 rounded-xl p-2.5 text-slate-800 placeholder:text-slate-400 focus:outline-hidden focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 font-medium"
                />
              </div>

              {softDeleteError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 font-semibold">
                  {softDeleteError}
                </div>
              )}
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={isSoftDeleting}
                onClick={() => {
                  setSoftDeleteModalOpen(false);
                  setSelectedTxForSoftDelete(null);
                }}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={isSoftDeleting || !deleteReason.trim()}
                onClick={handleConfirmSoftDelete}
                className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-xl transition-colors cursor-pointer shadow-sm disabled:opacity-50 flex items-center gap-1.5"
              >
                {isSoftDeleting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Menghapus...
                  </>
                ) : (
                  'Ya, Hapus Draft'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Drawer */}
      <TransactionDetailDrawer
        isOpen={detailDrawerOpen}
        transactionId={selectedTxIdForDetail}
        propertyId={propertyId}
        currentStaffName={currentStaffName}
        currentUserId={currentUserId}
        onClose={() => {
          setDetailDrawerOpen(false);
          setSelectedTxIdForDetail(null);
        }}
        onOpenVoidModal={(tx) => {
          setDetailDrawerOpen(false);
          openVoidModal(tx);
        }}
        onOpenSoftDeleteModal={(tx) => {
          setDetailDrawerOpen(false);
          openSoftDeleteModal(tx);
        }}
        onNavigateToReservation={(resId) => {
          setDetailDrawerOpen(false);
          if (onNavigateToReservation) {
            onNavigateToReservation(resId);
          }
        }}
        onNavigateToFolio={(resId) => {
          setDetailDrawerOpen(false);
          if (onViewReservationFolio) {
            onViewReservationFolio({ id: resId });
          } else if (onNavigateToReservation) {
            onNavigateToReservation(resId);
          }
        }}
        onTransactionUpdated={() => {
          loadTransactions();
        }}
      />
    </div>
  );
};
