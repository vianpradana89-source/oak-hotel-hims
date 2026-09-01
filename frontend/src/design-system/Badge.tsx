import React from 'react';

export type BadgeVariant =
  | 'neutral'
  | 'primary'
  | 'gold'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export type BadgeSize = 'sm' | 'md';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'neutral',
  size = 'md',
  dot = false,
  className = '',
  ...props
}) => {
  const sizeClasses: Record<BadgeSize, string> = {
    sm: 'text-oak-badge px-1.5 py-0.5 gap-1',
    md: 'text-oak-badge px-2 py-0.5 gap-1.5',
  };

  const variantClasses: Record<BadgeVariant, { container: string; dot: string }> = {
    neutral: {
      container: 'bg-slate-100 text-slate-700 border border-slate-200/80',
      dot: 'bg-slate-400',
    },
    primary: {
      container: 'bg-[#eaf2ec] text-[#1b4332] border border-[#1b4332]/20',
      dot: 'bg-[#1b4332]',
    },
    gold: {
      container: 'bg-[#fbf7ee] text-[#8f713a] border border-[#d4af37]/30',
      dot: 'bg-[#b89758]',
    },
    success: {
      container: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
      dot: 'bg-emerald-500',
    },
    warning: {
      container: 'bg-amber-50 text-amber-700 border border-amber-200',
      dot: 'bg-amber-500',
    },
    danger: {
      container: 'bg-rose-50 text-rose-700 border border-rose-200',
      dot: 'bg-rose-500',
    },
    info: {
      container: 'bg-blue-50 text-blue-700 border border-blue-200',
      dot: 'bg-blue-500',
    },
  };

  const currentVariant = variantClasses[variant] || variantClasses.neutral;

  return (
    <span
      className={`inline-flex items-center rounded-full select-none shrink-0 ${sizeClasses[size]} ${currentVariant.container} ${className}`}
      {...props}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${currentVariant.dot}`} />}
      {children}
    </span>
  );
};
