import React from 'react';
import { getStatusStyle } from './tokens';

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: string | null | undefined;
  customLabel?: string;
  size?: 'sm' | 'md';
  showDot?: boolean;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  customLabel,
  size = 'md',
  showDot = true,
  className = '',
  ...props
}) => {
  const style = getStatusStyle(status);
  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5 gap-1 font-medium' : 'text-xs px-2 py-0.5 gap-1.5 font-semibold';

  return (
    <span
      className={`inline-flex items-center rounded-full border select-none shrink-0 ${sizeClasses} ${style.bgClass} ${style.textClass} ${style.borderClass} ${className}`}
      {...props}
    >
      {showDot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dotClass}`} />}
      <span className="truncate">{customLabel || style.label}</span>
    </span>
  );
};
