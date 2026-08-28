import React from 'react';

export type ButtonVariant =
  | 'primary'      // Forest Green primary operational action
  | 'secondary'    // White surface / slate outline
  | 'ghost'        // Transparent with hover
  | 'danger'       // Rose red destructive action
  | 'warning'      // Amber warning / correction action
  | 'gold';        // Muted gold brand accent

export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
  isLoading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  isLoading = false,
  className = '',
  disabled,
  ...props
}) => {
  const sizeClasses: Record<ButtonSize, string> = {
    sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md font-medium',
    md: 'h-9 px-3.5 text-xs gap-2 rounded-md font-medium',
    lg: 'h-10 px-4 text-sm gap-2.5 rounded-lg font-semibold',
  };

  const variantClasses: Record<ButtonVariant, string> = {
    primary: 'bg-[#1b4332] hover:bg-[#143527] active:bg-[#0f291e] text-white border border-[#1b4332] shadow-xs focus:ring-2 focus:ring-[#1b4332]/30',
    secondary: 'bg-white hover:bg-slate-50 active:bg-slate-100 text-slate-700 border border-slate-300 shadow-xs hover:border-slate-400 focus:ring-2 focus:ring-slate-300/50',
    ghost: 'bg-transparent hover:bg-slate-100/80 active:bg-slate-200 text-slate-600 border border-transparent focus:ring-2 focus:ring-slate-300/40',
    danger: 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white border border-rose-600 shadow-xs focus:ring-2 focus:ring-rose-500/30',
    warning: 'bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white border border-amber-600 shadow-xs focus:ring-2 focus:ring-amber-500/30',
    gold: 'bg-[#b89758] hover:bg-[#a6864a] active:bg-[#94753c] text-white border border-[#b89758] shadow-xs focus:ring-2 focus:ring-[#b89758]/30',
  };

  return (
    <button
      type={props.type || 'button'}
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center select-none transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none focus:outline-none ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {isLoading ? (
        <svg
          className="animate-spin h-3.5 w-3.5 text-current shrink-0"
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
        icon && <span className="shrink-0">{icon}</span>
      )}
      {children && <span>{children}</span>}
      {!isLoading && iconRight && <span className="shrink-0">{iconRight}</span>}
    </button>
  );
};
