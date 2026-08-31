import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { StayChargeRule } from './stayChargesTypes';

interface StayChargePickerComboboxProps {
  rules: StayChargeRule[] | any[];
  onSelectRule: (rule: StayChargeRule | any) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
}

export const StayChargePickerCombobox: React.FC<StayChargePickerComboboxProps> = ({
  rules = [],
  onSelectRule,
  placeholder = 'Cari Extra Bed, Late Check-out, Denda Merokok, dll',
  label = 'Tambah layanan atau denda',
  disabled = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter out archived or inactive rules
  const activeRules = useMemo(() => {
    return (rules || []).filter((r: any) => !r.is_archived && r.is_active !== false);
  }, [rules]);

  // Filter rules based on search query
  const filteredRules = useMemo(() => {
    if (!query.trim()) return activeRules;
    const q = query.toLowerCase().trim();
    return activeRules.filter((r: any) => {
      const name = (r.name || '').toLowerCase();
      const code = (r.code || '').toLowerCase();
      const desc = (r.description || '').toLowerCase();
      const type = (r.charge_type || '').toLowerCase();
      return name.includes(q) || code.includes(q) || desc.includes(q) || type.includes(q);
    });
  }, [activeRules, query]);

  // Group filtered rules into Layanan Tambahan and Denda & Penalti
  const { serviceRules, penaltyRules } = useMemo(() => {
    const services: (StayChargeRule | any)[] = [];
    const penalties: (StayChargeRule | any)[] = [];

    for (const rule of filteredRules) {
      if (rule.charge_type === 'PENALTY') {
        penalties.push(rule);
      } else {
        services.push(rule);
      }
    }

    return { serviceRules: services, penaltyRules: penalties };
  }, [filteredRules]);

  // Flat list of visible items for keyboard navigation
  const flatItems = useMemo(() => {
    return [...serviceRules, ...penaltyRules];
  }, [serviceRules, penaltyRules]);

  // Handle outside click to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (rule: StayChargeRule | any) => {
    onSelectRule(rule);
    setQuery('');
    setIsOpen(false);
    setActiveIndex(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else {
        setActiveIndex(prev => (prev < flatItems.length - 1 ? prev + 1 : 0));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else {
        setActiveIndex(prev => (prev > 0 ? prev - 1 : flatItems.length - 1));
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isOpen && flatItems[activeIndex]) {
        handleSelect(flatItems[activeIndex]);
      } else if (!isOpen) {
        setIsOpen(true);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const formatPriceBadge = (rule: any) => {
    if (rule.charge_method === 'FREE' || Number(rule.default_amount || 0) === 0 && rule.charge_method === 'FIXED_AMOUNT' && !rule.percentage_rate) {
      return 'Gratis';
    }
    if (rule.calculation_type === 'PERCENT_ROOM_RATE' || rule.charge_method === 'PERCENTAGE_OF_NIGHTLY_RATE') {
      const pct = rule.percentage_rate ?? rule.percentage_of_rate ?? 50;
      return pct + '% Tarif Kamar';
    }
    if (rule.charge_method === 'FULL_NIGHT') {
      return 'Tarif 1 Malam';
    }
    if (rule.charge_method === 'MANUAL' || rule.calculation_type === 'MANUAL') {
      return 'Nominal Manual';
    }
    const amt = Number(rule.default_amount ?? rule.default_price ?? 0);
    return 'Rp ' + amt.toLocaleString('id-ID');
  };

  return (
    <div className="relative w-full text-left" ref={containerRef}>
      {label && (
        <label className="block text-[11px] font-semibold text-stone-700 mb-1">
          {label}
        </label>
      )}

      <div className="relative flex items-center">
        <div className="absolute left-3 pointer-events-none text-stone-400">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full pl-9 pr-16 py-2 bg-white border border-stone-300 rounded-xl text-xs text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-[#1b4332] focus:border-transparent transition-all shadow-2xs"
        />

        <div className="absolute right-2 flex items-center gap-1">
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="p-1 text-stone-400 hover:text-stone-600 rounded-md cursor-pointer"
              title="Bersihkan"
            >
              ✕
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setIsOpen(!isOpen)}
            className="p-1 text-stone-400 hover:text-stone-600 rounded-md cursor-pointer"
          >
            <svg
              className={'w-3.5 h-3.5 transition-transform duration-200 ' + (isOpen ? 'rotate-180' : '')}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Dropdown Suggestions */}
      {isOpen && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 max-h-72 overflow-y-auto bg-white border border-stone-200 rounded-xl shadow-xl divide-y divide-stone-100 animate-in fade-in zoom-in-95 duration-100">
          {flatItems.length === 0 ? (
            <div className="p-4 text-center text-xs text-stone-500">
              <span className="text-base block mb-1">🔍</span>
              Tidak ada layanan atau denda yang cocok dengan <span className="font-semibold text-stone-700">"{query}"</span>.
            </div>
          ) : (
            <>
              {/* Group 1: Layanan Tambahan */}
              {serviceRules.length > 0 && (
                <div className="p-1.5">
                  <div className="px-2.5 py-1 text-[10px] font-bold tracking-wider text-[#1b4332] uppercase bg-[#1b4332]/5 rounded-md flex items-center justify-between mb-1">
                    <span>🛎️ Layanan Tambahan</span>
                    <span className="text-[9px] font-normal text-stone-500">{serviceRules.length} pilihan</span>
                  </div>
                  <div className="space-y-0.5">
                    {serviceRules.map((rule) => {
                      const itemIdx = flatItems.indexOf(rule);
                      const isHighlighted = itemIdx === activeIndex;
                      return (
                        <div
                          key={rule.id || ('srv-' + (rule.code || rule.name))}
                          onMouseEnter={() => setActiveIndex(itemIdx)}
                          onClick={() => handleSelect(rule)}
                          className={'px-3 py-2 rounded-lg cursor-pointer flex items-center justify-between text-xs transition-colors ' + (isHighlighted ? 'bg-emerald-50 text-emerald-950 font-medium' : 'text-stone-700 hover:bg-stone-50')}
                        >
                          <div className="flex items-center gap-2 min-w-0 pr-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 shrink-0" />
                            <div className="min-w-0 truncate">
                              <span className="font-semibold text-stone-900 block truncate">{rule.name}</span>
                              {rule.code && (
                                <span className="text-[10px] text-stone-400 font-mono block">[{rule.code}]</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0 text-right">
                            <span className="font-mono font-semibold text-emerald-800 text-[11px] bg-emerald-100/60 px-2 py-0.5 rounded border border-emerald-200">
                              {formatPriceBadge(rule)}
                            </span>
                            {(rule.taxable || rule.is_taxable) && (
                              <span className="text-[9px] font-bold text-stone-500 bg-stone-100 px-1 rounded" title="Dikenakan Pajak">
                                PPN
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Group 2: Denda & Penalti */}
              {penaltyRules.length > 0 && (
                <div className="p-1.5">
                  <div className="px-2.5 py-1 text-[10px] font-bold tracking-wider text-rose-800 uppercase bg-rose-50 rounded-md flex items-center justify-between mb-1">
                    <span>⚠️ Denda & Penalti</span>
                    <span className="text-[9px] font-normal text-stone-500">{penaltyRules.length} pilihan</span>
                  </div>
                  <div className="space-y-0.5">
                    {penaltyRules.map((rule) => {
                      const itemIdx = flatItems.indexOf(rule);
                      const isHighlighted = itemIdx === activeIndex;
                      return (
                        <div
                          key={rule.id || ('pen-' + (rule.code || rule.name))}
                          onMouseEnter={() => setActiveIndex(itemIdx)}
                          onClick={() => handleSelect(rule)}
                          className={'px-3 py-2 rounded-lg cursor-pointer flex items-center justify-between text-xs transition-colors ' + (isHighlighted ? 'bg-rose-50 text-rose-950 font-medium' : 'text-stone-700 hover:bg-stone-50')}
                        >
                          <div className="flex items-center gap-2 min-w-0 pr-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                            <div className="min-w-0 truncate">
                              <span className="font-semibold text-stone-900 block truncate">{rule.name}</span>
                              {rule.code && (
                                <span className="text-[10px] text-stone-400 font-mono block">[{rule.code}]</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0 text-right">
                            <span className="font-mono font-semibold text-rose-800 text-[11px] bg-rose-100/60 px-2 py-0.5 rounded border border-rose-200">
                              {formatPriceBadge(rule)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
