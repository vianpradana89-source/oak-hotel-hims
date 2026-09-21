import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import html2pdf from 'html2pdf.js';
import html2canvas from 'html2canvas';
import ReservationConfirmationPrint from './ReservationConfirmationPrint';
import QuotationPrint from './QuotationPrint';
import QuotationEditor from './QuotationEditor';
import type { QuotationDraft, QuotationMode, PropertyPaymentInstructionsDto } from './quotationDraft';
import {
  createBlankQuotationDraft,
  buildQuotationDraftFromReservation,
} from './quotationDraft';
import { formatHotelDateIndonesian, formatHotelCurrency } from './GuestDocumentContent';
import type { PropertyInfoDto, PropertyBrandingDto } from './GuestDocumentContent';
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
  propertyInfo,
  propertyBranding,
}: {
  kind: 'confirmation' | 'quotation';
  quotationMode?: 'reservation' | 'manual';
  bid?: string | null;
  reference?: string | null;
  propertyInfo?: PropertyInfoDto;
  propertyBranding?: PropertyBrandingDto;
}): string {
  const rawHotelName = propertyBranding?.displayName || propertyInfo?.name || 'OAK-Hotel';
  const hotelPrefix = sanitizeFilenameSegment(rawHotelName) || 'OAK-Hotel';
  const today = new Date().toISOString().slice(0, 10);

  if (kind === 'confirmation') {
    const cleanBid = (bid || '').trim();
    const refSuffix = cleanBid
      ? (cleanBid.toUpperCase().startsWith('BID-') ? cleanBid : `BID-${cleanBid}`)
      : today;
    return `${hotelPrefix}-Reservation-Confirmation-${sanitizeFilenameSegment(refSuffix)}.pdf`;
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
/*  DocumentCenter - OAK HIMS DOCUMENT-1B Step 3A & 1B.1 Step D    */
/*                                                                  */
/*  Left  : doc kind + property-scoped reservation picker + summary */
/*          + QuotationEditor (Step C/D)                            */
/*  Right : live A4 preview (draft-powered QuotationPrint)          */
/*                                                                  */
/*  Canonical data fetched via dedicated Document Domain API:       */
/*    GET /api/documents/reservations           (list picker)       */
/*    GET /api/documents/reservations/:id       (detail print)      */
/*  No DB writes. No SSE. No invoice / receipt logic.              */
/* ---------------------------------------------------------------- */

export type DocKind = 'confirmation' | 'quotation';

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
  return bid.includes(needle) || guest.includes(needle) || roomNo.includes(needle);
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
  const [kind, setKind] = useState<DocKind>(initialKind ?? 'confirmation');
  const [selectedResId, setSelectedResId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  /* Debounce ref for search queries to avoid a request on every keystroke. */
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Stale-response guard: increments on every new request so late responses
     from a previous request never overwrite the latest one. */
  const pickerRequestVersion = useRef(0);

  /* Single authoritative effect for all picker requests.
     - Empty search → immediate default fetch (recent CHECKED_OUT, LIMIT 20)
     - Non-empty search → debounced 300ms global property-scoped search
     - propertyId change cancels any in-flight request and resets state */
  useEffect(() => {
    // Cancel any pending debounce timer from the previous run.
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
        // Stale-response protection: enforce immediately after fetch,
        // before ANY state update (success, error, or !res.ok handling).
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
      } catch (err) {
        if (controller.signal.aborted) return;
        if (version !== pickerRequestVersion.current) return;
        setPickerError('Gagal memuat daftar reservasi dokumen.');
        setPickerLoading(false);
      }
    };

    if (!searchQuery.trim()) {
      // DEFAULT MODE: immediate fetch, no debounce.
      doFetch(`/api/documents/reservations?property_id=${propertyId}`);
    } else {
      // SEARCH MODE: debounced 300ms to avoid excessive requests.
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
  }, [propertyId, authFetch, searchQuery]);

  /* Canonical detail state (loaded via API, not from picker row). */
  const [selectedDetail, setSelectedDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /* Stale-response protection: version ref incremented on every new request. */
  const detailRequestVersion = useRef(0);

  /* Quotation draft state (DOCUMENT-1B.1 Step C & D) */
  const [quotationMode, setQuotationMode] = useState<QuotationMode>('reservation');
  const [quotationDraft, setQuotationDraft] = useState<QuotationDraft>(() =>
    createBlankQuotationDraft('reservation'),
  );

  /* PDF export state & capture ref (DOCUMENT-1B.2F) */
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [savePdfError, setSavePdfError] = useState<string | null>(null);
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

          // If draft currently has blank bank info, prefill from active property config
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
      property's scoped list, clear the selection and all detail state.
      This protects against propertyId changes and reservation list updates
      that drop the selected id. */
  useEffect(() => {
    if (selectedResId == null) return;
    const stillExists = pickerReservations.some(
      (r) => Number(r?.id) === selectedResId,
    );
    if (!stillExists) {
      setSelectedResId(null);
      setSelectedDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      lastPreloadedResIdRef.current = null;
      setQuotationDraft(
        createBlankQuotationDraft(
          quotationMode === 'manual' ? 'manual' : 'reservation',
          propertyPaymentInstructions,
        ),
      );
    }
  }, [pickerReservations, selectedResId, quotationMode, propertyPaymentInstructions]);

  /* Explicit propertyId change safety: clear selection & draft immediately */
  const prevPropertyIdRef = useRef(propertyId);
  useEffect(() => {
    if (prevPropertyIdRef.current !== propertyId) {
      prevPropertyIdRef.current = propertyId;
      setSelectedResId(null);
      setSelectedDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      lastPreloadedResIdRef.current = null;
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

    /* Stale guard: bump version and capture it for this request. */
    const version = ++detailRequestVersion.current;
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
        /* The dedicated Document API returns:
           { status: "OK", data: { reservation: {...}, nightly_rates: [...] } }
           We extract the reservation object for rendering and keep nightly_rates for draft. */
        if (json?.status === 'ERROR') {
          throw new Error(json?.message || 'Data tidak tersedia');
        }
        const responseData = json?.data;
        if (!responseData || typeof responseData !== 'object') {
          throw new Error('Invalid response shape');
        }

        /* Extract reservation object (not the wrapper) */
        const reservation = responseData.reservation || responseData;
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
  }, [selectedResId, propertyId, authFetch]);

  /* Preload canonical reservation detail into quotation draft (reservation mode only) */
  useEffect(() => {
    if (selectedDetail && quotationMode === 'reservation') {
      const currentDetailId = Number(selectedDetail.id ?? selectedResId);
      if (currentDetailId && currentDetailId !== lastPreloadedResIdRef.current) {
        lastPreloadedResIdRef.current = currentDetailId;
        setQuotationDraft(
          buildQuotationDraftFromReservation(selectedDetail, propertyPaymentInstructions),
        );
      }
    }
  }, [selectedDetail, selectedResId, quotationMode, propertyPaymentInstructions]);

  /* If selected reservation is cleared while in reservation mode, reset draft */
  useEffect(() => {
    if (selectedResId == null && quotationMode === 'reservation') {
      lastPreloadedResIdRef.current = null;
      setQuotationDraft(
        createBlankQuotationDraft('reservation', propertyPaymentInstructions),
      );
    }
  }, [selectedResId, quotationMode, propertyPaymentInstructions]);

  /* Switch quotation source mode (reservation vs manual) */
  const handleSwitchMode = useCallback(
    (newMode: QuotationMode) => {
      if (newMode === quotationMode) return;
      setQuotationMode(newMode);
      if (newMode === 'manual') {
        // Clear reservation-specific state, create fresh blank draft
        lastPreloadedResIdRef.current = null;
        setQuotationDraft(
          createBlankQuotationDraft('manual', propertyPaymentInstructions),
        );
      } else {
        // Switching to reservation mode: preload canonical detail if already loaded
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
    const val = docRes?.total_price ?? pickerRow?.total_price ?? 0;
    if (!Number(val)) return '';
    return formatHotelCurrency(Number(val), currencyCode);
  }, [docRes, pickerRow, currencyCode]);

  const checkInLabel = useMemo(
    () => formatHotelDateIndonesian(pickerRow?.check_in),
    [pickerRow],
  );
  const checkOutLabel = useMemo(
    () => formatHotelDateIndonesian(pickerRow?.check_out),
    [pickerRow],
  );

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const statusLabel = (status?: string): string => {
    if (!status) return '—';
    const s = String(status).toUpperCase();
    if (s === 'BOOKED') return 'Terpesan';
    if (s === 'CHECKED_IN') return 'Check-in';
    if (s === 'CHECKED_OUT') return 'Check-out';
    if (s === 'CANCELLED') return 'Dibatalkan';
    return s;
  };

  /* Basic printable validation for quotation:
     At least one meaningful item has description.trim() !== '' and qty > 0 */
  const hasPrintableQuotation = useMemo(() => {
    return (quotationDraft.items || []).some(
      (item) => item.description?.trim() !== '' && Number(item.qty) > 0,
    );
  }, [quotationDraft.items]);

  /* Print button enablement logic (DOCUMENT-1B.1 Step D):
     - Confirmation: canonical detail loaded without error
     - Reservation quotation: canonical detail loaded without error AND has printable quotation
     - Manual quotation: has printable quotation (no reservation required) */
  const printEnabled =
    kind === 'confirmation'
      ? docRes != null && !detailLoading && !detailError
      : quotationMode === 'reservation'
        ? docRes != null && !detailLoading && !detailError && hasPrintableQuotation
        : hasPrintableQuotation;

  const printHint = useMemo(() => {
    if (kind === 'confirmation') {
      if (docRes) {
        return `BID ${pickerRow?.bid || '—'} · Konfirmasi Reservasi`;
      }
      if (detailError) {
        return 'Detail gagal dimuat — pilih reservasi lain';
      }
      if (detailLoading) {
        return 'Memuat detail…';
      }
      return 'Pilih reservasi terlebih dahulu';
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
    docRes,
    pickerRow?.bid,
    detailError,
    detailLoading,
    selectedResId,
    hasPrintableQuotation,
    quotationDraft.reference,
    quotationDraft.items,
  ]);

  /* Clear PDF error on document/selection change */
  useEffect(() => {
    setSavePdfError(null);
  }, [kind, selectedResId, quotationMode]);

  /* ------------------------------------------------------------------ */

   /* Handle real downloadable PDF export via DOM snapshot + jsPDF overlay
      *
      * Strategy (zero mutation of live preview DOM):
      *   1. Snapshot canonical header/footer via html2canvas directly — their
      *      `data-html2canvas-ignore="true"` is on the element itself, but
      *      html2canvas 1.4.1 skips that attribute only on children, not root,
      *      so the snapshots capture the rendered pixels faithfully.
      *   2. Build a detached clone of .oak-letterhead-frame, strip header &
      *      footer from it, then feed the clone to html2pdf so the existing
      *      pagebreak CSS rules paginate the body across multiple pages.
      *   3. Retrieve the actual jsPDF instance via the official API:
      *        const pdf = await worker.get('pdf')
      *   4. Overlay the canonical OAK letterhead snapshots on EVERY page
      *      (page 1 and pages 2+ use identical geometry).
      *   5. Exactly ONE final `pdf.save(filename)` call.
      *
      * The live preview DOM is never mutated.  No cloneNode or
      * document.body.appendChild is used.
      */
   const handleSavePdf = useCallback(async () => {
     if (!printEnabled || isSavingPdf) return;

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

     try {
       const filename = generateDocumentPdfFilename({
         kind,
         quotationMode,
         bid: docRes?.bid || pickerRow?.bid,
         reference: quotationDraft.reference,
         propertyInfo,
         propertyBranding,
       });

       // ── Step 1: Snapshot canonical header & footer ──────────────
       const now = Date.now();
       const cache = pdfSnapshotCacheRef.current;
       const ttlExpired = !cache.header ||
         (now - (cache.capturedAt || 0)) > SNAPSHOT_TTL_MS;

       let headerDataUrl = cache.header;
       let footerDataUrl = cache.footer;
       let headerHeightMm = cache.headerHeight;
       let footerHeightMm = cache.footerHeight;

       if (ttlExpired) {
         const [headerSnap, footerSnap] = await Promise.all([
           captureSnapshot(headerEl),
           captureSnapshot(footerEl),
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
       }

        // ── Step 2: Prepare body source (clone without header/footer) ─
        const frameEl = rootEl.querySelector('.oak-letterhead-frame') as HTMLElement;
        if (!frameEl) {
          throw new Error('Frame elemen tidak ditemukan.');
        }
        const bodyClone = frameEl.cloneNode(true) as HTMLElement;
        const bh = bodyClone.querySelector('.oak-letterhead-header');
        const bf = bodyClone.querySelector('.oak-letterhead-footer');
        if (bh instanceof HTMLElement) bh.remove();
        if (bf instanceof HTMLElement) bf.remove();

        // Neutralize outer frame presentation on the clone ONLY to avoid
        // double-spacing with html2pdf's own margin options.
        // Live .oak-letterhead-frame in the browser is untouched.
        bodyClone.style.padding = '0';
        bodyClone.style.margin = '0';
        bodyClone.style.border = '0';
        bodyClone.style.borderRadius = '0';
        bodyClone.style.boxShadow = 'none';
        bodyClone.style.minHeight = '0';
        bodyClone.style.maxWidth = 'none';

        // Compute safe margins from actual snapshot heights
        const headerGapMm = 3;
        const footerGapMm = 3;
        const topMargin = (headerHeightMm ?? 25) + headerGapMm;
        const bottomMargin = (footerHeightMm ?? 20) + footerGapMm;

       // ── Step 3: Generate paginated PDF via html2pdf ─────────────
       const html2pdfLib = (html2pdf as any)?.default || html2pdf;
       const worker = html2pdfLib().set({
         margin: [topMargin, 18, bottomMargin, 18] as [number, number, number, number],
         filename,
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
           mode: ['css', 'legacy'],
           avoid: [
             '.oak-letterhead-title',
             '.oak-doc-summary-table',
             '.oak-doc-fin-table tbody tr',
           ],
         },
       }).from(bodyClone);

       // Generate the PDF (no download yet).
       await worker.toPdf();

       // Retrieve the actual jsPDF instance via the official html2pdf API.
       const pdf = await worker.get('pdf') as unknown as import('jspdf').jsPDF;

       // ── Step 4: Overlay canonical header/footer on EVERY page ───
       const pages = pdf.getNumberOfPages();
       const contentWidthMm = 174; // A4 210 − 18 − 18
       const headerY = 0;
       const footerY = 297 - footerGapMm - (footerHeightMm ?? 20);

       for (let i = 1; i <= pages; i++) {
         pdf.setPage(i);

         // Header overlay at top
         if (headerDataUrl && headerHeightMm) {
           pdf.addImage(headerDataUrl, 'PNG', 18, headerY, contentWidthMm, headerHeightMm);
         }

         // Footer overlay at bottom
         if (footerDataUrl && footerHeightMm) {
           pdf.addImage(footerDataUrl, 'PNG', 18, footerY, contentWidthMm, footerHeightMm);
         }
       }

       // Exactly ONE download trigger.
       pdf.save(filename);

     } catch (err: unknown) {
       console.error('[DocumentCenter] Failed to generate PDF:', err);
       const msg = err instanceof Error ? err.message : 'Gagal menghasilkan file PDF.';
       setSavePdfError(msg);
     } finally {
       setIsSavingPdf(false);
     }
   }, [
     printEnabled,
     isSavingPdf,
     kind,
     quotationMode,
     docRes?.bid,
     pickerRow?.bid,
     quotationDraft.reference,
     propertyInfo,
     propertyBranding,
   ]);

  /* ------------------------------------------------------------------ */
  /*  LEFT SIDEBAR                                                      */
  /* ------------------------------------------------------------------ */

  const sidebar = (
    <aside className="document-center-sidebar doc-center-sidebar-fixed min-w-0">

      {/* Top Fixed Header & Control Area (not part of editor scroll) */}
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
                onClick={handleSavePdf}
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
          <div className="document-center-kind-grid">
            <button
              type="button"
              className={`document-center-kind-card ${kind === 'confirmation' ? 'active' : ''}`}
              onClick={() => setKind('confirmation')}
            >
              <span className="document-center-kind-name">Konfirmasi Reservasi</span>
              <span className="document-center-kind-desc">Keterangan menginap &amp; rincian biaya</span>
            </button>
            <button
              type="button"
              className={`document-center-kind-card ${kind === 'quotation' ? 'active' : ''}`}
              onClick={() => setKind('quotation')}
            >
              <span className="document-center-kind-name">Quotation / Penawaran</span>
              <span className="document-center-kind-desc">Penawaran tarif per malam &amp; total</span>
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
      </div>

      {/* Scrollable Editor Body */}
      <div className="doc-center-body-scroll min-w-0 flex-1">
        {/* Reservation selector (Confirmation OR Quotation in reservation mode) */}
        {(kind === 'confirmation' || quotationMode === 'reservation') && (
          <div className="document-center-block">
            <div className="document-center-block-label">Reservasi</div>
            {pickerReservations.length === 0 ? (
              <div className="document-center-no-res">
                {pickerLoading
                  ? 'Memuat daftar reservasi...'
                  : pickerError
                    ? pickerError
                    : 'Belum ada reservasi yang dimuat untuk properti ini.'}
              </div>
            ) : (
              <>
                <input
                  type="text"
                  className="document-center-search"
                  placeholder="Cari BID, nama tamu, atau nomor kamar..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Cari reservasi"
                />
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
                            <span>{r?.bid || '—'}</span>
                            <span>{dates}</span>
                            {r?.room_number ? <span>Kamar {r?.room_number}</span> : null}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Selected reservation summary (uses picker row; detail loads in background) */}
        {(kind === 'confirmation' || quotationMode === 'reservation') && pickerRow ? (
          <div className="document-center-block">
            <div className="document-center-block-label">Ringkasan Reservasi</div>
            <div className="document-center-summary">
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">BID</span>
                <span className="document-center-summary-val">{pickerRow?.bid || '—'}</span>
              </div>
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">Tamu</span>
                <span className="document-center-summary-val">
                  {pickerRow?.guest_name || pickerRow?.booker_name || '—'}
                </span>
              </div>
              <div className="document-center-summary-row">
                <span className="document-center-summary-key">Kamar</span>
                <span className="document-center-summary-val">
                  {pickerRow?.room_type_name || pickerRow?.room_type || '—'}
                  {pickerRow?.room_number ? ` · No. ${pickerRow?.room_number}` : ''}
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
                <span className="document-center-summary-val">{statusLabel(pickerRow?.status)}</span>
              </div>
              {totalLabel ? (
                <div className="document-center-summary-row">
                  <span className="document-center-summary-key">Total</span>
                  <span className="document-center-summary-val">{totalLabel}</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

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
  /*  RIGHT PREVIEW (DOCUMENT-1B.1 Step D: Draft-powered Live Preview)  */
  /* ------------------------------------------------------------------ */

  const preview = (
    <div className="document-center-preview min-w-0">
      <div className="document-center-preview-label">Pratinjau</div>
      <div className="document-center-preview-scroll w-full min-w-0">

        {kind === 'confirmation' ? (
          /* Confirmation mode: requires canonical detail */
          selectedResId == null ? (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Pilih reservasi untuk membuat dokumen.</div>
              <div className="document-center-empty-sub">Gunakan pencarian di panel kiri untuk memilih reservasi.</div>
            </div>
          ) : detailLoading ? (
            <div className="document-center-empty">
              <div className="document-center-empty-text">Memuat detail reservasi...</div>
            </div>
          ) : detailError ? (
            <div className="document-center-empty document-center-empty-error">
              <div className="document-center-empty-text">Detail reservasi tidak dapat dimuat.</div>
              <div className="document-center-empty-sub">{detailError}</div>
            </div>
          ) : docRes ? (
            <div ref={printDocumentRef} className="document-center-printable-wrapper">
              <ReservationConfirmationPrint
                reservation={docRes}
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
          /* Quotation kind: renders draft-powered QuotationPrint */
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
            </div>
          ) : (
            /* Draft-powered live quotation preview (both reservation and manual modes) */
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
            grid-template-columns: clamp(540px, 44%, 620px) minmax(0, 1fr) !important;
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
    </div>
  );
}
