import React, { useEffect } from 'react';

export interface OperationalSummaryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  count: number;
  countLabel?: string;
  badgeColor?: 'amber' | 'emerald' | 'slate' | 'blue' | 'rose';
  children: React.ReactNode;
}

const badgeColors: Record<string, string> = {
  amber: 'bg-amber-50 text-amber-800 border-amber-300',
  emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200/80',
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  blue: 'bg-blue-50 text-blue-800 border-blue-200',
  rose: 'bg-rose-50 text-rose-800 border-rose-200',
};

export const OperationalSummaryDrawer: React.FC<OperationalSummaryDrawerProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  count,
  countLabel = 'item',
  badgeColor = 'slate',
  children,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity duration-200"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl flex flex-col z-10 duration-200 animate-in slide-in-from-right border-l border-slate-200"
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between shrink-0 bg-white">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-sm font-bold text-slate-900 truncate">{title}</h2>
              <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${badgeColors[badgeColor]}`}>
                {count} {countLabel}
              </span>
            </div>
            {subtitle && <p className="text-[11px] text-slate-500 mt-0.5 truncate">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer shrink-0"
            aria-label="Tutup panel"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {children}
        </div>
      </div>
    </div>
  );
};

export default OperationalSummaryDrawer;
