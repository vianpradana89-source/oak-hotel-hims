/**
 * Excel export for the 7-tab Laporan workspace.
 *
 * No external xlsx library is installed in this project; we generate a
 * SpreadsheetML 2003 XML workbook that Excel opens directly, with a minimal
 * HTML fallback sheet for viewers that expect a .html file. The output is a
 * single self-contained .xml file that Excel can open (File → Open).
 *
 * If a real xlsx library is introduced later, replace this module with the
 * new implementation without touching the tab components.
 */

import type {
  AnalyticsHubData,
  FinancialsData,
} from './laporanTypes';
import type { DailyKpiData, DailyOperationsData } from './useDailyOperations';

type ExportRow = Array<string | number>;

interface ExportSheet {
  name: string;
  rows: ExportRow[];
}

function toCell(value: string | number): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<Cell ss:StyleID="s20"><Data ss:Type="Number">${value}</Data></Cell>`;
  }
  const safe = String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<Cell ss:StyleID="s20"><Data ss:Type="String">${safe}</Data></Cell>`;
}

function sheetXml(name: string, rows: ExportRow[]): string {
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const gridCols = Array.from({ length: maxCols }, () =>
    `<Column ss:Width="140"/>`
  ).join('');
  const body = rows
    .map(
      (r) =>
        `<Row>${Array.from({ length: maxCols })
          .map((_, i) => toCell(r[i] ?? ''))
          .join('')}</Row>`
    )
    .join('\n');
  return `<Worksheet ss:Name="${name.replace(/[\\/?*\[\]]/g, '_').slice(0, 31)}"><Table>${gridCols}${body}</Table></Worksheet>`;
}

