import { useState, useEffect, useRef } from 'react';
import type { Guest } from '../guests/guestTypes';

interface Props {
  propertyId: number;
  value: string;
  onChange: (name: string) => void;
  onSelectGuest: (guest: Guest) => void;
  onClearGuest?: () => void;
  selectedGuest?: Guest | null;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  label?: string;
}

export default function GuestSearchAutocomplete({
  propertyId,
  value,
  onChange,
  onSelectGuest,
  onClearGuest,
  selectedGuest,
  placeholder = 'Ketik nama / no. HP / identitas tamu...',
  required = false,
  disabled = false,
  label = 'Nama Tamu'
}: Props) {
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (selectedGuest && selectedGuest.full_name === query) {
      setResults([]);
      return;
    }

    if (!query || query.trim().length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/guests/search?property_id=${propertyId}&q=${encodeURIComponent(query.trim())}`);
        const data = await res.json();
        if (data.status === 'OK' || data.success) {
          setResults(data.data || []);
          setIsOpen(true);
        }
      } catch (err) {
        console.warn('Guest CRM search error:', err);
      } finally {
        setLoading(false);
      }
    }, 280);

    return () => clearTimeout(timer);
  }, [query, propertyId, selectedGuest]);

  const handleSelect = (guest: Guest) => {
    setQuery(guest.full_name);
    onChange(guest.full_name);
    onSelectGuest(guest);
    setIsOpen(false);
  };

  const handleClear = () => {
    setQuery('');
    onChange('');
    if (onClearGuest) onClearGuest();
  };

  const formatLastStay = (dateStr?: string | null) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="relative w-full" ref={containerRef}>
      {label && (
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs font-semibold text-stone-700">
            {label} {required && <span className="text-rose-500">*</span>}
          </label>
          {selectedGuest && (
            <span className="text-[10px] text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600"></span>
              Terhubung CRM {selectedGuest.guest_code || `#${selectedGuest.id}`}
            </span>
          )}
        </div>
      )}

      <div className="relative">
        <input
          type="text"
          value={query}
          required={required}
          disabled={disabled}
          placeholder={placeholder}
          onChange={e => {
            setQuery(e.target.value);
            onChange(e.target.value);
          }}
          onFocus={() => {
            if (results.length > 0) setIsOpen(true);
          }}
          className={`w-full text-sm px-3.5 py-2.5 bg-stone-50 border rounded-xl focus:ring-2 focus:ring-emerald-600 focus:bg-white transition-all outline-none ${
            selectedGuest ? 'border-emerald-500 bg-emerald-50/20' : 'border-stone-300'
          }`}
        />

        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1 text-stone-400">
          {loading ? (
            <svg className="animate-spin w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
            </svg>
          ) : selectedGuest ? (
            <button
              type="button"
              onClick={handleClear}
              title="Lepas tautan tamu"
              className="p-1 hover:text-stone-600 hover:bg-stone-200/60 rounded-full transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          )}
        </div>
      </div>

      {/* Autocomplete Dropdown */}
      {isOpen && query.trim().length >= 2 && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-white border border-emerald-900/15 rounded-xl shadow-xl overflow-hidden max-h-72 overflow-y-auto divide-y divide-stone-100 animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="px-3 py-2 bg-stone-50 border-b border-stone-200/60 text-[11px] font-semibold text-stone-500 uppercase tracking-wider flex justify-between items-center">
            <span>Database Tamu Hotel</span>
            <span>{results.length} ditemukan</span>
          </div>

          {results.length > 0 ? (
            results.map(g => {
              const stayCount = Number(g.visit_count || 0);
              const lastStayFormatted = formatLastStay(g.last_stay);
              const hasIdentity = Boolean(g.has_valid_identity || g.identity_number || g.identity_path);

              return (
                <div
                  key={g.id}
                  onClick={() => handleSelect(g)}
                  className="p-3 hover:bg-emerald-50/60 cursor-pointer transition-colors flex items-center justify-between gap-3 group"
                >
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-stone-900 group-hover:text-emerald-950">
                        {g.full_name}
                      </span>
                      {g.vip_status && g.vip_status !== 'STANDARD' && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">
                          {g.vip_status}
                        </span>
                      )}
                      {stayCount > 0 ? (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                          Pernah menginap {stayCount}x
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-stone-100 text-stone-600">
                          Tamu Baru
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
                      {g.phone && (
                        <span className="flex items-center gap-1 font-mono">
                          <svg className="w-3 h-3 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                          </svg>
                          {g.phone}
                        </span>
                      )}
                      {lastStayFormatted && (
                        <span>Terakhir: <strong>{lastStayFormatted}</strong></span>
                      )}
                      {hasIdentity ? (
                        <span className="text-emerald-700 font-medium flex items-center gap-0.5">
                          ✓ KTP Tersimpan
                        </span>
                      ) : (
                        <span className="text-amber-700 font-medium flex items-center gap-0.5">
                          ⚠ Belum ada KTP
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-100 group-hover:bg-emerald-800 group-hover:text-white rounded-lg transition-colors shrink-0 shadow-sm"
                  >
                    Pilih
                  </button>
                </div>
              );
            })
          ) : (
            <div className="p-4 text-center space-y-2">
              <p className="text-xs text-stone-500">
                Tidak ada tamu dengan nama/nomor "<strong>{query}</strong>" di database.
              </p>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-xs font-semibold text-emerald-800 hover:text-emerald-950 underline"
              >
                + Lanjutkan sebagai Tamu Baru
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
