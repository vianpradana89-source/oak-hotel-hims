import logoPng from '../../../assets/branding/oak-letterhead/logo.png';
import { authenticatedFetch } from '../../../lib/authenticatedFetch';
import { formatIdr } from './laporanUi';

interface PropertyIdentity {
  name: string;
  tagline: string;
  address: string;
  phone: string;
}

const DEFAULT_PROPERTY_IDENTITY: PropertyIdentity = {
  name: 'OAK LAWANG',
  tagline: 'OAK Hotel Integrated Management System',
  address: 'Jl. Dr. Wahidin No.82, Kalirejo, Lawang, Kab. Malang, Jawa Timur 65216',
  phone: '',
};

let cachedPropertyIdentity: PropertyIdentity | null = null;

async function resolvePropertyIdentity(): Promise<PropertyIdentity> {
  if (cachedPropertyIdentity) return cachedPropertyIdentity;
  try {
    const res = await authenticatedFetch('/api/properties');
    if (res.ok) {
      const json = await res.json();
      const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      const prop = rows[0];
      if (prop) {
        cachedPropertyIdentity = {
          name: String(prop.name || DEFAULT_PROPERTY_IDENTITY.name).toUpperCase(),
          tagline: DEFAULT_PROPERTY_IDENTITY.tagline,
          address: String(prop.address || DEFAULT_PROPERTY_IDENTITY.address),
          phone: String(prop.phone || ''),
        };
        return cachedPropertyIdentity;
      }
    }
  } catch {
    // fallback to default OAK Lawang identity
  }
  return DEFAULT_PROPERTY_IDENTITY;
}

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDecimalCurrency(val: number): string {
  const num = Number(val) || 0;
  return num.toLocaleString('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatNowWib(): string {
  return new Date().toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  }) + ' WIB';
}

function buildOakPdfHeaderHtml(opts: {
  identity: PropertyIdentity;
  reportTitle: string;
  sourceLabel: string;
  periodLabel: string;
  extraMetaLabel?: string;
}): string {
  const { identity, reportTitle, sourceLabel, periodLabel, extraMetaLabel } = opts;
  const printedAt = formatNowWib();

  return `
    <div class="oak-acc-pdf-header">
      <div class="oak-acc-pdf-brand">
        <img src="${logoPng}" alt="OAK Logo" class="oak-acc-pdf-logo" />
        <div class="oak-acc-pdf-brand-text">
          <div class="oak-acc-pdf-hotel-name">${escapeHtml(identity.name)}</div>
          <div class="oak-acc-pdf-tagline">${escapeHtml(identity.tagline)}</div>
          <div class="oak-acc-pdf-address">${escapeHtml(identity.address)}${
            identity.phone ? ` • Telp: ${escapeHtml(identity.phone)}` : ''
          }</div>
        </div>
      </div>
      <div class="oak-acc-pdf-doc-box">
        <div class="oak-acc-pdf-doc-title">${escapeHtml(reportTitle)}</div>
        <div class="oak-acc-pdf-meta-row">
          <span class="oak-acc-pdf-source-badge">Sumber: ${escapeHtml(sourceLabel)}</span>
        </div>
        <div class="oak-acc-pdf-meta-sub">Periode: <strong>${escapeHtml(periodLabel)}</strong></div>
        ${
          extraMetaLabel
            ? `<div class="oak-acc-pdf-meta-sub">${escapeHtml(extraMetaLabel)}</div>`
            : ''
        }
        <div class="oak-acc-pdf-meta-time">Dicetak: ${escapeHtml(printedAt)}</div>
      </div>
    </div>
  `;
}

