import React from 'react';
import type { ButtonVariant, ButtonSize } from './Button';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon: React.ReactNode;
  label: string; // Accessible label
  isLoading?: boolean;
}

export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  isLoading = false,
  className = '',
  disabled,
  ...props
}) => {
  const sizeClasses: Record<ButtonSize, string> = {
    sm: 'w-8 h-8 text-oak-button rounded-md',
    md: 'w-10 h-10 text-oak-button rounded-md',
    lg: 'w-11 h-11 text-oak-button rounded-lg',
  };

  const variantClasses: Record<ButtonVariant, string> = {
    primary: 'bg-[#1b4332] hover:bg-[#143527] active:bg-[#0f291e] text-white border border-[#1b4332] shadow-xs',
    secondary: 'bg-white hover:bg-slate-50 active:bg-slate-100 text-slate-700 border border-slate-300 shadow-xs hover:border-slate-400',
    ghost: 'bg-transparent hover:bg-slate-100 active:bg-slate-200 text-slate-600 border border-transparent',
    danger: 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white border border-rose-600 shadow-xs',
    warning: 'bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white border border-amber-600 shadow-xs',
    gold: 'bg-[#b89758] hover:bg-[#a6864a] active:bg-[#94753c] text-white border border-[#b89758] shadow-xs',
  };

  return (
    <button
      type={props.type || 'button'}
      aria-label={label}
      title={label}
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center shrink-0 select-none transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none focus:outline-none focus:ring-2 focus:ring-slate-400/40 ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {isLoading ? (
        <svg
          className="animate-spin h-3.5 w-3.5 text-current"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      ) : (
        icon
      )}
    </button>
  );
};
