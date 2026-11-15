/**
 * GuestPicker — dropdown "Pilih Tamu Menginap" di POS header.
 *
 * Menampilkan daftar reservasi CHECKED_IN + IN_HOUSE untuk properti aktif.
 * Data diambil dari GET /api/reservations?property_id=X&status=CHECKED_IN&stay_status=IN_HOUSE.
 *
 * Kontrak:
 * - permission: hanya dirender bila caller sudah memverifikasi hasCalendarView.
 * - Key untuk option = reservation_id (bukan nama/BID), agar nama sama
 *   pada dua kamar tetap menjadi dua pilihan terpisah.
 * - Tampilkan: nama tamu, nomor kamar, BID.
 * - Loading / empty / error / retry.
 * - Invalidasi: respons usang (property_id tidak cocok dengan properti terkini)
 *   TIDAK BOLEH menimpa konteks baru.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

export interface GuestPickerReservation {
  reservation_id: number;
  guest_name: string | null;
  room_number: string | null;
  bid: string | null;
}

interface Props {
  propertyId: number;
  /**
   * Authenticated fetch dari useAuth(). Bila undefined, picker tidak
   * menjalankan fetch (fallback: hanya pelanggan manual).
   */
  authFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * Callback saat pilihan dibuat (guest_name, room_number, reservation_id).
   * Bila undefined, selection tidak di-notify ke parent.
   */
  onGuestSelected?: (guest: {
    reservation_id: number;
    guest_name: string | null;
    room_number: string | null;
  }) => void;
  /**
   * Bila true, input pelanggan manual (Nama Tamu / Nomor Meja) TIDAK
   * ditampilkan di dalam picker — caller tetap punya akses ke input
   * terpisah di PosWorkspace.
   */
  embeddedInForm?: boolean;
  /**
   * Bila true, seluruh interaksi picker terkunci:
   * trigger, pilihan tamu, dan retry tidak dapat diklik.
   * Dipakai saat draft POS ter-lock (saving/busy/ambiguous).
   */
  disabled?: boolean;
}

// ── Internal state ─────────────────────────────────────────────────────────

type FetchState = 'idle' | 'loading' | 'success' | 'error';

// ── Component ──────────────────────────────────────────────────────────────

export default function GuestPicker({
  propertyId,
  authFetch,
  onGuestSelected,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [fetchState, setFetchState] = useState<FetchState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<GuestPickerReservation[]>([]);
  // Data terakhir yang berhasil di-load beserta property_id pada saat fetch
  // — dipakai untuk invalidasi: bila property berganti, respons usang
  // tidak boleh menimpa konteks baru.
  const lastFetchPropertyRef = useRef<number | null>(null);
  // Request generation ref: setiap fetch mendapat generation baru;
  // invalidasi (property berubah / unmount) meningkatkan generation sehingga
  // respons fetch lama tidak menulis state apa pun.
  const requestGenerationRef = useRef(0);

  // Invalidasi: property berubah → naikkan generation, reset state.
  useEffect(() => {
    requestGenerationRef.current++;
    if (lastFetchPropertyRef.current !== null && lastFetchPropertyRef.current !== propertyId) {
      setItems([]);
      setFetchState('idle');
      setError(null);
      lastFetchPropertyRef.current = null;
    }
  }, [propertyId]);

  // Invalidasi: unmount → naikkan generation sehingga respons in-flight
  // tidak akan menulis state setelah komponen sudah unmounted.
  useEffect(() => {
    return () => { requestGenerationRef.current++; };
  }, []);

  const fetchGuests = useCallback(async () => {
    if (!authFetch) return;
    const gen = ++requestGenerationRef.current;
    setFetchState('loading');
    setError(null);
    const reqPropertyId = propertyId;
    try {
      const res = await authFetch(
        `/api/reservations?property_id=${reqPropertyId}&status=CHECKED_IN&stay_status=IN_HOUSE`,
      );
      const json = await res.json().catch(() => null);
      // Guard: bila generation sudah usang (property berubah / unmount),
      // abaikan respons — data properti lama tidak boleh dipilih.
      if (gen !== requestGenerationRef.current) return;
      if (!res.ok || !json || !Array.isArray(json.data)) {
        setError('Gagal memuat daftar tamu menginap.');
        setFetchState('error');
        return;
      }
      const rows: GuestPickerReservation[] = json.data.map((r: any) => ({
        reservation_id: r.reservation_id,
        guest_name: r.guest_name ?? null,
        room_number: r.room_number ?? null,
        bid: r.bid ?? null,
      }));
      setItems(rows);
      lastFetchPropertyRef.current = reqPropertyId;
      setFetchState('success');
    } catch {
      if (gen !== requestGenerationRef.current) return;
      setError('Gagal memuat daftar tamu menginap.');
      setFetchState('error');
    }
  }, [authFetch, propertyId]);

  // Fetch saat open pertama kali / property berubah
  useEffect(() => {
    if (!open) return;
    if (lastFetchPropertyRef.current !== propertyId) {
      void fetchGuests();
    }
  }, [open, propertyId, fetchGuests]);

  const selectGuest = (guest: GuestPickerReservation) => {
    if (disabled) return;
    setOpen(false);
    onGuestSelected?.({
      reservation_id: guest.reservation_id,
      guest_name: guest.guest_name,
      room_number: guest.room_number,
    });
  };

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!authFetch || disabled}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="text-gray-600 font-medium">Pilih Tamu Menginap</span>
        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && authFetch && (
        <div
          className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto"
          role="listbox"
        >
          {fetchState === 'idle' || fetchState === 'loading' ? (
            <div className="px-3 py-4 text-center text-xs text-gray-400">
              <span className="inline-block w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin mr-2" />
              Memuat tamu menginap…
            </div>
          ) : fetchState === 'error' ? (
            <div className="px-3 py-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg m-1">
              <p className="font-semibold mb-1">{error}</p>
              <button
                type="button"
                onClick={() => void fetchGuests()}
                disabled={disabled}
                className="mt-1.5 px-2.5 py-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-[11px] font-bold cursor-pointer"
              >
                Coba Lagi
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-gray-400">
              Tidak ada tamu menginap saat ini.
            </div>
          ) : (
            <ul>
              {items.map((g) => (
                <li key={g.reservation_id}>
                  <button
                    type="button"
                    role="option"
                    onClick={() => selectGuest(g)}
                    disabled={disabled}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-purple-50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <div className="font-semibold text-gray-900">{g.guest_name || 'Tamu'}</div>
                    <div className="text-gray-500 text-[11px] mt-0.5 flex gap-2">
                      {g.room_number && <span>Kamar {g.room_number}</span>}
                      {g.bid && <span className="font-mono">{g.bid}</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