function buildOakPdfFooterHtml(sourceLabel: string): string {
  return `
    <div class="oak-acc-pdf-footer">
      <div class="oak-acc-pdf-signatures">
        <div class="oak-acc-pdf-sig-box">
          <div class="oak-acc-pdf-sig-title">Disiapkan Oleh (Akuntansi)</div>
          <div class="oak-acc-pdf-sig-space"></div>
          <div class="oak-acc-pdf-sig-line">( ............................................ )</div>
        </div>
        <div class="oak-acc-pdf-sig-box">
          <div class="oak-acc-pdf-sig-title">Disetujui Oleh (Manajemen)</div>
          <div class="oak-acc-pdf-sig-space"></div>
          <div class="oak-acc-pdf-sig-line">( ............................................ )</div>
        </div>
      </div>
      <div class="oak-acc-pdf-footer-note">
        Dokumen Resmi OAK HIMS • Sumber Data: ${escapeHtml(sourceLabel)} • Dicetak otomatis dari sistem
      </div>
    </div>
  `;
}

const ACCOUNTING_PDF_CSS = `
  @media screen {
    #oak-accounting-pdf-print-root {
      display: none !important;
    }
  }
  @media print {
    @page {
      size: A4 portrait !important;
      margin: 10mm 12mm !important;
    }
    html, body {
      width: 100% !important;
      max-width: 100% !important;
      height: auto !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #ffffff !important;
      overflow: visible !important;
    }
    body > *:not(#oak-accounting-pdf-print-root) {
      display: none !important;
    }
    #oak-accounting-pdf-print-root,
    #oak-accounting-pdf-print-root * {
      visibility: visible !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    #oak-accounting-pdf-print-root {
      display: block !important;
      position: static !important;
      width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #ffffff !important;
      color: #0f172a !important;
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif !important;
      font-size: 11px !important;
      line-height: 1.45 !important;
    }
    .oak-acc-pdf-header {
      display: flex !important;
      justify-content: space-between !important;
      align-items: flex-start !important;
      gap: 16px !important;
      padding-bottom: 12px !important;
      margin-bottom: 14px !important;
      border-bottom: 2.5px solid #123524 !important;
    }
    .oak-acc-pdf-brand {
      display: flex !important;
      align-items: center !important;
      gap: 12px !important;
      flex: 1 !important;
    }
    .oak-acc-pdf-logo {
      width: 58px !important;
      height: 58px !important;
      object-fit: contain !important;
      flex-shrink: 0 !important;
    }
    .oak-acc-pdf-hotel-name {
      font-size: 18px !important;
      font-weight: 800 !important;
      color: #123524 !important;
      letter-spacing: 0.04em !important;
      line-height: 1.15 !important;
    }
    .oak-acc-pdf-tagline {
      font-size: 10px !important;
      font-weight: 600 !important;
      color: #856404 !important;
      margin-top: 2px !important;
    }
    .oak-acc-pdf-address {
      font-size: 10px !important;
      color: #475569 !important;
      margin-top: 3px !important;
      line-height: 1.35 !important;
      max-width: 340px !important;
    }
    .oak-acc-pdf-doc-box {
      text-align: right !important;
      flex-shrink: 0 !important;
    }
    .oak-acc-pdf-doc-title {
      font-size: 15px !important;
      font-weight: 800 !important;
      color: #123524 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.05em !important;
    }
    .oak-acc-pdf-meta-row {
      margin-top: 4px !important;
      margin-bottom: 4px !important;
    }
    .oak-acc-pdf-source-badge {
      display: inline-block !important;
      padding: 2px 8px !important;
      border-radius: 4px !important;
      background: #123524 !important;
      color: #E6C786 !important;
      font-size: 9.5px !important;
      font-weight: 700 !important;
      letter-spacing: 0.02em !important;
    }
    .oak-acc-pdf-meta-sub {
      font-size: 10px !important;
      color: #334155 !important;
      margin-top: 2px !important;
    }
    .oak-acc-pdf-meta-time {
      font-size: 9.5px !important;
      color: #64748b !important;
      margin-top: 2px !important;
    }
    .oak-acc-pdf-section {
      border: 1px solid #cbd5e1 !important;
      border-radius: 6px !important;
      margin-bottom: 10px !important;
      overflow: hidden !important;
      break-inside: avoid !important;
    }
    .oak-acc-pdf-section-head {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      padding: 6px 12px !important;
      font-weight: 700 !important;
      font-size: 11px !important;
      border-bottom: 1px solid #e2e8f0 !important;
      background: #f8fafc !important;
    }
    .oak-acc-pdf-section-body {
      padding: 6px 12px !important;
    }
    .oak-acc-pdf-row {
      display: flex !important;
      justify-content: space-between !important;
      align-items: baseline !important;
      padding: 4px 0 !important;
      border-bottom: 1px dashed #e2e8f0 !important;
      font-size: 10.5px !important;
    }
    .oak-acc-pdf-row:last-child {
      border-bottom: none !important;
    }
    .oak-acc-pdf-row-bold {
      font-weight: 700 !important;
      color: #0f172a !important;
      border-top: 1px solid #cbd5e1 !important;
      border-bottom: none !important;
      padding-top: 6px !important;
      margin-top: 2px !important;
    }
    .oak-acc-pdf-banner {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      padding: 8px 12px !important;
      border-radius: 6px !important;
      border: 1.5px solid #123524 !important;
      background: #f0fdf4 !important;
      margin-bottom: 10px !important;
      font-weight: 800 !important;
      font-size: 12px !important;
      break-inside: avoid !important;
    }
    .oak-acc-pdf-kpi-grid {
      display: grid !important;
      grid-template-columns: repeat(4, 1fr) !important;
      gap: 8px !important;
      margin-bottom: 12px !important;
    }
    .oak-acc-pdf-kpi-card {
      border: 1px solid #cbd5e1 !important;
      border-radius: 6px !important;
      padding: 8px 10px !important;
      background: #f8fafc !important;
    }
    .oak-acc-pdf-kpi-label {
      font-size: 9.5px !important;
      font-weight: 600 !important;
      color: #475569 !important;
    }
    .oak-acc-pdf-kpi-val {
      font-size: 13px !important;
      font-weight: 800 !important;
      color: #0f172a !important;
      margin-top: 2px !important;
    }
    .oak-acc-pdf-table {
      width: 100% !important;
      border-collapse: collapse !important;
      font-size: 10px !important;
      margin-bottom: 12px !important;
    }
    .oak-acc-pdf-table th {
      background: #123524 !important;
      color: #ffffff !important;
      font-weight: 700 !important;
      text-align: left !important;
      padding: 6px 8px !important;
      border: 1px solid #123524 !important;
    }
    .oak-acc-pdf-table td {
      padding: 5px 8px !important;
      border: 1px solid #cbd5e1 !important;
      vertical-align: top !important;
    }
    .oak-acc-pdf-table tr {
      break-inside: avoid !important;
    }
    .oak-acc-pdf-footer {
      margin-top: 18px !important;
      padding-top: 10px !important;
      border-top: 1px solid #cbd5e1 !important;
      break-inside: avoid !important;
    }
    .oak-acc-pdf-signatures {
      display: grid !important;
      grid-template-columns: 1fr 1fr !important;
      gap: 32px !important;
      text-align: center !important;
      margin-bottom: 10px !important;
    }
    .oak-acc-pdf-sig-title {
      font-size: 10px !important;
      font-weight: 700 !important;
      color: #334155 !important;
    }
    .oak-acc-pdf-sig-space {
      height: 44px !important;
    }
    .oak-acc-pdf-sig-line {
      font-size: 10px !important;
      font-weight: 600 !important;
      color: #475569 !important;
    }
    .oak-acc-pdf-footer-note {
      text-align: center !important;
      font-size: 9px !important;
      color: #64748b !important;
      border-top: 1px dashed #e2e8f0 !important;
      padding-top: 6px !important;
    }
  }
`;

