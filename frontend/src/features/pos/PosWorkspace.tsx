import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import GuestPicker from './GuestPicker';
import {buildPosOrderDraft, previewPosDraft, type PosCartLine, type PosDiscountType, type PosPricingPreviewParams} from './posOrderDraft';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import type { PosPayCashOrderContext } from './PosPayCashModal';

export interface PosMenuItem {
  id: number;
  item_code?: string;
  name: string;
  category_name?: string;
  price: number | string;
  is_available?: boolean;
}

export interface PosOrderItem {
  id: number;
  order_number: string;
  reservation_id?: number | null;
  table_number?: string;
  guest_name?: string;
  status: string;
  total_amount: number | string;
  created_at?: string;
  items?: {
    id: number;
    menu_item_id: number;
    name: string;
    quantity: number;
    unit_price: number | string;
    line_total: number | string;
  }[];
}

/**
 * Response shape ACTUAL dari POST /api/pos/orders (handler backend):
 *  - create → 201 { status:'SUCCESS', data: <pos_order> }
 *  - replay → 200 { status:'REPLAY',  data: { ...pos_order, items: [...] } }
 * Order berada LANGSUNG di json.data — bukan json.data.order.
 * items hanya hadir pada path replay; harga adalah milik backend.
 */
interface PosCreateOrderResponse {
  status: string;
  data: {
    id: number;
    property_id: number;
    order_number: string;
    status: string;
    total_amount: number | string;
    table_number?: string | null;
    guest_name?: string | null;
    reservation_id?: number | null;
    created_at?: string | null;
    items?: unknown[];
  };
}

/**
 * Hasil `handleSaveOrder`:
 *  - ok: true  → order tervalidasi + payContext (context pembayaran)
 *  - ok: false → tanpa order/payContext (gagal, ditolak, atau ambiguous)
 */
export type PosSaveOrderResult =
  | { ok: true; order: PosOrderItem; payContext: PosPayCashOrderContext }
  | { ok: false };

interface Props {
  propertyId: number | null;
  posMenu: PosMenuItem[];
  posOrders: PosOrderItem[];
  /** Tampilkan tombol "Buat Order Contoh" (mode halaman penuh, TIDAK untuk modal). */
  onCreateDemoOrder?: () => void | Promise<void>;
  onRefresh?: () => void;
  /** Notifikasi perubahan isi cart ke parent (untuk guard close modal). */
  onCartChange?: (hasItems: boolean) => void;
  /**
   * Notifikasi request in-flight (saving=true saat request berjalan, false
   * saat selesai). Parent (PosModal/App) memakai ref sinkron untuk guard
   * close/pindah konteks. TERPISAH dari `busy` parent: `busy` hanya mengunci
   * mutasi draft, TIDAK memblokir Retry.
   */
  onRequestPending?: (pending: boolean) => void;
  /**
   * Notifikasi status unresolved (snapshot ambigu dipertahankan).
   * Parent memakai ref sinkron untuk guard close/pindah konteks yang
   * akan membuang snapshot. Retry tetap dapat digunakan saat unresolved.
   */
  onUnresolvedChange?: (unresolved: boolean) => void;
  /** Request sedang berjalan di parent — kunci mutasi draft (bukan Retry). */
  busy?: boolean;
  /**
   * Authenticated fetch — jika disediakan, "Simpan Pesanan" akan melakukan
   * POST /api/pos/orders dengan Idempotency-Key. Tanpa ini, tombol tetap
   * menunjukkan demo alert (backward-compatible untuk halaman penuh).
   */
  authFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** reservation_id untuk scope order ke reservasi tertentu */
  reservationId?: number | null;
  /**
   * Identitas reservasi/tamu — ditampilkan di header modal bila scoped.
   */
  reservationLabel?: string;
  /**
   * Nama tamu dari reservasi — inisialisasi field "Nama Tamu" HANYA saat
   * draft baru (cart kosong & snapshot null & tidak pending/unresolved).
   * Tidak menyentuh draft yang sudah ada.
   */
  guestNameInitial?: string | null;
  /**
   * Nomor kamar dari reservasi — ditampilkan sebagai identitas di header
   * POS. TIDAK mengisi field "Nomor Meja" atau payload `table_number`.
   */
  roomNumberInitial?: string | null;
  /** Callback sukses — parent bisa refresh order list dsb. */
  onOrderCreated?: (order: PosOrderItem) => void;
  /** Gate "Simpan Pesanan": hanya true bila user punya izin edit POS. */
  canEditPos?: boolean;
  /** Separate granular pos.discount.edit grant. */
  canDiscountPos?: boolean;
  /**
   * Buka modal pembayaran CASH untuk order yang baru dibuat.
   * Dipanggil setelah create-order sukses dari dalam PosWorkspace
   * (tombol "Bayar" di hasil sukses). `context` berisi data order
   * yang baru dibuat + properti/reservasi aktif.
   */
  onOpenCashPayment?: (ctx: PosPayCashOrderContext) => void;
  /**
   * Tampilkan GuestPicker di mode POS header (tanpa reservation_id scoped).
   * Hanya dirender bila `reservationId === null` dan prop ini `true`.
   * Caller (App) bertanggung jawab memastikan user punya Kalender:view
   * sebelum meneruskan `true`.
   */
  canPickGuest?: boolean;
  /**
   * Signal pembayaran sukses dari App: propertyId + orderId dari settlement
   * terverifikasi. Bila cocok saveResult.order, status lokal diubah PAID dan
   * tombol "Bayar" hilang.
   */
  paidOrderId?: PosOrderPaidSignal | null;
}

/**
 * Pengaturan pricing properti (sumber dari GET /api/pos/pricing-settings).
 * Persentase selalu berasal dari sini — backend adalah pricing authority.
 */
interface PosPricingSettings {
  service_charge_enabled: boolean;
  service_charge_percent: number;
  tax_enabled: boolean;
  tax_percent: number;
}

/** Status muat pricing settings. */
type PricingSettingsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PosPricingSettings };

function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(amount);
}

/** Generate UUID v4 (fallback jika crypto.randomUUID tidak tersedia) */
function generateUUIDv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Manual v4 fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Signal pembayaran sukses dari App (propertyId + orderId dari settlement
 * terverifikasi). PosModal meneruskan ke PosWorkspace; bila cocok dengan
 * order hasil create-session ini, status lokal diubah menjadi PAID.
 */
export interface PosOrderPaidSignal {
  propertyId: number;
  orderId: number;
}

