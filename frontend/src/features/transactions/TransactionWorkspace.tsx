import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import type {
  TransactionRecord,
  TransactionSummary,
  TransactionSheetCounts,
  CategoryOption,
  DepartmentOption,
  OperationalStatus,
  VerificationStatus
} from './transactionDomainTypes';
import { displayTransactionNet, formatReservationStayType, mapToOperationalStatus, stayTypeBadgeClass, getPurchaseReceivingClass, getPurchaseVerificationClass, getPurchaseWorkflowClass, isTransactionEditable } from './transactionDomainTypes';
import {
  flattenAllTabRows,
  formatStayShortDate,
  groupAllTabRows,
  groupPenjualanSaleRows,
  paymentStatusBadgeClass,
  shouldShowListSettlementAmounts,
  type PenjualanListItem
} from './penjualanBidGrouping';
import { getPenjualanPeriodPresetRange } from './transactionPeriodHelpers';
import { resolvePenjualanMainRowDetailTarget } from './penjualanDetailTarget';
import {
  fetchTransactionsApi,
  fetchCategoriesApi,
  fetchTransactionDetailApi,
  softDeleteTransactionApi,
  updatePurchaseLifecycleApi,
  updateExpenseLifecycleApi,
} from './transactionClient';
import type { PurchaseLifecycleAction, ExpenseLifecycleAction } from './transactionDomainTypes';
import { VoidTransactionModal } from './VoidTransactionModal';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';
import { BookingSalesDetailDrawer } from './BookingSalesDetailDrawer';
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
  // Editor View Mode (null = table view, 'PURCHASE' | 'EXPENSE' | 'INCOME' = dedicated full editors)
  const [activeEditor, setActiveEditor] = useState<'PURCHASE' | 'EXPENSE' | 'INCOME' | null>(null);
  /** EDIT-1B: Store transaction id for edit mode */
  const [editingExpenseId, setEditingExpenseId] = useState<number | string | null>(null);
  /** EDIT-1B: Store transaction data for edit mode pre-population */
  const [editingExpenseData, setEditingExpenseData] = useState<TransactionRecord | null>(null);

  // LEVEL 1 — TRANSACTION TYPE (Default: SALE)
  const [activeTab, setActiveTab] = useState<'SALE' | 'PURCHASE' | 'EXPENSE' | 'INCOME' | 'ALL'>('SALE');
  const [showVendorSupplierMaster, setShowVendorSupplierMaster] = useState<boolean>(false);

  // LEVEL 2 — DATE PERIOD
  const [datePreset, setDatePreset] = useState<'today' | 'yesterday' | 'this_month' | 'last_month' | 'all_time' | 'custom'>('today');
  const [startDate, setStartDate] = useState<string>(() => getPenjualanPeriodPresetRange('today').start);
  const [endDate, setEndDate] = useState<string>(() => getPenjualanPeriodPresetRange('today').end);
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
  const [bookingDetailOpen, setBookingDetailOpen] = useState<boolean>(false);
  const [selectedBookingIdForDetail, setSelectedBookingIdForDetail] = useState<number | string | null>(null);
  const [expandedBids, setExpandedBids] = useState<Record<string, boolean>>({});

  // PURCHASE-2B: expandable operational detail row
  const [expandedPurchaseIds, setExpandedPurchaseIds] = useState<Set<number | string>>(new Set());
  const [purchaseDetailCache, setPurchaseDetailCache] = useState<Map<number | string, TransactionRecord>>(new Map());
  const [purchaseLoadingIds, setPurchaseLoadingIds] = useState<Set<number | string>>(new Set());
  const [purchaseExpandErrors, setPurchaseExpandErrors] = useState<Map<number | string, string>>(new Map());

  // EXPENSE-1D: expandable operational detail row (mirrors Purchase pattern)
  const [expandedExpenseIds, setExpandedExpenseIds] = useState<Set<number | string>>(new Set());
  const [expenseDetailCache, setExpenseDetailCache] = useState<Map<number | string, TransactionRecord>>(new Map());
  const [expenseLoadingIds, setExpenseLoadingIds] = useState<Set<number | string>>(new Set());
  const [expenseExpandErrors, setExpenseExpandErrors] = useState<Map<number | string, string>>(new Map());

  // PURCHASE-2A3: inline lifecycle control per-cell loading state
  const [lifecycleSaving, setLifecycleSaving] = useState<Record<string, boolean>>({});

  // PURCHASE-2C: supplier bank quick-info popover
  const [bankPopoverOpen, setBankPopoverOpen] = useState<boolean>(false);
  const [bankPopoverTx, setBankPopoverTx] = useState<TransactionRecord | null>(null);
  const [bankPopoverPos, setBankPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [bankCopied, setBankCopied] = useState<string | null>(null);
  const [bankToastMessage, setBankToastMessage] = useState<string | null>(null);
  const [activeBankTrigger, setActiveBankTrigger] = useState<HTMLButtonElement | null>(null);
  const [bankPopoverPinned, setBankPopoverPinned] = useState<boolean>(false);
  // Ref tracks current pinned state for use inside async callbacks
  // Synchronized synchronously in closeBankPopover and handleBankPopoverToggle
  // so that already-queued timers see the updated state immediately,
  // without waiting for the next React render.
  const bankPopoverPinnedRef = useRef<boolean>(false);
  const bankPopoverRef = useRef<HTMLDivElement>(null);
  const bankHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bankToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const range = getPenjualanPeriodPresetRange(preset);
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
    setExpandedBids({});
    setExpandedPurchaseIds(new Set());
    setPurchaseDetailCache(new Map());
    setPurchaseLoadingIds(new Set());
    setPurchaseExpandErrors(new Map());
    setExpandedExpenseIds(new Set());
    setExpenseDetailCache(new Map());
    setExpenseLoadingIds(new Set());
    setExpenseExpandErrors(new Map());
  }, [propertyId, activeTab, operationalStatus, startDate, endDate, debouncedSearch, page]);

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
    setBookingDetailOpen(false);
    setSelectedBookingIdForDetail(null);
    setSelectedTxIdForDetail(txId);
    setDetailDrawerOpen(true);
  };

  const openBookingSalesDetail = (bookingId: number | string) => {
    setDetailDrawerOpen(false);
    setSelectedTxIdForDetail(null);
    setSelectedBookingIdForDetail(bookingId);
    setBookingDetailOpen(true);
  };

  const openPenjualanItemDetail = (item: PenjualanListItem) => {
    const target = resolvePenjualanMainRowDetailTarget(item);
    if (target.kind === 'booking') {
      openBookingSalesDetail(target.bookingId);
      return;
    }
    openDetailDrawer(target.transactionId);
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

  /** EDIT-1B: Open expense in edit mode */
  const openExpenseEditor = async (tx: TransactionRecord) => {
    // Load full detail for pre-population
    try {
      const detail = await fetchTransactionDetailApi(tx.id, propertyId);
      setEditingExpenseData(detail);
      setEditingExpenseId(tx.id);
      setActiveEditor('EXPENSE');
    } catch (err) {
      console.error('Failed to load expense detail for editing:', err);
      // Fallback: use list data
      setEditingExpenseData(tx);
      setEditingExpenseId(tx.id);
      setActiveEditor('EXPENSE');
    }
  };

  // PURCHASE-2A3: inline lifecycle mutation handler with per-cell loading state
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const handlePurchaseLifecycleMutation = async (
    tx: TransactionRecord,
    action: PurchaseLifecycleAction,
    value: string
  ) => {
    const key = `${String(tx.id)}:${action}`;
    setLifecycleSaving(prev => ({ ...prev, [key]: true }));
    setLifecycleError(null);
    try {
      const payload: {
        property_id: number;
        action: PurchaseLifecycleAction;
        receiving_status?: string | null;
        verification_status?: string | null;
        workflow_status?: string | null;
      } = { property_id: propertyId, action };
      if (action === 'SET_RECEIVING') {
        payload.receiving_status = value;
      } else if (action === 'SET_VERIFICATION') {
        payload.verification_status = value;
      } else if (action === 'SET_WORKFLOW') {
        payload.workflow_status = value;
      }
      await updatePurchaseLifecycleApi(tx.id, payload);
      await loadTransactions();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'Gagal memperbarui status';
      setLifecycleError(msg);
      console.error(`PURCHASE-2A3: ${action} failed:`, err);
    } finally {
      setLifecycleSaving(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  // EXPENSE-1C: inline lifecycle mutation handler for expense verification & workflow
  const handleExpenseLifecycleMutation = async (
    tx: TransactionRecord,
    action: ExpenseLifecycleAction,
    value: string
  ) => {
    const key = `exp:${String(tx.id)}:${action}`;
    setLifecycleSaving(prev => ({ ...prev, [key]: true }));
    setLifecycleError(null);
    try {
      const payload: {
        property_id: number;
        action: ExpenseLifecycleAction;
        verification_status?: string | null;
        workflow_status?: string | null;
      } = { property_id: propertyId, action };
      if (action === 'SET_VERIFICATION') {
        payload.verification_status = value;
      } else if (action === 'SET_WORKFLOW') {
        payload.workflow_status = value;
      }
      await updateExpenseLifecycleApi(tx.id, payload);
      await loadTransactions();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'Gagal memperbarui status';
      setLifecycleError(msg);
      console.error(`EXPENSE-1C: ${action} failed:`, err);
    } finally {
      setLifecycleSaving(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  // PURCHASE-2C: supplier bank quick-info popover
  const clearBankHoverTimer = () => {
    if (bankHoverTimerRef.current) {
      clearTimeout(bankHoverTimerRef.current);
      bankHoverTimerRef.current = null;
    }
  };

  const closeBankPopover = () => {
    clearBankHoverTimer();
    setActiveBankTrigger(null);
    bankPopoverPinnedRef.current = false;
    setBankPopoverPinned(false);
    setBankPopoverOpen(false);
    setBankPopoverTx(null);
  };

  const handleBankPopoverToggle = (tx: TransactionRecord, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    clearBankHoverTimer();
    if (bankPopoverTx?.id === tx.id && bankPopoverOpen) {
      // Clicking same trigger while unpinned → pin (don't close)
      // Clicking same trigger while pinned → close
      if (bankPopoverPinned) {
        closeBankPopover();
      } else {
        bankPopoverPinnedRef.current = true;
        setBankPopoverPinned(true);
      }
      return;
    }
    setActiveBankTrigger(e.currentTarget);
    setBankPopoverTx(tx);
    setBankPopoverOpen(true);
    // Click always pins so backdrop appears and stays open
    bankPopoverPinnedRef.current = true;
    setBankPopoverPinned(true);
  };

  // Desktop hover intent: open after brief delay; moving into popover cancels close
  const handleBankTriggerMouseEnter = (tx: TransactionRecord, e: React.MouseEvent<HTMLButtonElement>) => {
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      // Pinned popover is isolated — hover on other rows must not mutate it
      if (bankPopoverPinnedRef.current) return;
      clearBankHoverTimer();
      const triggerEl = e.currentTarget;
      bankHoverTimerRef.current = setTimeout(() => {
        // Re-check pinned state inside stale-closure-safe callback
        if (bankPopoverPinnedRef.current) return;
        setActiveBankTrigger(triggerEl);
        setBankPopoverTx(tx);
        setBankPopoverOpen(true);
      }, 120);
    }
  };

  const handleBankTriggerMouseLeave = () => {
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      // Pinned popover is immune to mouse leave
      if (bankPopoverPinnedRef.current) return;
      clearBankHoverTimer();
      bankHoverTimerRef.current = setTimeout(() => {
        if (bankPopoverRef.current && !bankPopoverRef.current.matches(':hover')) {
          closeBankPopover();
        }
      }, 200);
    }
  };

  // Keyboard accessibility: focus on trigger opens popover
  const handleBankTriggerFocus = (tx: TransactionRecord, e: React.FocusEvent<HTMLButtonElement>) => {
    if (e.target === e.currentTarget) {
      // Pinned popover is isolated from focus on other triggers
      if (bankPopoverPinnedRef.current) return;
      clearBankHoverTimer();
      // Focus = hover mode, no pin
      setActiveBankTrigger(e.currentTarget);
      setBankPopoverTx(tx);
      setBankPopoverOpen(true);
    }
  };

  const handleBankPopoverMouseEnter = () => {
    clearBankHoverTimer();
  };

  const handleBankPopoverMouseLeave = () => {
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      // Pinned popover is immune to mouse leave
      if (bankPopoverPinnedRef.current) return;
      clearBankHoverTimer();
      bankHoverTimerRef.current = setTimeout(() => {
        closeBankPopover();
      }, 200);
    }
  };

  const handleCopyBankAccount = async (txId: string | number, account: string) => {
    try {
      await navigator.clipboard.writeText(account);
      setBankCopied(String(txId));
      setBankToastMessage('No. rekening disalin');
      if (bankToastTimerRef.current) clearTimeout(bankToastTimerRef.current);
      bankToastTimerRef.current = setTimeout(() => {
        setBankToastMessage(null);
        setBankCopied(null);
      }, 2000);
    } catch { /* ignore */ }
  };

  // Close bank popover on outside click or Escape
  useEffect(() => {
    if (!bankPopoverOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeBankPopover();
      }
    };
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        bankPopoverRef.current && !bankPopoverRef.current.contains(target) &&
        activeBankTrigger && !activeBankTrigger.contains(target)
      ) {
        closeBankPopover();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [bankPopoverOpen, activeBankTrigger]);

  // PURCHASE-2C: position bank popover near active trigger
  useLayoutEffect(() => {
    if (!bankPopoverOpen || !activeBankTrigger) return;
    const rect = activeBankTrigger.getBoundingClientRect();
    const cardWidth = 320;
    const padding = 16;
    const spaceBelow = window.innerHeight - rect.bottom - padding;
    const spaceAbove = rect.top - padding;
    let top = rect.bottom + 8;
    let left = Math.max(padding, Math.min(rect.left, window.innerWidth - cardWidth - padding));
    if (spaceBelow >= 200) {
      top = rect.bottom + 8;
    } else if (spaceAbove >= 200) {
      top = rect.top - 200 - 8;
    }
    top = Math.min(top, window.innerHeight - 200 - padding);
    setBankPopoverPos({ top, left });
  }, [bankPopoverOpen, activeBankTrigger]);

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

  const penjualanItems = useMemo(
    () => (activeTab === 'SALE' && operationalStatus !== 'HAPUS' ? groupPenjualanSaleRows(transactions) : []),
    [activeTab, operationalStatus, transactions]
  );

  const workspaceRows = useMemo(() => {
    if (activeTab === 'ALL' && operationalStatus !== 'HAPUS') {
      return flattenAllTabRows(groupAllTabRows(transactions));
    }
    return transactions;
  }, [activeTab, operationalStatus, transactions]);

  const periodListHint = 'Nilai pada daftar mengikuti periode yang dipilih. Detail menampilkan seluruh booking.';
  const settlementListHint = 'Pelunasan booking ditampilkan di Detail, bukan sebagai sisa periode.';

  const openWorkspaceRowDetail = (t: TransactionRecord) => {
    if (t.booking_bid_group) {
      const bookingId = t.booking_bid_group.booking_id ?? t.booking_id ?? t.booking_bid_group.bid;
      if (bookingId) {
        openBookingSalesDetail(bookingId);
        return;
      }
    }
    openDetailDrawer(t.id);
  };

  const toggleBidExpand = (bid: string) => {
    setExpandedBids((prev) => ({ ...prev, [bid]: !prev[bid] }));
  };

  // PURCHASE-2B: toggle purchase row expansion with lazy load
  const togglePurchaseExpand = async (txId: number | string) => {
    const isExpanded = expandedPurchaseIds.has(txId);

    if (isExpanded) {
      setExpandedPurchaseIds((prev) => {
        const next = new Set(prev);
        next.delete(txId);
        return next;
      });
    } else {
      setExpandedPurchaseIds((prev) => {
        const next = new Set(prev);
        next.add(txId);
        return next;
      });
      setPurchaseExpandErrors((prev) => {
        const next = new Map(prev);
        next.delete(txId);
        return next;
      });

      if (!purchaseDetailCache.has(txId) && !purchaseLoadingIds.has(txId)) {
        setPurchaseLoadingIds((prev) => {
          const next = new Set(prev);
          next.add(txId);
          return next;
        });
        try {
          const detail = await fetchTransactionDetailApi(txId, propertyId);
          setPurchaseDetailCache((prev) => {
            const next = new Map(prev);
            next.set(txId, detail);
            return next;
          });
        } catch (err: any) {
          setPurchaseExpandErrors((prev) => {
            const next = new Map(prev);
            next.set(txId, err.message || 'Gagal memuat detail');
            return next;
          });
        } finally {
          setPurchaseLoadingIds((prev) => {
            const next = new Set(prev);
            next.delete(txId);
            return next;
          });
        }
      }
    }
  };

  // PURCHASE-2B: retry detail fetch while keeping row expanded
  const retryPurchaseExpand = async (txId: number | string) => {
    setPurchaseExpandErrors((prev) => {
      const next = new Map(prev);
      next.delete(txId);
      return next;
    });
    setPurchaseLoadingIds((prev) => {
      const next = new Set(prev);
      next.add(txId);
      return next;
    });
    try {
      const detail = await fetchTransactionDetailApi(txId, propertyId);
      setPurchaseDetailCache((prev) => {
        const next = new Map(prev);
        next.set(txId, detail);
        return next;
      });
    } catch (err: any) {
      setPurchaseExpandErrors((prev) => {
        const next = new Map(prev);
        next.set(txId, err.message || 'Gagal memuat detail');
        return next;
      });
    } finally {
      setPurchaseLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(txId);
        return next;
      });
    }
  };

  // EXPENSE-1D: toggle expense row expansion with lazy load
  const toggleExpenseExpand = async (txId: number | string) => {
    const isExpanded = expandedExpenseIds.has(txId);

    if (isExpanded) {
      setExpandedExpenseIds((prev) => {
        const next = new Set(prev);
        next.delete(txId);
        return next;
      });
    } else {
      setExpandedExpenseIds((prev) => {
        const next = new Set(prev);
        next.add(txId);
        return next;
      });
      setExpenseExpandErrors((prev) => {
        const next = new Map(prev);
        next.delete(txId);
        return next;
      });

      if (!expenseDetailCache.has(txId) && !expenseLoadingIds.has(txId)) {
        setExpenseLoadingIds((prev) => {
          const next = new Set(prev);
          next.add(txId);
          return next;
        });
        try {
          const detail = await fetchTransactionDetailApi(txId, propertyId);
          setExpenseDetailCache((prev) => {
            const next = new Map(prev);
            next.set(txId, detail);
            return next;
          });
        } catch (err: any) {
          setExpenseExpandErrors((prev) => {
            const next = new Map(prev);
            next.set(txId, err.message || 'Gagal memuat detail');
            return next;
          });
        } finally {
          setExpenseLoadingIds((prev) => {
            const next = new Set(prev);
            next.delete(txId);
            return next;
          });
        }
      }
    }
  };

  // EXPENSE-1D: retry detail fetch while keeping row expanded
  const retryExpenseExpand = async (txId: number | string) => {
    setExpenseExpandErrors((prev) => {
      const next = new Map(prev);
      next.delete(txId);
      return next;
    });
    setExpenseLoadingIds((prev) => {
      const next = new Set(prev);
      next.add(txId);
      return next;
    });
    try {
      const detail = await fetchTransactionDetailApi(txId, propertyId);
      setExpenseDetailCache((prev) => {
        const next = new Map(prev);
        next.set(txId, detail);
        return next;
      });
    } catch (err: any) {
      setExpenseExpandErrors((prev) => {
        const next = new Map(prev);
        next.set(txId, err.message || 'Gagal memuat detail');
        return next;
      });
    } finally {
      setExpenseLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(txId);
        return next;
      });
    }
  };

  const renderStayTypeBadge = (label: string) => {
    if (!label || label === '-') {
      return <span className="text-[11px] font-medium text-slate-400">-</span>;
    }
    if (label === 'MIXED') {
      return (
        <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border bg-slate-50 text-slate-700 border-slate-200">
          MIXED
        </span>
      );
    }
    const stayType = label === 'DAY USE' ? 'DAY_USE' : label === 'OVERNIGHT' ? 'OVERNIGHT' : label;
    return (
      <span className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded border ${stayTypeBadgeClass(stayType)}`}>
        {label}
      </span>
    );
  };

  const renderPaymentBadge = (status: string) => (
    <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${paymentStatusBadgeClass(status)}`}>
      {status}
    </span>
  );

  const renderOperationalBadge = (txLike: Parameters<typeof mapToOperationalStatus>[0]) => {
    const op = mapToOperationalStatus(txLike);
    return (
      <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${op.badgeClass}`}>
        {op.label}
      </span>
    );
  };

  const renderPenjualanItem = (item: PenjualanListItem) => {
    if (item.kind === 'standalone') {
      const t = item.tx;
      const party = t.party_name || t.guest_name_snapshot || t.supplier_name || '-';
      const paid = t.reservation_amount_paid != null ? Number(t.reservation_amount_paid) : Number(t.paid_amount || 0);
      const remaining = t.reservation_remaining_balance != null
        ? Number(t.reservation_remaining_balance)
        : Number(t.outstanding_amount || 0);
      return (
        <tr
          key={t.id}
          onClick={() => openPenjualanItemDetail(item)}
          className="hover:bg-slate-50/80 transition-colors cursor-pointer"
        >
          <td className="py-2.5 px-3 whitespace-nowrap">
            <div className="font-semibold text-slate-800">{t.transaction_date}</div>
            <div className="text-[10px] text-slate-400">
              {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </td>
          <td className="py-2.5 px-3 whitespace-nowrap">
            <span className="font-mono font-semibold text-slate-800">{t.transaction_no}</span>
            {t.source_reference && (
              <div className="text-[10px] font-mono text-slate-400">Ref: {t.source_reference}</div>
            )}
            <div className="mt-0.5">{getSourceBadge(t.source_type)}</div>
          </td>
          <td className="py-2.5 px-3 max-w-[180px]">
            <div className="font-semibold text-slate-800 truncate">{party}</div>
            <div className="text-[10px] text-slate-400 truncate">{t.description}</div>
          </td>
          <td className="py-2.5 px-3 whitespace-nowrap">{renderStayTypeBadge(formatReservationStayType(t.stay_type))}</td>
          <td className="py-2.5 px-3 text-right font-mono text-slate-700 whitespace-nowrap">{formatIdr(t.amount)}</td>
          <td className="py-2.5 px-3 text-right font-mono text-slate-500 whitespace-nowrap">{formatIdr(t.discount_amount)}</td>
          <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-800 whitespace-nowrap">{formatIdr(displayTransactionNet(t))}</td>
          <td className="py-2.5 px-3 text-right font-mono text-slate-700 whitespace-nowrap">{formatIdr(paid)}</td>
          <td className="py-2.5 px-3 text-right font-mono text-slate-700 whitespace-nowrap">{formatIdr(remaining)}</td>
          <td className="py-2.5 px-2 text-center whitespace-nowrap">{renderPaymentBadge(t.payment_status)}</td>
          <td className="py-2.5 px-2 text-center whitespace-nowrap">{renderOperationalBadge(t)}</td>
          <td className="py-2.5 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => openPenjualanItemDetail(item)}
              className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
            >
              Detail
            </button>
          </td>
        </tr>
      );
    }

    const { group } = item;
    const t = group.primary;
    const expanded = Boolean(expandedBids[group.bid]);
    return (
      <React.Fragment key={`bid:${group.bid}`}>
        <tr
          onClick={() => openPenjualanItemDetail(item)}
          className="hover:bg-slate-50/80 transition-colors cursor-pointer"
        >
          <td className="py-2.5 px-3 whitespace-nowrap">
            <div className="flex items-start gap-1.5">
              <button
                type="button"
                aria-label={expanded ? 'Tutup kamar' : 'Lihat kamar'}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBidExpand(group.bid);
                }}
                className="mt-0.5 w-5 h-5 inline-flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <div>
                <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                <div className="text-[10px] text-slate-400">
                  {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          </td>
          <td className="py-2.5 px-3 whitespace-nowrap">
            <span className="font-mono font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
              {group.bid}
            </span>
          </td>
          <td className="py-2.5 px-3 max-w-[200px]">
            <div className="font-semibold text-slate-800 truncate">{group.guest_name}</div>
            <span
              className="inline-flex items-center mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800"
              title={periodListHint}
            >
              {group.room_count} kamar aktivitas
            </span>
          </td>
          <td className="py-2.5 px-3 whitespace-nowrap">{renderStayTypeBadge(group.stay_type_label)}</td>
          <td className="py-2.5 px-3 text-right font-mono text-slate-700 whitespace-nowrap">{formatIdr(group.gross)}</td>
          <td className="py-2.5 px-3 text-right font-mono text-slate-500 whitespace-nowrap">{formatIdr(group.discount)}</td>
          <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-800 whitespace-nowrap" title={periodListHint}>
            {formatIdr(group.net)}
          </td>
          <td className="py-2.5 px-3 text-right font-mono text-slate-400 whitespace-nowrap" title={settlementListHint}>
            {shouldShowListSettlementAmounts(item) ? formatIdr(group.paid) : '—'}
          </td>
          <td className="py-2.5 px-3 text-right font-mono text-slate-400 whitespace-nowrap" title={settlementListHint}>
            {shouldShowListSettlementAmounts(item) ? formatIdr(group.remaining) : '—'}
          </td>
          <td className="py-2.5 px-2 text-center whitespace-nowrap">{renderPaymentBadge(group.payment_status)}</td>
          <td className="py-2.5 px-2 text-center whitespace-nowrap">
            {renderOperationalBadge({
              transaction_status: t.transaction_status,
              transaction_type: 'SALE',
              is_lifecycle_primary: true,
              operational_sheet: group.operational_sheet
            })}
          </td>
          <td className="py-2.5 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => openPenjualanItemDetail(item)}
              className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
            >
              Detail
            </button>
          </td>
        </tr>
        {expanded && (
          <tr className="bg-slate-50/70">
            <td colSpan={12} className="px-4 py-2.5">
              <div className="rounded-lg border border-slate-200 bg-white/80 overflow-hidden">
                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-100">
                  Kamar aktivitas periode
                </div>
                <table className="w-full text-[11px]">
                  <thead className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="py-1.5 px-3 text-left">Kamar</th>
                      <th className="py-1.5 px-3 text-left">Tipe</th>
                      <th className="py-1.5 px-3 text-left">Check-in</th>
                      <th className="py-1.5 px-3 text-left">Check-out</th>
                      <th className="py-1.5 px-3 text-right">Gross</th>
                      <th className="py-1.5 px-3 text-right">Diskon</th>
                      <th className="py-1.5 px-3 text-right">Net</th>
                      <th className="py-1.5 px-3 text-right">Dibayar</th>
                      <th className="py-1.5 px-3 text-right">Sisa</th>
                      <th className="py-1.5 px-3 text-center">Status</th>
                      <th className="py-1.5 px-3 text-center">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.children.map((child) => (
                      <tr key={child.reservation_id || child.primary_transaction_id} className="border-t border-slate-100">
                        <td className="py-1.5 px-3 font-semibold text-slate-800 whitespace-nowrap">{child.room_number || '-'}</td>
                        <td className="py-1.5 px-3 text-slate-700 whitespace-nowrap">{child.room_type_name || '-'}</td>
                        <td className="py-1.5 px-3 text-slate-600 whitespace-nowrap">{formatStayShortDate(child.check_in)}</td>
                        <td className="py-1.5 px-3 text-slate-600 whitespace-nowrap">{formatStayShortDate(child.check_out)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-slate-700 whitespace-nowrap">{formatIdr(child.gross)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-slate-500 whitespace-nowrap">{formatIdr(child.discount)}</td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-slate-800 whitespace-nowrap">{formatIdr(child.net)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-slate-400 whitespace-nowrap" title={settlementListHint}>—</td>
                        <td className="py-1.5 px-3 text-right font-mono text-slate-400 whitespace-nowrap" title={settlementListHint}>—</td>
                        <td className="py-1.5 px-3 text-center whitespace-nowrap">{renderPaymentBadge(child.payment_status)}</td>
                        <td className="py-1.5 px-3 text-center whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => openDetailDrawer(child.primary_transaction_id)}
                            className="px-2 py-0.5 text-[10px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                          >
                            Detail
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
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
        onBack={() => {
          setActiveEditor(null);
          setEditingExpenseId(null);
          setEditingExpenseData(null);
        }}
        editMode={!!editingExpenseId}
        initialData={editingExpenseData}
        onSuccess={(updatedId) => {
          setActiveEditor(null);
          setEditingExpenseId(null);
          setEditingExpenseData(null);
          loadTransactions();
          openDetailDrawer(updatedId);
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
              {(activeTab === 'SALE' || activeTab === 'ALL') && (
                <span
                  className="ml-1 text-[10px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md"
                  title={periodListHint}
                >
                  Aktivitas Periode
                </span>
              )}
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
                        <th className="py-3 px-3">Tipe Stay</th>
                        <th className="py-3 px-3 text-right" title={periodListHint}>Gross</th>
                        <th className="py-3 px-3 text-right" title={periodListHint}>Diskon</th>
                        <th className="py-3 px-3 text-right" title={periodListHint}>Net</th>
                        <th className="py-3 px-3 text-right" title={settlementListHint}>Dibayar</th>
                        <th className="py-3 px-3 text-right" title={settlementListHint}>Sisa</th>
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
                        <th className="py-3 px-4">Keterangan</th>
                        <th className="py-3 px-3 text-right">Total Tagihan</th>
                        <th className="py-3 px-3 text-center">Penerimaan</th>
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
                        <th className="py-3 px-2 text-center">Pembayaran</th>
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
                {activeTab === 'SALE' && operationalStatus !== 'HAPUS' && penjualanItems.map(renderPenjualanItem)}
                {(activeTab !== 'SALE' || operationalStatus === 'HAPUS') && workspaceRows.map((t) => {
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

                  if (activeTab === 'PURCHASE') {
                    const isExpanded = expandedPurchaseIds.has(t.id);
                    const detail = purchaseDetailCache.get(t.id);
                    const isLoading = purchaseLoadingIds.has(t.id);
                    const error = purchaseExpandErrors.get(t.id);

                    return (
                      <React.Fragment key={t.id}>
                        <tr
                          onClick={() => openDetailDrawer(t.id)}
                          className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                        >
                          <td className="py-3 px-3 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                aria-label={isExpanded ? 'Tutup detail pembelian' : 'Lihat detail pembelian'}
                                aria-expanded={isExpanded}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePurchaseExpand(t.id);
                                }}
                                className="mt-0.5 w-5 h-5 inline-flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 cursor-pointer transition-colors"
                              >
                                <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                                </svg>
                              </button>
                              <div>
                                <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                                <div className="text-[10px] text-slate-400">
                                  {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              </div>
                            </div>
                          </td>
                        <td className="py-3 px-3 font-mono font-semibold text-slate-800 whitespace-nowrap">
                          {t.transaction_no}
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-800 truncate max-w-[150px]">
                          <div>{t.supplier_name || t.party_name || '-'}</div>
                          <div className="text-[10px] text-slate-400 font-normal">
                            {t.department_name_snapshot || t.department_code || ''}
                          </div>
                          {t.supplier_phone && (
                            <div className="text-[10px] text-slate-400 font-normal">{t.supplier_phone}</div>
                          )}
                          {t.supplier_bank_name && t.supplier_bank_account && (
                            <button
                              type="button"
                              onClick={(e) => handleBankPopoverToggle(t, e)}
                              onMouseEnter={(e) => handleBankTriggerMouseEnter(t, e)}
                              onMouseLeave={handleBankTriggerMouseLeave}
                              onFocus={(e) => handleBankTriggerFocus(t, e)}
                              onBlur={() => clearBankHoverTimer()}
                              className="mt-1 inline-flex items-center gap-1 text-[10px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded px-1 py-0.5 transition-colors cursor-pointer"
                              title="Lihat info bank supplier"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <span>Bank</span>
                            </button>
                          )}
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-800">
                          <div>{t.description}</div>
                          {t.source_reference && (
                            <div className="text-[10px] font-mono text-slate-400">Faktur: {t.source_reference}</div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-slate-800 whitespace-nowrap">
                          {formatIdr(displayTransactionNet(t))}
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const rc = getPurchaseReceivingClass(t.receiving_status || 'BELUM_DITERIMA');
                            return (
                              <select
                                value={t.receiving_status || 'BELUM_DITERIMA'}
                                onChange={async (e) => {
                                  e.stopPropagation();
                                  await handlePurchaseLifecycleMutation(t, 'SET_RECEIVING', e.target.value);
                                }}
                                disabled={lifecycleSaving[`${String(t.id)}:SET_RECEIVING`] || !isTransactionEditable(t)}
                                className={`text-[11px] font-semibold px-2 py-0.5 rounded-lg border cursor-pointer focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-60 ${rc.bg} ${rc.border} ${rc.text} hover:bg-opacity-80`}
                              >
                                <option value="BELUM_DITERIMA">Belum Diterima</option>
                                <option value="DITERIMA_SEBAGIAN">Diterima Sebagian</option>
                                <option value="DITERIMA">Diterima</option>
                                <option value="DITERIMA_LENGKAP">Diterima Lengkap</option>
                              </select>
                            );
                          })()}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const vc = getPurchaseVerificationClass(t.verification_status || 'UNVERIFIED');
                            return (
                              <select
                                value={t.verification_status || 'UNVERIFIED'}
                                onChange={async (e) => {
                                  e.stopPropagation();
                                  await handlePurchaseLifecycleMutation(t, 'SET_VERIFICATION', e.target.value);
                                }}
                                disabled={lifecycleSaving[`${String(t.id)}:SET_VERIFICATION`] || !isTransactionEditable(t)}
                                className={`text-[11px] font-semibold px-2 py-0.5 rounded-lg border cursor-pointer focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-60 ${vc.bg} ${vc.border} ${vc.text} hover:bg-opacity-80`}
                              >
                                <option value="UNVERIFIED">Belum Terverifikasi</option>
                                <option value="VERIFIED">Terverifikasi</option>
                                <option value="REJECTED">Ditolak</option>
                              </select>
                            );
                          })()}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          {(() => {
                            const ws = t.operational_sheet || 'PROSES';
                            const wc = getPurchaseWorkflowClass(ws);
                            if (ws === 'BATAL') {
                              return (
                                <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md ${wc.bg} ${wc.border} ${wc.text} cursor-default`}>
                                  Batal
                                </span>
                              );
                            }
                            if (ws === 'HAPUS') {
                              return (
                                <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md ${wc.bg} ${wc.border} ${wc.text} cursor-default`}>
                                  Dihapus
                                </span>
                              );
                            }
                            return (
                              <select
                                value={ws}
                                onChange={async (e) => {
                                  e.stopPropagation();
                                  await handlePurchaseLifecycleMutation(t, 'SET_WORKFLOW', e.target.value);
                                }}
                                disabled={lifecycleSaving[`${String(t.id)}:SET_WORKFLOW`]}
                                className={`text-[11px] font-semibold px-2 py-0.5 rounded-lg border cursor-pointer focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-60 ${wc.bg} ${wc.border} ${wc.text} hover:bg-opacity-80`}
                              >
                                <option value="PROSES">Proses</option>
                                <option value="SELESAI">Selesai</option>
                              </select>
                            );
                          })()}
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
                        {isExpanded && (
                          <tr className="bg-slate-50/60">
                            <td colSpan={9} className="px-4 py-3">
                              <div className="rounded-lg border border-slate-200 bg-white/90 overflow-hidden">
                                <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-100 bg-slate-50/50">
                                  Rincian Item Pembelian
                                </div>
                                {isLoading ? (
                                  <div className="px-4 py-6 text-center text-sm text-slate-500">
                                    Memuat detail...
                                  </div>
                                 ) : error ? (
                                   <div className="px-4 py-4">
                                     <div className="text-sm text-rose-600 mb-2">Gagal memuat detail pembelian.</div>
                                     <button
                                       type="button"
                                       onClick={(e) => {
                                         e.stopPropagation();
                                         retryPurchaseExpand(t.id);
                                       }}
                                       className="text-xs text-emerald-600 hover:text-emerald-700 underline cursor-pointer"
                                     >
                                       Coba lagi
                                     </button>
                                   </div>
                                 ) : detail ? (
                                   <>
                                     {detail.lines && detail.lines.length > 0 ? (
                                       <div className="overflow-x-auto">
                                         <table className="w-full text-[11px]">
                                           <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase text-[10px]">
                                             <tr>
                                               <th className="py-2 px-3 text-left">Item / Deskripsi</th>
                                               <th className="py-2 px-3 text-right">Qty</th>
                                               <th className="py-2 px-3 text-left">Satuan</th>
                                               <th className="py-2 px-3 text-right">Harga Satuan</th>
                                               <th className="py-2 px-3 text-right">Diskon</th>
                                               <th className="py-2 px-3 text-right">Subtotal</th>
                                             </tr>
                                           </thead>
                                           <tbody className="divide-y divide-slate-100">
                                             {detail.lines.map((line, idx) => (
                                               <tr key={line.id || idx}>
                                                 <td className="py-2 px-3 text-slate-700">{line.description_snapshot}</td>
                                                 <td className="py-2 px-3 text-right font-mono">{Number(line.quantity)}</td>
                                                 <td className="py-2 px-3 text-slate-500">{line.unit}</td>
                                                 <td className="py-2 px-3 text-right font-mono">{formatIdr(Number(line.unit_price))}</td>
                                                 <td className="py-2 px-3 text-right font-mono text-slate-500">{formatIdr(Number(line.discount_amount))}</td>
                                                 <td className="py-2 px-3 text-right font-mono font-semibold text-slate-800">{formatIdr(Number(line.line_total))}</td>
                                               </tr>
                                             ))}
                                           </tbody>
                                         </table>
                                       </div>
                                     ) : (
                                       <div className="px-4 py-4 text-center text-sm text-slate-500">
                                         Tidak ada rincian item.
                                       </div>
                                     )}
                                     <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/30 space-y-1 text-xs">
                                       <div className="flex justify-between">
                                         <span className="text-slate-500">Gross / Nilai Bruto:</span>
                                         <span className="font-mono font-semibold">{formatIdr(detail.amount)}</span>
                                       </div>
                                       <div className="flex justify-between">
                                         <span className="text-slate-500">Diskon Transaksi:</span>
                                         <span className="font-mono">{formatIdr(detail.discount_amount)}</span>
                                       </div>
                                       <div className="flex justify-between font-bold border-t border-slate-200 pt-1">
                                         <span className="text-slate-700">Net / Total Tagihan:</span>
                                         <span className="font-mono text-emerald-700">{formatIdr(detail.net_amount)}</span>
                                       </div>
                                       <div className="flex justify-between">
                                         <span className="text-slate-500">Penerimaan:</span>
                                         <span className="font-mono">{detail.receiving_status || '-'}</span>
                                       </div>
                                       <div className="flex justify-between">
                                         <span className="text-slate-500">Referensi:</span>
                                         <span className="font-mono">{detail.source_reference || '-'}</span>
                                       </div>
                                       <div className="flex justify-between">
                                         <span className="text-slate-500">Departemen:</span>
                                         <span className="font-mono">{detail.department_name_snapshot || detail.department_code || '-'}</span>
                                       </div>
                                       <div className="flex justify-between">
                                         <span className="text-slate-500">Kategori:</span>
                                         <span className="font-mono">{detail.category_name || detail.category_code || '-'}</span>
                                       </div>
                                     </div>
                                   </>
                                 ) : (
                                   <div className="px-4 py-6 text-center text-sm text-slate-500">
                                     Memuat detail...
                                   </div>
                                 )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  }

                    if (activeTab === 'EXPENSE') {
                      const isExpanded = expandedExpenseIds.has(t.id);
                      const detail = expenseDetailCache.get(t.id);
                      const isLoading = expenseLoadingIds.has(t.id);
                      const error = expenseExpandErrors.get(t.id);
                      const party = t.party_name || ' -';
                      const hasRecipientBank = !!(t.recipient_bank_name || t.recipient_bank_account || t.recipient_bank_holder);

                      return (
                        <React.Fragment key={t.id}>
                          <tr
                            onClick={() => openDetailDrawer(t.id)}
                            className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                          >
                            <td className="py-3 px-3 whitespace-nowrap">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  aria-label={isExpanded ? 'Tutup detail pengeluaran' : 'Lihat detail pengeluaran'}
                                  aria-expanded={isExpanded}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleExpenseExpand(t.id);
                                  }}
                                  className="mt-0.5 w-5 h-5 inline-flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 cursor-pointer transition-colors"
                                >
                                  <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                                  </svg>
                                </button>
                                <div>
                                  <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                                  <div className="text-[10px] text-slate-400">
                                    {new Date(t.transaction_time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-3 font-mono font-semibold text-slate-800 whitespace-nowrap">
                              {t.transaction_no}
                            </td>
                            <td className="py-3 px-3 font-semibold text-slate-800 truncate max-w-[150px]">
                              <div>{party}</div>
                              {hasRecipientBank && (
                                <button
                                  type="button"
                                  onClick={(e) => handleBankPopoverToggle(t, e)}
                                  onMouseEnter={(e) => handleBankTriggerMouseEnter(t, e)}
                                  onMouseLeave={handleBankTriggerMouseLeave}
                                  onFocus={(e) => handleBankTriggerFocus(t, e)}
                                  onBlur={() => clearBankHoverTimer()}
                                  className="mt-1 inline-flex items-center gap-1 text-[10px] text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded px-1 py-0.5 transition-colors cursor-pointer"
                                  title="Lihat info bank penerima"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                  <span>Bank</span>
                                </button>
                              )}
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
                              {formatIdr(displayTransactionNet(t))}
                            </td>
                            {/* Pembayaran — read-only badge */}
                            <td className="py-3 px-2 text-center whitespace-nowrap">
                              <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                                t.payment_status === 'PAID'
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : 'bg-amber-50 text-amber-700 border-amber-200'
                              }`}>
                                {t.payment_status === 'PAID' ? 'Sudah Bayar' : 'Belum Bayar'}
                              </span>
                            </td>
                            {/* Verifikasi — inline dropdown */}
                            <td className="py-3 px-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              {(() => {
                                const vc = getPurchaseVerificationClass(t.verification_status || 'UNVERIFIED');
                                return (
                                  <select
                                    value={t.verification_status || 'UNVERIFIED'}
                                    onChange={async (e) => {
                                      e.stopPropagation();
                                      await handleExpenseLifecycleMutation(t, 'SET_VERIFICATION', e.target.value);
                                    }}
                                    disabled={lifecycleSaving[`exp:${String(t.id)}:SET_VERIFICATION`] || !isTransactionEditable(t)}
                                    className={`text-[11px] font-semibold px-2 py-0.5 rounded-lg border cursor-pointer focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-60 ${vc.bg} ${vc.border} ${vc.text} hover:bg-opacity-80`}
                                  >
                                    <option value="UNVERIFIED">Belum Terverifikasi</option>
                                    <option value="VERIFIED">Terverifikasi</option>
                                    <option value="REJECTED">Ditolak</option>
                                  </select>
                                );
                              })()}
                            </td>
                            {/* Status — inline dropdown */}
                            <td className="py-3 px-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              {(() => {
                                const ws = t.operational_sheet || 'PROSES';
                                const wc = getPurchaseWorkflowClass(ws);
                                if (ws === 'BATAL') {
                                  return (
                                    <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md ${wc.bg} ${wc.border} ${wc.text} cursor-default`}>
                                      Batal
                                    </span>
                                  );
                                }
                                if (ws === 'HAPUS') {
                                  return (
                                    <span className={`inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md ${wc.bg} ${wc.border} ${wc.text} cursor-default`}>
                                      Dihapus
                                    </span>
                                  );
                                }
                                return (
                                  <select
                                    value={ws}
                                    onChange={async (e) => {
                                      e.stopPropagation();
                                      await handleExpenseLifecycleMutation(t, 'SET_WORKFLOW', e.target.value);
                                    }}
                                    disabled={lifecycleSaving[`exp:${String(t.id)}:SET_WORKFLOW`]}
                                    className={`text-[11px] font-semibold px-2 py-0.5 rounded-lg border cursor-pointer focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-60 ${wc.bg} ${wc.border} ${wc.text} hover:bg-opacity-80`}
                                  >
                                    <option value="PROSES">Proses</option>
                                    <option value="SELESAI">Selesai</option>
                                  </select>
                                );
                              })()}
                            </td>
                            <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  onClick={() => openDetailDrawer(t.id)}
                                  className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                                >
                                  Detail
                                </button>
                                {isTransactionEditable(t) && (
                                  <button
                                    onClick={() => openExpenseEditor(t)}
                                    className="px-2 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors cursor-pointer border border-emerald-200"
                                  >
                                    Edit/Revisi
                                  </button>
                                )}
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
                          {isExpanded && (
                            <tr className="bg-slate-50/60">
                              <td colSpan={10} className="px-4 py-3">
                                <div className="rounded-lg border border-slate-200 bg-white/90 overflow-hidden">
                                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-100 bg-slate-50/50">
                                    Rincian Operasional Pengeluaran
                                  </div>
                                  {isLoading ? (
                                    <div className="px-4 py-6 text-center text-sm text-slate-500">
                                      Memuat detail...
                                    </div>
                                  ) : error ? (
                                    <div className="px-4 py-4">
                                      <div className="text-sm text-rose-600 mb-2">Gagal memuat detail pengeluaran.</div>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          retryExpenseExpand(t.id);
                                        }}
                                        className="text-xs text-emerald-600 hover:text-emerald-700 underline cursor-pointer"
                                      >
                                        Coba lagi
                                      </button>
                                    </div>
                                  ) : detail ? (
                                    <>
                                      {/* Line items table */}
                                      {detail.lines && detail.lines.length > 0 ? (
                                        <div className="overflow-x-auto border-b border-slate-100">
                                          <table className="w-full text-[11px]">
                                            <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-[10px]">
                                              <tr>
                                                <th className="py-2 px-3 text-left">Item / Deskripsi</th>
                                                <th className="py-2 px-3 text-right">Qty</th>
                                                <th className="py-2 px-3 text-left">Satuan</th>
                                                <th className="py-2 px-3 text-right">Harga Satuan</th>
                                                <th className="py-2 px-3 text-right">Diskon</th>
                                                <th className="py-2 px-3 text-right">Subtotal</th>
                                              </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-100">
                                              {detail.lines.map((line, idx) => (
                                                <tr key={line.id || idx}>
                                                  <td className="py-2 px-3 text-slate-700">{line.description_snapshot}</td>
                                                  <td className="py-2 px-3 text-right font-mono">{Number(line.quantity)}</td>
                                                  <td className="py-2 px-3 text-slate-500">{line.unit}</td>
                                                  <td className="py-2 px-3 text-right font-mono">{formatIdr(Number(line.unit_price))}</td>
                                                  <td className="py-2 px-3 text-right font-mono text-slate-500">{formatIdr(Number(line.discount_amount))}</td>
                                                  <td className="py-2 px-3 text-right font-mono font-semibold text-slate-800">{formatIdr(Number(line.line_total))}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      ) : null}
                                      {/* Summary block */}
                                      <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/30 space-y-1 text-xs">
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">Keterangan:</span>
                                          <span className="font-mono text-slate-700 max-w-[200px] text-right truncate" title={detail.description}>{detail.description || '-'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">Penerima / Vendor:</span>
                                          <span className="font-mono text-slate-700">{detail.party_name || '-'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">Kategori:</span>
                                          <span className="font-mono text-slate-700">{detail.category_name || detail.category_code || '-'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">Departemen:</span>
                                          <span className="font-mono text-slate-700">{detail.department_name_snapshot || detail.department_code || '-'}</span>
                                        </div>
                                        {detail.source_reference && (
                                          <div className="flex justify-between">
                                            <span className="text-slate-500">Referensi:</span>
                                            <span className="font-mono text-slate-700">{detail.source_reference}</span>
                                          </div>
                                        )}
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">Metode Pembayaran:</span>
                                          <span className="font-mono text-slate-700">{detail.payment_method || '-'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">Status Pembayaran:</span>
                                          <span className={`font-mono font-semibold ${detail.payment_status === 'PAID' ? 'text-emerald-700' : 'text-amber-700'}`}>
                                            {detail.payment_status || '-'}
                                          </span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">Status Verifikasi:</span>
                                          <span className="font-mono text-slate-700">{detail.verification_status || '-'}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-slate-500">Workflow Pengeluaran:</span>
                                          <span className="font-mono text-slate-700">{detail.expense_workflow_status || '-'}</span>
                                        </div>
                                        {/* Recipient bank snapshot */}
                                        {detail.recipient_bank_name || detail.recipient_bank_account || detail.recipient_bank_holder ? (
                                          <>
                                            <div className="border-t border-slate-200 pt-1 mt-1"></div>
                                            <div className="flex justify-between">
                                              <span className="text-slate-500">Bank Penerima:</span>
                                              <span className="font-mono text-slate-700">{detail.recipient_bank_name || '-'}</span>
                                            </div>
                                            {detail.recipient_bank_account && (
                                              <div className="flex justify-between">
                                                <span className="text-slate-500">No. Rekening:</span>
                                                <span className="font-mono font-bold text-slate-800">{detail.recipient_bank_account}</span>
                                              </div>
                                            )}
                                            {detail.recipient_bank_holder && (
                                              <div className="flex justify-between">
                                                <span className="text-slate-500">Atas Nama:</span>
                                                <span className="font-mono text-slate-700">{detail.recipient_bank_holder}</span>
                                              </div>
                                            )}
                                          </>
                                        ) : (
                                          <div className="flex justify-between text-slate-400 italic">
                                            <span>Data rekening penerima:</span>
                                            <span>Belum diisi</span>
                                          </div>
                                        )}
                                        {/* Attachment count */}
                                        {detail.attachments && detail.attachments.length > 0 && (
                                          <div className="flex justify-between">
                                            <span className="text-slate-500">Lampiran:</span>
                                            <span className="font-mono text-slate-700">{detail.attachments.length} berkas</span>
                                          </div>
                                        )}
                                        {/* Financial summary */}
                                        <div className="flex justify-between border-t border-slate-200 pt-1 mt-1">
                                          <span className="text-slate-500">Nominal:</span>
                                          <span className="font-mono font-semibold text-rose-700">{formatIdr(detail.amount)}</span>
                                        </div>
                                        {/* Verified by metadata */}
                                        {detail.verified_by_name_snapshot && (
                                          <div className="flex justify-between text-[11px] text-slate-400">
                                            <span>Terverifikasi oleh:</span>
                                            <span>{detail.verified_by_name_snapshot}{detail.verified_at ? ` • ${new Date(detail.verified_at).toLocaleDateString('id-ID')}` : ''}</span>
                                          </div>
                                        )}
                                      </div>
                                    </>
                                  ) : (
                                    <div className="px-4 py-6 text-center text-sm text-slate-500">
                                      Memuat detail...
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
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
                          {formatIdr(displayTransactionNet(t))}
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
                  if (t.booking_bid_group) {
                    const group = t.booking_bid_group;
                    return (
                      <tr
                        key={`all-bid:${group.bid}`}
                        onClick={() => openWorkspaceRowDetail(t)}
                        className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                      >
                        <td className="py-3 px-3 whitespace-nowrap">
                          <div className="font-semibold text-slate-800">{t.transaction_date}</div>
                          <div className="text-[10px] text-slate-400" title={periodListHint}>Aktivitas Periode</div>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span className="font-mono font-bold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                            {group.bid}
                          </span>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span className="inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200">
                            Penjualan
                          </span>
                        </td>
                        <td className="py-3 px-3 font-medium text-slate-800 truncate max-w-[140px]">
                          <div className="truncate">{group.guest_name}</div>
                          <span className="text-[10px] font-bold text-emerald-800">
                            {group.room_count} kamar aktivitas
                          </span>
                        </td>
                        <td className="py-3 px-3 text-slate-700 truncate max-w-[120px]">
                          <span className="text-[11px] font-medium text-slate-700">{t.category_name || 'Penjualan'}</span>
                        </td>
                        <td className="py-3 px-4 max-w-xs truncate text-slate-800">
                          <div title={periodListHint}>Aktivitas periode</div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold whitespace-nowrap text-emerald-700" title={periodListHint}>
                          {formatIdr(group.net)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          {renderVerificationBadge(t.verification_status)}
                        </td>
                        <td className="py-3 px-2 text-center whitespace-nowrap">
                          {renderOperationalBadge({
                            transaction_status: t.transaction_status,
                            transaction_type: 'SALE',
                            is_lifecycle_primary: true,
                            operational_sheet: group.operational_sheet
                          })}
                        </td>
                        <td className="py-3 px-3 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => openWorkspaceRowDetail(t)}
                            className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                          >
                            Detail
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr
                      key={t.id}
                      onClick={() => openWorkspaceRowDetail(t)}
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
                          {formatIdr(displayTransactionNet(t))}
                        </span>
                        {Number(t.lifecycle_member_count || 0) > 1 && (
                          <div className="text-[10px] font-semibold text-slate-400">{t.lifecycle_member_count} riwayat</div>
                        )}
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
                            onClick={() => openWorkspaceRowDetail(t)}
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

              {lifecycleError && activeTab === 'PURCHASE' && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 font-semibold">
                  {lifecycleError}
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

      <BookingSalesDetailDrawer
        isOpen={bookingDetailOpen}
        bookingId={selectedBookingIdForDetail}
        propertyId={propertyId}
        onClose={() => {
          setBookingDetailOpen(false);
          setSelectedBookingIdForDetail(null);
        }}
      />

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
        onEditExpense={(tx) => {
          setDetailDrawerOpen(false);
          openExpenseEditor(tx);
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
      {/* PURCHASE-2C: Supplier Bank Quick Info Popover */}
      {bankPopoverOpen && bankPopoverTx && (
        <>
          {/* Backdrop - only for pinned/click mode, not hover mode */}
          {bankPopoverPinned && (
            <div
              className="fixed inset-0 z-40"
              onClick={() => closeBankPopover()}
              aria-hidden="true"
            />
          )}
          {/* Popover */}
          <div
            ref={bankPopoverRef}
            style={{ position: 'fixed', top: `${bankPopoverPos.top}px`, left: `${bankPopoverPos.left}px`, zIndex: 60 }}
            role="dialog"
            aria-label={bankPopoverTx?.transaction_type === 'EXPENSE' ? 'Info Bank Penerima' : 'Info Bank Supplier'}
            className="bg-white rounded-xl shadow-2xl border border-stone-200 w-[320px] p-4 animate-in fade-in zoom-in-95 duration-150"
            onMouseEnter={handleBankPopoverMouseEnter}
            onMouseLeave={handleBankPopoverMouseLeave}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold text-stone-800 uppercase tracking-wide">
                {bankPopoverTx?.transaction_type === 'EXPENSE' ? 'Info Bank Penerima' : 'Info Bank Supplier'}
              </h3>
              <button
                type="button"
                onClick={() => closeBankPopover()}
                className="text-stone-400 hover:text-stone-600 transition-colors cursor-pointer"
                aria-label="Tutup"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-2">
              {/* PURCHASE: supplier bank fields */}
              {bankPopoverTx?.transaction_type === 'PURCHASE' && (
                <>
                  {bankPopoverTx.supplier_bank_name && (
                    <div>
                      <span className="text-[11px] text-stone-500 block font-medium">Nama Bank</span>
                      <span className="text-sm font-semibold text-stone-800">{bankPopoverTx.supplier_bank_name}</span>
                    </div>
                  )}
                  {bankPopoverTx.supplier_bank_account && (
                    <div>
                      <span className="text-[11px] text-stone-500 block font-medium">No. Rekening</span>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <span className="text-sm font-mono font-bold text-stone-900">{bankPopoverTx.supplier_bank_account}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleCopyBankAccount(bankPopoverTx.id, bankPopoverTx.supplier_bank_account!); }}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                            bankCopied === String(bankPopoverTx.id)
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                          }`}
                        >
                          Salin
                        </button>
                      </div>
                    </div>
                  )}
                  {bankPopoverTx.supplier_bank_holder && (
                    <div>
                      <span className="text-[11px] text-stone-500 block font-medium">Atas Nama</span>
                      <span className="text-sm text-stone-700">{bankPopoverTx.supplier_bank_holder}</span>
                    </div>
                  )}
                </>
              )}
              {/* EXPENSE: recipient bank snapshot fields */}
              {bankPopoverTx?.transaction_type === 'EXPENSE' && (
                <>
                  {bankPopoverTx.recipient_bank_name && (
                    <div>
                      <span className="text-[11px] text-stone-500 block font-medium">Nama Bank</span>
                      <span className="text-sm font-semibold text-stone-800">{bankPopoverTx.recipient_bank_name}</span>
                    </div>
                  )}
                  {bankPopoverTx.recipient_bank_account && (
                    <div>
                      <span className="text-[11px] text-stone-500 block font-medium">No. Rekening</span>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <span className="text-sm font-mono font-bold text-stone-900">{bankPopoverTx.recipient_bank_account}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleCopyBankAccount(bankPopoverTx.id, bankPopoverTx.recipient_bank_account!); }}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                            bankCopied === String(bankPopoverTx.id)
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                          }`}
                        >
                          Salin
                        </button>
                      </div>
                    </div>
                  )}
                  {bankPopoverTx.recipient_bank_holder && (
                    <div>
                      <span className="text-[11px] text-stone-500 block font-medium">Atas Nama</span>
                      <span className="text-sm text-stone-700">{bankPopoverTx.recipient_bank_holder}</span>
                    </div>
                  )}
                </>
              )}
              {bankPopoverTx?.transaction_type === 'EXPENSE' ? (
                !(bankPopoverTx.recipient_bank_name || bankPopoverTx.recipient_bank_account || bankPopoverTx.recipient_bank_holder) && (
                  <p className="text-xs text-stone-400 italic">Tidak ada data rekening</p>
                )
              ) : (
                !(bankPopoverTx.supplier_bank_name || bankPopoverTx.supplier_bank_account || bankPopoverTx.supplier_bank_holder) && (
                  <p className="text-xs text-stone-400 italic">Tidak ada data rekening</p>
                )
              )}
            </div>
            <p className="text-[10px] text-stone-400 mt-3 pt-2 border-t border-stone-100">
              Klik di luar untuk menutup
            </p>
          </div>
        </>
      )}
      {/* PURCHASE-2C: Copy success toast */}
      {bankToastMessage && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg shadow-lg animate-in fade-in zoom-in-95 duration-150"
          role="status"
          aria-live="polite"
        >
          {bankToastMessage}
        </div>
      )}
    </div>
  );
};