async function mountAndPrintAccountingHtml(innerHtml: string): Promise<void> {
  // Remove any leftover print root/styles
  document.getElementById('oak-accounting-pdf-print-root')?.remove();
  document.getElementById('oak-accounting-pdf-print-style')?.remove();
  document.getElementById('oak-thermal-print-page-style')?.remove();

  const styleEl = document.createElement('style');
  styleEl.id = 'oak-accounting-pdf-print-style';
  styleEl.textContent = ACCOUNTING_PDF_CSS;
  document.head.appendChild(styleEl);

  const rootEl = document.createElement('div');
  rootEl.id = 'oak-accounting-pdf-print-root';
  rootEl.innerHTML = innerHtml;
  document.body.appendChild(rootEl);

  // Wait for logo image to load before opening print dialog
  const imgs = Array.from(rootEl.querySelectorAll('img'));
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }
          img.onload = () => resolve();
          img.onerror = () => resolve();
          setTimeout(resolve, 600);
        })
    )
  );

  const cleanup = () => {
    document.getElementById('oak-accounting-pdf-print-root')?.remove();
    document.getElementById('oak-accounting-pdf-print-style')?.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  window.print();
}

export async function printLabaRugiPdf(params: {
  startDate: string;
  endDate: string;
  pendapatanKamar: number;
  pendapatanPos: number;
  pendapatanLain: number;
  potonganDiskon: number;
  subTotalPendapatan: number;
  hppProduk: number;
  subTotalHpp: number;
  labaKotor: number;
  expCategories: Array<{ category_code: string; category_name: string; total: number }>;
  subTotalPengeluaran: number;
  stokKeluarVal: number;
  opnameStokVal: number;
  totalStokVal: number;
  poDiskon: number;
  poPengiriman: number;
  poPajak: number;
  totalPembelianAdj: number;
  labaBersih: number;
}): Promise<void> {
  const identity = await resolvePropertyIdentity();
  const sourceLabel = 'Akuntansi — Laporan Laba Rugi';
  const periodLabel = `${params.startDate} s/d ${params.endDate}`;

  const expRowsHtml =
    params.expCategories.length === 0
      ? `<div class="oak-acc-pdf-row"><span>Tidak ada pengeluaran pada periode ini</span><span>Rp 0</span></div>`
      : params.expCategories
          .map(
            (c) => `
          <div class="oak-acc-pdf-row">
            <span>${escapeHtml(c.category_name)}</span>
            <span>${escapeHtml(formatIdr(c.total))}</span>
          </div>`
          )
          .join('');

  const html = `
    ${buildOakPdfHeaderHtml({
      identity,
      reportTitle: 'LAPORAN LABA / RUGI',
      sourceLabel,
      periodLabel,
    })}

    <!-- A. Pendapatan -->
    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head">
        <span>A. Pendapatan</span>
        <span style="color:#047857;">${escapeHtml(formatIdr(params.subTotalPendapatan))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div class="oak-acc-pdf-row">
          <span>Penjualan Kamar (Room Revenue)</span>
          <span>${escapeHtml(formatIdr(params.pendapatanKamar))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Penjualan Produk & POS (F&B)</span>
          <span>${escapeHtml(formatIdr(params.pendapatanPos))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Pemasukan Lain (Non-Kamar / Non-POS)</span>
          <span>${escapeHtml(formatIdr(params.pendapatanLain))}</span>
        </div>
        ${
          params.potonganDiskon > 0
            ? `<div class="oak-acc-pdf-row" style="color:#6d28d9;">
                <span>Informasi Potongan Diskon (Kamar & POS)</span>
                <span>(${escapeHtml(formatIdr(params.potonganDiskon))})</span>
              </div>`
            : ''
        }
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>Sub Total Pendapatan</span>
          <span style="color:#047857;">${escapeHtml(formatIdr(params.subTotalPendapatan))}</span>
        </div>
      </div>
    </div>

    <!-- B. HPP -->
    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head">
        <span>B. Harga Pokok Penjualan (HPP)</span>
        <span style="color:#c2410c;">${escapeHtml(formatIdr(params.subTotalHpp))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div class="oak-acc-pdf-row">
          <span>HPP Produk & F&B Terjual</span>
          <span>${escapeHtml(formatIdr(params.hppProduk))}</span>
        </div>
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>Sub Total HPP</span>
          <span style="color:#c2410c;">${escapeHtml(formatIdr(params.subTotalHpp))}</span>
        </div>
      </div>
    </div>

    <!-- C. Laba Kotor -->
    <div class="oak-acc-pdf-banner" style="background:#eff6ff !important; border-color:#1d4ed8 !important;">
      <div>
        <div>C. Laba Kotor</div>
        <div style="font-size:9.5px; font-weight:500; color:#475569;">Pendapatan - HPP</div>
      </div>
      <div style="color:#1d4ed8; font-size:13px;">${escapeHtml(formatIdr(params.labaKotor))}</div>
    </div>

    <!-- D. Pengeluaran -->
    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head">
        <span>D. Pengeluaran Operasional</span>
        <span style="color:#be123c;">${escapeHtml(formatIdr(params.subTotalPengeluaran))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        ${expRowsHtml}
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>Sub Total Pengeluaran</span>
          <span style="color:#be123c;">${escapeHtml(formatIdr(params.subTotalPengeluaran))}</span>
        </div>
      </div>
    </div>

    <!-- E. Stok -->
    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head">
        <span>E. Stok (Stok Keluar & Opname)</span>
        <span style="color:#6d28d9;">${escapeHtml(formatIdr(params.totalStokVal))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div class="oak-acc-pdf-row">
          <span>Stok Keluar (Nilai Barang)</span>
          <span>${escapeHtml(formatIdr(params.stokKeluarVal))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Opname Stok (Nilai Opname)</span>
          <span>${escapeHtml(formatIdr(params.opnameStokVal))}</span>
        </div>
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>Total Stok</span>
          <span style="color:#6d28d9;">${escapeHtml(formatIdr(params.totalStokVal))}</span>
        </div>
      </div>
    </div>

    <!-- F. Pembelian -->
    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head">
        <span>F. Pembelian (Diskon, Pengiriman & Pajak)</span>
        <span style="color:#3730a3;">${escapeHtml(formatIdr(params.totalPembelianAdj))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div class="oak-acc-pdf-row">
          <span>Nilai Diskon Pembelian</span>
          <span>${escapeHtml(formatIdr(params.poDiskon))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Biaya Pengiriman</span>
          <span>${escapeHtml(formatIdr(params.poPengiriman))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Nilai Pajak Pembelian</span>
          <span>${escapeHtml(formatIdr(params.poPajak))}</span>
        </div>
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>Total Pembelian (Diskon - Pengiriman - Pajak)</span>
          <span style="color:#3730a3;">${escapeHtml(formatIdr(params.totalPembelianAdj))}</span>
        </div>
      </div>
    </div>

    <!-- G. Laba Bersih -->
    <div class="oak-acc-pdf-banner">
      <div>
        <div>G. Laba / Rugi Bersih</div>
        <div style="font-size:9.5px; font-weight:500; color:#123524;">Laba Kotor - Pengeluaran + Stok + Pembelian</div>
      </div>
      <div style="color:${params.labaBersih >= 0 ? '#047857' : '#be123c'}; font-size:14px;">
        ${escapeHtml(formatIdr(params.labaBersih))}
      </div>
    </div>

    ${buildOakPdfFooterHtml(sourceLabel)}
  `;

  await mountAndPrintAccountingHtml(html);
}

