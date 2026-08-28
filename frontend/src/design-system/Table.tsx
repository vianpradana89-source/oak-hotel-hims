import React from 'react';

export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  children,
  className = '',
  ...props
}) => (
  <div className="w-full overflow-x-auto rounded-lg border border-slate-200/90 bg-white">
    <table className={`w-full text-left text-xs border-collapse ${className}`} {...props}>
      {children}
    </table>
  </div>
);

export const TableHeader: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  children,
  className = '',
  ...props
}) => (
  <thead className={`bg-[#f8f7f4] text-slate-600 border-b border-slate-200 uppercase font-semibold text-[11px] tracking-wider select-none ${className}`} {...props}>
    {children}
  </thead>
);

export const TableBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  children,
  className = '',
  ...props
}) => (
  <tbody className={`divide-y divide-slate-100 text-slate-700 ${className}`} {...props}>
    {children}
  </tbody>
);

export interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  isSelected?: boolean;
  isClickable?: boolean;
}

export const TableRow: React.FC<TableRowProps> = ({
  children,
  isSelected = false,
  isClickable = false,
  className = '',
  ...props
}) => (
  <tr
    className={`transition-colors duration-100 ${
      isSelected
        ? 'bg-amber-50/60 font-medium'
        : isClickable
        ? 'hover:bg-slate-50 cursor-pointer'
        : 'hover:bg-slate-50/70'
    } ${className}`}
    {...props}
  >
    {children}
  </tr>
);

export interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'center' | 'right';
}

export const TableHead: React.FC<TableHeadProps> = ({
  children,
  align = 'left',
  className = '',
  ...props
}) => {
  const alignClasses = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };
  return (
    <th className={`px-3.5 py-2.5 font-semibold ${alignClasses[align]} ${className}`} {...props}>
      {children}
    </th>
  );
};

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'center' | 'right';
  isMoney?: boolean;
  isMono?: boolean;
}

export const TableCell: React.FC<TableCellProps> = ({
  children,
  align = 'left',
  isMoney = false,
  isMono = false,
  className = '',
  ...props
}) => {
  const alignClasses = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };
  return (
    <td
      className={`px-3.5 py-2.5 ${alignClasses[align]} ${
        isMoney ? 'font-mono font-bold tabular-nums text-slate-900' : isMono ? 'font-mono text-slate-800' : ''
      } ${className}`}
      {...props}
    >
      {children}
    </td>
  );
};