function workbookXml(sheets: ExportSheet[]): string {
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
 <Style ss:ID="s20"><Font ss:Bold="0"/><Alignment ss:WrapText="0"/></Style>
</Styles>
<WorkbookOptions/>
${sheets.map((s) => sheetXml(s.name, s.rows)).join('\n')}
</Workbook>`;
}

export function downloadExportXml(filename: string, sheets: ExportSheet[]): void {
  const xml = workbookXml(sheets);
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const money = (v: number | string | null | undefined) => Number(v ?? 0) || 0;

export function buildLaporanSheets(opts: {
  rangeLabel: string;
  dailyOps: DailyOperationsData | null;
  dailyKpis: DailyKpiData | null;
  financials: FinancialsData | null;
  analytics: AnalyticsHubData | null;
}): ExportSheet[] {
  const { rangeLabel, dailyOps, dailyKpis, financials, analytics } = opts;

  const sheets: ExportSheet[] = [];

  // Keseluruhan
  const overallRows: ExportRow[] = [
    ['Laporan Keseluruhan', rangeLabel],
    [],
    ['Metrik', 'Nilai'],
  ];
  if (dailyOps) {
    overallRows.push(
      ['Arrivals', dailyOps.business_date_metrics?.arrivals ?? 0],
      ['Departures', dailyOps.business_date_metrics?.departures ?? 0],
      ['Cash Collected', money(dailyOps.business_date_metrics?.cash_collected)],
      ['In-House', dailyOps.live_snapshot?.in_house_current ?? 0],
      ['Booked Active', dailyOps.live_snapshot?.booked_active ?? 0],
      ['Outstanding Guest Balance', money(dailyOps.live_snapshot?.outstanding_guest_balance_current)],
      ['Total Active Rooms', dailyOps.live_snapshot?.total_active_rooms ?? 0]
    );
  }
  if (financials) {
    overallRows.push(
      [],
      ['Pemasukan Total', money(financials.income.total)],
      ['Pengeluaran Total', money(financials.expense.total)],
      ['Pembelian Total', money(financials.purchase.total)],
      ['Pemasukan - Pengeluaran', money(financials.income.total - financials.expense.total)]
    );
  }
  sheets.push({ name: 'Keseluruhan', rows: overallRows });

  // Pemasukan
  const incomeRows: ExportRow[] = [['Metode Pembayaran', 'Total', 'Jumlah']];
  if (financials) {
    for (const m of financials.income.by_payment_method || []) {
      incomeRows.push([m.method, money(m.total), m.count]);
    }
    incomeRows.push([]);
    incomeRows.push(['Kategori', 'Kode', 'Total', 'Jumlah']);
    for (const c of financials.income.by_category || []) {
      incomeRows.push([c.category_name, c.category_code, money(c.total), c.count]);
    }
  }
  sheets.push({ name: 'Pemasukan', rows: incomeRows });

  // Pengeluaran
  const expenseRows: ExportRow[] = [
    ['Kategori', 'Kode', 'Departemen', 'Total', 'Jumlah'],
  ];
  if (financials) {
    const byDept = new Map<string, number>();
    for (const d of financials.expense.by_department || []) {
      byDept.set(d.department_code, money(d.total));
    }
    for (const c of financials.expense.by_category || []) {
      expenseRows.push([c.category_name, c.category_code, '', money(c.total), c.count]);
    }
    expenseRows.push([]);
    expenseRows.push(['Departemen', '', 'Total', '', '']);
    for (const d of financials.expense.by_department || []) {
      expenseRows.push([d.department_code, '', money(d.total), '', d.count]);
    }
  }
  sheets.push({ name: 'Pengeluaran', rows: expenseRows });

  // Pembelian
  const purchaseRows: ExportRow[] = [
    ['Tanggal', 'No. Transaksi', 'Supplier', 'Item', 'Qty', 'Harga', 'Total', 'Status'],
  ];
  if (analytics) {
    for (const p of analytics.purchase_lines || []) {
      purchaseRows.push([
        p.transaction_date,
        p.transaction_no,
        p.supplier_name,
        p.item_name,
        money(p.quantity),
        money(p.unit_price),
        money(p.line_total),
        p.payment_status,
      ]);
    }
  }
  sheets.push({ name: 'Pembelian', rows: purchaseRows });

  // Penjualan Kamar
  const roomSalesRows: ExportRow[] = [
    [
      'No. Booking',
      'Tanggal',
      'Pelanggan',
      'Room',
      'Durasi (Malam)',
      'Total Biaya',
      'Room Rate',
      'Diskon',
      'Jumlah Bayar',
      'Status',
      'Metode Bayar',
    ],
  ];
  if (analytics) {
    for (const r of analytics.room_sales || []) {
      const netTotal = money(r.total_price);
      const disc = money(r.discount_amount);
      const totalBiaya = r.is_complimentary ? netTotal : netTotal + disc;
      const nights = Math.max(1, Number(r.period_nights ?? r.nights) || 1);
      const isDayUse =
        String(r.stay_type || '').toUpperCase().includes('DAY') ||
        String(r.stay_type || '').toUpperCase().includes('SHORT');
      const roomRate = isDayUse
        ? totalBiaya
        : money(r.room_rate) > 0
        ? money(r.room_rate)
        : Math.round(totalBiaya / nights);
      roomSalesRows.push([
        r.booking_code,
        r.tx_datetime || r.tx_date,
        r.guest_name,
        `${r.room_number} ${r.room_type_name}`,
        isDayUse ? 'Day Use' : `${nights} malam`,
        totalBiaya,
        roomRate,
        disc,
        r.is_complimentary ? 0 : money(r.amount_paid) > 0 ? money(r.amount_paid) : netTotal,
        r.reservation_status,
        r.payment_method,
      ]);
    }
  }
  sheets.push({ name: 'Penjualan Kamar', rows: roomSalesRows });

  // Penjualan POS
  const salesRows: ExportRow[] = [
    ['Tanggal', 'No. Order', 'Item', 'Kategori', 'Qty', 'Harga', 'Total', 'HPP', 'Metode'],
  ];
  if (analytics) {
    for (const s of analytics.pos_item_sales || []) {
      salesRows.push([
        s.tx_date,
        s.booking_or_order_no,
        s.item_name,
        s.category_name,
        money(s.quantity),
        money(s.unit_price),
        money(s.line_total),
        money(s.total_hpp),
        s.payment_method,
      ]);
    }
  }
  sheets.push({ name: 'Penjualan', rows: salesRows });

  // Metode Bayar
  const methodRows: ExportRow[] = [
    ['Metode', 'Booking', 'POS', 'Income', 'Purchase', 'Expense', 'Grand Total', 'Grand Count'],
  ];
  if (financials) {
    for (const m of financials.payment_method_summary || []) {
      methodRows.push([
        m.method,
        money(m.booking_total),
        money(m.pos_total),
        money(m.income_total),
        money(m.purchase_total),
        money(m.expense_total),
        money(m.grand_total),
        m.grand_count,
      ]);
    }
  }
  sheets.push({ name: 'Metode Bayar', rows: methodRows });

  // Kinerja Kamar
  const kpiRows: ExportRow[] = [
    ['KPI', 'Nilai'],
  ];
  if (dailyKpis) {
    kpiRows.push(
      ['Occupancy %', dailyKpis.occupancy.occupancy_pct ?? 0],
      ['Occupied Rooms', dailyKpis.occupancy.occupied_rooms],
      ['Sellable Rooms', dailyKpis.occupancy.sellable_rooms],
      ['OOO/OOS', dailyKpis.occupancy.ooo_oos_rooms],
      ['Booked Rooms', dailyKpis.booked_today.rooms],
      ['Booked Bookings', dailyKpis.booked_today.bookings],
      ['Check-in Rooms', dailyKpis.check_in_today.rooms],
      ['Check-out Rooms', dailyKpis.check_out_today.rooms],
      ['Kamar Kotor', dailyKpis.rooms.dirty],
      ['Kamar Bersih', dailyKpis.rooms.vacant_clean]
    );
  }
  sheets.push({ name: 'Kinerja Kamar', rows: kpiRows });

  return sheets;
}