export async function printArusKasPdf(params: {
  startDate: string;
  endDate: string;
  saldoAwal: number;
  op: {
    customer_receipts: number;
    supplier_payments: number;
    operating_expenses: number;
    maintenance_expenses: number;
    other_income_receipts: number;
    other_expenses: number;
    stock_opname_adjustment: number;
    stock_out_adjustment: number;
    subtotal_operating: number;
  };
  invSubtotal: number;
  totalPendapatanCf: number;
  finSubtotal: number;
  kenaikanKas: number;
  saldoAkhir: number;
}): Promise<void> {
  const identity = await resolvePropertyIdentity();
  const sourceLabel = 'Akuntansi — Laporan Arus Kas';
  const periodLabel = `${params.startDate} s/d ${params.endDate}`;
  const { op } = params;

  const html = `
    ${buildOakPdfHeaderHtml({
      identity,
      reportTitle: 'LAPORAN ARUS KAS',
      sourceLabel,
      periodLabel,
    })}

    <div class="oak-acc-pdf-banner" style="background:#f8fafc !important; border-color:#334155 !important;">
      <span>Saldo Kas Awal</span>
      <span>Rp ${escapeHtml(formatDecimalCurrency(params.saldoAwal))}</span>
    </div>

    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head" style="background:#0284c7 !important; color:#ffffff !important;">
        <span>1. Aktivitas Operasional</span>
        <span>Rp ${escapeHtml(formatDecimalCurrency(op.subtotal_operating))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div class="oak-acc-pdf-row">
          <span>Penerimaan dari pelanggan</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.customer_receipts))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Pembayaran ke pemasok</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.supplier_payments))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Biaya operasional</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.operating_expenses))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Biaya perawatan</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.maintenance_expenses))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Pendapatan lain</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.other_income_receipts))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Pengeluaran lain</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.other_expenses))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Opname stok (penyesuaian)</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.stock_opname_adjustment))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Stok keluar (penyesuaian)</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.stock_out_adjustment))}</span>
        </div>
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>SubTotal Aktivitas Operasional</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(op.subtotal_operating))}</span>
        </div>
      </div>
    </div>

    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head">
        <span>2. Aktivitas Investasi</span>
        <span>Rp ${escapeHtml(formatDecimalCurrency(params.invSubtotal))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>SubTotal Aktivitas Investasi</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(params.invSubtotal))}</span>
        </div>
      </div>
    </div>

    <div class="oak-acc-pdf-banner" style="background:#eff6ff !important; border-color:#0284c7 !important;">
      <span>Total Pendapatan (Setelah Aktivitas Investasi)</span>
      <span>Rp ${escapeHtml(formatDecimalCurrency(params.totalPendapatanCf))}</span>
    </div>

    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head">
        <span>3. Aktivitas Pendanaan</span>
        <span>Rp ${escapeHtml(formatDecimalCurrency(params.finSubtotal))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>SubTotal Aktivitas Pendanaan</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(params.finSubtotal))}</span>
        </div>
      </div>
    </div>

    <div class="oak-acc-pdf-banner" style="background:#f8fafc !important; border-color:#475569 !important;">
      <span>Total Kenaikan / Penurunan Kas</span>
      <span>Rp ${escapeHtml(formatDecimalCurrency(params.kenaikanKas))}</span>
    </div>

    <div class="oak-acc-pdf-banner">
      <span>Saldo Kas Akhir</span>
      <span style="color:#123524; font-size:14px;">Rp ${escapeHtml(formatDecimalCurrency(params.saldoAkhir))}</span>
    </div>

    ${buildOakPdfFooterHtml(sourceLabel)}
  `;

  await mountAndPrintAccountingHtml(html);
}

