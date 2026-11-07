import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import html2pdf from 'html2pdf.js';
import html2canvas from 'html2canvas';
import ReservationConfirmationPrint from './ReservationConfirmationPrint';
import QuotationPrint from './QuotationPrint';
import QuotationEditor from './QuotationEditor';
import GuestFolioPrint, {
  type GuestFolioDocumentDto,
  type GuestFolioScope,
  type GuestFolioViewMode,
  updateFolioPrintTimestampInDom,
} from './GuestFolioPrint';
import type { QuotationDraft, QuotationMode, PropertyPaymentInstructionsDto } from './quotationDraft';
import {
  createBlankQuotationDraft,
  buildQuotationDraftFromReservation,
  buildQuotationDraftFromSavedRecord,
  calculateQuotationDraftTotals,
} from './quotationDraft';
import { formatHotelDateIndonesian, formatHotelCurrency } from './GuestDocumentContent';
import type { PropertyInfoDto, PropertyBrandingDto } from './GuestDocumentContent';
import { Modal } from '../../design-system/Modal';
import QuotationListModal from './QuotationListModal';
import './guestDocumentPrint.css';

function sanitizeFilenameSegment(segment: string): string {
  return segment
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function generateDocumentPdfFilename({
  kind,
  quotationMode,
  bid,
  reference,
  folioNumber,
  quotationNumber,
  revisionLabel,
  propertyInfo,
  propertyBranding,
}: {
  kind: 'confirmation' | 'quotation' | 'folio';
  quotationMode?: 'reservation' | 'manual';
  bid?: string | null;
  reference?: string | null;
  folioNumber?: string | null;
  quotationNumber?: string | null;
  revisionLabel?: string | null;
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
}): string {
  const rawHotelName = propertyBranding?.displayName || propertyInfo?.name || 'OAK-Hotel';
  const hotelPrefix = sanitizeFilenameSegment(rawHotelName) || 'OAK-Hotel';
  const today = new Date().toISOString().slice(0, 10);

  if (kind === 'folio') {
    const cleanFolio = (folioNumber || bid || reference || '').trim();
    const refSuffix = cleanFolio ? sanitizeFilenameSegment(cleanFolio) : today;
    return `${hotelPrefix}-Guest-Folio-${refSuffix}.pdf`;
  }

  if (kind === 'confirmation') {
    const cleanBid = (bid || '').trim();
    const refSuffix = cleanBid
      ? (cleanBid.toUpperCase().startsWith('BID-') ? cleanBid : `BID-${cleanBid}`)
      : today;
    return `${hotelPrefix}-Guest-Bill-${sanitizeFilenameSegment(refSuffix)}.pdf`;
  }

  if (kind === 'quotation' && quotationNumber && quotationNumber.trim()) {
    const qNum = sanitizeFilenameSegment(quotationNumber);
    const rev = sanitizeFilenameSegment(revisionLabel || 'R1');
    return `${hotelPrefix}-Quotation-${qNum}-${rev}.pdf`;
  }

  if (quotationMode === 'reservation') {
    const rawRef = (reference || bid || '').trim();
    const refSuffix = rawRef
      ? (rawRef.toUpperCase().startsWith('BID-') ? rawRef : `BID-${rawRef}`)
      : today;
    return `${hotelPrefix}-Quotation-${sanitizeFilenameSegment(refSuffix)}.pdf`;
  }

  const cleanRef = (reference || '').trim();
  const refSuffix = cleanRef ? sanitizeFilenameSegment(cleanRef) : today;
  return `${hotelPrefix}-Quotation-${refSuffix}.pdf`;
}

/* ---------------------------------------------------------------- */
/*  PDF snapshot helpers                                            */
/* ---------------------------------------------------------------- */

const SNAPSHOT_TTL_MS = 30_000; // reuse snapshots for 30s before re-capturing

async function captureSnapshot(
  el: HTMLElement,
  scale = 2,
): Promise<{ dataUrl: string; widthPx: number; heightPx: number }> {
  const canvas = await html2canvas(el, {
    scale,
    useCORS: true,
    allowTaint: true,
    logging: false,
    scrollX: 0,
    scrollY: 0,
    backgroundColor: '#ffffff',
  });
  return {
    dataUrl: canvas.toDataURL('image/png'),
    widthPx: canvas.width,
    heightPx: canvas.height,
  };
}

function computePdfDimensions(pixels: { widthPx: number; heightPx: number }, pdfWidthMm: number) {
  return pdfWidthMm * (pixels.heightPx / pixels.widthPx);
}

/* ---------------------------------------------------------------- */
/*  DocumentCenter - OAK HIMS DOCUMENT-1B & Guest Folio             */
/*                                                                  */
/*  Left  : doc kind + property-scoped reservation picker + summary */
/*          + QuotationEditor / Guest Folio Presentation Controls   */
/*  Right : live A4 preview                                         */
/*                                                                  */
/*  Canonical data fetched via dedicated Document Domain API:       */
/*    GET /api/documents/reservations                (list picker)  */
/*    GET /api/documents/reservations/:id            (detail print) */
/*    GET /api/documents/reservations/:id/folio      (guest folio)  */
/*  No DB writes. No SSE.                                           */
/* ---------------------------------------------------------------- */

export type DocKind = 'confirmation' | 'quotation' | 'folio';

/* Compatible signature for an authenticated fetch function. */
export type AuthFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface DocumentCenterProps {
  /** The property row currently active in App. */
  propertyInfo?: PropertyInfoDto;
  /** Active branding config; passed through to the renderers. */
  propertyBranding?: PropertyBrandingDto;
  /** Numeric property id, required for property-scoped filtering + detail fetch. */
  propertyId: number;
  /** Authenticated fetch from App; used to load canonical reservation detail. */
  authFetch: AuthFetchFn;
  /** Optionally pre-select a reservation (by numeric id).
      Only honored if the id exists in the property-scoped picker list. */
  initialReservationId?: number | null;
  /** Optionally pre-select document kind. */
  initialKind?: DocKind;
}

/* ---- helpers -------------------------------------------------------- */

function reservationMatches(res: any, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase().trim();
  if (!needle) return true;
  const bid = String(res?.bid || '').toLowerCase();
  const guest = String(res?.guest_name || res?.booker_name || '').toLowerCase();
  const roomNo = String(res?.room_number || '').toLowerCase();
  const idStr = String(res?.id || '').toLowerCase();
  return (
    bid.includes(needle) ||
    guest.includes(needle) ||
    roomNo.includes(needle) ||
    idStr.includes(needle)
  );
}

/* ---- component -------------------------------------------------------- */

export default function DocumentCenter({
  propertyInfo,
  propertyBranding,
  propertyId,
  authFetch,
  initialReservationId,
  initialKind,
}: DocumentCenterProps) {

  /* Property-scoped picker list loaded from Document Domain API. */
  const [pickerReservations, setPickerReservations] = useState<any[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [kind, setKind] = useState<DocKind>(() => {
    if (initialKind != null) return initialKind;
    try {
      const savedKind = sessionStorage.getItem('oak_active_doc_kind');
      if (savedKind === 'quotation' || savedKind === 'confirmation' || savedKind === 'folio') {
        return savedKind as DocKind;
      }
    } catch {}
    return 'confirmation';
  });
  const [guestBillShowGuestSignature, setGuestBillShowGuestSignature] = useState(true);
  const [selectedResId, setSelectedResId] = useState<number | null>(null);
  const [explicitIncludeId, setExplicitIncludeId] = useState<number | null>(
    initialReservationId ?? null
  );
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (initialReservationId != null) {
      setExplicitIncludeId(Number(initialReservationId));
    }
  }, [initialReservationId]);

  /* Debounce ref for search queries to avoid a request on every keystroke. */
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Stale-response guard: increments on every new request so late responses
     from a previous request never overwrite the latest one. */
  const pickerRequestVersion = useRef(0);

  /* Single authoritative effect for all picker requests.
     - Empty search → immediate default fetch (recent CHECKED_OUT + optional include_id, LIMIT 20)
     - Non-empty search → debounced 300ms global property-scoped search
     - propertyId change cancels any in-flight request and resets state */
  useEffect(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }

    setPickerLoading(true);
    setPickerError(null);
    setPickerReservations([]);

    const controller = new AbortController();
    const version = ++pickerRequestVersion.current;

    const doFetch = async (url: string) => {
      try {
        const res = await authFetch(url, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (version !== pickerRequestVersion.current) return;
        if (!res.ok) {
          if (res.status === 403) {
            setPickerError('Akses ke Dokumen & Print ditolak.');
          } else {
            setPickerError('Gagal memuat daftar reservasi dokumen.');
          }
          setPickerLoading(false);
          return;
        }
        const json = await res.json();
        if (controller.signal.aborted) return;
        if (version !== pickerRequestVersion.current) return;
        const rows = Array.isArray(json?.data) ? json.data : [];
        setPickerReservations(rows);
        setPickerLoading(false);
      } catch {
        if (controller.signal.aborted) return;
        if (version !== pickerRequestVersion.current) return;
        setPickerError('Gagal memuat daftar reservasi dokumen.');
        setPickerLoading(false);
      }
    };

    if (!searchQuery.trim()) {
      const includeQuery =
        explicitIncludeId && Number.isInteger(explicitIncludeId) && explicitIncludeId > 0
          ? `&include_id=${explicitIncludeId}`
          : '';
      doFetch(`/api/documents/reservations?property_id=${propertyId}${includeQuery}`);
    } else {
      searchDebounceRef.current = setTimeout(() => {
        const encoded = encodeURIComponent(searchQuery.trim());
        doFetch(`/api/documents/reservations?property_id=${propertyId}&search=${encoded}`);
      }, 300);
    }

    return () => {
      controller.abort();
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
    };
  }, [propertyId, authFetch, searchQuery, explicitIncludeId]);

  /* Canonical detail state (loaded via API for Confirmation / Quotation). */
  const [selectedDetail, setSelectedDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRetryCount, setDetailRetryCount] = useState(0);

  /* Stale-response protection: version ref incremented on every new request. */
  const detailRequestVersion = useRef(0);

  /* Canonical Guest Folio state (loaded via GET /api/documents/reservations/:id/folio). */
  const [folioDoc, setFolioDoc] = useState<GuestFolioDocumentDto | null>(null);
  const [folioLoading, setFolioLoading] = useState(false);
  const [folioError, setFolioError] = useState<string | null>(null);
  const [folioScope, setFolioScope] = useState<GuestFolioScope>('GUEST_FOLIO');
  const [folioViewMode, setFolioViewMode] = useState<GuestFolioViewMode>('EFFECTIVE');
  const [folioFooterNote, setFolioFooterNote] = useState('');
  const [folioCashierLabel, setFolioCashierLabel] = useState('');
  const [folioRetryCount, setFolioRetryCount] = useState(0);
  const folioRequestVersion = useRef(0);

  /* Quotation draft state (DOCUMENT-1B.1 Step C & D) */
  const [quotationMode, setQuotationMode] = useState<QuotationMode>('reservation');
  const [quotationDraft, setQuotationDraft] = useState<QuotationDraft>(() =>
    createBlankQuotationDraft('reservation'),
  );

  /* Persisted Quotation state */
  const [isQuotationListModalOpen, setIsQuotationListModalOpen] = useState(false);
  const [savedQuotationRecord, setSavedQuotationRecord] = useState<{
    id: number;
    quotation_number: string;
    revision_number: number;
    revision_label: string;
    version: number;
  } | null>(null);
  const [initialQuotationBaselineJson, setInitialQuotationBaselineJson] = useState<string>(() =>
    JSON.stringify(createBlankQuotationDraft('reservation')),
  );
  const [isSavingQuotation, setIsSavingQuotation] = useState(false);
  const [quotationActionMessage, setQuotationActionMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [showUnsavedExitModal, setShowUnsavedExitModal] = useState(false);
  const [pendingExitAction, setPendingExitAction] = useState<(() => void) | null>(null);

  const isQuotationDirty = useMemo(() => {
    return JSON.stringify(quotationDraft) !== initialQuotationBaselineJson;
  }, [quotationDraft, initialQuotationBaselineJson]);

  /* PDF export state & capture ref (DOCUMENT-1B.2F) */
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [savePdfError, setSavePdfError] = useState<string | null>(null);
  const [showPdfFilenameModal, setShowPdfFilenameModal] = useState(false);
  const [pdfFilename, setPdfFilename] = useState('');
  const [actionTimestamp, setActionTimestamp] = useState<Date | null>(null);
  const printDocumentRef = useRef<HTMLDivElement>(null);
  const pdfSnapshotCacheRef = useRef<{
    header?: string;
    footer?: string;
    headerHeight?: number;
    footerHeight?: number;
    capturedAt?: number;
  }>({});

  /* Refs for snapshotting canonical letterhead elements */
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  /* Property payment instructions state (DOCUMENT-1B.2A) */
  const [propertyPaymentInstructions, setPropertyPaymentInstructions] =
    useState<PropertyPaymentInstructionsDto | null>(null);

  /* Ref tracking which reservation ID was last preloaded into quotationDraft */
  const lastPreloadedResIdRef = useRef<number | null>(null);

  /* Fetch property payment instructions whenever active property changes */
  useEffect(() => {
    let cancelled = false;
    setPropertyPaymentInstructions(null);

    (async () => {
      try {
        const res = await authFetch(
          `/api/settings/property/payment-instructions?property_id=${propertyId}`,
        );
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json?.data) {
          const config: PropertyPaymentInstructionsDto = json.data;
          setPropertyPaymentInstructions(config);

          if (config.is_active !== false && (config.bank_name || config.bank_account_number)) {
            setQuotationDraft((prev) => {
              if (!prev.bankName && !prev.bankAccountNumber) {
                return {
                  ...prev,
                  bankName: config.bank_name || '',
                  bankAccountName: config.bank_account_name || '',
                  bankAccountNumber: config.bank_account_number || '',
                };
              }
              return prev;
            });
          }
        }
      } catch {
        // Silently ignore network failures; prefill remains optional
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [propertyId, authFetch]);

  /* Resolve initialReservationId only if it exists in the scoped list. */
  useEffect(() => {
    if (initialReservationId == null) return;
    const exists = pickerReservations.some(
      (r) => Number(r?.id) === Number(initialReservationId),
    );
    if (exists) setSelectedResId(Number(initialReservationId));
  }, [initialReservationId, pickerReservations]);

  useEffect(() => {
    if (initialKind != null) setKind(initialKind);
  }, [initialKind]);

  /* Property-switch / list-refresh safety:
      If the currently selected reservation no longer exists in the active
      property's scoped list (and picker has finished loading), clear the selection. */
  useEffect(() => {
    if (selectedResId == null || pickerLoading) return;
    const stillExists = pickerReservations.some(
      (r) => Number(r?.id) === selectedResId,
    );
    if (!stillExists) {
      setSelectedResId(null);
      setSelectedDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      setFolioDoc(null);
      setFolioError(null);
      setFolioLoading(false);
      lastPreloadedResIdRef.current = null;
      setQuotationDraft(
        createBlankQuotationDraft(
          quotationMode === 'manual' ? 'manual' : 'reservation',
          propertyPaymentInstructions,
        ),
      );
    }
  }, [pickerReservations, pickerLoading, selectedResId, quotationMode, propertyPaymentInstructions]);

  /* Explicit propertyId change safety: clear selection & draft immediately */
  const prevPropertyIdRef = useRef(propertyId);
  useEffect(() => {
    if (prevPropertyIdRef.current !== propertyId) {
      prevPropertyIdRef.current = propertyId;
      setSelectedResId(null);
      setExplicitIncludeId(null);
      setSelectedDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      setFolioDoc(null);
      setFolioError(null);
      setFolioLoading(false);
      lastPreloadedResIdRef.current = null;
      pdfSnapshotCacheRef.current = {};
      setQuotationDraft(
        createBlankQuotationDraft(
          quotationMode === 'manual' ? 'manual' : 'reservation',
          null,
        ),
      );
    }
  }, [propertyId, quotationMode]);

  /* Fetch canonical detail when the selected reservation or active property changes. */
  useEffect(() => {
    if (selectedResId == null) {
      setSelectedDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    const version = ++detailRequestVersion.current;
    // Clear previous detail immediately to prevent stale render
    setSelectedDetail(null);
    setDetailLoading(true);
    setDetailError(null);

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const url = `/api/documents/reservations/${selectedResId}?property_id=${propertyId}`;
        const res = await authFetch(url, { signal: controller.signal });
        if (cancelled || version !== detailRequestVersion.current) return;
        if (!res.ok) {
          if (res.status === 403) {
            throw new Error('Akses ke Dokumen & Print ditolak.');
          }
          if (res.status === 404) {
            throw new Error('Reservasi tidak ditemukan.');
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        if (cancelled || version !== detailRequestVersion.current) return;
        if (json?.status === 'ERROR') {
          throw new Error(json?.message || 'Data tidak tersedia');
        }
        const responseData = json?.data;
        if (!responseData || typeof responseData !== 'object') {
          throw new Error('Invalid response shape');
        }

        const baseRes = responseData.reservation && (responseData.reservation.guest_name || responseData.reservation.check_in)
          ? { ...responseData, ...responseData.reservation }
          : responseData;
        const reservation = responseData.financials
          ? { ...responseData.financials, ...baseRes }
          : baseRes;
        setSelectedDetail(reservation);
        setDetailLoading(false);
      } catch (err: any) {
        if (cancelled || version !== detailRequestVersion.current) return;
        if (err?.name === 'AbortError') return;
        setDetailError(err?.message || 'Gagal memuat detail reservasi');
        setDetailLoading(false);
        setSelectedDetail(null);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedResId, propertyId, authFetch, detailRetryCount]);

  /* Fetch canonical Guest Folio projection when selectedResId, propertyId, or folioScope changes. */
  useEffect(() => {
    if (selectedResId == null) {
      setFolioDoc(null);
      setFolioError(null);
      setFolioLoading(false);
      return;
    }

    const version = ++folioRequestVersion.current;
    // Immediately clear old folioDoc to guarantee zero stale preview
    setFolioDoc(null);
    setFolioLoading(true);
    setFolioError(null);

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const url = `/api/documents/reservations/${selectedResId}/folio?property_id=${propertyId}&scope=${folioScope}`;
        const res = await authFetch(url, { signal: controller.signal });
        if (cancelled || version !== folioRequestVersion.current) return;
        if (!res.ok) {
          let errMsg = `HTTP ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson?.message) errMsg = errJson.message;
          } catch {
            // ignore json parse error
          }
          if (res.status === 403) {
            throw new Error(errMsg || 'Akses ke Guest Folio ditolak.');
          }
          if (res.status === 404) {
            throw new Error(errMsg || 'Reservasi tidak ditemukan pada properti ini.');
          }
          throw new Error(errMsg);
        }
        const json = await res.json();
        if (cancelled || version !== folioRequestVersion.current) return;
        if (json?.status === 'ERROR' || !json?.data) {
          throw new Error(json?.message || 'Data Guest Folio tidak tersedia.');
        }

        setFolioDoc(json.data as GuestFolioDocumentDto);
        setFolioLoading(false);
      } catch (err: any) {
        if (cancelled || version !== folioRequestVersion.current) return;
        if (err?.name === 'AbortError') return;
        setFolioError(err?.message || 'Gagal memuat rincian Guest Folio.');
        setFolioLoading(false);
        setFolioDoc(null);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedResId, propertyId, folioScope, authFetch, folioRetryCount]);

  /* Preload canonical reservation detail into quotation draft (reservation mode only) */
  useEffect(() => {
    if (selectedDetail && quotationMode === 'reservation' && !savedQuotationRecord) {
      const currentDetailId = Number(selectedDetail.id ?? selectedResId);
      if (currentDetailId && currentDetailId !== lastPreloadedResIdRef.current) {
        lastPreloadedResIdRef.current = currentDetailId;
        const draft = buildQuotationDraftFromReservation(selectedDetail, propertyPaymentInstructions);
        setQuotationDraft(draft);
        setInitialQuotationBaselineJson(JSON.stringify(draft));
      }
    }
  }, [selectedDetail, selectedResId, quotationMode, propertyPaymentInstructions, savedQuotationRecord]);

  /* If selected reservation is cleared while in reservation mode, reset draft */
  useEffect(() => {
    if (selectedResId == null && quotationMode === 'reservation' && !savedQuotationRecord) {
      lastPreloadedResIdRef.current = null;
      const blank = createBlankQuotationDraft('reservation', propertyPaymentInstructions);
      setQuotationDraft(blank);
      setInitialQuotationBaselineJson(JSON.stringify(blank));
    }
  }, [selectedResId, quotationMode, propertyPaymentInstructions, savedQuotationRecord]);

  /* Switch quotation source mode (reservation vs manual) */
  const handleSwitchMode = useCallback(
    (newMode: QuotationMode) => {
      if (newMode === quotationMode) return;
      setQuotationMode(newMode);
      if (newMode === 'manual') {
        lastPreloadedResIdRef.current = null;
        setQuotationDraft(
          createBlankQuotationDraft('manual', propertyPaymentInstructions),
        );
      } else {
        if (selectedDetail) {
          lastPreloadedResIdRef.current = Number(selectedDetail.id ?? selectedResId);
          setQuotationDraft(
            buildQuotationDraftFromReservation(selectedDetail, propertyPaymentInstructions),
          );
        } else {
          lastPreloadedResIdRef.current = null;
          setQuotationDraft(
            createBlankQuotationDraft('reservation', propertyPaymentInstructions),
          );
        }
      }
    },
    [quotationMode, selectedDetail, selectedResId, propertyPaymentInstructions],
  );

  const doResetQuotation = useCallback(() => {
    const blank = createBlankQuotationDraft('manual', propertyPaymentInstructions);
    setQuotationDraft(blank);
    setSavedQuotationRecord(null);
    setQuotationMode('manual');
    lastPreloadedResIdRef.current = null;
    setInitialQuotationBaselineJson(JSON.stringify(blank));
    setQuotationActionMessage(null);
    try {
      sessionStorage.removeItem('oak_active_quotation_id');
    } catch {}
  }, [propertyPaymentInstructions]);

  const handleNewQuotationClick = useCallback(() => {
    if (isQuotationDirty) {
      setPendingExitAction(() => () => doResetQuotation());
      setShowUnsavedExitModal(true);
    } else {
      doResetQuotation();
    }
  }, [isQuotationDirty, doResetQuotation]);

  const handleOpenSavedListClick = useCallback(() => {
    if (isQuotationDirty) {
      setPendingExitAction(() => () => {
        setIsQuotationListModalOpen(true);
      });
      setShowUnsavedExitModal(true);
    } else {
      setIsQuotationListModalOpen(true);
    }
  }, [isQuotationDirty]);

  const handleSwitchKind = useCallback(
    (targetKind: 'confirmation' | 'quotation' | 'folio') => {
      if (targetKind === kind) return;
      if (kind === 'quotation' && isQuotationDirty) {
        setPendingExitAction(() => () => {
          try {
            sessionStorage.setItem('oak_active_doc_kind', targetKind);
          } catch {}
          setKind(targetKind);
        });
        setShowUnsavedExitModal(true);
      } else {
        try {
          sessionStorage.setItem('oak_active_doc_kind', targetKind);
        } catch {}
        setKind(targetKind);
      }
    },
    [kind, isQuotationDirty],
  );

  const handleSelectSavedQuotation = useCallback(
    async (selectedId: number) => {
      try {
        const res = await authFetch(`/api/documents/quotations/${selectedId}?property_id=${propertyId}`);
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.message || 'Gagal memuat rincian quotation');
        }
        const json = await res.json();
        const detail = json.data;
        const q = detail.quotation || detail;
        const rev = detail.latest_revision || detail.revision || {};

        const quotationId = Number(q.id ?? detail.id ?? selectedId);
        const quotationNumber = String(q.quotation_number ?? detail.quotation_number ?? '');
        const version = Number(q.version ?? detail.version ?? 1);
        const revNumber = Number(rev.revision_number ?? 1);
        const revLabel = String(rev.revision_label ?? `R${revNumber}`);

        const newDraft = buildQuotationDraftFromSavedRecord(detail);
        setQuotationDraft(newDraft);
        setSavedQuotationRecord({
          id: quotationId,
          quotation_number: quotationNumber,
          revision_number: revNumber,
          revision_label: revLabel,
          version: version,
        });
        setQuotationMode('manual');
        lastPreloadedResIdRef.current = null;
        setInitialQuotationBaselineJson(JSON.stringify(newDraft));
        setIsQuotationListModalOpen(false);
        try {
          sessionStorage.setItem('oak_active_quotation_id', String(quotationId));
          sessionStorage.setItem('oak_active_doc_kind', 'quotation');
        } catch {}
        setQuotationActionMessage({
          type: 'success',
          text: `Quotation ${quotationNumber} (${revLabel}) berhasil dibuka.`,
        });
      } catch (err: any) {
        try {
          sessionStorage.removeItem('oak_active_quotation_id');
        } catch {}
        setQuotationActionMessage({
          type: 'error',
          text: err.message || 'Gagal memuat quotation',
        });
      }
    },
    [authFetch, propertyId],
  );

  const handleSaveQuotation = useCallback(async () => {
    if (isSavingQuotation) return;
    setQuotationActionMessage(null);

    const customerName = quotationDraft.customerName?.trim();
    if (!customerName) {
      setQuotationActionMessage({
        type: 'error',
        text: 'Nama pelanggan wajib diisi untuk menyimpan quotation.',
      });
      return;
    }

    const validItems = (quotationDraft.items || []).filter(
      (it) => it.description && it.description.trim() !== '',
    );
    if (validItems.length === 0) {
      setQuotationActionMessage({
        type: 'error',
        text: 'Minimal harus ada 1 item penawaran dengan deskripsi.',
      });
      return;
    }

    setIsSavingQuotation(true);
    try {
      const totals = calculateQuotationDraftTotals(quotationDraft);
      const isRevision =
        savedQuotationRecord !== null &&
        Number.isInteger(savedQuotationRecord.id) &&
        savedQuotationRecord.id > 0;

      const payload: any = {
        property_id: propertyId,
        customer_name: customerName,
        customer_email: quotationDraft.email?.trim() || null,
        customer_phone: quotationDraft.phone?.trim() || null,
        customer_address: quotationDraft.address?.trim() || null,
        check_in_date: quotationDraft.checkIn || null,
        check_out_date: quotationDraft.checkOut || null,
        items: validItems.map((it) => ({
          description: it.description.trim(),
          quantity: Math.max(0, Number(it.qty) || 1),
          unit_price: Math.max(0, Number(it.unitPrice) || 0),
          discount: 0,
        })),
        pricing: {
          subtotal: totals.subtotal,
          service_rate:
            quotationDraft.serviceType === 'percent'
              ? Math.max(0, Number(quotationDraft.serviceValue) || 0)
              : undefined,
          service_amount: totals.serviceAmount,
          tax_rate:
            quotationDraft.taxType === 'percent'
              ? Math.max(0, Number(quotationDraft.taxValue) || 0)
              : undefined,
          tax_amount: totals.taxAmount,
          total_discount: totals.discountAmount,
          total_amount: totals.grandTotal,
        },
        notes: quotationDraft.notes?.trim() || null,
        terms_conditions: quotationDraft.terms?.trim() || null,
        bank_details: {
          bank_name: quotationDraft.bankName?.trim() || '',
          bank_account_name: quotationDraft.bankAccountName?.trim() || '',
          bank_account_number: quotationDraft.bankAccountNumber?.trim() || '',
        },
      };

      let url = '/api/documents/quotations';
      let method = 'POST';

      if (isRevision) {
        url = `/api/documents/quotations/${savedQuotationRecord.id}`;
        method = 'PUT';
        payload.expected_version = savedQuotationRecord.version;
        payload.change_summary = `Revisi R${savedQuotationRecord.revision_number + 1}`;
      }

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        if (res.status === 409) {
          throw new Error('Konflik perubahan: Quotation ini telah diubah di sesi lain. Buka ulang dari daftar tersimpan.');
        }
        throw new Error(errJson.message || 'Gagal menyimpan quotation.');
      }

      const json = await res.json();
      const resData = json.data;
      const q = resData.quotation || resData;
      const revision = resData.revision || resData.latest_revision || {};

      const savedId = Number(q.id ?? resData.id);
      const savedNumber = String(q.quotation_number ?? resData.quotation_number ?? '');
      const savedVersion = Number(q.version ?? resData.version ?? 1);
      const savedRevNumber = Number(revision.revision_number ?? 1);
      const savedRevLabel = String(revision.revision_label ?? `R${savedRevNumber}`);

      const updatedDraft: QuotationDraft = {
        ...quotationDraft,
        quotationNumber: savedNumber,
        revisionNumber: savedRevNumber,
        revisionLabel: savedRevLabel,
        version: savedVersion,
        savedQuotationId: savedId,
      };

      setQuotationDraft(updatedDraft);
      setSavedQuotationRecord({
        id: savedId,
        quotation_number: savedNumber,
        revision_number: savedRevNumber,
        revision_label: savedRevLabel,
        version: savedVersion,
      });
      try {
        sessionStorage.setItem('oak_active_quotation_id', String(savedId));
        sessionStorage.setItem('oak_active_doc_kind', 'quotation');
      } catch {}
      setInitialQuotationBaselineJson(JSON.stringify(updatedDraft));
      setQuotationActionMessage({
        type: 'success',
        text: isRevision
          ? `Revisi ${savedRevLabel} berhasil disimpan untuk ${savedNumber}.`
          : `Quotation berhasil disimpan: ${savedNumber} (R1).`,
      });
    } catch (err: any) {
      setQuotationActionMessage({
        type: 'error',
        text: err.message || 'Terjadi kesalahan saat menyimpan quotation.',
      });
    } finally {
      setIsSavingQuotation(false);
    }
  }, [
    isSavingQuotation,
    quotationDraft,
    savedQuotationRecord,
    propertyId,
    authFetch,
  ]);

  const handleQuotationDeleted = useCallback(
    (deletedId: number) => {
      if (savedQuotationRecord && savedQuotationRecord.id === deletedId) {
        doResetQuotation();
      }
    },
    [savedQuotationRecord, doResetQuotation],
  );

  // Auto-restore active quotation across browser refreshes if available
  useEffect(() => {
    if (kind !== 'quotation') return;
    if (savedQuotationRecord !== null) return;
    try {
      const storedIdStr = sessionStorage.getItem('oak_active_quotation_id');
      if (storedIdStr) {
        const storedId = Number(storedIdStr);
        if (Number.isInteger(storedId) && storedId > 0) {
          void handleSelectSavedQuotation(storedId);
        }
      }
    } catch {}
  }, [kind, savedQuotationRecord, handleSelectSavedQuotation]);

  /* Switch to a sibling room in a multi-room booking */
  const handleSelectSiblingReservation = useCallback((siblingId: number) => {
    setExplicitIncludeId(siblingId);
    setSelectedResId(siblingId);
  }, []);

  /* Picker row for summary (used while detail is still loading). */
  const pickerRow = useMemo(
    () =>
      selectedResId != null
        ? pickerReservations.find((r) => Number(r?.id) === selectedResId) ?? null
        : null,
    [pickerReservations, selectedResId],
  );

  /* Document renderer uses canonical detail for confirmation. */
  const docRes = selectedDetail;

  const filtered = useMemo(
    () => pickerReservations.filter((r) => reservationMatches(r, searchQuery)),
    [pickerReservations, searchQuery],
  );

  const currencyCode = propertyInfo?.currency;

  const totalLabel = useMemo(() => {
    if (kind === 'folio' && folioDoc) {
      return formatHotelCurrency(Number(folioDoc.summary.net_total_charges || 0), currencyCode);
    }
    const val = docRes?.total_price ?? pickerRow?.total_price ?? 0;
    if (!Number(val)) return '';
    return formatHotelCurrency(Number(val), currencyCode);
  }, [kind, folioDoc, docRes, pickerRow, currencyCode]);

  const checkInLabel = useMemo(
    () => formatHotelDateIndonesian(folioDoc?.check_in || pickerRow?.check_in),
    [folioDoc?.check_in, pickerRow],
  );
  const checkOutLabel = useMemo(
    () => formatHotelDateIndonesian(folioDoc?.check_out || pickerRow?.check_out),
    [folioDoc?.check_out, pickerRow],
  );

  /* Basic printable validation for quotation:
     At least one meaningful item has description.trim() !== '' and qty > 0 */
  const hasPrintableQuotation = useMemo(() => {
    return (quotationDraft.items || []).some(
      (item) => item.description?.trim() !== '' && Number(item.qty) > 0,
    );
  }, [quotationDraft.items]);

  /* Guest Bill R7: Charges breakdown and dual signature receptionist resolution */
  const guestBillChargeLines = useMemo(() => {
    if (!folioDoc?.effective_lines) return [];
    return folioDoc.effective_lines.filter(
      (l) =>
        l.included_in_scope &&
        l.category !== 'PAYMENT' &&
        l.category !== 'GROUP_PAYMENT_ALLOCATION' &&
        l.category !== 'DEPOSIT_APPLY' &&
        l.category !== 'DEPOSIT_UNAPPLY' &&
        l.entry_type !== 'PAYMENT' &&
        l.entry_type !== 'BOOKING_GROUP_ALLOCATION' &&
        l.entry_type !== 'DEPOSIT_APPLICATION' &&
        l.entry_type !== 'DEPOSIT_UNAPPLY' &&
        l.entry_type !== 'PAYMENT_REVERSAL' &&
        l.entry_type !== 'BOOKING_GROUP_ALLOCATION_REVERSAL',
    );
  }, [folioDoc?.effective_lines]);

  const chargeBreakdownSum = useMemo(() => {
    return guestBillChargeLines.reduce(
      (sum, l) => sum + (Number(l.debit || 0) - Number(l.credit || 0)),
      0,
    );
  }, [guestBillChargeLines]);

  const isGuestBillChargesReconciled = useMemo(() => {
    if (!folioDoc?.summary) return true;
    return Math.abs(chargeBreakdownSum - Number(folioDoc.summary.net_total_charges || 0)) === 0;
  }, [chargeBreakdownSum, folioDoc?.summary?.net_total_charges]);

  const guestBillReceptionistName = useMemo(() => {
    const role = String(folioDoc?.print_metadata?.printed_by_role || '')
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, '');
    const foRoles = ['RECEPTIONIST', 'FRONTDESK', 'FRONTOFFICE', 'FO', 'RESEPSIONIS'];
    if (foRoles.includes(role)) {
      return folioDoc?.print_metadata?.printed_by_name || null;
    }
    return null;
  }, [folioDoc?.print_metadata]);

  /* Print button enablement logic:
     - Confirmation (Guest Bill): canonical detail loaded without error AND folio loaded and reconciled AND charges reconciled
     - Folio: canonical folioDoc loaded without error AND reconciled
     - Reservation quotation: canonical detail loaded without error AND has printable quotation
     - Manual quotation: has printable quotation (no reservation required) */
  const printEnabled =
    kind === 'confirmation'
      ? docRes != null &&
        !detailLoading &&
        !detailError &&
        folioDoc != null &&
        !folioLoading &&
        !folioError &&
        folioDoc.reconciliation?.is_reconciled === true &&
        isGuestBillChargesReconciled === true
      : kind === 'folio'
        ? folioDoc != null &&
          !folioLoading &&
          !folioError &&
          folioDoc.reconciliation?.is_reconciled === true
        : quotationMode === 'reservation'
          ? docRes != null && !detailLoading && !detailError && hasPrintableQuotation
          : hasPrintableQuotation;

  const handlePrint = useCallback(() => {
    if (!printEnabled || isSavingPdf) return;
    const now = new Date();
    const targetTz = (propertyInfo as any)?.timezone || (folioDoc?.property as any)?.timezone || 'Asia/Jakarta';
    if (printDocumentRef.current) {
      updateFolioPrintTimestampInDom(printDocumentRef.current, now, targetTz);
    }
    flushSync(() => {
      setActionTimestamp(now);
    });
    if (kind === 'folio' && (!folioDoc || !folioDoc.reconciliation || !folioDoc.reconciliation.is_reconciled)) {
      alert('Pencetakan diblokir: Rincian transaksi dan ringkasan finansial tidak cocok.');
      return;
    }
    if (kind === 'confirmation') {
      if (!folioDoc || !folioDoc.reconciliation || !folioDoc.reconciliation.is_reconciled) {
        alert('Pencetakan diblokir: Guest Bill hanya boleh dicetak setelah folio siap dan rekonsiliasi berhasil.');
        return;
      }
      if (!isGuestBillChargesReconciled) {
        alert('Pencetakan diblokir: Jumlah rincian tagihan tidak sesuai dengan total tagihan ringkasan.');
        return;
      }
      window.print();
      return;
    }
    window.print();
  }, [printEnabled, isSavingPdf, kind, folioDoc, isGuestBillChargesReconciled, propertyInfo]);

  const statusLabel = (status?: string): string => {
    if (!status) return '—';
    const s = String(status).toUpperCase();
    if (s === 'BOOKED') return 'Terpesan';
    if (s === 'CHECKED_IN') return 'Check-in';
    if (s === 'CHECKED_OUT') return 'Check-out';
    if (s === 'CANCELLED') return 'Dibatalkan';
    return s;
  };

  const printHint = useMemo(() => {
    if (kind === 'folio') {
      if (folioDoc) {
        if (folioDoc.reconciliation && !folioDoc.reconciliation.is_reconciled) {
          return `Pencetakan diblokir: Rincian transaksi dan ringkasan finansial tidak cocok (Selisih: Rp ${(folioDoc.reconciliation.discrepancy_amount || 0).toLocaleString('id-ID')})`;
        }
        return `${folioDoc.folio_number} · ${folioDoc.summary.payment_status_label}`;
      }
      if (folioError) {
        return 'Guest Folio gagal dimuat — klik Coba Lagi atau pilih reservasi lain';
      }
      if (folioLoading) {
        return 'Memuat rincian Guest Folio…';
      }
      return 'Pilih reservasi terlebih dahulu';
    }

    if (kind === 'confirmation') {
      if (detailError) {
        return 'Detail gagal dimuat — pilih reservasi lain';
      }
      if (folioError) {
        return 'Guest Folio gagal dimuat — klik Coba Lagi atau pilih reservasi lain';
      }
      if (detailLoading || folioLoading) {
        return 'Memuat rincian Guest Bill & Folio…';
      }
      if (!docRes || !folioDoc) {
        return 'Pilih reservasi terlebih dahulu';
      }
      if (folioDoc.reconciliation && !folioDoc.reconciliation.is_reconciled) {
        return `Pencetakan diblokir: Rincian transaksi dan ringkasan finansial tidak cocok (Selisih: Rp ${(folioDoc.reconciliation.discrepancy_amount || 0).toLocaleString('id-ID')})`;
      }
      if (!isGuestBillChargesReconciled) {
        return `Pencetakan diblokir: Total rincian tagihan (Rp ${chargeBreakdownSum.toLocaleString('id-ID')}) tidak cocok dengan total tagihan (Rp ${Number(folioDoc.summary.net_total_charges || 0).toLocaleString('id-ID')})`;
      }
      return `BID ${pickerRow?.bid || docRes?.bid || '—'} · Guest Bill`;
    }

    /* kind === 'quotation' */
    if (quotationMode === 'reservation') {
      if (selectedResId == null) {
        return 'Pilih reservasi terlebih dahulu';
      }
      if (detailLoading) {
        return 'Memuat detail…';
      }
      if (detailError) {
        return 'Detail gagal dimuat — pilih reservasi lain';
      }
      if (!hasPrintableQuotation) {
        return 'Tambahkan minimal 1 item penawaran untuk mencetak.';
      }
      const refLabel = quotationDraft.reference || pickerRow?.bid || '—';
      return `BID ${refLabel} · Quotation / Penawaran`;
    }

    /* quotationMode === 'manual' */
    if (!hasPrintableQuotation) {
      return 'Tambahkan minimal 1 item penawaran untuk mencetak.';
    }
    const validItemCount = (quotationDraft.items || []).filter(
      (item) => item.description?.trim() !== '' && Number(item.qty) > 0,
    ).length;
    return `Quotation Manual · ${validItemCount} item`;
  }, [
    kind,
    quotationMode,
    folioDoc,
    folioError,
    folioLoading,
    docRes,
    pickerRow?.bid,
    detailError,
    detailLoading,
    selectedResId,
    hasPrintableQuotation,
    quotationDraft.reference,
    quotationDraft.items,
    isGuestBillChargesReconciled,
    chargeBreakdownSum,
  ]);

  const isLoadingDocument =
    kind === 'confirmation'
      ? detailLoading || folioLoading
      : kind === 'folio'
        ? folioLoading
        : detailLoading;
  const documentError =
    kind === 'confirmation'
      ? detailError || folioError
      : kind === 'folio'
        ? folioError
        : detailError;

  /* Clear PDF error and close export modal on document/selection change */
  useEffect(() => {
    setSavePdfError(null);
    setShowPdfFilenameModal(false);
  }, [
    kind,
    selectedResId,
    quotationMode,
    folioScope,
    folioViewMode,
    isLoadingDocument,
    documentError,
    propertyInfo,
  ]);

  const handleOpenSavePdfDialog = useCallback(() => {
    if (!printEnabled || isSavingPdf) return;
    setSavePdfError(null);
    const filename = generateDocumentPdfFilename({
      kind,
      quotationMode,
      bid: folioDoc?.bid || docRes?.bid || pickerRow?.bid,
      reference: quotationDraft.reference,
      folioNumber: folioDoc?.folio_number,
      quotationNumber: quotationDraft.quotationNumber,
      revisionLabel: quotationDraft.revisionLabel,
      propertyInfo,
      propertyBranding,
    });
    setPdfFilename(filename);
    setShowPdfFilenameModal(true);
  }, [
    printEnabled,
    isSavingPdf,
    kind,
    quotationMode,
    folioDoc?.bid,
    folioDoc?.folio_number,
    docRes?.bid,
    pickerRow?.bid,
    quotationDraft.reference,
    quotationDraft.quotationNumber,
    quotationDraft.revisionLabel,
    propertyInfo,
    propertyBranding,
  ]);

  const savePdfWithFilename = useCallback(async (finalFilename: string) => {
    if (isSavingPdf) return;

    if (isLoadingDocument) {
      setSavePdfError('Ekspor PDF diblokir: Dokumen masih dalam proses pemuatan.');
      return;
    }
    if (documentError) {
      setSavePdfError(`Ekspor PDF diblokir: ${documentError}`);
      return;
    }

    if (kind === 'folio') {
      if (!folioDoc) {
        setSavePdfError('Ekspor PDF diblokir: Data guest folio belum siap.');
        return;
      }
      const folioResId = (folioDoc as any).reservation?.id ?? folioDoc.reservation_id;
      if (pickerRow && folioResId && folioResId !== pickerRow.id) {
        setSavePdfError('Ekspor PDF diblokir: Identitas reservasi tidak sesuai dengan pilihan aktif.');
        return;
      }
      if (!folioDoc.reconciliation || !folioDoc.reconciliation.is_reconciled) {
        setSavePdfError('Ekspor PDF diblokir: Rincian transaksi dan ringkasan finansial tidak cocok.');
        return;
      }
    } else if (kind === 'confirmation') {
      if (!docRes) {
        setSavePdfError('Ekspor PDF diblokir: Data guest bill belum siap.');
        return;
      }
      if (pickerRow && docRes.reservation?.id && docRes.reservation.id !== pickerRow.id) {
        setSavePdfError('Ekspor PDF diblokir: Identitas reservasi tidak sesuai dengan pilihan aktif.');
        return;
      }
      if (!folioDoc) {
        setSavePdfError('Ekspor PDF diblokir: Data folio belum siap.');
        return;
      }
      if (!folioDoc.reconciliation || !folioDoc.reconciliation.is_reconciled) {
        setSavePdfError('Ekspor PDF diblokir: Guest Bill hanya boleh diekspor setelah folio siap dan rekonsiliasi berhasil.');
        return;
      }
      if (!isGuestBillChargesReconciled) {
        setSavePdfError('Ekspor PDF diblokir: Jumlah rincian tagihan tidak sesuai dengan total tagihan ringkasan.');
        return;
      }
    }

    const nowTimestamp = new Date();
    const targetTz = (propertyInfo as any)?.timezone || (folioDoc?.property as any)?.timezone || 'Asia/Jakarta';
    if (printDocumentRef.current) {
      updateFolioPrintTimestampInDom(printDocumentRef.current, nowTimestamp, targetTz);
    }
    flushSync(() => {
      setActionTimestamp(nowTimestamp);
    });

    const rootEl = printDocumentRef.current;
    if (!rootEl) {
      setSavePdfError('Elemen pratinjau dokumen tidak ditemukan.');
      return;
    }

    const headerEl = headerRef.current;
    const footerEl = footerRef.current;

    if (!headerEl || !footerEl) {
      setSavePdfError('Elemen header/footer tidak ditemukan di DOM.');
      return;
    }

    setIsSavingPdf(true);
    setSavePdfError(null);

    let bodyClone: HTMLElement | null = null;
    let bodyHost: HTMLDivElement | null = null;

    try {
      const now = Date.now();
      const cache = pdfSnapshotCacheRef.current;
      const ttlExpired = !cache.header ||
        (now - (cache.capturedAt || 0)) > SNAPSHOT_TTL_MS;

      let headerDataUrl = cache.header;
      let footerDataUrl = cache.footer;
      let headerHeightMm = cache.headerHeight;
      let footerHeightMm = cache.footerHeight;

      if (ttlExpired) {
        const snapshotHost = document.createElement('div');
        snapshotHost.style.position = 'fixed';
        snapshotHost.style.left = '-10000px';
        snapshotHost.style.top = '0';
        snapshotHost.style.width = '174mm';
        snapshotHost.style.background = '#fff';
        snapshotHost.style.pointerEvents = 'none';
        snapshotHost.style.zIndex = '-1';
        document.body.appendChild(snapshotHost);

        try {
          const headerClone = headerEl.cloneNode(true) as HTMLElement;
          headerClone.removeAttribute('data-html2canvas-ignore');
          snapshotHost.appendChild(headerClone);

          const footerClone = footerEl.cloneNode(true) as HTMLElement;
          footerClone.removeAttribute('data-html2canvas-ignore');
          snapshotHost.appendChild(footerClone);

          const [headerSnap, footerSnap] = await Promise.all([
            captureSnapshot(headerClone),
            captureSnapshot(footerClone),
          ]);
          headerDataUrl = headerSnap.dataUrl;
          footerDataUrl = footerSnap.dataUrl;
          headerHeightMm = computePdfDimensions(headerSnap, 174);
          footerHeightMm = computePdfDimensions(footerSnap, 174);
          pdfSnapshotCacheRef.current = {
            header: headerDataUrl,
            footer: footerDataUrl,
            headerHeight: headerHeightMm,
            footerHeight: footerHeightMm,
            capturedAt: now,
          };
        } finally {
          document.body.removeChild(snapshotHost);
        }
      }

      const frameEl = rootEl.querySelector('.oak-letterhead-frame') as HTMLElement;
      if (!frameEl) {
        throw new Error('Frame elemen tidak ditemukan.');
      }
      bodyClone = frameEl.cloneNode(true) as HTMLElement;
      updateFolioPrintTimestampInDom(bodyClone, nowTimestamp, targetTz);
      bodyClone.querySelectorAll('[data-html2canvas-ignore="true"]').forEach((el) => el.remove());
      const bh = bodyClone.querySelector('.oak-letterhead-header');
      const bf = bodyClone.querySelector('.oak-letterhead-footer');
      const bw = bodyClone.querySelector('.oak-letterhead-watermark');
      const br = bodyClone.querySelector('.oak-letterhead-rose');
      if (bh instanceof HTMLElement) bh.remove();
      if (bf instanceof HTMLElement) bf.remove();
      if (bw instanceof HTMLElement) bw.remove();
      if (br instanceof HTMLElement) br.remove();

      // GF-F01 & R6: Multi-page table pagination for Save PDF (html2pdf)
      // Chunk folio / guest bill table rows so that every continuation page repeats the full <thead>
      if (kind === 'folio' || kind === 'confirmation') {
        const tableSelector = kind === 'folio' ? '.oak-folio-table' : '.oak-guest-bill-table';
        const table = bodyClone.querySelector(tableSelector);
        if (table) {
          const thead = table.querySelector('thead');
          const tbody = table.querySelector('tbody');
          const tfoot = table.querySelector('tfoot');
          if (thead && tbody) {
            const rows = Array.from(tbody.querySelectorAll('tr'));
            const total = rows.length;
            const singlePageLimit = kind === 'confirmation' ? 12 : 8;
            if (total > singlePageLimit) {
              const chunks: HTMLTableRowElement[][] = [];
              // GB6-F03 (R8): Allocate balanced table chunks so closing block (summary + signatures)
              // lands together with the final chunk rows on the last page without creating an orphaned page.
              const page1Max = kind === 'confirmation' ? 13 : 10;
              const intermediateMax = kind === 'confirmation' ? 14 : 14;
              const finalMax = kind === 'confirmation' ? 8 : 10;

              if (total <= page1Max) {
                const half = Math.ceil(total / 2);
                chunks.push(rows.slice(0, half));
                chunks.push(rows.slice(half));
              } else {
                chunks.push(rows.slice(0, page1Max));
                let cur = page1Max;
                while (cur < total) {
                  const rem = total - cur;
                  if (rem <= finalMax) {
                    chunks.push(rows.slice(cur));
                    break;
                  }
                  if (rem <= intermediateMax + finalMax) {
                    const nextSize = Math.min(intermediateMax, rem - Math.min(finalMax, Math.ceil(rem / 2)));
                    chunks.push(rows.slice(cur, cur + nextSize));
                    cur += nextSize;
                    chunks.push(rows.slice(cur));
                    break;
                  } else {
                    chunks.push(rows.slice(cur, cur + intermediateMax));
                    cur += intermediateMax;
                  }
                }
              }

              const theadHtml = thead.outerHTML;
              const tfootHtml = tfoot ? tfoot.outerHTML : '';
              const totalChunks = chunks.length;

              if (kind === 'confirmation' && totalChunks > 1) {
                const mainTitle = bodyClone.querySelector(
                  '.oak-guest-bill-charges-section .oak-doc-section-title',
                );
                if (mainTitle) {
                  mainTitle.textContent = `Rincian Tagihan (Halaman 1 dari ${totalChunks})`;
                }
              }

              tbody.innerHTML = '';
              chunks[0].forEach((r) => tbody.appendChild(r.cloneNode(true) as HTMLTableRowElement));
              if (chunks.length > 1 && tfoot) {
                tfoot.remove();
              }

              let lastInsertedEl: Element = table;
              for (let c = 1; c < chunks.length; c++) {
                const isLastChunk = c === chunks.length - 1;

                const pageBreak = document.createElement('div');
                pageBreak.className = 'html2pdf__page-break';
                pageBreak.style.height = '0';
                pageBreak.style.margin = '0';
                pageBreak.style.padding = '0';
                lastInsertedEl.after(pageBreak);

                const contSection = document.createElement('div');
                contSection.className = 'oak-folio-continuation-section';
                contSection.style.marginTop = '4px';

                const contHeader = document.createElement('div');
                contHeader.className = 'oak-folio-continuation-header';
                contHeader.style.fontSize = '11px';
                contHeader.style.fontWeight = '600';
                contHeader.style.color = '#1b3d2f';
                contHeader.style.marginBottom = '6px';
                contHeader.style.paddingBottom = '3px';
                contHeader.style.borderBottom = '1px dashed #c2b280';
                contHeader.textContent = kind === 'confirmation'
                  ? `Rincian Tagihan (Lanjutan - Halaman ${c + 1} dari ${totalChunks})`
                  : `Rincian Transaksi Folio (Lanjutan - Halaman ${c + 1} dari ${totalChunks})`;
                contSection.appendChild(contHeader);

                const newTable = document.createElement('table');
                newTable.className = kind === 'confirmation' ? 'oak-guest-bill-table' : 'oak-doc-fin-table oak-folio-table';
                newTable.innerHTML = theadHtml;

                const newTbody = document.createElement('tbody');
                chunks[c].forEach((r) => newTbody.appendChild(r.cloneNode(true) as HTMLTableRowElement));
                newTable.appendChild(newTbody);

                if (isLastChunk && tfootHtml) {
                  const tempFoot = document.createElement('table');
                  tempFoot.innerHTML = tfootHtml;
                  const footEl = tempFoot.querySelector('tfoot');
                  if (footEl) newTable.appendChild(footEl);
                }

                contSection.appendChild(newTable);
                pageBreak.after(contSection);
                lastInsertedEl = contSection;
              }
            }
          }
        }
      }

      bodyClone.classList.add('oak-pdf-export-body');
      bodyClone.style.display = 'block';
      bodyClone.style.padding = '0';
      bodyClone.style.margin = '0';
      bodyClone.style.border = '0';
      bodyClone.style.borderRadius = '0';
      bodyClone.style.boxShadow = 'none';
      bodyClone.style.minHeight = '0';
      bodyClone.style.height = 'auto';
      bodyClone.style.maxWidth = 'none';
      bodyClone.style.boxSizing = 'border-box';

      const bodyHostEl = document.createElement('div');
      bodyHostEl.style.position = 'fixed';
      bodyHostEl.style.left = '-10000px';
      bodyHostEl.style.top = '0';
      bodyHostEl.style.width = '174mm';
      bodyHostEl.style.background = '#fff';
      bodyHostEl.style.pointerEvents = 'none';
      bodyHostEl.style.zIndex = '-1';

      bodyClone.style.position = 'static';
      bodyClone.style.left = 'auto';
      bodyClone.style.top = 'auto';
      bodyClone.style.zIndex = 'auto';
      bodyClone.style.width = '174mm';

      bodyHostEl.appendChild(bodyClone);
      document.body.appendChild(bodyHostEl);
      bodyHost = bodyHostEl;

      const headerGapMm = 2;
      const topMargin = (headerHeightMm ?? 20) + headerGapMm;
      const overlayFooterGapMm = 4;
      const bodyToFooterGapMm = 2;
      const bottomMargin = (footerHeightMm ?? 14) + overlayFooterGapMm + bodyToFooterGapMm;

      const html2pdfLib = (html2pdf as any)?.default || html2pdf;
      const worker = html2pdfLib().set({
        margin: [topMargin, 18, bottomMargin, 18] as [number, number, number, number],
        filename: finalFilename,
        image: { type: 'jpeg' as const, quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          scrollY: 0,
          scrollX: 0,
        },
        jsPDF: {
          unit: 'mm' as const,
          format: 'a4' as const,
          orientation: 'portrait' as const,
        },
        pagebreak: {
          mode: ['css'],
          avoid: [
            '.oak-folio-table tbody tr',
            '.oak-guest-bill-table tbody tr',
            '.oak-doc-fin-table tbody tr',
            '.oak-doc-summary-table',
            '.oak-doc-fin-block',
            '.oak-doc-signature-block',
            '.oak-folio-summary-block',
            '.oak-folio-signature-block',
            '.oak-guest-bill-closing-block',
          ],
        },
      }).from(bodyClone);

      await worker.toPdf();

      const pdf = await worker.get('pdf') as unknown as import('jspdf').jsPDF;

      const pages = pdf.getNumberOfPages();
      const contentWidthMm = 174;
      const headerY = 3;
      const footerY = 297 - overlayFooterGapMm - (footerHeightMm ?? 14);

      for (let i = 1; i <= pages; i++) {
        pdf.setPage(i);
        if (headerDataUrl && headerHeightMm) {
          pdf.addImage(headerDataUrl, 'PNG', 18, headerY, contentWidthMm, headerHeightMm);
        }
        if (footerDataUrl && footerHeightMm) {
          pdf.addImage(footerDataUrl, 'PNG', 18, footerY, contentWidthMm, footerHeightMm);
        }
        // GB6-F03 (R8): Stamp physical page numbering on every page
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7.5);
        pdf.setTextColor(110, 110, 110);
        const pageNumText = `Halaman ${i} dari ${pages}`;
        pdf.text(pageNumText, 18 + contentWidthMm, 297 - overlayFooterGapMm - 1, { align: 'right' });
      }

      pdf.save(finalFilename);
    } catch (err: unknown) {
      console.error('[DocumentCenter] Failed to generate PDF:', err);
      const msg = err instanceof Error ? err.message : 'Gagal menghasilkan file PDF.';
      setSavePdfError(msg);
    } finally {
      if (bodyHost && bodyHost.parentNode) {
        bodyHost.parentNode.removeChild(bodyHost);
      }
      setIsSavingPdf(false);
    }
  }, [
    isSavingPdf,
    kind,
    folioDoc,
    docRes,
    pickerRow,
    isLoadingDocument,
    documentError,
    propertyInfo,
  ]);

  const normalizePdfFilename = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const lower = trimmed.toLowerCase();
    if (lower.endsWith('.pdf')) return trimmed;
    return trimmed + '.pdf';
  };

  const handleConfirmPdfSave = useCallback(() => {
    const finalFilename = normalizePdfFilename(pdfFilename);
    if (!finalFilename) return;
    if (isLoadingDocument) {
      setShowPdfFilenameModal(false);
      setSavePdfError('Ekspor PDF diblokir: Dokumen masih dalam proses pemuatan.');
      return;
    }
    if (documentError) {
      setShowPdfFilenameModal(false);
      setSavePdfError(`Ekspor PDF diblokir: ${documentError}`);
      return;
    }
    if (kind === 'folio' && (!folioDoc || !folioDoc.reconciliation || !folioDoc.reconciliation.is_reconciled)) {
      setShowPdfFilenameModal(false);
      setSavePdfError('Ekspor PDF diblokir: Rincian transaksi dan ringkasan finansial tidak cocok.');
      return;
    }
    if (kind === 'confirmation' && (!folioDoc || !folioDoc.reconciliation || !folioDoc.reconciliation.is_reconciled)) {
      setShowPdfFilenameModal(false);
      setSavePdfError('Ekspor PDF diblokir: Guest Bill hanya boleh diekspor setelah folio siap dan rekonsiliasi berhasil.');
      return;
    }
    setShowPdfFilenameModal(false);
    savePdfWithFilename(finalFilename);
  }, [
    pdfFilename,
    savePdfWithFilename,
    isLoadingDocument,
    documentError,
    kind,
    folioDoc,
  ]);

  const handleCancelPdfSave = useCallback(() => {
    setShowPdfFilenameModal(false);
  }, []);

  /* ------------------------------------------------------------------ */
  /*  LEFT SIDEBAR                                                      */
  /* ------------------------------------------------------------------ */

  const needsReservationPicker =
    kind === 'confirmation' || kind === 'folio' || (kind === 'quotation' && quotationMode === 'reservation' && !savedQuotationRecord);

  const sidebar = (
    <aside className="document-center-sidebar doc-center-sidebar-fixed min-w-0">

      {/* Top Fixed Header & Control Area */}
      <div className="doc-center-fixed-top shrink-0 bg-white border-b border-[#e8e5dd]">
        {/* Header with Title & Action */}
        <div className="document-center-header flex items-center justify-between gap-3 border-b-0 pb-3">
          <div className="min-w-0">
            <h2 className="document-center-title">Dokumen &amp; Print</h2>
            <p className="document-center-subtitle">Buat, tinjau, dan cetak dokumen tamu</p>
          </div>
          <div className="flex-shrink-0 flex flex-col items-end">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="document-center-print-btn whitespace-nowrap !w-auto px-3.5 py-1.5 text-xs font-semibold rounded-md shadow-sm"
                onClick={handlePrint}
                disabled={!printEnabled || isSavingPdf}
                title={!printEnabled ? printHint : undefined}
              >
                Cetak
              </button>
              <button
                type="button"
                className="document-center-print-btn whitespace-nowrap !w-auto px-3.5 py-1.5 text-xs font-semibold rounded-md shadow-sm !bg-[#c5a880] hover:!bg-[#b3956c] !text-[#1b4332] font-bold"
                onClick={handleOpenSavePdfDialog}
                disabled={!printEnabled || isSavingPdf}
                title={!printEnabled ? printHint : undefined}
              >
                {isSavingPdf ? 'Menyimpan...' : 'Save PDF'}
              </button>
            </div>
            {!printEnabled && printHint ? (
              <span className="text-[10px] text-stone-400 mt-1 max-w-[220px] text-right truncate" title={printHint}>
                {printHint}
              </span>
            ) : null}
            {savePdfError ? (
              <span className="text-[10px] text-rose-600 mt-1 max-w-[220px] text-right truncate" title={savePdfError}>
                {savePdfError}
              </span>
            ) : null}
          </div>
        </div>

        {/* Document type */}
        <div className="document-center-block border-t border-[#ece9e2]">
          <div className="document-center-block-label">Jenis Dokumen</div>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className={`document-center-kind-card ${kind === 'confirmation' ? 'active' : ''}`}
              onClick={() => handleSwitchKind('confirmation')}
            >
              <span className="document-center-kind-name">Guest Bill</span>
              <span className="document-center-kind-desc">Ringkasan tagihan &amp; pembayaran</span>
            </button>
            <button
              type="button"
              className={`document-center-kind-card ${kind === 'quotation' ? 'active' : ''}`}
              onClick={() => handleSwitchKind('quotation')}
            >
              <span className="document-center-kind-name">Quotation / Penawaran</span>
              <span className="document-center-kind-desc">Penawaran tarif kamar &amp; paket</span>
            </button>
            <button
              type="button"
              className={`document-center-kind-card ${kind === 'folio' ? 'active' : ''}`}
              onClick={() => handleSwitchKind('folio')}
            >
              <span className="document-center-kind-name">Tagihan Tamu (Guest Folio)</span>
              <span className="document-center-kind-desc">Rincian tagihan, bayar &amp; saldo</span>
            </button>
          </div>
        </div>

        {/* Source mode selector (Quotation only) */}
        {kind === 'quotation' && (
          <div className="document-center-block border-t border-[#ece9e2]">
            <div className="document-center-block-label">Sumber Penawaran</div>
            <div className="document-center-kind-grid">
              <button
                type="button"
                className={`document-center-kind-card ${quotationMode === 'reservation' ? 'active' : ''}`}
                onClick={() => handleSwitchMode('reservation')}
              >
                <span className="document-center-kind-name">Dari Reservasi</span>
                <span className="document-center-kind-desc">Muat data dari reservasi hotel</span>
              </button>
              <button
                type="button"
                className={`document-center-kind-card ${quotationMode === 'manual' ? 'active' : ''}`}
                onClick={() => handleSwitchMode('manual')}
              >
                <span className="document-center-kind-name">Manual</span>
                <span className="document-center-kind-desc">Entri penawaran kustom langsung</span>
              </button>
            </div>
          </div>
        )}

        {/* Quotation Management Toolbar (Quotation only) */}
        {kind === 'quotation' && (
          <div className="document-center-block border-t border-[#ece9e2]">
            <div className="flex items-center justify-between mb-2">
              <span className="document-center-block-label !mb-0">Kelola Quotation</span>
              {savedQuotationRecord ? (
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#1b4332]/10 text-[#1b4332]">
                    {savedQuotationRecord.quotation_number} ({savedQuotationRecord.revision_label})
                  </span>
                  {isQuotationDirty ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800">
                      ● Ada Revisi
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800">
                      ✓ Tersimpan
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-stone-100 text-stone-600">
                    Draft Baru
                  </span>
                  {isQuotationDirty && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800">
                      ● Belum disimpan
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Quotation action status message */}
            {quotationActionMessage && (
              <div
                className={`mb-2.5 p-2 rounded text-xs flex items-center justify-between ${
                  quotationActionMessage.type === 'success'
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : 'bg-rose-50 text-rose-800 border border-rose-200'
                }`}
              >
                <span>{quotationActionMessage.text}</span>
                <button
                  type="button"
                  className="text-stone-400 hover:text-stone-700 ml-2 font-bold"
                  onClick={() => setQuotationActionMessage(null)}
                >
                  ✕
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 mb-2">
              <button
                type="button"
                className="px-2.5 py-1.5 text-xs font-medium rounded border border-[#c5a880]/60 bg-[#faf8f5] hover:bg-[#f3ede2] text-[#1b4332] text-center"
                onClick={handleNewQuotationClick}
              >
                + Quotation Baru
              </button>
              <button
                type="button"
                className="px-2.5 py-1.5 text-xs font-medium rounded border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 text-center"
                onClick={handleOpenSavedListClick}
              >
                📁 Daftar Tersimpan
              </button>
            </div>

            {/* Primary Save / Revise button */}
            <button
              type="button"
              className={`w-full py-2 px-3 text-xs font-semibold rounded shadow-sm text-center transition-colors ${
                savedQuotationRecord
                  ? 'bg-[#1b4332] hover:bg-[#143225] text-[#f7f4ee]'
                  : 'bg-[#c5a880] hover:bg-[#b3956c] text-[#1b4332]'
              } ${isSavingQuotation ? 'opacity-70 cursor-not-allowed' : ''}`}
              onClick={handleSaveQuotation}
              disabled={isSavingQuotation}
            >
              {isSavingQuotation
                ? 'Menyimpan...'
                : savedQuotationRecord
                  ? `Simpan Revisi (${savedQuotationRecord.quotation_number} - R${savedQuotationRecord.revision_number + 1})`
                  : 'Simpan Quotation'}
            </button>
          </div>
        )}
      </div>

      {/* Scrollable Editor Body */}
      <div className="doc-center-body-scroll min-w-0 flex-1">
        {/* Reservation selector */}
        {needsReservationPicker && (
          <div className="document-center-block">
            <div className="document-center-block-label">Reservasi</div>
            <input
              type="text"
              className="document-center-search"
              placeholder="Cari BID, ID reservasi, nama tamu, atau nomor kamar..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Cari reservasi"
            />
            {pickerReservations.length === 0 ? (
              <div className="document-center-no-res">
                {pickerLoading
                  ? 'Memuat daftar reservasi...'
                  : pickerError
                    ? pickerError
                    : 'Belum ada reservasi yang dimuat untuk properti ini.'}
              </div>
            ) : (
              <div className="document-center-res-list">
                {filtered.length === 0 ? (
                  <div className="document-center-no-res">Tidak ada reservasi yang cocok.</div>
                ) : (
                  filtered.map((r) => {
                    const isActive = Number(r?.id) === selectedResId;
                    const guest = r?.guest_name || r?.booker_name || '—';
                    const dates = `${formatHotelDateIndonesian(r?.check_in)} – ${formatHotelDateIndonesian(r?.check_out)}`;
                    return (
                      <button
                        key={r?.id}
                        type="button"
                        className={`document-center-res-item ${isActive ? 'active' : ''}`}
                        onClick={() => setSelectedResId(Number(r?.id))}
                      >
                        <div className="document-center-res-name">{guest}</div>
                        <div className="document-center-res-meta">
                          <span>{r?.bid || `#${r?.id}`}</span>
                          <span>{dates}</span>
                          {r?.room_number ? <span>Kamar {r?.room_number}</span> : null}
                          <span>({statusLabel(r?.status)})</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* Selected reservation summary */}
        {needsReservationPicker && (pickerRow || folioDoc) ? (
          <div className="document-center-block">
            <div className="document-center-block-label">Ringkasan Reservasi</div>
            <div className="document-center-summary">
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">Referensi</span>
                <span className="document-center-summary-val">
                  {folioDoc?.reference_value || pickerRow?.bid || `#${selectedResId}`}
                </span>
              </div>
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">Tamu</span>
                <span className="document-center-summary-val">
                  {folioDoc?.guest_name || pickerRow?.guest_name || pickerRow?.booker_name || '—'}
                </span>
              </div>
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">Kamar</span>
                <span className="document-center-summary-val">
                  {folioDoc?.room_type_name || pickerRow?.room_type_name || pickerRow?.room_type || '—'}
                  {(folioDoc?.room_number || pickerRow?.room_number)
                    ? ` · No. ${folioDoc?.room_number || pickerRow?.room_number}`
                    : ''}
                </span>
              </div>
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">Check-in</span>
                <span className="document-center-summary-val">{checkInLabel}</span>
              </div>
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">Check-out</span>
                <span className="document-center-summary-val">{checkOutLabel}</span>
              </div>
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">Status</span>
                <span className="document-center-summary-val">
                  {folioDoc?.status_label || statusLabel(pickerRow?.status)}
                </span>
              </div>
              {totalLabel ? (
                <div className="document-center-summary-row">
                  <span className="document-center-summary-key">Total Tagihan</span>
                  <span className="document-center-summary-val">{totalLabel}</span>
                </div>
              ) : null}
              {kind === 'folio' && folioDoc ? (
                <div className="document-center-summary-row">
                  <span className="document-center-summary-key">Sisa Tagihan</span>
                  <span className="document-center-summary-val">
                    {formatHotelCurrency(Number(folioDoc.summary.remaining_balance || 0), currencyCode)}{' '}
                    ({folioDoc.summary.payment_status_label})
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Guest Bill presentation option; never changes financial data. */}
        {kind === 'confirmation' && selectedResId != null && (
          <div className="document-center-block">
            <div className="document-center-block-label">Pengaturan Guest Bill</div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium">Guest Signature</span>
              <div className="flex items-center gap-2">
                <span className="text-xs">{guestBillShowGuestSignature ? 'ON' : 'OFF'}</span>
                <button
                  type="button"
                  role="switch"
                  aria-label="Guest Signature"
                  aria-checked={guestBillShowGuestSignature}
                  onClick={() => setGuestBillShowGuestSignature((value) => !value)}
                  className={`inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b4332] ${guestBillShowGuestSignature ? 'bg-[#1b4332]' : 'bg-stone-300'}`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-4 w-4 rounded-full bg-white transition-transform ${guestBillShowGuestSignature ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Guest Folio Options (Guest Folio only) */}
        {kind === 'folio' && selectedResId != null && (
          <div className="document-center-block">
            <div className="document-center-block-label">Pengaturan Tampilan Guest Folio</div>
            <div className="document-center-opts">
              {/* Multi-room booking sibling switcher */}
              {folioDoc?.is_multi_room_booking && folioDoc.booking_siblings.length >= 1 && (
                <div className="document-center-opt-field document-center-sibling-switcher">
                  <label className="document-center-opt-label">
                    Pilih Kamar dalam Grup Booking ({folioDoc.bid || `#${folioDoc.booking_id}`})
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="px-2.5 py-1.5 text-xs rounded border transition-colors bg-[#1b4332] text-white border-[#1b4332] font-semibold active"
                    >
                      {folioDoc.room_number ? `Kamar ${folioDoc.room_number}` : `Res #${folioDoc.reservation_id}`} · {folioDoc.guest_name} (Aktif)
                    </button>
                    {folioDoc.booking_siblings.map((sib) => (
                      <button
                        key={sib.id}
                        type="button"
                        onClick={() => handleSelectSiblingReservation(sib.id)}
                        className="px-2.5 py-1.5 text-xs rounded border transition-colors bg-white text-stone-700 border-stone-300 hover:border-[#c5a880]"
                      >
                        {sib.room_number ? `Kamar ${sib.room_number}` : `Res #${sib.id}`} · {sib.guest_name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Scope selector */}
              <div className="document-center-opt-field">
                <label className="document-center-opt-label">Cakupan Tagihan Folio</label>
                <div className="document-center-kind-grid">
                  <button
                    type="button"
                    className={`document-center-kind-card ${folioScope === 'GUEST_FOLIO' ? 'active' : ''}`}
                    onClick={() => setFolioScope('GUEST_FOLIO')}
                  >
                    <span className="document-center-kind-name">Tagihan Tamu (Sesuai Pembayar)</span>
                    <span className="document-center-kind-desc">
                      Kewajiban bayar tamu di hotel (kecualikan kamar OTA Collect)
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`document-center-kind-card ${folioScope === 'FULL_RESERVATION' ? 'active' : ''}`}
                    onClick={() => setFolioScope('FULL_RESERVATION')}
                  >
                    <span className="document-center-kind-name">Seluruh Tagihan Kamar</span>
                    <span className="document-center-kind-desc">
                      Tampilkan seluruh nilai kamar &amp; biaya tambahan
                    </span>
                  </button>
                </div>
              </div>

              {/* View Mode selector: Effective vs Audit */}
              <div className="document-center-opt-field">
                <label className="document-center-opt-label">Mode Rincian Baris Transaksi</label>
                <div className="document-center-kind-grid">
                  <button
                    type="button"
                    className={`document-center-kind-card ${folioViewMode === 'EFFECTIVE' ? 'active' : ''}`}
                    onClick={() => setFolioViewMode('EFFECTIVE')}
                  >
                    <span className="document-center-kind-name">Item Efektif (Standar Tamu)</span>
                    <span className="document-center-kind-desc">
                      Hanya transaksi aktif pembentuk saldo akhir
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`document-center-kind-card ${folioViewMode === 'AUDIT' ? 'active' : ''}`}
                    onClick={() => setFolioViewMode('AUDIT')}
                  >
                    <span className="document-center-kind-name">Jejak Audit Lengkap</span>
                    <span className="document-center-kind-desc">
                      Sertakan histori void/koreksi beserta jurnal pembalik
                    </span>
                  </button>
                </div>
              </div>

              {/* Non-financial presentation labels */}
              <div className="document-center-opt-field">
                <label className="document-center-opt-label">
                  Nama Petugas Kasir / FO (Opsional)
                </label>
                <input
                  type="text"
                  className="document-center-opt-input document-center-opt-input-inline"
                  placeholder={folioDoc?.print_metadata?.printed_by_name || 'Nama kasir pada blok tanda tangan...'}
                  value={folioCashierLabel}
                  onChange={(e) => setFolioCashierLabel(e.target.value)}
                />
              </div>

              <div className="document-center-opt-field">
                <label className="document-center-opt-label">
                  Catatan Kaki / Pernyataan Tamu (Opsional)
                </label>
                <textarea
                  rows={2}
                  className="document-center-opt-input"
                  placeholder="Saya menyatakan bahwa rincian tagihan kamar, layanan tambahan, dan pembayaran pada Guest Folio ini telah diperiksa dan disetujui."
                  value={folioFooterNote}
                  onChange={(e) => setFolioFooterNote(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {/* Quotation Editor (Quotation only, single instance) */}
        {kind === 'quotation' && (
          <div className="document-center-block">
            <div className="document-center-block-label">Editor Penawaran</div>
            <QuotationEditor draft={quotationDraft} onChange={setQuotationDraft} />
          </div>
        )}
      </div>

    </aside>
  );

  /* ------------------------------------------------------------------ */
  /*  RIGHT PREVIEW                                                     */
  /* ------------------------------------------------------------------ */

  const preview = (
    <div className="document-center-preview min-w-0">
      <div className="document-center-preview-label">Pratinjau</div>
      <div className="document-center-preview-scroll w-full min-w-0">

        {kind === 'folio' ? (
          selectedResId == null ? (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Pilih reservasi untuk menampilkan Guest Folio.</div>
              <div className="document-center-empty-sub">
                Gunakan pencarian di panel kiri untuk memilih reservasi yang akan dicetak tagihannya.
              </div>
            </div>
          ) : folioLoading ? (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Memuat rincian Guest Folio...</div>
            </div>
          ) : folioError ? (
            <div className="document-center-empty document-center-empty-error">
              <div className="document-center-empty-text">Guest Folio tidak dapat dimuat.</div>
              <div className="document-center-empty-sub">{folioError}</div>
              <button
                type="button"
                onClick={() => setFolioRetryCount((c) => c + 1)}
                className="mt-3 px-3.5 py-1.5 text-xs font-semibold rounded-md bg-[#1b4332] text-white hover:bg-[#143626] transition-colors cursor-pointer"
              >
                Coba Lagi
              </button>
            </div>
          ) : folioDoc ? (
            <div ref={printDocumentRef} className="document-center-printable-wrapper">
              {folioDoc.reconciliation && !folioDoc.reconciliation.is_reconciled && (
                <div className="mb-4 p-4 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs">
                  <div className="font-bold flex items-center gap-2 text-amber-800 text-sm mb-1">
                    <span>⚠️</span>
                    <span>Peringatan Rekonsiliasi Finansial — Cetak & Ekspor PDF Dinonaktifkan</span>
                  </div>
                  <p className="mb-2">
                    Rincian baris transaksi tidak seimbang dengan ringkasan kalkulator finansial. Dokumen tidak dapat dicetak atau diekspor ke PDF hingga selisih teratasi.
                  </p>
                  {folioDoc.reconciliation.discrepancy_reasons && folioDoc.reconciliation.discrepancy_reasons.length > 0 && (
                    <ul className="list-disc list-inside space-y-1 font-mono text-[11px] bg-white/70 p-2.5 rounded border border-amber-200">
                      {folioDoc.reconciliation.discrepancy_reasons.map((reason, idx) => (
                        <li key={idx}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <GuestFolioPrint
                data={folioDoc}
                propertyInfo={propertyInfo}
                propertyBranding={propertyBranding}
                viewMode={folioViewMode}
                customFooterNote={folioFooterNote}
                cashierSignatureLabel={folioCashierLabel}
                actionTimestamp={actionTimestamp}
                headerRef={headerRef}
                footerRef={footerRef}
              />
            </div>
          ) : (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Pilih reservasi untuk menampilkan Guest Folio.</div>
            </div>
          )
        ) : kind === 'confirmation' ? (
          selectedResId == null ? (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Pilih reservasi untuk membuat dokumen.</div>
              <div className="document-center-empty-sub">Gunakan pencarian di panel kiri untuk memilih reservasi.</div>
            </div>
          ) : (detailLoading || folioLoading) ? (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Memuat rincian Guest Bill &amp; Folio...</div>
            </div>
          ) : (detailError || folioError) ? (
            <div className="document-center-empty document-center-empty-error">
              <div className="document-center-empty-text">Detail reservasi atau folio tidak dapat dimuat.</div>
              <div className="document-center-empty-sub">{detailError || folioError}</div>
              <button
                type="button"
                onClick={() => {
                  setDetailRetryCount((c) => c + 1);
                  setFolioRetryCount((c) => c + 1);
                }}
                className="mt-3 px-3.5 py-1.5 text-xs font-semibold rounded-md bg-[#1b4332] text-white hover:bg-[#143626] transition-colors cursor-pointer"
              >
                Coba Lagi
              </button>
            </div>
          ) : docRes ? (
            <div ref={printDocumentRef} className="document-center-printable-wrapper">
              {folioDoc?.reconciliation && !folioDoc.reconciliation.is_reconciled && (
                <div className="mb-4 p-4 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs">
                  <div className="font-bold flex items-center gap-2 text-amber-800 text-sm mb-1">
                    <span>⚠️</span>
                    <span>Peringatan Rekonsiliasi Finansial — Cetak &amp; Ekspor PDF Dinonaktifkan</span>
                  </div>
                  <p className="mb-2">
                    Rincian transaksi tidak seimbang dengan ringkasan kalkulator finansial. Guest Bill tidak dapat dicetak atau diekspor ke PDF hingga selisih teratasi.
                  </p>
                  {folioDoc.reconciliation.discrepancy_reasons && folioDoc.reconciliation.discrepancy_reasons.length > 0 && (
                    <ul className="list-disc list-inside space-y-1 font-mono text-[11px] bg-white/70 p-2.5 rounded border border-amber-200">
                      {folioDoc.reconciliation.discrepancy_reasons.map((reason, idx) => (
                        <li key={idx}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {folioDoc && !isGuestBillChargesReconciled && (
                <div className="mb-4 p-4 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs">
                  <div className="font-bold flex items-center gap-2 text-amber-800 text-sm mb-1">
                    <span>⚠️</span>
                    <span>Peringatan Rincian Tagihan — Cetak &amp; Ekspor PDF Dinonaktifkan</span>
                  </div>
                  <p>
                    Total rincian tagihan (Rp {chargeBreakdownSum.toLocaleString('id-ID')}) tidak sesuai dengan total tagihan ringkasan (Rp {Number(folioDoc?.summary?.net_total_charges || 0).toLocaleString('id-ID')}).
                  </p>
                </div>
              )}
              <ReservationConfirmationPrint
                reservation={
                  folioDoc?.summary
                    ? {
                        ...docRes,
                        total_price: folioDoc.summary.net_total_charges,
                        amount_paid: folioDoc.summary.effective_amount_paid,
                        applied_deposit: folioDoc.summary.applied_deposit,
                        remaining_balance: folioDoc.summary.remaining_balance,
                        payment_status: folioDoc.summary.payment_status,
                      }
                    : docRes
                }
                chargeLines={guestBillChargeLines}
                showGuestSignature={guestBillShowGuestSignature}
                receptionistName={guestBillReceptionistName}
                propertyInfo={propertyInfo}
                propertyBranding={propertyBranding}
                headerRef={headerRef}
                footerRef={footerRef}
              />
            </div>
          ) : (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Pilih reservasi untuk membuat dokumen.</div>
            </div>
          )
        ) : (
          quotationMode === 'reservation' && selectedResId == null ? (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Pilih reservasi untuk membuat penawaran.</div>
              <div className="document-center-empty-sub">Gunakan pencarian di panel kiri untuk memilih reservasi.</div>
            </div>
          ) : quotationMode === 'reservation' && detailLoading ? (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Memuat detail reservasi...</div>
            </div>
          ) : quotationMode === 'reservation' && detailError ? (
            <div className="document-center-empty document-center-empty-error">
              <div className="document-center-empty-text">Detail reservasi tidak dapat dimuat.</div>
              <div className="document-center-empty-sub">{detailError}</div>
              <button
                type="button"
                onClick={() => setDetailRetryCount((c) => c + 1)}
                className="mt-3 px-3.5 py-1.5 text-xs font-semibold rounded-md bg-[#1b4332] text-white hover:bg-[#143626] transition-colors cursor-pointer"
              >
                Coba Lagi
              </button>
            </div>
          ) : (
            <div ref={printDocumentRef} className="document-center-printable-wrapper">
              <QuotationPrint
                draft={quotationDraft}
                propertyInfo={propertyInfo}
                propertyBranding={propertyBranding}
                headerRef={headerRef}
                footerRef={footerRef}
              />
            </div>
          )
        )}

      </div>
    </div>
  );

  /* ------------------------------------------------------------------ */

  return (
    <div className="document-center doc-center-desktop-grid">
      <style>{`
        @media (min-width: 901px) {
          .doc-center-desktop-grid {
            grid-template-columns: minmax(560px, 720px) minmax(0, 1fr) !important;
          }
          .doc-center-sidebar-fixed {
            height: calc(100vh - 64px);
            max-height: calc(100vh - 64px);
            overflow: hidden !important;
            display: flex;
            flex-direction: column;
          }
          .doc-center-body-scroll {
            flex: 1 1 0;
            min-height: 0;
            overflow-y: auto;
          }
        }
        @media (max-width: 900px) {
          .doc-center-sidebar-fixed {
            max-height: none !important;
            overflow: visible !important;
          }
          .doc-center-body-scroll {
            overflow: visible !important;
          }
        }
      `}</style>
      {sidebar}
      {preview}
      <QuotationListModal
        isOpen={isQuotationListModalOpen}
        onClose={() => setIsQuotationListModalOpen(false)}
        propertyId={propertyId}
        onSelectQuotation={handleSelectSavedQuotation}
        onDeleteQuotation={handleQuotationDeleted}
      />
      <Modal
        isOpen={showUnsavedExitModal}
        onClose={() => {
          setShowUnsavedExitModal(false);
          setPendingExitAction(null);
        }}
        title="Perubahan Belum Disimpan"
      >
        <div className="p-4 space-y-4">
          <p className="text-sm text-stone-700">
            Quotation saat ini memiliki perubahan yang belum disimpan. Jika Anda melanjutkan, perubahan yang belum disimpan akan hilang.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 rounded"
              onClick={() => {
                setShowUnsavedExitModal(false);
                setPendingExitAction(null);
              }}
            >
              Tetap di Sini
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded"
              onClick={() => {
                setShowUnsavedExitModal(false);
                if (pendingExitAction) {
                  pendingExitAction();
                  setPendingExitAction(null);
                }
              }}
            >
              Abaikan Perubahan &amp; Lanjutkan
            </button>
          </div>
        </div>
      </Modal>
      {showPdfFilenameModal && (
        <Modal
          isOpen={showPdfFilenameModal}
          onClose={handleCancelPdfSave}
          title="Simpan PDF"
          size="sm"
          closeOnOverlayClick={false}
          footer={
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelPdfSave}
                disabled={isSavingPdf}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-md shadow-sm border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 transition-colors cursor-pointer disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmPdfSave}
                disabled={isSavingPdf || !pdfFilename.trim()}
                className="px-3.5 py-1.5 text-xs font-semibold rounded-md shadow-sm bg-emerald-800 hover:bg-emerald-700 text-white transition-colors cursor-pointer disabled:opacity-50"
              >
                {isSavingPdf ? 'Menyimpan...' : 'Simpan PDF'}
              </button>
            </div>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                Nama File
              </label>
              <input
                type="text"
                value={pdfFilename}
                onChange={(e) => setPdfFilename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && pdfFilename.trim() && !isSavingPdf) {
                    handleConfirmPdfSave();
                  }
                }}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-700/40 focus:border-emerald-700 transition-colors"
                autoFocus
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
