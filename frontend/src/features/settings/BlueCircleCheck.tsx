import React from 'react';

export interface BlueCircleCheckProps {
  checked: boolean;
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
}

/**
 * Checklist button with a solid royal-blue circle and white checkmark icon when active,
 * or a clean circular border with white background when inactive.
 * Matches Gambar 2 reference exactly.
 */
export const BlueCircleCheck: React.FC<BlueCircleCheckProps> = ({
  checked,
  disabled = false,
  onClick,
  ariaLabel,
  title,
}) => {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={`inline-flex items-center justify-center p-0.5 rounded-full transition-transform active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer disabled:cursor-not-allowed ${
        disabled ? 'opacity-60' : ''
      }`}
    >
      {checked ? (
        <span className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white shadow-xs">
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      ) : (
        <span className="w-5 h-5 rounded-full border-2 border-slate-300 bg-white hover:border-blue-500 transition-colors" />
      )}
    </button>
  );
};