export async function printNeracaPdf(params: {
  startDate: string;
  endDate: string;
  ca: {
    cash_on_hand: number;
    bank_account: number;
    transfer_bank: number;
    qris_balance: number;
    card_edc: number;
    short_term_investment: number;
    accounts_receivable: number;
    inventory_value: number;
    subtotal_current_assets: number;
  };
  nca: {
    fixed_assets: number;
    subtotal_non_current_assets: number;
  };
  totalAset: number;
  kew: {
    accounts_payable: number;
    guest_deposits: number;
    subtotal_liabilities: number;
  };
  mod: {
    retained_earnings: number;
    current_period_income: number;
    subtotal_equity: number;
  };
  totalKewajibanModal: number;
}): Promise<void> {
  const identity = await resolvePropertyIdentity();
  const sourceLabel = 'Akuntansi — Laporan Neraca';
  const periodLabel = `s/d ${params.endDate} (Periode ${params.startDate} – ${params.endDate})`;
  const { ca, nca, kew, mod } = params;

  const html = `
    ${buildOakPdfHeaderHtml({
      identity,
      reportTitle: 'LAPORAN NERACA',
      sourceLabel,
      periodLabel,
    })}

    <!-- SISI ASET -->
    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head" style="background:#0284c7 !important; color:#ffffff !important;">
        <span>ASET</span>
        <span>Rp ${escapeHtml(formatDecimalCurrency(params.totalAset))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div style="font-weight:700; color:#1e293b; padding:4px 0;">Aset Lancar</div>
        <div class="oak-acc-pdf-row">
          <span>11101 - Kas</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.cash_on_hand))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>11102 - Bank</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.bank_account))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>11105 - Transfer BCA / Bank</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.transfer_bank))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>11106 - Qris</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.qris_balance))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>11107 - Kartu Debit / Kredit</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.card_edc))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>11200 - Investasi jangka pendek dan surat berharga</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.short_term_investment))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>11300 - Piutang</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.accounts_receivable))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>11400 - Persediaan Barang Dagang</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.inventory_value))}</span>
        </div>
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>SubTotal Aset Lancar</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(ca.subtotal_current_assets))}</span>
        </div>

        <div style="font-weight:700; color:#1e293b; padding:8px 0 4px;">Aset Tidak Lancar</div>
        <div class="oak-acc-pdf-row">
          <span>12000 - Aset Tetap</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(nca.fixed_assets))}</span>
        </div>
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>SubTotal Aset Tidak Lancar</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(nca.subtotal_non_current_assets))}</span>
        </div>
      </div>
    </div>

    <div class="oak-acc-pdf-banner">
      <span>TOTAL ASET</span>
      <span>Rp ${escapeHtml(formatDecimalCurrency(params.totalAset))}</span>
    </div>

    <!-- SISI KEWAJIBAN DAN MODAL -->
    <div class="oak-acc-pdf-section">
      <div class="oak-acc-pdf-section-head" style="background:#0284c7 !important; color:#ffffff !important;">
        <span>KEWAJIBAN DAN MODAL</span>
        <span>Rp ${escapeHtml(formatDecimalCurrency(params.totalKewajibanModal))}</span>
      </div>
      <div class="oak-acc-pdf-section-body">
        <div style="font-weight:700; color:#1e293b; padding:4px 0;">Kewajiban</div>
        <div class="oak-acc-pdf-row">
          <span>21000 - Hutang Usaha</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(kew.accounts_payable))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>21100 - Deposit Tamu Berjalan</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(kew.guest_deposits))}</span>
        </div>
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>SubTotal Kewajiban</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(kew.subtotal_liabilities))}</span>
        </div>

        <div style="font-weight:700; color:#1e293b; padding:8px 0 4px;">Modal</div>
        <div class="oak-acc-pdf-row">
          <span>Modal & Laba Ditahan</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(mod.retained_earnings))}</span>
        </div>
        <div class="oak-acc-pdf-row">
          <span>Pendapatan periode ini</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(mod.current_period_income))}</span>
        </div>
        <div class="oak-acc-pdf-row oak-acc-pdf-row-bold">
          <span>SubTotal Modal</span>
          <span>Rp ${escapeHtml(formatDecimalCurrency(mod.subtotal_equity))}</span>
        </div>
      </div>
    </div>

    <div class="oak-acc-pdf-banner">
      <span>TOTAL KEWAJIBAN DAN MODAL</span>
      <span>Rp ${escapeHtml(formatDecimalCurrency(params.totalKewajibanModal))}</span>
    </div>

    ${buildOakPdfFooterHtml(sourceLabel)}
  `;

  await mountAndPrintAccountingHtml(html);
}