export default function PosWorkspace({
  propertyId,
  posMenu,
  posOrders,
  onCreateDemoOrder,
  onRefresh,
  onCartChange,
  onRequestPending,
  onUnresolvedChange,
  busy = false,
  authFetch,
  reservationId,
  reservationLabel,
  guestNameInitial,
  roomNumberInitial,
  onOrderCreated,
  canEditPos = true,
  canDiscountPos = false,
  canPickGuest = false,
  onOpenCashPayment,
  paidOrderId,
}: Props) {
  const [activeTab, setActiveTab] = useState<'register' | 'orders'>('register');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [cart, setCart] = useState<PosCartLine[]>([]);
  const [tableNumber, setTableNumber] = useState('Table 1');
  const [guestName, setGuestName] = useState('Walk-in Guest');
  const [guestPhone, setGuestPhone] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [orderDiscountType, setOrderDiscountType] = useState<PosDiscountType>('');
  const [orderDiscountInput, setOrderDiscountInput] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  // ── Per-order Service Charge & PBJT toggle state ─────────────────────────
  // Default: mengikuti pengaturan properti (di-set setelah pricing settings
  // dimuat). Bila properti OFF, toggle terlihat abu-abu & disabled.
  // Terkunci saat draftLocked / pending / ambiguous.
  const [svcToggleOn, setSvcToggleOn] = useState<boolean>(false);
  const [taxToggleOn, setTaxToggleOn] = useState<boolean>(false);

  // ── Pricing settings (GET /api/pos/pricing-settings) ─────────────────────
  // Dimuat saat propertyId berubah / draft baru di-reset.
  // status 'error' → jangan asumsikan OFF permanen; cegah submit dengan
  // expected_total yang tidak dapat dipercaya.
  const [pricingSettings, setPricingSettings] = useState<PricingSettingsState>({ status: 'loading' });

  // Ref untuk mencegah stale request bila propertyId berubah cepat.
  const pricingFetchEpochRef = useRef(0);

  // ── GuestPicker state (hanya aktif di mode POS header) ──────────────────
  // pickedGuest: reservasi tamu menginap yang dipilih dari picker.
  // null = pelanggan manual (tanpa reservation_id).
  // TIDAK di-reset oleh pergantian cart (pergantian pilihan tidak menghapus cart).
  // Dihapus hanya saat modal ditutup/dibuka ulang (parent reset state).
  const [pickedGuest, setPickedGuest] = useState<{
    reservation_id: number;
    guest_name: string | null;
    room_number: string | null;
  } | null>(null);
  // GuestPicker hanya tampil di mode header (tanpa reservation scoped)
  // dan bila user punya izin Kalender:view (canPickGuest dari App).
  const showGuestPicker = reservationId === null && canPickGuest && propertyId !== null;

  // ── Save-order state (real API, bukan demo) ─────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string; order?: PosOrderItem } | null>(null);
  // Ambiguous state: hasil request tidak diketahui (network error / timeout /
  // 5xx / respons sukses malformed). Draft + snapshot dipertahankan untuk retry.
  const [ambiguous, setAmbiguous] = useState(false);

  /**
   * Idempotency snapshot — dibuat SEKALI sebelum pengiriman pertama.
   * Retry WAJIB membaca pasangan (key, bodyJson) ini PERSIS — payload tidak
   * pernah di-rebuild dari state UI (state bisa berubah setelah snapshot).
   * cartFingerprint dipakai untuk memblokir submit BAHAN BARU setelah ada
   * snapshot (backend membalas 409 fingerprint mismatch bila key lama dipakai
   * untuk draft berbeda).
   *
   * `unresolved` = pengajuan sudah pernah menghasilkan status ambigu
   * (network/timeout, 5xx, atau respons 200/201 malformed). Selaam
   * unresolved:
   *  - retry WAJIB memakai (key, bodyJson) tersimpan persis — fingerprint
   *    draft TIDAK diperiksa lagi (draft ter-lock, snapshot tetap valid);
   *  - penolakan definitif 4xx TIDAK membuang snapshot, TIDAK membuat key
   *    baru, TIDAK mengurai unresolved — draft tetap terkunci dan alasan
   *    penolakan ditampilkan;
   *  - snapshot baru boleh dibuat hanya setelah draft bersih (cart kosong
   *    pasca-sukses) sehingga siklus pengajuan baru dimulai dari nol.
   */
  const idempotencySnapshotRef = useRef<{
    key: string;
    propertyId: number;
    reservationId: number | null;
    bodyJson: string;
    cartFingerprint: string;
    unresolved: boolean;
  } | null>(null);
  // Ref sinkron untuk guard submit ganda — state `saving` bisa tertinggal satu
  // tick di belakang; ref dicek secara sinkron sebelum request dimulai.
  const submittingRef = useRef(false);

  /**
   * Context identitas pembayaran — SIMPAN SEKALI saat create-order sukses.
   * Dipakai tombol "Bayar": jangan fallback ke pilihan tamu/reservasi
   * yang berubah kemudian (guestName draft, pickedGuest, dsb.).
   * reservation_id null (order umum) TIDAK boleh berubah menjadi reservasi
   * yang baru dipilih setelah order dibuat.
   */
  const payCtxRef = useRef<PosPayCashOrderContext | null>(null);

  /**
   * ID order yang status lokalnya diubah menjadi PAID oleh signal
   * `paidOrderId` (App → PosModal → PosWorkspace). Dibersihkan saat
   * siklus draft baru dimulai (cart diisi lagi setelah sukses).
   */
  const [localPaidOrderId, setLocalPaidOrderId] = useState<number | null>(null);

  // Ref sinkron: orderId yang sudah diterapkan status PAID lokal.
  // Mencegah effect re-menerapkan perubahan saveResult bila paidOrderId
  // prop tetap tidak null antar render (mis. App belum reset setelah tutup
  // modal pembayaran) — satu pembaruan per order, tanpa loop render.
  const appliedPaidOrderIdRef = useRef<number | null>(null);

  // Effect: signal pembayaran dari App — bila cocok saveResult.order
  // (propertyId EKSAK + orderId EKSAK), tandai order lokal sebagai PAID.
  // Hanya berlaku SATU KALI per order (appliedPaidOrderIdRef).
  useEffect(() => {
    if (!paidOrderId) return;
    // Jangan terapkan dua kali untuk order yang sama.
    if (appliedPaidOrderIdRef.current === paidOrderId.orderId) return;

    const sr = saveResult;
    if (
      sr?.ok &&
      sr.order &&
      sr.order.id === paidOrderId.orderId &&
      // propertyId harus cocok EKSAK (null TIDAK diterima sebagai kecocokan)
      propertyId != null &&
      paidOrderId.propertyId === propertyId &&
      // Jangan buat objek saveResult baru bila sudah PAID
      sr.order.status !== 'PAID'
    ) {
      setLocalPaidOrderId(sr.order.id);
      appliedPaidOrderIdRef.current = sr.order.id;
      setSaveResult({
        ok: true,
        message: `Order ${sr.order.order_number} LUNAS (pembayaran terverifikasi).`,
        order: { ...sr.order, status: 'PAID' },
      });
    }
  }, [paidOrderId, saveResult, propertyId]);

  // ── Inisialisasi identitas dari reservasi (hanya saat draft baru) ─────────
  // guestNameInitial mengisi ulang field "Nama Tamu" HANYA saat:
  //   - cart kosong (draft baru, belum ada item)
  //   - snapshot null (tidak ada pengajuan pending/unresolved)
  //   - tidak sedang saving (request tidak in-flight)
  // Nomor kamar & reservation_id TIDAK mengisi field meja/guest; mereka
  // hanya ditampilkan sebagai identitas di header. Jika kondisi di atas
  // tidak terpenuhi, nilai lama dipertahankan agar draft & snapshot tidak
  // berubah.
  useEffect(() => {
    if (guestNameInitial != null && cart.length === 0 && idempotencySnapshotRef.current === null && !saving) {
      setGuestName(guestNameInitial);
    }
  }, [guestNameInitial]);

  // ── Load pricing settings saat propertyId tersedia ─────────────────────────
  // 1. Fetch GET /api/pos/pricing-settings?property_id=<id>.
  // 2. Default svcToggleOn / taxToggleOn mengikuti properti.
  // 3. Bila fetch gagal → status 'error', jangan asumsikan OFF permanen;
  //    cegah submit dengan expected_total (tidak dapat dipercaya).
  // 4. Epoch guard: discard response bila propertyId sudah berubah.
  // fetchPricingSettings dipanggil dari useEffect (propertyId berubah) DAN
  // dari tombol "Muat Ulang" saat pricing status 'error' — logika sama,
  // hanya pemicu berbeda.
  const fetchPricingSettings = useCallback(async (isRefetch = false) => {
    if (propertyId === null) {
      setPricingSettings({ status: 'ready', data: { service_charge_enabled: false, service_charge_percent: 0, tax_enabled: false, tax_percent: 0 } });
      return;
    }
    const epoch = ++pricingFetchEpochRef.current;
    setPricingSettings({ status: 'loading' });
    try {
      const res = await authenticatedFetch(
        `/api/pos/pricing-settings?property_id=${propertyId}`,
      );
      if (epoch !== pricingFetchEpochRef.current) return;
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        setPricingSettings({
          status: 'error',
          message: errJson.message || `Gagal memuat pengaturan pricing (HTTP ${res.status})`,
        });
        return;
      }
      const json = await res.json();
      if (epoch !== pricingFetchEpochRef.current) return;
      const data = json?.data;
      const settings: PosPricingSettings = {
        service_charge_enabled: typeof data?.service_charge_enabled === 'boolean' ? data.service_charge_enabled : false,
        service_charge_percent: Number(data?.service_charge_percent) || 0,
        tax_enabled: typeof data?.tax_enabled === 'boolean' ? data.tax_enabled : false,
        tax_percent: Number(data?.tax_percent) || 0,
      };
      setPricingSettings({ status: 'ready', data: settings });
      // Sinkronkan toggle ke master flag properti:
      // - isRefetch=true (setelah 400 pricing / tombol Muat Ulang) →
      //   SELALU sinkronkan, bahkan saat cart berisi — nilai toggle lama
      //   bisa stale (properti svc/tax ON→OFF di tengah draft aktif).
      // - Initial load (isRefetch=false) → sinkronkan HANYA saat draft kosong.
      const shouldSyncToggles = isRefetch
        ? (!draftLocked && !submittingRef.current && !idempotencySnapshotRef.current?.unresolved)
        : (cart.length === 0 && !idempotencySnapshotRef.current && !saving);
      if (shouldSyncToggles) {
        setSvcToggleOn(settings.service_charge_enabled);
        setTaxToggleOn(settings.tax_enabled);
      }
    } catch (err: unknown) {
      if (epoch !== pricingFetchEpochRef.current) return;
      setPricingSettings({
        status: 'error',
        message: err instanceof Error ? err.message : 'Gagal memuat pengaturan pricing.',
      });
    }
  }, [propertyId, authenticatedFetch]);
  useEffect(() => {
    if (propertyId === null) {
      setPricingSettings({ status: 'ready', data: { service_charge_enabled: false, service_charge_percent: 0, tax_enabled: false, tax_percent: 0 } });
      return;
    }
    if (authFetch) {
      // Initial load (isRefetch=false): toggle hanya sinkron saat draft kosong.
      void fetchPricingSettings(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId]);

  // Draft baru (cart dikosongkan setelah sukses, lalu user mulai memilih lagi)
  // → siklus pengajuan baru: snapshot/ambiguitas lama tidak berlaku lagi.
  // Reset toggle ke default properti saat draft baru dimulai.
  useEffect(() => {
    if (cart.length > 0 && saveResult?.ok) {
      setSaveResult(null);
      setAmbiguous(false);
      idempotencySnapshotRef.current = null;
      if (pricingSettings.status === 'ready') {
        setSvcToggleOn(pricingSettings.data.service_charge_enabled);
        setTaxToggleOn(pricingSettings.data.tax_enabled);
      }
    }
  }, [cart.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notifikasi parent saat isi cart berubah (untuk guard close modal).
  useEffect(() => {
    onCartChange?.(cart.length > 0);
  }, [cart, onCartChange]);

  // Notifikasi request in-flight ke parent (sinkron, dipakai guard close/switch).
  useEffect(() => {
    onRequestPending?.(saving);
  }, [saving, onRequestPending]);

  // Notifikasi status unresolved (snapshot ambigu) ke parent.
  // Parent memakai ref sinkron: saat unresolved, close/property-switch yang
  // membuang snapshot harus dicegah; Retry tetap bisa digunakan.
  useEffect(() => {
    onUnresolvedChange?.(ambiguous);
  }, [ambiguous, onUnresolvedChange]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    posMenu.forEach((m) => {
      if (m.category_name) set.add(m.category_name);
    });
    return Array.from(set);
  }, [posMenu]);

  const filteredMenu = useMemo(() => {
    return posMenu.filter((item) => {
      const matchSearch =
        searchQuery === '' ||
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.item_code && item.item_code.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchCat = selectedCategory === 'ALL' || item.category_name === selectedCategory;
      return matchSearch && matchCat;
    });
  }, [posMenu, searchQuery, selectedCategory]);

  /**
   * Draft terkunci saat request pending (`saving`/`busy`) ATAU hasil ambigu —
   * mutasi item/qty/hapus/meja/nama dilarang agar payload yang di-replay
   * (snapshot) tetap identik dengan draft di layar.
   * `busy` (parent) mengunci mutasi draft tetapi TIDAK memblokir Retry —
   * Retry hanya dicek oleh `saving` (request in-flight sendiri).
   */
  const draftLocked = saving || busy || ambiguous;

  const addToCart = (item: PosMenuItem) => {
    if (draftLocked || submittingRef.current || idempotencySnapshotRef.current?.unresolved) return;
    setCart((prev) => {
      const idx = prev.findIndex((p) => p.item.id === item.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [...prev, { item, qty: 1 }];
    });
  };

  const removeFromCart = (itemId: number) => {
    if (draftLocked || submittingRef.current || idempotencySnapshotRef.current?.unresolved) return;
    setCart((prev) => prev.filter((p) => p.item.id !== itemId));
  };

  const updateCartQty = (itemId: number, delta: number) => {
    if (draftLocked || submittingRef.current || idempotencySnapshotRef.current?.unresolved) return;
    setCart((prev) => {
      return prev
        .map((p) => {
          if (p.item.id === itemId) {
            const newQty = p.qty + delta;
            return newQty > 0 ? { ...p, qty: newQty } : null;
          }
          return p;
        })
        .filter(Boolean) as PosCartLine[];
    });
  };

  const draftPreview = useMemo(() => {
    // Harga & persen selalu diambil dari pengaturan properti (backend authority).
    // Toggle svc/tax di draft menentukan apakah svc/tax diaktifkan untuk pesanan ini.
    const pricing: PosPricingPreviewParams = {
      serviceChargeEnabled: svcToggleOn,
      serviceChargePercent: pricingSettings.status === 'ready' ? pricingSettings.data.service_charge_percent : 0,
      taxEnabled: taxToggleOn,
      taxPercent: pricingSettings.status === 'ready' ? pricingSettings.data.tax_percent : 0,
    };
    try {
      return { value: previewPosDraft(cart, orderDiscountType, orderDiscountInput, pricing), error: null };
    } catch (err) {
      return { value: null, error: err instanceof Error ? err.message : 'Periksa diskon pesanan.' };
    }
  }, [cart, orderDiscountType, orderDiscountInput, svcToggleOn, taxToggleOn, pricingSettings]);
  const cartSubtotal = draftPreview.value?.gross || 0;
  const hasDiscount = !!orderDiscountType || cart.some(line => !!line.discountType);
  // ── Guard pricing: blokir submit bila pricing settings belum ready ───────
  //  - 'loading'  → persentase belum diketahui; expected_total tidak valid.
  //  - 'error'    → konfigurasi tidak dapat dipercaya; submit tanpa expected_total
  //                  menghasilkan order dengan total yang kasir tidak ketahui.
  //  - 'ready'    → submit diizinkan.
  // Jika propertyId === null (tanpa API/properti) → pricingSettings default
  // dibuat 'ready' dengan semua flag OFF (backward compat), submit tetap valid.
  const pricingSettingsBlocked =
    propertyId !== null && authFetch !== undefined &&
    pricingSettings.status !== 'ready';
  const canSaveDraft =
    !draftPreview.error &&
    (!hasDiscount || canDiscountPos) &&
    !pricingSettingsBlocked;
  const changeLine = (id: number, patch: Partial<Pick<PosCartLine, 'discountType' | 'discountInput' | 'notes'>>) => {
    if (draftLocked || submittingRef.current || idempotencySnapshotRef.current?.unresolved) return;
    setCart(lines => lines.map(line => line.item.id === id ? {...line, ...patch} : line));
  };
  const canMutateDraft = () => !draftLocked && !submittingRef.current && !idempotencySnapshotRef.current?.unresolved;

  const totalOrdersAmount = useMemo(() => {
    return posOrders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
  }, [posOrders]);

  // ── Simpan Pesanan (real API) ──────────────────────────────────────────────
  // Strategi:
  //  1. Draft tanpa snapshot (atau draft berbeda dari snapshot) → bangun
  //     payload, buat UUID key baru, SIMPAN snapshot (key + body terseri +
  //     fingerprint draft) SEBELUM request pertama.
  //  2. Draft sama dengan snapshot → replay snapshot PERSIS (key & body
  //     tidak pernah di-rebuild dari state).
  //  3. Draft berubah sejak snapshot → snapshot lama tidak terpakai
  //     (menghindari 409 fingerprint mismatch) → jalur 1 dengan key baru.
  // Hasil:
  //  - 200/201 + json.data valid → sukses: reset cart, snapshot, key, ambigu.
  //  - 200/201 + json.data MALFORMED → AMBIGU: draft & snapshot TIDAK
  //     dikosongkan — hasil belum pasti.
  //  - Ditolak definitif (4xx) → snapshot dibuang; status ambigu dari
  //     pengajuan sebelumnya TIDAK dihapus oleh penolakan definitif.
  //  - Network error / 5xx → AMBIGU: snapshot & draft dipertahankan.
  const handleSaveOrder = useCallback(async (): Promise<PosSaveOrderResult> => {
    if (submittingRef.current || busy || cart.length === 0 || propertyId === null) return { ok: false };
    // Gate permission diperiksa SEBELUM apapun — termasuk retry:
    // penolakan permission tidak boleh membangun payload baru, tidak boleh
    // menyentuh snapshot, dan tidak boleh mengubah status unresolved.
    if (!canEditPos) {
      setSaveResult({
        ok: false,
        message: 'Anda tidak memiliki izin untuk membuat order POS.',
      });
      return { ok: false };
    }
    if (!authFetch) return { ok: false }; // fallback: no API — should not reach here in modal context
    // Gate pricing: submit (order baru) diblokir saat pricing settings belum
    // 'ready' (loading/error) — expected_total tidak dapat dipercaya.
    // Retry snapshot unresolved TIDAK diblokir: payload & key sudah terkunci
    // sebelum pricing error, hasil pengajuan sebelumnya yang belum diketahui
    // tetap harus bisa di-replay.
    if (pricingSettingsBlocked && !idempotencySnapshotRef.current?.unresolved) {
      setSaveResult({
        ok: false,
        message:
          'Pengaturan pricing properti belum siap — submit diblokir. ' +
          'Muat ulang pengaturan pricing lalu simpan ulang.',
      });
      return { ok: false };
    }
    const snapshot = idempotencySnapshotRef.current;
    const effectiveResId = reservationId ?? pickedGuest?.reservation_id ?? null;
    let key: string, bodyJson: string;
    if (snapshot?.unresolved) {
      if (snapshot.propertyId !== propertyId || snapshot.reservationId !== effectiveResId) {
        setSaveResult({ok: false, message: 'Konteks pesanan berubah. Selesaikan pengajuan sebelumnya yang hasilnya belum diketahui.'});
        return {ok: false};
      }
      key = snapshot.key;
      bodyJson = snapshot.bodyJson;
    } else {
      try {
        const estimatedTotal = draftPreview.value?.total;
        // ── State efektif toggle: sinkronkan dengan properti ──────────────────
        // Jika properti OFF, payload WAJIB mengirim false eksplisit — bukan
        // nilai stale dari svcToggleOn/taxToggleOn yang mungkin masih true
        // dari siklus sebelumnya (mis. admin mengubah setting ON→OFF tanpa
        // re-fetch otomatis). Draft terkunci (unresolved) → snapshot dipertahankan,
        // branch ini hanya berjalan di draft baru (snapshot?.unresolved === false).
        const psSvcOn = pricingSettings.status === 'ready' ? pricingSettings.data.service_charge_enabled : false;
        const psTaxOn = pricingSettings.status === 'ready' ? pricingSettings.data.tax_enabled : false;
        const effectiveSvcToggle = svcToggleOn && psSvcOn;
        const effectiveTaxToggle = taxToggleOn && psTaxOn;
        const payload = buildPosOrderDraft(cart, {
          propertyId, reservationId: effectiveResId, tableNumber,
          guestName: pickedGuest ? pickedGuest.guest_name || '' : guestName,
          guestPhone, notes: orderNotes, discountType: orderDiscountType,
          discountInput: orderDiscountInput, discountReason,
          // Per-order override — kirim eksplisit (klien baru WAJIB true/false).
          // effectiveSvc/effectiveTax menjamin: jika properti OFF → false,
          // sehingga backend tidak akan menerima true saat properti OFF.
          serviceChargeEnabled: effectiveSvcToggle,
          taxEnabled: effectiveTaxToggle,
          // expected_total: nominal yang ditampilkan kasir.
          // Hanya dikirim bila pricing settings sudah siap (persentase dapat dipercaya).
          expectedTotal: pricingSettings.status === 'ready' && estimatedTotal !== undefined
            ? estimatedTotal
            : undefined,
        }, canDiscountPos);
        bodyJson = JSON.stringify(payload);
        const fp = bodyJson;
        key = snapshot?.cartFingerprint === fp ? snapshot.key : generateUUIDv4();
        idempotencySnapshotRef.current = {key, propertyId, reservationId: effectiveResId, bodyJson, cartFingerprint: fp, unresolved: false};
      } catch (err) {
        setSaveResult({ok: false, message: err instanceof Error ? err.message : 'Periksa data pesanan.'});
        return {ok: false};
      }
    }
    // Input validation is complete before publishing pending; failures cannot strand the close guard.
    submittingRef.current = true;
    setSaving(true);
    onRequestPending?.(true);

    try {
      const res = await authFetch('/api/pos/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: bodyJson,
      });

      if (res.status === 200 || res.status === 201) {
        // Sukses — order ada LANGSUNG di json.data (bukan data.order):
        // create → 201 { status:'SUCCESS', data: <order row> }
        // replay → 200 { status:'REPLAY', data: {...row, items} }
        const json = (await res.json().catch(() => null)) as PosCreateOrderResponse | null;
        const raw = json?.data;
        const totalValue = raw && (raw.total_amount !== undefined && raw.total_amount !== null)
          ? Number(raw.total_amount)
          : NaN;
        // Validasi sukses: id integer positif; order_number/status string
        // tidak kosong setelah trim; total hadir, finite, dan >= 0.
        const valid =
          raw !== null &&
          typeof raw === 'object' &&
          ((res.status === 201 && json?.status === 'SUCCESS') || (res.status === 200 && json?.status === 'REPLAY')) &&
          raw.property_id === propertyId &&
          (raw.reservation_id ?? null) === effectiveResId &&
          Number.isInteger(Number(raw.id)) &&
          Number(raw.id) > 0 &&
          typeof raw.order_number === 'string' &&
          raw.order_number.trim().length > 0 &&
          typeof raw.status === 'string' &&
          raw.status.trim().length > 0 &&
          Number.isFinite(totalValue) &&
          totalValue >= 0;

        if (valid) {
          const createdOrder: PosOrderItem = {
            id: Number(raw!.id),
            order_number: raw!.order_number,
            reservation_id: (typeof raw!.reservation_id === 'number' && raw!.reservation_id > 0) ? raw!.reservation_id : null,
            status: raw!.status,
            total_amount: raw!.total_amount,
            table_number: typeof raw!.table_number === 'string' ? raw!.table_number : undefined,
            guest_name: typeof raw!.guest_name === 'string' ? raw!.guest_name : undefined,
            created_at: typeof raw!.created_at === 'string' ? raw!.created_at : undefined,
            items: Array.isArray(raw!.items) ? (raw!.items as PosOrderItem['items']) : undefined,
          };
          setSaveResult({
            ok: true,
            message: `Order ${createdOrder.order_number} tersimpan (${createdOrder.status}).`,
            order: createdOrder,
          });
          // Bangun context identitas pembayaran dari data order tervalidasi
          // (bukan dari React state/ref yang baru di-set).
          // Context disimpan ke payCtxRef hanya bila belum ada untuk order ini
          // (idempotent: retry replay menghasilkan order sama, context milik
          // pengajuan pertama dipertahankan).
          const effResId = reservationId ?? pickedGuest?.reservation_id ?? null;
          // Kamar tamu terpilih HARUS cocok reservasi order:
          //  - scoped mode → roomNumberInitial (prop dari reservasi)
          //  - header mode + pickedGuest → room_number dari reservasi picked
          //  - pelanggan umum (resId null) → null, jangan fallback
          const effRoomNo =
            effResId != null
              ? (reservationId != null ? roomNumberInitial : pickedGuest?.room_number) ?? null
              : null;
          const effGuestName =
            createdOrder.guest_name ??
            (effResId != null
              ? (reservationId != null ? guestNameInitial : pickedGuest?.guest_name) ?? null
              : null);
          const payContext: PosPayCashOrderContext =
            (!payCtxRef.current || payCtxRef.current.orderId !== createdOrder.id)
              ? {
                  orderId: createdOrder.id,
                  propertyId: propertyId!,
                  orderNumber: createdOrder.order_number,
                  totalAmount: createdOrder.total_amount,
                  guestName: effGuestName,
                  roomNumber: effRoomNo,
                  reservationId: effResId,
                }
              : payCtxRef.current;
          payCtxRef.current = payContext;
          // Sukses nyata: reset draft + snapshot + key + ambigu.
          // Notifikasi unresolved=false LANGSUNG (sinkron, bukan menunggu
          // useEffect) — hanya dipanggil SETELAH sukses terverifikasi.
          onUnresolvedChange?.(false);
          setCart([]);
          setGuestPhone(''); setOrderNotes(''); setOrderDiscountType('');
          setOrderDiscountInput(''); setDiscountReason('');
          setAmbiguous(false);
          setLocalPaidOrderId(null);
          appliedPaidOrderIdRef.current = null;
          idempotencySnapshotRef.current = null;
          // Reset toggle svc/tax ke default properti (bukan ke OFF paksa)
          // agar draft baru mengikuti pengaturan properti saat ini.
          // TIDAK memanggil setSvcToggleOn/setTaxToggleOn dari dalam updater
          // setPricingSettings (anti-pattern: React tidak menjamin updater
          // dipanggil, dan side-effect di dalam updater dilarang).
          // pricingSettings dari closure adalah state terkini di titik ini.
          if (pricingSettings.status === 'ready') {
            setSvcToggleOn(pricingSettings.data.service_charge_enabled);
            setTaxToggleOn(pricingSettings.data.tax_enabled);
          }
          // Refresh/callback pasca-sukses TIDAK boleh mengubah hasil:
          // order sudah tervalidasi dari respons POST — kegagalan callback
          // (atau pemanggilan apa pun setelahnya) tidak membuat order jadi
          // ambigu dan tidak memicu submit ulang.
          try {
            onOrderCreated?.(createdOrder);
            onRefresh?.();
          } catch (cbErr) {
            console.error('[PosWorkspace] post-success callback failed (order tetap tersimpan):', cbErr);
          }
          return { ok: true, order: createdOrder, payContext };
        } else {
          // Respons sukses tapi shape MALFORMED → hasil belum diketahui.
          // Snapshot ditandai unresolved: draft, key, dan body dipertahankan
          // penuh — retry berikutnya memakai snapshot tersimpan PERSIS.
          if (idempotencySnapshotRef.current) {
            idempotencySnapshotRef.current.unresolved = true;
          }
          // Notifikasi unresolved LANGSUNG (sinkron, bukan menunggu useEffect) —
          // parent aktifkan guard close/switch sebelum pending dilepas di finally.
          onUnresolvedChange?.(true);
          setAmbiguous(true);
          setSaveResult({
            ok: false,
            message:
              'Server membalas sukses tetapi data order tidak lengkap. Hasil belum diketahui — draft dan idempotency key dipertahankan. Gunakan "Coba Lagi" untuk memverifikasi.',
          });
          return { ok: false };
        }
      } else if (res.status === 409) {
        const errData: any = await res.json().catch(() => ({}));
        // ── PRICING_TOTAL_CHANGED: properti di-ubah di tengah, total tidak cocok ─
        // Ditolak definitif oleh backend (bukan ambigu): order TIDAK dibuat.
        // - Bila snapshot unresolved/ambiguous (hasil pengajuan sebelumnya
        //   belum diketahui), JANGAN buang snapshot — idempotency key, payload
        //   asli, dan status locked dipertahankan penuh; kasir tidak boleh
        //   membuat key baru sebelum hasil pengajuan sebelumnya dipastikan
        //   (retry memakai snapshot tersimpan via "Coba Lagi").
        // - Bila snapshot tidak unresolved, kasir boleh memperbarui estimasi
        //   lalu submit ulang dengan key baru setelah snapshot dibuang.
        if (errData.code === 'PRICING_TOTAL_CHANGED' && errData.data?.computed_total !== undefined) {
          const computed = Number(errData.data.computed_total);
          const svcPct = Number(errData.data.service_charge_percent) || 0;
          const taxPct = Number(errData.data.tax_percent) || 0;
          const unresolvedNow = idempotencySnapshotRef.current?.unresolved === true;
          setSaveResult({
            ok: false,
            message:
              'Total order berubah: pengaturan properti mungkin telah diperbarui. ' +
              `Estimasi Anda ${formatIDR(Number(errData.data.expected_total) || 0)}, total server ${formatIDR(computed)}. ` +
              `Service ${svcPct}%, PBJT ${taxPct}%. ` +
              (unresolvedNow
                ? 'Pengajuan sebelumnya belum selesai — hasil belum diketahui, draft tetap terkunci; gunakan "Coba Lagi".'
                : 'Periksa kembali dan simpan ulang.'),
          });
          // Update local pricing state + buang snapshot HANYA bila snapshot
          // tidak unresolved. Bila unresolved, persentase & draft dikunci
          // penuh — tidak boleh berubah sebelum pengajuan sebelumnya selesai.
          if (!unresolvedNow) {
            setPricingSettings(prev => {
              if (prev.status !== 'ready') return prev;
              return {
                status: 'ready',
                data: {
                  ...prev.data,
                  service_charge_percent: typeof errData.data.service_charge_percent === 'number' ? errData.data.service_charge_percent : prev.data.service_charge_percent,
                  tax_percent: typeof errData.data.tax_percent === 'number' ? errData.data.tax_percent : prev.data.tax_percent,
                },
              };
            });
            idempotencySnapshotRef.current = null;
          }
          return { ok: false };
        }
        // ── 409 lain: idempotency key conflict (fingerprint mismatch) ────────
        const unresolvedNow = idempotencySnapshotRef.current?.unresolved === true;
        setSaveResult({
          ok: false,
          message:
            errData.message ||
            (unresolvedNow
              ? 'Idempotency key masih terpakai untuk pengajuan belum terselesaikan — hasil sebelumnya belum diketahui. Draft tetap terkunci; gunakan "Coba Lagi".'
              : 'Konflik: idempotency key sudah dipakai untuk payload berbeda.'),
        });
        if (!unresolvedNow) {
          idempotencySnapshotRef.current = null;
        }
        return { ok: false };
      } else if (res.status === 400 || res.status === 422) {
        const errData: any = await res.json().catch(() => ({}));
        const unresolvedNow = idempotencySnapshotRef.current?.unresolved === true;
        // ── Penolakan pricing spesifik: properti di-OFF-kan saat draft aktif ─
        // Tampilkan alasan jelas, refresh pricing settings agar persentase &
        // flag lokal sinkron, buang snapshot (ditolak definitif — bukan
        // ambigu), pertahankan cart & diskon. Kasir dapat memperbaiki toggle
        // dan submit ulang dengan key baru setelah re-fetch selesai.
        const isPricing400 =
          errData.code === 'SERVICE_CHARGE_NOT_ENABLED_AT_PROPERTY' ||
          errData.code === 'TAX_NOT_ENABLED_AT_PROPERTY';
        if (isPricing400 && !unresolvedNow) {
          setSaveResult({
            ok: false,
            message:
              errData.message ||
              'Pengaturan pricing properti telah berubah. ' +
              'Periksa toggle Service Charge/PBJT lalu simpan ulang.',
          });
          // Re-fetch pricing settings (isRefetch=true):
          // - Set status 'loading' dulu → blokir Simpan/Bayar selama re-fetch.
          // - Sukses: sinkronkan master flag, persentase & toggle ke nilai
          //   properti terbaru (bahkan saat cart berisi — toggle lama bisa stale).
          // - Gagal: status 'error' → submit tetap diblokir; kasir bisa klik
          //   "Muat Ulang" untuk retry manual setelah jaringan pulih.
          // - Epoch guard: respons diabaikan bila propertyId sudah berubah.
          // - Cart, diskon, dan input kasir TIDAK disentuh — tetap tersimpan.
          // - TIDAK ada submit otomatis — kasir memajukan ulang secara manual.
          void fetchPricingSettings(true);
          idempotencySnapshotRef.current = null;
          return { ok: false };
        }
        setSaveResult({
          ok: false,
          message:
            errData.message ||
            (unresolvedNow
              ? 'Permintaan ditolak (HTTP ' + res.status + '), tetapi pengajuan sebelumnya masih belum terselesaikan — hasil belum diketahui. Draft tetap terkunci; gunakan "Coba Lagi".'
              : 'Data order tidak valid. Periksa kembali.'),
        });
        if (!unresolvedNow) {
          idempotencySnapshotRef.current = null;
        }
        return { ok: false };
      } else if (res.status === 401 || res.status === 403) {
        const errData: any = await res.json().catch(() => ({}));
        const unresolvedNow = idempotencySnapshotRef.current?.unresolved === true;
        setSaveResult({
          ok: false,
          message:
            errData.message ||
            (unresolvedNow
              ? 'Akses ditolak (HTTP ' + res.status + '), tetapi pengajuan sebelumnya masih belum terselesaikan — hasil belum diketahui. Draft tetap terkunci; gunakan "Coba Lagi".'
              : 'Anda tidak memiliki akses untuk membuat order POS.'),
        });
        if (!unresolvedNow) {
          idempotencySnapshotRef.current = null;
        }
        return { ok: false };
      } else if (res.status >= 500) {
        // 5xx → hasil tak pasti (order mungkin sudah commit di server).
        // Snapshot ditandai unresolved & draft DIPERTAHANKAN.
        const errData: any = await res.json().catch(() => ({}));
        if (idempotencySnapshotRef.current) {
          idempotencySnapshotRef.current.unresolved = true;
        }
        // Notifikasi unresolved LANGSUNG — guard close/switch aktif sebelum
        // pending dilepas di finally.
        onUnresolvedChange?.(true);
        setAmbiguous(true);
        setSaveResult({
          ok: false,
          message:
            `${errData.message || `Server error (HTTP ${res.status}).`} ` +
            'Hasil penyimpanan belum diketahui — draft dan idempotency key dipertahankan. Gunakan "Coba Lagi".',
        });
        return { ok: false };
      } else {
        // 4xx lain (mis. 404 menu/meja tidak ditemukan) → ditolak definitif.
        const errData: any = await res.json().catch(() => ({}));
        const unresolvedNow = idempotencySnapshotRef.current?.unresolved === true;
        setSaveResult({
          ok: false,
          message:
            errData.message ||
            (unresolvedNow
              ? 'Permintaan ditolak (HTTP ' + res.status + '), tetapi pengajuan sebelumnya masih belum terselesaikan — hasil belum diketahui. Draft tetap terkunci; gunakan "Coba Lagi".'
              : `Gagal menyimpan order (HTTP ${res.status}).`),
        });
        if (!unresolvedNow) {
          idempotencySnapshotRef.current = null;
        }
        return { ok: false };
      }
    } catch (networkErr) {
      // Network error / timeout / abort → hasil tak diketahui.
      // Snapshot ditandai unresolved; draft + (key, body) dipertahankan
      // penuh agar retry memakai payload yang persis sama.
      if (idempotencySnapshotRef.current) {
        idempotencySnapshotRef.current.unresolved = true;
      }
      // Notifikasi unresolved LANGSUNG — guard close/switch aktif sebelum
      // pending dilepas di finally.
      onUnresolvedChange?.(true);
      setAmbiguous(true);
      setSaveResult({
        ok: false,
        message:
          'Hasil penyimpanan belum diketahui. Draft dan idempotency key dipertahankan — gunakan "Coba Lagi" untuk retry.',
      });
      console.error('[PosWorkspace] network/timeout on save order:', networkErr);
      return { ok: false };
    } finally {
      submittingRef.current = false;
      setSaving(false);
      // Lepaskan pending LANGSUNG di tick yang sama (sinkron) — parent (App)
      // memakai ref, jadi guard close/switch terbebas tepat saat request selesai.
      // (useEffect pada `saving` tetap ada sebagai sinkronisasi cadangan.)
      onRequestPending?.(false);
    }
  }, [busy, cart, propertyId, tableNumber, guestName, reservationId, pickedGuest, authFetch, onOrderCreated, onRefresh, canEditPos, canDiscountPos, guestPhone, orderNotes, orderDiscountType, orderDiscountInput, discountReason, svcToggleOn, taxToggleOn, pricingSettings, draftPreview]);

  // Retry handler: membaca snapshot (key + body terseri) PERSIS.
  // handleSaveOrder otomatis memilih snapshot bila fingerprint draft cocok;
  // draft yang berubah membuat snapshot lama tidak terpakai dan key baru dibuat.
  const handleRetrySave = useCallback(() => {
    void handleSaveOrder();
  }, [handleSaveOrder]);

  /**
   * "Bayar" — kombinasi: simpan order, lalu (hanya bila sukses
   * dan order masih OPEN) segera buka modal pembayaran CASH dari dalam
   * PosWorkspace.
   *
   * Alur:
   *  1. `handleSaveOrder()` → POST /api/pos/orders dengan idempotency key.
   *     Mengembalikan `PosSaveOrderResult` — hasil sukses membawa
   *     order tervalidasi + context pembayaran; hasil gagal tidak
   *     membawa context.
   *  2. Sukses + order.status === 'OPEN' → `onOpenCashPayment(payContext)`
   *     → App membuka PosPayCashModal.
   *  3. Sukses + order.status === 'PAID' (replay order sudah dibayar)
   *     → tampilkan indikator "sudah dibayar", TIDAK buka modal.
   *  4. Status terminal lainnya (VOIDED, CANCELLED, dsb.) → TIDAK buka modal.
   *  5. Gagal (4xx, 5xx, network) → modal pembayaran TIDAK dibuka.
   *     Draft tetap ada untuk retry.
   */
  const handleSaveAndPay = useCallback(async () => {
    const result = await handleSaveOrder();
    if (!result.ok) return;

    if (result.order.status === 'OPEN') {
      if (onOpenCashPayment) {
        onOpenCashPayment(result.payContext);
      }
    } else if (result.order.status === 'PAID') {
      // Replay: order sudah dibayar sebelumnya. Tampilkan status,
      // jangan buka modal pembayaran.
      setSaveResult({
        ok: true,
        message: `Order ${result.order.order_number} sudah dibayar (PAID).`,
        order: result.order,
      });
      setLocalPaidOrderId(result.order.id);
      appliedPaidOrderIdRef.current = result.order.id;
    }
    // Status terminal lainnya (VOIDED, CANCELLED, dsb.) → tidak ada aksi
    // pembayaran; saveResult sudah menampilkan status order dari
    // handleSaveOrder.
  }, [handleSaveOrder, onOpenCashPayment]);

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-2xl border border-gray-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold tracking-wider bg-purple-50 text-purple-800 border border-purple-200/60 uppercase">
              Departemen Operasional POS
            </span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs text-gray-500">Property #{propertyId || 1}</span>
          </div>

          {/* Konteks reservasi — hanya tampil bila POS dibuka dari reservasi */}
          {reservationId != null && (
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                {reservationLabel || `Reservasi #${reservationId}`}
              </span>
              {guestNameInitial && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-stone-50 text-stone-700 border border-stone-200">
                  Tamu: {guestNameInitial}
                </span>
              )}
              {roomNumberInitial && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 text-sky-800 border border-sky-200">
                  Kamar {roomNumberInitial}
                </span>
              )}
            </div>
          )}

          <h1 className="text-2xl font-black text-gray-900 tracking-tight">Point of Sale (POS) &amp; F&amp;B</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Workspace operasional kasir restoran, pesanan meja tamu hotel, dan penjualan langsung.
          </p>
        </div>

          <div className="flex items-center gap-2">
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={busy}
                className="p-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Refresh Data"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}
            {/* Tombol demo order hanya muncul bila parent menyediakan aksi (halaman penuh).
                Di modal, onCreateDemoOrder tidak diteruskan → tidak menghasilkan transaksi nyata. */}
            {onCreateDemoOrder && !busy && (
              <button
                type="button"
                onClick={onCreateDemoOrder}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs sm:text-sm font-semibold shadow-xs transition-colors cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                [Demo] Buat Order Contoh
              </button>
            )}
          </div>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Menu Aktif</div>
          <div className="text-2xl font-black text-gray-900 mt-1">{posMenu.length}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Item makanan &amp; minuman</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Total Pesanan</div>
          <div className="text-2xl font-black text-purple-700 mt-1">{posOrders.length}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Order tercatat</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xs">
          <div className="text-xs text-gray-500 font-medium">Total Transaksi POS</div>
          <div className="text-2xl font-black text-emerald-700 mt-1">{formatIDR(totalOrdersAmount)}</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Akumulasi penjualan</div>
        </div>
      </div>

      {/* View Selector Tabs */}
      <div className="flex gap-2 border-b border-gray-200 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab('register')}
          className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
            activeTab === 'register'
              ? 'bg-purple-900 text-white shadow-xs'
              : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
          }`}
        >
          Kasir &amp; Menu POS
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('orders')}
          className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
            activeTab === 'orders'
              ? 'bg-purple-900 text-white shadow-xs'
              : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
          }`}
        >
          Riwayat Order ({posOrders.length})
        </button>
      </div>

      {activeTab === 'register' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Menu Picker (2 cols) */}
          <div className="lg:col-span-2 space-y-4">
            {/* Search & Category Filter */}
            <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-xs space-y-3">
              <div className="relative">
                <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Cari menu F&B..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-gray-50 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:outline-hidden"
                />
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setSelectedCategory('ALL')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer ${
                    selectedCategory === 'ALL'
                      ? 'bg-purple-800 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  Semua
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer ${
                      selectedCategory === cat
                        ? 'bg-purple-800 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Menu Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {filteredMenu.map((item) => (
                <div
                  key={item.id}
                  onClick={() => addToCart(item)}
                  className={`bg-white border border-gray-200 hover:border-purple-300 hover:shadow-md rounded-xl p-3 flex flex-col justify-between transition-all group ${
                    draftLocked ? 'opacity-50 pointer-events-none' : 'cursor-pointer'
                  }`}
                >
                  <div>
                    <span className="text-[10px] font-semibold text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">
                      {item.category_name || 'F&B'}
                    </span>
                    <h4 className="font-bold text-xs sm:text-sm text-gray-900 mt-1.5 group-hover:text-purple-900 transition-colors">
                      {item.name}
                    </h4>
                    {item.item_code && (
                      <div className="text-[10px] text-gray-400 font-mono mt-0.5">{item.item_code}</div>
                    )}
                  </div>
                  <div className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-between">
                    <span className="font-extrabold text-xs sm:text-sm text-gray-900">
                      {formatIDR(Number(item.price))}
                    </span>
                    <button
                      type="button"
                      className="p-1 rounded-lg bg-gray-100 group-hover:bg-purple-100 text-gray-600 group-hover:text-purple-800 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Cart / Order Slip (1 col) */}
          <div className="bg-white border border-gray-200 rounded-2xl p-4 shadow-xs flex flex-col justify-between h-fit space-y-4">
            <div>
              <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                <h3 className="font-bold text-sm text-gray-900">Slip Pesanan</h3>
                <span className="text-xs bg-purple-50 text-purple-700 font-semibold px-2 py-0.5 rounded-full">
                  {cart.reduce((c, l) => c + l.qty, 0)} Items
                </span>
              </div>

              {/* Table & Guest Form — terkunci saat pending/ambigu agar
                   payload replay tetap identik dengan snapshot */}
              <div className={`my-3 space-y-2 ${draftLocked ? 'opacity-60' : ''}`}>
                {/* ── Mode POS header: pilih tamu menginap ATAU pelanggan manual ── */}
                {showGuestPicker && !pickedGuest && (
                  <div>
                    <label className="text-[10px] uppercase font-bold text-gray-500 block mb-1">Tamu</label>
                    <GuestPicker
                      propertyId={propertyId!}
                      authFetch={authFetch}
                      disabled={draftLocked}
                      onGuestSelected={(g) => {
                        // Guard: jangan ubah pickedGuest/nama/konteks saat
                        // draft ter-lock atau request sedang in-flight.
                        if (draftLocked || submittingRef.current) return;
                        setPickedGuest(g);
                        setGuestPhone('');
                        // Set guest_name dari reservasi — hanya bila draft masih kosong
                        // (tidak menyentuh draft yang sudah ada).
                        if (cart.length === 0 && idempotencySnapshotRef.current === null && !saving) {
                          setGuestName(g.guest_name || 'Walk-in Guest');
                        }
                      }}
                    />
                  </div>
                )}

                {/* ── Tamu reservasi dipilih: identitas read-only ── */}
                {showGuestPicker && pickedGuest && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase font-bold text-gray-500">Tamu Terhubung</span>
                      <button
                        type="button"
                        onClick={() => {if (canMutateDraft()) {setPickedGuest(null); setGuestPhone('');}}}
                        disabled={draftLocked}
                        className="text-[10px] text-gray-400 hover:text-gray-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Hapus
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 text-sky-800 border border-sky-200">
                        Kamar {pickedGuest.room_number || '-'}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-stone-50 text-stone-700 border border-stone-200">
                        {pickedGuest.guest_name || 'Tamu'}
                      </span>
                      {pickedGuest.reservation_id && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-50 text-purple-800 border border-purple-200">
                          Res #{String(pickedGuest.reservation_id)}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Form input: Nomor Meja (hanya saat pelanggan manual) + Nama Tamu ── */}
                <div className="grid grid-cols-2 gap-2">
                  {/* Nomor Meja (manual) ATAU Kamar readonly (reservasi scoped/header) */}
                  {reservationId != null ? (
                    // Dari reservasi asal (scoped): Kamar readonly memakai roomNumberInitial
                    <div>
                      <label className="text-[10px] uppercase font-bold text-gray-500">Kamar</label>
                      <input
                        type="text"
                        value={roomNumberInitial ?? ''}
                        readOnly
                        disabled
                        className="w-full text-xs bg-gray-100 border border-gray-200 rounded-lg p-1.5 mt-0.5 text-gray-500 cursor-not-allowed"
                      />
                    </div>
                  ) : showGuestPicker && pickedGuest ? (
                    // Dari header dengan tamu terpilih: Kamar readonly memakai pickedGuest.room_number
                    <div>
                      <label className="text-[10px] uppercase font-bold text-gray-500">Kamar</label>
                      <input
                        type="text"
                        value={pickedGuest.room_number || ''}
                        readOnly
                        disabled
                        className="w-full text-xs bg-gray-100 border border-gray-200 rounded-lg p-1.5 mt-0.5 text-gray-500 cursor-not-allowed"
                      />
                    </div>
                  ) : (
                    // Pelanggan manual: Nomor Meja editable
                    <div>
                      <label className="text-[10px] uppercase font-bold text-gray-500">Nomor Meja</label>
                      <input
                        type="text"
                        value={tableNumber}
                        onChange={(e) => {if (canMutateDraft()) setTableNumber(e.target.value);}}
                        disabled={draftLocked}
                        className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg p-1.5 mt-0.5"
                      />
                    </div>
                  )}
                  {/* Nama Tamu — read-only bila reservasi terhubung (header/scoped),
                      input biasa bila pelanggan manual */}
                  {(showGuestPicker && pickedGuest) || reservationId != null ? (
                    <div>
                      <label className="text-[10px] uppercase font-bold text-gray-500">Nama Tamu</label>
                      <input
                        type="text"
                        value={pickedGuest ? (pickedGuest.guest_name ?? '') : (guestNameInitial ?? guestName)}
                        readOnly
                        disabled
                        className="w-full text-xs bg-gray-100 border border-gray-200 rounded-lg p-1.5 mt-0.5 text-gray-500 cursor-not-allowed"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="text-[10px] uppercase font-bold text-gray-500">Nama Tamu</label>
                      <input
                        type="text"
                        value={guestName}
                        onChange={(e) => {if (canMutateDraft()) setGuestName(e.target.value);}}
                        disabled={draftLocked}
                        className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg p-1.5 mt-0.5"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2 mb-3">
                <label className="block text-xs font-semibold text-gray-600">Nomor WhatsApp untuk struk (opsional)
                  <input type="tel" maxLength={50} value={guestPhone} disabled={draftLocked}
                    onChange={e => {if (canMutateDraft()) setGuestPhone(e.target.value);}}
                    placeholder="08… atau +62…" className="block mt-1 w-full text-xs border border-gray-200 rounded-lg p-2" />
                </label>
                <label className="block text-xs font-semibold text-gray-600">Catatan pesanan (opsional)
                  <textarea maxLength={1000} rows={2} value={orderNotes} disabled={draftLocked}
                    onChange={e => {if (canMutateDraft()) setOrderNotes(e.target.value);}}
                    className="block mt-1 w-full text-xs border border-gray-200 rounded-lg p-2" />
                </label>
              </div>

              {/* Cart Items */}
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {cart.length === 0 ? (
                  <div className="py-8 text-center text-xs text-gray-400">
                    Klik item menu di samping untuk menambahkan pesanan.
                  </div>
                ) : (
                  cart.map(({ item, qty, discountType = '', discountInput = '', notes = '' }, lineIndex) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between p-2 bg-gray-50 rounded-lg text-xs"
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="font-semibold text-gray-800 truncate">{item.name}</div>
                        <div className="text-gray-500 text-[11px]">
                          {formatIDR(Number(item.price))}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.id, -1)}
                          disabled={draftLocked}
                          className="w-5 h-5 flex items-center justify-center rounded bg-gray-200 text-gray-700 font-bold hover:bg-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          -
                        </button>
                        <span className="font-bold w-4 text-center">{qty}</span>
                        <button
                          type="button"
                          onClick={() => updateCartQty(item.id, 1)}
                          disabled={draftLocked}
                          className="w-5 h-5 flex items-center justify-center rounded bg-gray-200 text-gray-700 font-bold hover:bg-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          +
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFromCart(item.id)}
                          disabled={draftLocked}
                          className="text-red-500 hover:text-red-700 ml-1 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <div className="basis-full mt-2 space-y-2 border-t border-gray-200 pt-2">
                        {canDiscountPos && <div className="flex gap-2">
                          <select aria-label={`Diskon item ${item.name}`} value={discountType} disabled={draftLocked}
                            onChange={e => {if (canMutateDraft()) changeLine(item.id, {discountType: e.target.value as PosDiscountType, discountInput: ''});}}
                            className="min-w-0 flex-1 border border-gray-200 rounded p-1">
                            <option value="">Tanpa diskon</option><option value="NOMINAL">Nominal per baris</option><option value="PERCENT">Persen per baris</option>
                          </select>
                          {discountType && <input aria-label={`Nilai diskon ${item.name}`} type="text" inputMode="decimal" value={discountInput}
                            disabled={draftLocked} onChange={e => changeLine(item.id, {discountInput: e.target.value})}
                            className="w-24 border border-gray-200 rounded p-1" placeholder={discountType === 'PERCENT' ? '%' : 'Rp'} />}
                        </div>}
                        {draftPreview.value && <div className="flex justify-between text-gray-600"><span>Total baris</span>
                          <span>{formatIDR(draftPreview.value.lines[lineIndex].net)}</span></div>}
                        <input aria-label={`Catatan ${item.name}`} type="text" maxLength={1000} value={notes} disabled={draftLocked}
                          onChange={e => changeLine(item.id, {notes: e.target.value})} placeholder="Catatan item (opsional)"
                          className="w-full border border-gray-200 rounded p-1" />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Total & Checkout */}
            <div className="border-t border-gray-100 pt-3 space-y-2">
              <div className="flex justify-between text-xs text-gray-500">
                <span>Subtotal</span>
                <span>{formatIDR(cartSubtotal)}</span>
              </div>
              {canDiscountPos && <div className="space-y-2">
                <label className="block text-xs font-semibold text-gray-600">Diskon pesanan
                  <select value={orderDiscountType} disabled={draftLocked}
                    onChange={e => {if (canMutateDraft()) {setOrderDiscountType(e.target.value as PosDiscountType); setOrderDiscountInput('');}}}
                    className="block w-full mt-1 border border-gray-200 rounded p-2 text-xs">
                    <option value="">Tanpa diskon</option><option value="NOMINAL">Nominal</option><option value="PERCENT">Persen</option>
                  </select>
                </label>
                {orderDiscountType && <>
                  <input aria-label="Nilai diskon pesanan" type="text" inputMode="decimal" value={orderDiscountInput} disabled={draftLocked}
                    onChange={e => {if (canMutateDraft()) setOrderDiscountInput(e.target.value);}}
                    placeholder={orderDiscountType === 'PERCENT' ? 'Persen (maks. 100)' : 'Nominal rupiah'}
                    className="w-full border border-gray-200 rounded p-2 text-xs" />
                  <input aria-label="Alasan diskon pesanan" type="text" maxLength={100} value={discountReason} disabled={draftLocked}
                    onChange={e => {if (canMutateDraft()) setDiscountReason(e.target.value);}} placeholder="Alasan diskon (opsional)"
                    className="w-full border border-gray-200 rounded p-2 text-xs" />
                </>}
                <p className="text-[11px] text-gray-500">Diskon pesanan dihitung setelah diskon setiap baris.</p>
              </div>}
              {draftPreview.value && <>
                <div className="flex justify-between text-xs text-gray-500"><span>Diskon item</span><span>{formatIDR(draftPreview.value.itemDiscount)}</span></div>
                <div className="flex justify-between text-xs text-gray-500"><span>Diskon pesanan</span><span>{formatIDR(draftPreview.value.orderDiscount)}</span></div>
              </>}

              {/* ── Per-order Service Charge & PBJT toggles ──────────────────────
                  Terlihat di blok "Total & Checkout", di atas "Total perkiraan".
                  - Properti ON  → toggle aktif, kasir dapat ON/OFF
                  - Properti OFF → toggle terlihat abu-abu (disabled), selalu OFF
                  - draftLocked / pending / ambiguous → toggle terkunci
                  - Persentase selalu dari pengaturan properti (backend authority). */}
              {authFetch && propertyId !== null && (
                <div className={`space-y-1.5 ${draftLocked ? 'opacity-60' : ''}`}>
                  {/* Loading / error state */}
                  {pricingSettings.status === 'loading' && (
                    <p className="text-[11px] text-gray-400">
                      Memuat pengaturan pricing… submit diblokir hingga selesai.
                    </p>
                  )}
                  {pricingSettings.status === 'error' && (
                    <div className="space-y-1">
                      <p className="text-[11px] text-amber-700">
                        {pricingSettings.message} — submit diblokir hingga pengaturan berhasil dimuat.
                      </p>
                      <button
                        type="button"
                        className="text-[11px] text-forest-700 underline underline-offset-2 hover:text-forest-900"
                        onClick={() => { void fetchPricingSettings(true); }}
                      >
                        Muat Ulang
                      </button>
                    </div>
                  )}

                  {pricingSettings.status === 'ready' && (() => {
                    const ps = pricingSettings.data;
                    return (
                    <div className="flex items-center justify-between gap-2">
                      {/* Service Charge */}
                      <label
                        className={`flex items-center gap-1.5 text-xs font-medium ${
                          !ps.service_charge_enabled
                            ? 'text-gray-400 cursor-not-allowed'
                            : 'text-gray-700 cursor-pointer'
                        }`}
                        title={
                          !ps.service_charge_enabled
                            ? 'Service charge tidak diaktifkan di pengaturan properti'
                            : `Service charge per pesanan (${ps.service_charge_percent ?? 0}%)`
                        }
                      >
                        <input
                          type="checkbox"
                          checked={svcToggleOn && !!ps.service_charge_enabled}
                          disabled={
                            draftLocked ||
                            !ps.service_charge_enabled
                          }
                          onChange={e => { if (canMutateDraft()) setSvcToggleOn(e.target.checked); }}
                          className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                          aria-label="Aktifkan Service Charge per pesanan"
                        />
                        <span>
                          Service Charge
                          {ps.service_charge_percent > 0 && (
                            <span className="text-gray-400"> ({ps.service_charge_percent}%)</span>
                          )}
                        </span>
                      </label>

                      {/* PBJT */}
                      <label
                        className={`flex items-center gap-1.5 text-xs font-medium ${
                          !ps.tax_enabled
                            ? 'text-gray-400 cursor-not-allowed'
                            : 'text-gray-700 cursor-pointer'
                        }`}
                        title={
                          !ps.tax_enabled
                            ? 'PBJT tidak diaktifkan di pengaturan properti'
                            : `PBJT per pesanan (${ps.tax_percent ?? 0}%)`
                        }
                      >
                        <input
                          type="checkbox"
                          checked={taxToggleOn && !!ps.tax_enabled}
                          disabled={
                            draftLocked ||
                            !ps.tax_enabled
                          }
                          onChange={e => { if (canMutateDraft()) setTaxToggleOn(e.target.checked); }}
                          className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                          aria-label="Aktifkan PBJT per pesanan"
                        />
                        <span>
                          PBJT
                          {ps.tax_percent > 0 && (
                            <span className="text-gray-400"> ({ps.tax_percent}%)</span>
                          )}
                        </span>
                      </label>
                    </div>
                  );})()}

                  {/* Estimasi Service Charge & PBJT */}
                  {draftPreview.value && ((draftPreview.value.serviceCharge > 0) || (draftPreview.value.tax > 0)) && (
                    <>
                      {draftPreview.value.serviceCharge > 0 && (
                        <div className="flex justify-between text-xs text-gray-500">
                          <span>Service Charge{pricingSettings.status === 'ready' && pricingSettings.data.service_charge_percent > 0 ? ` (${pricingSettings.data.service_charge_percent}%)` : ''}</span>
                          <span>{formatIDR(draftPreview.value.serviceCharge)}</span>
                        </div>
                      )}
                      {draftPreview.value.tax > 0 && (
                        <div className="flex justify-between text-xs text-gray-500">
                          <span>PBJT{pricingSettings.status === 'ready' && pricingSettings.data.tax_percent > 0 ? ` (${pricingSettings.data.tax_percent}%)` : ''}</span>
                          <span>{formatIDR(draftPreview.value.tax)}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="flex justify-between items-center text-sm font-black text-gray-900">
                <span>Total perkiraan</span>
                <span>{draftPreview.value ? formatIDR(draftPreview.value.total) : '—'}</span>
              </div>
              {draftPreview.error && <p role="alert" className="text-xs text-red-700">{draftPreview.error}</p>}
              {!canDiscountPos && hasDiscount && <div className="space-y-1 text-xs text-red-700">
                <p>Izin diskon tidak tersedia. Hapus diskon untuk menyimpan pesanan biasa.</p>
                <button type="button" disabled={draftLocked} className="underline font-semibold" onClick={() => {
                  if (!canMutateDraft()) return;
                  setCart(lines => lines.map(line => ({...line, discountType: '' as PosDiscountType, discountInput: ''})));
                  setOrderDiscountType(''); setOrderDiscountInput(''); setDiscountReason('');
                }}>Hapus semua diskon</button>
              </div>}
              {draftPreview.value?.total === 0 && cart.length > 0 && <p className="text-xs text-amber-700">Total nol belum dapat dibayar.</p>}
              {!authFetch && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-700">
                  <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 font-semibold">DEMO</span>
                  <span>Simulasi cart — tidak tersimpan, tidak dibayar, tidak diposting ke folio.</span>
                </div>
              )}
                {/* Real save action — replace demo alert when authFetch is provided */}
                {authFetch ? (
                  <>
                    {!canEditPos && (
                      <p className="text-[11px] text-stone-500 mb-1">
                        Anda tidak memiliki izin untuk membuat order POS.
                      </p>
                    )}
                    {/* Dua tombol: "Simpan Pesanan" (OPEN saja) + "Bayar"
                        (OPEN → langsung CASH payment) bila onOpenCashPayment tersedia.
                        Kedua tombol disabled saat saving/busy/draft kosong/
                        tidak ada izin edit. */}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={!canEditPos || !canSaveDraft || cart.length === 0 || saving || busy}
                        onClick={() => void handleSaveOrder()}
                        className={`flex-1 py-2.5 rounded-xl ${
                          onOpenCashPayment
                            ? 'bg-emerald-700 hover:bg-emerald-600'
                            : 'bg-emerald-800 hover:bg-emerald-700'
                        } disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer`}
                      >
                        {saving ? 'Menyimpan…' : 'Simpan Pesanan'}
                      </button>
                      {onOpenCashPayment && (
                        <button
                          type="button"
                          disabled={!canEditPos || !canSaveDraft || draftPreview.value?.total === 0 || cart.length === 0 || saving || busy}
                          onClick={() => void handleSaveAndPay()}
                          className="flex-1 py-2.5 rounded-xl bg-emerald-900 hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-xs sm:text-sm transition-colors cursor-pointer"
                        >
                          {saving ? 'Menyimpan…' : 'Bayar'}
                        </button>
                      )}
                    </div>
                  {(ambiguous || saveResult) && (
                    <div
                      className={`rounded-lg p-2 text-[11px] font-medium ${
                        saveResult?.ok
                          ? 'bg-emerald-50 border border-emerald-300 text-emerald-800'
                          : 'bg-red-50 border border-red-200 text-red-800'
                      }`}
                    >
                       {ambiguous && (
                         <>
                           <p className="font-semibold mb-1">Hasil penyimpanan belum diketahui</p>
                           <p className="mb-2">
                             Draft &amp; idempotency key terkunci dan tidak dapat diubah —
                             hanya tombol "Coba Lagi" yang dapat menyelesaikan keadaan ini.
                             Gunakan tombol di bawah untuk mengirim ulang dengan key &amp;
                             payload yang sama (aman — tidak membuat order duplikat).
                             Draft baru dapat dibuat HANYA SETELAH replay sukses terverifikasi.
                           </p>
                         </>
                       )}
                       {saveResult && <p>{saveResult.message}</p>}
                       {(ambiguous || !saveResult?.ok) && (
                          <button
                            type="button"
                            onClick={handleRetrySave}
                            disabled={saving || !canEditPos}
                            className="mt-2 px-2.5 py-1 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-[11px] font-bold cursor-pointer"
                          >
                           Coba Lagi
                         </button>
                       )}
                        {/* Bayar — hanya untuk order sukses + izin edit + callback tersedia */}
                        {saveResult?.ok && saveResult.order && canEditPos && onOpenCashPayment &&
                          propertyId != null &&
                          payCtxRef.current &&
                          payCtxRef.current.orderId === saveResult.order.id &&
                          saveResult.order.status === 'OPEN' &&
                          localPaidOrderId !== saveResult.order.id && (
                            <button
                              type="button"
                              onClick={() => {
                                // Pakai context tersimpan (bukan state UI saat ini)
                                // agar identitas pembayaran stabil.
                                onOpenCashPayment(payCtxRef.current!);
                              }}
                              className="mt-2 px-2.5 py-1 bg-emerald-800 hover:bg-emerald-700 text-white rounded text-[11px] font-bold cursor-pointer"
                            >
                              Bayar
                            </button>
                          )}
                        {/* Indikator order sudah LUNAS (lokal atau dari signal App) */}
                        {saveResult?.ok && saveResult.order && localPaidOrderId === saveResult.order.id && (
                          <div className="mt-2 text-[11px] font-semibold text-emerald-700">
                            ✓ LUNAS — pembayaran terverifikasi
                          </div>
                        )}
                    </div>
                  )}                </>
              ) : (
                <button
                  type="button"
                  disabled={cart.length === 0 || busy}
                  onClick={() => {
                    alert(`[DEMO] Pesanan ${tableNumber} untuk ${guestName} sebesar ${formatIDR(cartSubtotal)} (simulasi, tidak tersimpan/diposting).`);
                    setCart([]);
                  }}
                  className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-bold text-xs sm:text-sm transition-colors shadow-xs cursor-pointer"
                >
                  [Demo] Bayar
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Orders History Table */
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs sm:text-sm">
              <thead className="bg-gray-50/80 border-b border-gray-200 text-gray-600 font-semibold uppercase text-[11px] tracking-wider">
                <tr>
                  <th className="py-3 px-4">Nomor Order</th>
                  <th className="py-3 px-4">Meja</th>
                  <th className="py-3 px-4">Nama Tamu</th>
                  <th className="py-3 px-4 text-right">Total (IDR)</th>
                  <th className="py-3 px-4 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {posOrders.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-gray-400">
                      Belum ada order POS tercatat.
                    </td>
                  </tr>
                ) : (
                  posOrders.map((order) => (
                    <tr key={order.id} className="hover:bg-gray-50/60 transition-colors">
                      <td className="py-3 px-4 font-mono font-semibold text-purple-900">
                        {order.order_number}
                      </td>
                      <td className="py-3 px-4 text-gray-700">
                        {order.table_number || 'Takeaway'}
                      </td>
                      <td className="py-3 px-4 font-medium text-gray-900">
                        {order.guest_name || 'Walk-in Guest'}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-gray-900">
                        {formatIDR(Number(order.total_amount || 0))}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-purple-50 text-purple-700 border border-purple-200">
                          {order.status || 'PAID'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
