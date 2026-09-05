import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OverrideChoice } from '../auth/accessControl';

const ICON_CLASS = 'w-3.5 h-3.5';

export const HrdActionIcons = {
  eye: (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  ),
  pencil: (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536M4 20h4.586a1 1 0 00.707-.293l9.414-9.414a2 2 0 000-2.828l-2.172-2.172a2 2 0 00-2.828 0L4.293 14.707A1 1 0 004 15.414V20z" />
    </svg>
  ),
  key: (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
    </svg>
  ),
  userCheck: (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h8" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 18l2 2 4-4" />
    </svg>
  ),
  userX: (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h6" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 16l5 5m0-5l-5 5" />
    </svg>
  ),
  power: (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v8m6.364-5.364a9 9 0 11-12.728 0" />
    </svg>
  ),
  trash: (
    <svg className={ICON_CLASS} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3m-9 0h12" />
    </svg>
  ),
  more: (
    <svg className={ICON_CLASS} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  ),
};

export type HrdIconTone = 'neutral' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<HrdIconTone, string> = {
  neutral: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  success: 'text-emerald-700 hover:bg-emerald-50 hover:text-emerald-900',
  warning: 'text-amber-700 hover:bg-amber-50 hover:text-amber-900',
  danger: 'text-rose-700 hover:bg-rose-50 hover:text-rose-900',
};

const ICON_BUTTON_CLASS =
  'peer inline-flex items-center justify-center w-7 h-7 rounded-md border border-transparent transition-colors duration-150 cursor-pointer shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1b4332]/35 focus-visible:ring-offset-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-current';

export function HrdActionCluster({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap">
      {children}
    </div>
  );
}

interface HrdIconActionProps {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  tone?: HrdIconTone;
}

export const HrdIconAction: React.FC<HrdIconActionProps> = ({
  label,
  icon,
  onClick,
  disabled = false,
  disabledReason,
  tone = 'neutral',
}) => {
  const tip = disabled && disabledReason ? disabledReason : label;

  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        aria-label={label}
        title={tip}
        disabled={disabled}
        onClick={onClick}
        className={`${ICON_BUTTON_CLASS} ${TONE_CLASS[tone]}`}
      >
        {icon}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-0.5 text-[10px] font-medium text-white opacity-0 shadow-md transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
};

export interface HrdMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  hidden?: boolean;
  tone?: HrdIconTone;
}

interface HrdActionMenuProps {
  label?: string;
  items: HrdMenuItem[];
}

function useFloatingPanel(panelWidth: number) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = panelWidth;
    const estimatedHeight = panelRef.current?.offsetHeight || 168;
    let left = rect.right - width;
    if (left < 8) left = 8;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    let top = rect.bottom + 4;
    if (top + estimatedHeight > window.innerHeight - 8 && rect.top - estimatedHeight - 4 > 8) {
      top = rect.top - estimatedHeight - 4;
    }
    setCoords({ top, left });
  }, [panelWidth]);

  useEffect(() => {
    if (!open) return;
    place();
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onReposition = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, place]);

  return { open, setOpen, triggerRef, panelRef, coords, place };
}

const MENU_ITEM_TONE: Record<HrdIconTone, string> = {
  neutral: 'text-slate-700 hover:bg-slate-50',
  success: 'text-emerald-800 hover:bg-emerald-50',
  warning: 'text-amber-800 hover:bg-amber-50',
  danger: 'text-rose-700 hover:bg-rose-50',
};

export const HrdActionMenu: React.FC<HrdActionMenuProps> = ({
  label = 'Aksi lainnya',
  items,
}) => {
  const visible = items.filter(item => !item.hidden);
  const { open, setOpen, triggerRef, panelRef, coords } = useFloatingPanel(188);
  const menuId = useId();

  if (visible.length === 0) return null;

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(prev => !prev)}
        className={`${ICON_BUTTON_CLASS} ${TONE_CLASS.neutral}`}
      >
        {HrdActionIcons.more}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-0.5 text-[10px] font-medium text-white opacity-0 shadow-md transition-opacity peer-hover:opacity-100 peer-focus-visible:opacity-100"
      >
        {label}
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={menuId}
            role="menu"
            style={{ top: coords.top, left: coords.left }}
            className="fixed z-40 min-w-[11.5rem] rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
          >
            {visible.map(item => {
              const tip = item.disabled && item.disabledReason ? item.disabledReason : item.label;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  title={tip}
                  aria-label={item.label}
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return;
                    setOpen(false);
                    item.onClick();
                  }}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${MENU_ITEM_TONE[item.tone || 'neutral']}`}
                >
                  {item.icon && <span className="shrink-0 opacity-80">{item.icon}</span>}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </span>
  );
};

const OVERRIDE_DISPLAY: Record<
  OverrideChoice,
  { short: string; full: string; className: string }
> = {
  INHERIT: {
    short: 'Role',
    full: 'Ikuti Role',
    className: 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100',
  },
  ALLOW: {
    short: 'Allow',
    full: 'Izinkan',
    className: 'bg-emerald-50/80 text-emerald-700 border-emerald-200/80 hover:bg-emerald-50',
  },
  DENY: {
    short: 'Deny',
    full: 'Tolak',
    className: 'bg-rose-50/80 text-rose-700 border-rose-200/80 hover:bg-rose-50',
  },
};

const OVERRIDE_OPTIONS: { value: OverrideChoice; label: string }[] = [
  { value: 'INHERIT', label: 'Ikuti Role' },
  { value: 'ALLOW', label: 'Izinkan' },
  { value: 'DENY', label: 'Tolak' },
];

interface OverrideStateControlProps {
  value: OverrideChoice;
  onChange: (next: OverrideChoice) => void;
  disabled?: boolean;
  ariaLabel: string;
  hint?: string;
  roleAllowed?: boolean;
}

export const OverrideStateControl: React.FC<OverrideStateControlProps> = ({
  value,
  onChange,
  disabled = false,
  ariaLabel,
  hint,
  roleAllowed,
}) => {
  const { open, setOpen, triggerRef, panelRef, coords } = useFloatingPanel(168);
  const display = OVERRIDE_DISPLAY[value];
  const title = hint ? `${display.full} · ${hint}` : display.full;

  return (
    <div className="relative inline-flex flex-col items-center">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen(prev => !prev);
        }}
        className={`min-w-[3.25rem] px-1.5 py-0.5 rounded-md border text-[10px] font-bold leading-4 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1b4332]/35 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-inherit ${display.className}`}
      >
        {display.short}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{ top: coords.top, left: coords.left }}
            className="fixed z-40 min-w-[10.5rem] rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
          >
            {OVERRIDE_OPTIONS.map(option => {
              const selected = option.value === value;
              const extra =
                option.value === 'INHERIT'
                  ? ` (${roleAllowed ? 'Izin' : 'Tolak'})`
                  : '';
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] font-semibold cursor-pointer transition-colors ${
                    option.value === 'ALLOW'
                      ? 'text-emerald-800 hover:bg-emerald-50'
                      : option.value === 'DENY'
                        ? 'text-rose-700 hover:bg-rose-50'
                        : 'text-slate-700 hover:bg-slate-50'
                  } ${selected ? 'bg-slate-50' : ''}`}
                >
                  <span>
                    {option.label}
                    {extra}
                  </span>
                  {selected && <span aria-hidden="true" className="text-[10px]">✓</span>}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
};