export async function printJurnalUmumPdf(params: {
  startDate: string;
  endDate: string;
  badgeFilter: string;
  searchQuery: string;
  totalIn: number;
  totalOut: number;
  closingBalance: number;
  rows: Array<{
    id: string;
    bid_or_ref: string;
    badge_type: string;
    tx_datetime: string;
    description: string;
    payment_method: string;
    cash_in: number;
    cash_out: number;
    running_balance: number;
  }>;
}): Promise<void> {
  const identity = await resolvePropertyIdentity();
  const filterNote =
    params.badgeFilter && params.badgeFilter !== 'ALL'
      ? `Kategori: ${params.badgeFilter}`
      : 'Kategori: Semua Transaksi';
  const sourceLabel = `Akuntansi — Jurnal Umum (${filterNote})`;
  const periodLabel = `${params.startDate} s/d ${params.endDate}`;

  const tableRowsHtml =
    params.rows.length === 0
      ? `<tr><td colspan="8" style="text-align:center; padding:16px; color:#64748b;">Tidak ada transaksi jurnal pada periode dan filter ini.</td></tr>`
      : params.rows
          .map(
            (r, idx) => `
          <tr>
            <td style="text-align:center;">${idx + 1}</td>
            <td>
              <div style="font-weight:700; color:#0f172a;">${escapeHtml(r.bid_or_ref)}</div>
              <div style="font-size:9px; color:#475569;">${escapeHtml(r.badge_type)}</div>
            </td>
            <td style="white-space:nowrap;">${escapeHtml(r.tx_datetime)}</td>
            <td>${escapeHtml(r.description)}</td>
            <td style="white-space:nowrap; font-weight:600;">${escapeHtml(r.payment_method)}</td>
            <td style="text-align:right; font-weight:700; color:#047857; white-space:nowrap;">
              ${r.cash_in > 0 ? escapeHtml(formatIdr(r.cash_in)) : '-'}
            </td>
            <td style="text-align:right; font-weight:700; color:#be123c; white-space:nowrap;">
              ${r.cash_out > 0 ? escapeHtml(formatIdr(r.cash_out)) : '-'}
            </td>
            <td style="text-align:right; font-weight:800; color:#0f172a; white-space:nowrap;">
              ${escapeHtml(formatIdr(r.running_balance))}
            </td>
          </tr>`
          )
          .join('');

  const html = `
    ${buildOakPdfHeaderHtml({
      identity,
      reportTitle: 'LAPORAN JURNAL UMUM',
      sourceLabel: 'Akuntansi — Jurnal Umum',
      periodLabel,
      extraMetaLabel: `${filterNote}${params.searchQuery ? ` • Pencarian: "${params.searchQuery}"` : ''}`,
    })}

    <div class="oak-acc-pdf-kpi-grid">
      <div class="oak-acc-pdf-kpi-card" style="background:#ecfdf5 !important; border-color:#a7f3d0 !important;">
        <div class="oak-acc-pdf-kpi-label">Total Uang Masuk</div>
        <div class="oak-acc-pdf-kpi-val" style="color:#047857 !important;">${escapeHtml(formatIdr(params.totalIn))}</div>
      </div>
      <div class="oak-acc-pdf-kpi-card" style="background:#fff1f2 !important; border-color:#fecdd3 !important;">
        <div class="oak-acc-pdf-kpi-label">Total Uang Keluar</div>
        <div class="oak-acc-pdf-kpi-val" style="color:#be123c !important;">${escapeHtml(formatIdr(params.totalOut))}</div>
      </div>
      <div class="oak-acc-pdf-kpi-card" style="background:#FDFBF7 !important; border-color:#E6C786 !important;">
        <div class="oak-acc-pdf-kpi-label">Saldo Akhir</div>
        <div class="oak-acc-pdf-kpi-val" style="color:#123524 !important;">${escapeHtml(formatIdr(params.closingBalance))}</div>
      </div>
      <div class="oak-acc-pdf-kpi-card">
        <div class="oak-acc-pdf-kpi-label">Jumlah Transaksi</div>
        <div class="oak-acc-pdf-kpi-val">${params.rows.length} Baris</div>
      </div>
    </div>

    <table class="oak-acc-pdf-table">
      <thead>
        <tr>
          <th style="width:28px; text-align:center;">#</th>
          <th style="width:120px;">BID / No. Ref</th>
          <th style="width:95px;">Tanggal</th>
          <th>Keterangan</th>
          <th style="width:80px;">Metode Bayar</th>
          <th style="width:95px; text-align:right;">Uang Masuk</th>
          <th style="width:95px; text-align:right;">Uang Keluar</th>
          <th style="width:105px; text-align:right;">Saldo</th>
        </tr>
      </thead>
      <tbody>
        ${tableRowsHtml}
      </tbody>
    </table>

    ${buildOakPdfFooterHtml(sourceLabel)}
  `;

  await mountAndPrintAccountingHtml(html);
}
