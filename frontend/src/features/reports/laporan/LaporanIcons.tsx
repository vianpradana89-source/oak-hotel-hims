import React from 'react';

export interface LucideIconProps {
  className?: string;
  size?: number;
  strokeWidth?: number;
}

const BaseSvg: React.FC<LucideIconProps & { children: React.ReactNode }> = ({
  className = 'w-4 h-4',
  size,
  strokeWidth = 1.85,
  children,
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`shrink-0 ${className}`}
  >
    {children}
  </svg>
);

export const IconLayoutGrid: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </BaseSvg>
);

export const IconBuilding2: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
    <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
    <path d="M10 6h4" />
    <path d="M10 10h4" />
    <path d="M10 14h4" />
    <path d="M10 18h4" />
  </BaseSvg>
);

export const IconDollarSign: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <line x1="12" x2="12" y1="2" y2="22" />
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </BaseSvg>
);

export const IconShoppingCart: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <circle cx="8" cy="21" r="1" />
    <circle cx="19" cy="21" r="1" />
    <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
  </BaseSvg>
);

export const IconTrendingUp: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
    <polyline points="16 7 22 7 22 13" />
  </BaseSvg>
);

export const IconTrendingDown: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
    <polyline points="16 17 22 17 22 11" />
  </BaseSvg>
);

export const IconCreditCard: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <rect width="20" height="14" x="2" y="5" rx="2" />
    <line x1="2" x2="22" y1="10" y2="10" />
  </BaseSvg>
);

export const IconGift: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <rect x="3" y="8" width="18" height="4" rx="1" />
    <path d="M12 8v13" />
    <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
    <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
  </BaseSvg>
);

export const IconBadgePercent: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
    <path d="m15 9-6 6" />
    <path d="M9 9h.01" />
    <path d="M15 15h.01" />
  </BaseSvg>
);

export const IconWallet: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
    <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
  </BaseSvg>
);

export const IconBedDouble: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8" />
    <path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" />
    <path d="M12 4v6" />
    <path d="M2 18h20" />
  </BaseSvg>
);

export const IconBarChart3: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </BaseSvg>
);

export const IconSearch: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </BaseSvg>
);

export const IconDownload: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </BaseSvg>
);

export const IconFileText: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </BaseSvg>
);

export const IconFileSpreadsheet: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M8 13h2" />
    <path d="M14 13h2" />
    <path d="M8 17h2" />
    <path d="M14 17h2" />
  </BaseSvg>
);

export const IconRefreshCw: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </BaseSvg>
);

export const IconChevronDown: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="m6 9 6 6 6-6" />
  </BaseSvg>
);

export const IconChevronUp: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="m18 15-6-6-6 6" />
  </BaseSvg>
);

export const IconChevronRight: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="m9 18 6-6-6-6" />
  </BaseSvg>
);

export const IconChevronLeft: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="m15 18-6-6 6-6" />
  </BaseSvg>
);

export const IconCheck: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M20 6 9 17l-5-5" />
  </BaseSvg>
);

export const IconX: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </BaseSvg>
);

export const IconAlertTriangle: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </BaseSvg>
);

export const IconCalendar: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M8 2v4" />
    <path d="M16 2v4" />
    <rect width="18" height="18" x="3" y="4" rx="2" />
    <path d="M3 10h18" />
  </BaseSvg>
);

export const IconClock: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </BaseSvg>
);

export const IconPackage: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
    <path d="M12 22V12" />
    <path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" />
    <path d="m7.5 4.27 9 5.15" />
  </BaseSvg>
);

export const IconColumns2: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M12 3v18" />
  </BaseSvg>
);

export const IconRows2: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M3 12h18" />
  </BaseSvg>
);

export const IconScale: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
    <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
    <path d="M7 21h10" />
    <path d="M12 3v18" />
    <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
  </BaseSvg>
);

export const IconInbox: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </BaseSvg>
);

export const IconFilter: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </BaseSvg>
);

export const IconCopy: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </BaseSvg>
);

export const IconUsers: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </BaseSvg>
);

export const IconXCircle: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="m15 9-6 6" />
    <path d="m9 9 6 6" />
  </BaseSvg>
);

export const IconGlobe: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </BaseSvg>
);

export const IconLayers: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
    <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
    <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
  </BaseSvg>
);

export const IconEye: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </BaseSvg>
);

export const IconReceipt: React.FC<LucideIconProps> = (props) => (
  <BaseSvg {...props}>
    <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
    <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
    <path d="M12 17.5v-11" />
  </BaseSvg>
);

