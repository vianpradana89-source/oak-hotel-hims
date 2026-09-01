import React from 'react';

export interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  shortcutBadge?: string;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(({
  value,
  onChange,
  onClear,
  placeholder = 'Cari...',
  shortcutBadge,
  className = '',
  disabled,
  ...props
}, ref) => {
  return (
    <div className="relative flex items-center w-full">
      <div className="absolute left-3 text-slate-400 pointer-events-none flex items-center justify-center">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>
      <input
        ref={ref}
        type="text"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full h-10 text-oak-input pl-9 pr-14 rounded-lg border border-slate-300 bg-white text-slate-800 placeholder:text-slate-400 transition-colors duration-150 focus:outline-none focus:border-[#1b4332] focus:ring-2 focus:ring-[#1b4332]/20 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed ${className}`}
        {...props}
      />
      <div className="absolute right-2.5 flex items-center gap-1.5">
        {value && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer"
            title="Hapus pencarian"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {shortcutBadge && (
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 bg-slate-100 border border-slate-200 rounded">
            {shortcutBadge}
          </kbd>
        )}
      </div>
    </div>
  );
});

SearchInput.displayName = 'SearchInput';
