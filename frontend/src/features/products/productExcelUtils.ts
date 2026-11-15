export type ProductTypeCode = 'RAW_MATERIAL' | 'SEMI_FINISHED' | 'FINISHED_GOOD' | 'OPERATIONAL_ITEM';

export interface ProductVariantDto {
  name: string;
  price: number;
  cost_price?: number | null;
  sku?: string | null;
  barcode?: string | null;
}

export interface ParsedExcelProductRow {
  rowNumber: number;
  sku: string;
  barcode: string;
  name: string;
  product_type: ProductTypeCode;
  category_name: string;
  base_unit: string;
  location_code: string;
  storage_sublocation: string;
  stock_qty: number | null;
  cost_price: number;
  price: number | null;
  is_sellable_pos: boolean;
  track_stock: boolean;
  notes: string;
  variants: ProductVariantDto[];
}

// ── CRC32 Table for standard ZIP generation ──────────────────────────────────
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipArchive(files: Array<{ name: string; content: string | Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const nameBytes = encoder.encode(f.name);
    const dataBytes = typeof f.content === 'string' ? encoder.encode(f.content) : f.content;
    const crc = crc32(dataBytes);
    return { nameBytes, dataBytes, crc, offset: 0 };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const entry of entries) {
    entry.offset = localSize;
    localSize += 30 + entry.nameBytes.length + entry.dataBytes.length;
    centralSize += 46 + entry.nameBytes.length;
  }

  const totalSize = localSize + centralSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let pos = 0;

  for (const entry of entries) {
    view.setUint32(pos, 0x04034b50, true); // Local file header signature
    view.setUint16(pos + 4, 20, true); // Version needed to extract (2.0)
    view.setUint16(pos + 6, 0, true); // General purpose bit flag
    view.setUint16(pos + 8, 0, true); // Compression method (0 = STORE)
    view.setUint16(pos + 10, 0, true); // File last modification time
    view.setUint16(pos + 12, 0x596f, true); // File last modification date
    view.setUint32(pos + 14, entry.crc, true);
    view.setUint32(pos + 18, entry.dataBytes.length, true);
    view.setUint32(pos + 22, entry.dataBytes.length, true);
    view.setUint16(pos + 26, entry.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    pos += 30;
    out.set(entry.nameBytes, pos);
    pos += entry.nameBytes.length;
    out.set(entry.dataBytes, pos);
    pos += entry.dataBytes.length;
  }

  const centralDirOffset = pos;
  for (const entry of entries) {
    view.setUint32(pos, 0x02014b50, true); // Central directory file header signature
    view.setUint16(pos + 4, 20, true); // Version made by
    view.setUint16(pos + 6, 20, true); // Version needed to extract
    view.setUint16(pos + 8, 0, true); // General purpose bit flag
    view.setUint16(pos + 10, 0, true); // Compression method (0 = STORE)
    view.setUint16(pos + 12, 0, true);
    view.setUint16(pos + 14, 0x596f, true);
    view.setUint32(pos + 16, entry.crc, true);
    view.setUint32(pos + 20, entry.dataBytes.length, true);
    view.setUint32(pos + 24, entry.dataBytes.length, true);
    view.setUint16(pos + 28, entry.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true);
    view.setUint16(pos + 32, 0, true);
    view.setUint16(pos + 34, 0, true);
    view.setUint16(pos + 36, 0, true);
    view.setUint32(pos + 38, 0, true);
    view.setUint32(pos + 42, entry.offset, true);
    pos += 46;
    out.set(entry.nameBytes, pos);
    pos += entry.nameBytes.length;
  }

  // End of central directory record
  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, entries.length, true);
  view.setUint16(pos + 10, entries.length, true);
  view.setUint32(pos + 12, centralSize, true);
  view.setUint32(pos + 16, centralDirOffset, true);
  view.setUint16(pos + 20, 0, true);

  return out;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnNumberToName(colIndexZeroBased: number): string {
  let n = colIndexZeroBased + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function columnNameToZeroBasedIndex(colLetters: string): number {
  let result = 0;
  const upper = colLetters.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    result = result * 26 + (upper.charCodeAt(i) - 64);
  }
  return result - 1;
}

export function buildXlsxBytes(sheetName: string, rows: Array<Array<string | number | null | undefined>>): Uint8Array {
  const safeSheetName = escapeXml((sheetName || 'Data').slice(0, 31));
  const colsXmlParts: string[] = [];
  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  for (let c = 0; c < maxCols; c++) {
    let maxLen = 12;
    for (let r = 0; r < rows.length; r++) {
      const val = rows[r]?.[c];
      if (val !== null && val !== undefined) {
        maxLen = Math.max(maxLen, Math.min(42, String(val).length + 4));
      }
    }
    colsXmlParts.push(`<col min="${c + 1}" max="${c + 1}" width="${maxLen}" customWidth="1"/>`);
  }

  const rowXmlParts: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const cellXmlParts: string[] = [];
    const isHeader = r === 0;
    for (let c = 0; c < row.length; c++) {
      const rawVal = row[c];
      if (rawVal === null || rawVal === undefined || rawVal === '') continue;
      const cellRef = `${columnNumberToName(c)}${r + 1}`;
      const styleAttr = isHeader ? ' s="1"' : '';
      if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
        cellXmlParts.push(`<c r="${cellRef}"${styleAttr}><v>${rawVal}</v></c>`);
      } else {
        const text = escapeXml(String(rawVal));
        cellXmlParts.push(`<c r="${cellRef}" t="inlineStr"${styleAttr}><is><t>${text}</t></is></c>`);
      }
    }
    rowXmlParts.push(`<row r="${r + 1}">${cellXmlParts.join('')}</row>`);
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4D3A"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
</styleSheet>`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${colsXmlParts.length > 0 ? `<cols>${colsXmlParts.join('')}</cols>` : ''}
  <sheetData>${rowXmlParts.join('')}</sheetData>
</worksheet>`;

  return createZipArchive([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: rootRelsXml },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { name: 'xl/styles.xml', content: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}

function triggerXlsxDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── 4 Template Generators ────────────────────────────────────────────────────

export function downloadProductTemplateXlsx(templateType: ProductTypeCode): void {
  if (templateType === 'FINISHED_GOOD') {
    const headers = [
      'Kode Item / SKU',
      'Barcode',
      'Nama Item',
      'Jenis',
      'Kategori',
      'Satuan',
      'Kode Lokasi Stok',
      'Tempat Penyimpanan',
      'Stok',
      'Harga Pokok',
      'Harga Jual',
      'Tampil di POS',
      'Lacak Inventory',
      'Catatan',
      'Varian1_Nama',
      'Varian1_Harga',
      'Varian1_HPP',
      'Varian1_Barcode',
      'Varian2_Nama',
      'Varian2_Harga',
      'Varian2_HPP',
      'Varian2_Barcode',
      'Varian3_Nama',
      'Varian3_Harga',
      'Varian3_HPP',
      'Varian3_Barcode',
    ];
    const sampleRows = [
      [
        'FG-001',
        '89910001',
        'Nasi Goreng Spesial Oak',
        'Produk Jadi',
        'Makanan',
        'PORSI',
        'KCH',
        'Dapur Utama',
        0,
        18000,
        35000,
        'YA',
        'TIDAK',
        'Menu racikan dapur utama',
        'Reguler',
        35000,
        18000,
        '',
        'Jumbo',
        45000,
        23000,
        '',
        '',
        '',
        '',
        '',
      ],
      [
        'FG-002',
        '89910002',
        'Kopi Susu Oak Aren',
        'Produk Jadi',
        'Minuman',
        'CUP',
        'RCP',
        'Showcase',
        25,
        10000,
        22000,
        'YA',
        'YA',
        'Saldo awal stok showcase resepsionis',
        'Hot (Panas)',
        20000,
        9000,
        '',
        'Ice Regular',
        22000,
        10000,
        '',
        'Ice Large',
        28000,
        13000,
        '',
      ],
    ];
    const bytes = buildXlsxBytes('Template Produk Jadi', [headers, ...sampleRows]);
    triggerXlsxDownload(bytes, 'Template_Produk_Jadi_OAK_HIMS.xlsx');
    return;
  }

  if (templateType === 'SEMI_FINISHED') {
    const headers = [
      'Kode Item / SKU',
      'Barcode',
      'Nama Item',
      'Jenis',
      'Kategori',
      'Satuan',
      'Kode Lokasi Stok',
      'Tempat Penyimpanan',
      'Stok',
      'Harga Pokok',
      'Harga Jual',
      'Tampil di POS',
      'Lacak Inventory',
      'Catatan',
    ];
    const sampleRows = [
      ['SF-001', '', 'Bumbu Dasar Putih', 'Produk Setengah Jadi', 'Bumbu Olahan', 'GRAM', 'KCH', 'Chiller Dapur', 1000, 45, 0, 'TIDAK', 'YA', 'Saldo awal prep bumbu putih'],
      ['SF-002', '', 'Kaldu Ayam Pekat', 'Produk Setengah Jadi', 'Kaldu & Saus', 'ML', 'KCH', 'Freezer Dapur', 2000, 25, 0, 'TIDAK', 'YA', 'Saldo awal kaldu dapur'],
    ];
    const bytes = buildXlsxBytes('Template Setengah Jadi', [headers, ...sampleRows]);
    triggerXlsxDownload(bytes, 'Template_Produk_Setengah_Jadi_OAK_HIMS.xlsx');
    return;
  }

  if (templateType === 'RAW_MATERIAL') {
    const headers = [
      'Kode Item / SKU',
      'Barcode',
      'Nama Item',
      'Jenis',
      'Kategori',
      'Satuan',
      'Kode Lokasi Stok',
      'Tempat Penyimpanan',
      'Stok',
      'Harga Pokok',
      'Harga Jual',
      'Tampil di POS',
      'Lacak Inventory',
      'Catatan',
    ];
    const sampleRows = [
      ['BB-001', '', 'Pokcoy Segar Organik', 'Bahan Baku', 'Vegetarian', 'GRAM', 'KCH', 'Chiller Sayur', 1500, 35, 0, 'TIDAK', 'YA', 'Saldo awal bahan baku sayur'],
      ['BB-002', '', 'Fillet Ikan Dori', 'Bahan Baku', 'Fish Meal', 'GRAM', 'KCH', 'Freezer Seafood', 2000, 85, 0, 'TIDAK', 'YA', 'Saldo awal freezer dapur'],
    ];
    const bytes = buildXlsxBytes('Template Bahan Baku', [headers, ...sampleRows]);
    triggerXlsxDownload(bytes, 'Template_Bahan_Baku_OAK_HIMS.xlsx');
    return;
  }

  // OPERATIONAL_ITEM
  const headers = [
    'Kode Item / SKU',
    'Barcode',
    'Nama Item',
    'Jenis',
    'Kategori',
    'Satuan',
    'Kode Lokasi Stok',
    'Tempat Penyimpanan',
    'Stok',
    'Harga Pokok',
    'Harga Jual',
    'Tampil di POS',
    'Lacak Inventory',
    'Catatan',
  ];
  const sampleRows = [
    ['OP-001', '', 'Bath Towel Putih Hotel', 'Item Operasional', 'Handuk', 'PCS', 'KCH', 'Rak Linen Housekeeping', 50, 65000, 0, 'TIDAK', 'YA', 'Saldo awal linen housekeeping'],
    ['OP-002', '', 'Dental Kit Oak', 'Item Operasional', 'Amenities', 'SET', 'KCH', 'Lemari Amenities', 100, 4500, 0, 'TIDAK', 'YA', 'Saldo awal amenities kamar'],
  ];
  const bytes = buildXlsxBytes('Template Item Operasional', [headers, ...sampleRows]);
  triggerXlsxDownload(bytes, 'Template_Item_Operasional_OAK_HIMS.xlsx');
}

const PRODUCT_TYPE_EXPORT_LABEL: Record<string, string> = {
  FINISHED_GOOD: 'Produk Jadi',
  SEMI_FINISHED: 'Produk Setengah Jadi',
  RAW_MATERIAL: 'Bahan Baku',
  OPERATIONAL_ITEM: 'Item Operasional',
};

export function exportProductsToXlsx(
  items: Array<{
    item_code?: string | null;
    sku?: string | null;
    barcode?: string | null;
    name: string;
    product_type?: string | null;
    category_name?: string | null;
    canonical_base_unit_code?: string | null;
    base_unit?: string | null;
    location_code?: string | null;
    storage_sublocation?: string | null;
    stock_qty?: number | string | null;
    cost_price?: number | string | null;
    average_cost?: number | string | null;
    last_cost?: number | string | null;
    price?: number | string | null;
    is_sellable_pos?: boolean;
    track_stock?: boolean | null;
    track_inventory?: boolean | null;
    description?: string | null;
    is_active?: boolean;
    variants?: ProductVariantDto[] | null;
  }>,
  filterLabel?: string
): void {
  let maxVariants = 2;
  for (const item of items) {
    if (Array.isArray(item.variants) && item.variants.length > maxVariants) {
      maxVariants = item.variants.length;
    }
  }

  const headers: string[] = [
    'Kode Item / SKU',
    'Barcode',
    'Nama Item',
    'Jenis',
    'Kategori',
    'Satuan',
    'Kode Lokasi Stok',
    'Tempat Penyimpanan',
    'Stok',
    'Harga Pokok',
    'Harga Jual',
    'Tampil di POS',
    'Lacak Inventory',
    'Catatan',
    'Status Aktif',
  ];

  for (let v = 1; v <= maxVariants; v++) {
    headers.push(`Varian${v}_Nama`, `Varian${v}_Harga`, `Varian${v}_HPP`, `Varian${v}_Barcode`);
  }

  const rows: Array<Array<string | number | null>> = [headers];
  for (const item of items) {
    const ptCode = item.product_type || 'FINISHED_GOOD';
    const ptLabel = PRODUCT_TYPE_EXPORT_LABEL[ptCode] || ptCode;
    const unit = item.canonical_base_unit_code || item.base_unit || 'PCS';
    const rawCost = item.cost_price ?? item.average_cost ?? item.last_cost;
    const costNum = rawCost !== null && rawCost !== undefined ? Number(rawCost) : 0;
    const priceNum = item.price !== null && item.price !== undefined ? Number(item.price) : 0;
    const stockNum =
      item.stock_qty !== null && item.stock_qty !== undefined && String(item.stock_qty).trim() !== ''
        ? Number(item.stock_qty)
        : '';
    const isTracked =
      typeof item.track_stock === 'boolean'
        ? item.track_inventory === false
          ? false
          : item.track_stock
        : typeof item.track_inventory === 'boolean'
          ? item.track_inventory
          : ptCode === 'RAW_MATERIAL' || ptCode === 'SEMI_FINISHED' || ptCode === 'OPERATIONAL_ITEM';

    const row: Array<string | number | null> = [
      item.item_code || item.sku || '',
      item.barcode || '',
      item.name || '',
      ptLabel,
      item.category_name || '',
      unit,
      item.location_code || '',
      item.storage_sublocation || '',
      typeof stockNum === 'number' && Number.isFinite(stockNum) ? stockNum : '',
      Number.isFinite(costNum) ? costNum : 0,
      Number.isFinite(priceNum) ? priceNum : 0,
      item.is_sellable_pos !== false ? 'YA' : 'TIDAK',
      isTracked ? 'YA' : 'TIDAK',
      item.description || '',
      item.is_active !== false ? 'AKTIF' : 'NONAKTIF',
    ];

    const variants = Array.isArray(item.variants) ? item.variants : [];
    for (let v = 0; v < maxVariants; v++) {
      const vr = variants[v];
      if (vr) {
        row.push(
          vr.name || '',
          Number.isFinite(Number(vr.price)) ? Number(vr.price) : 0,
          vr.cost_price !== null && vr.cost_price !== undefined && Number.isFinite(Number(vr.cost_price))
            ? Number(vr.cost_price)
            : '',
          vr.barcode || ''
        );
      } else {
        row.push('', '', '', '');
      }
    }
    rows.push(row);
  }

  const dateSuffix = new Date().toISOString().slice(0, 10);
  const safeFilter = filterLabel ? `_${filterLabel.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
  const bytes = buildXlsxBytes('Master Barang & Produk', rows);
  triggerXlsxDownload(bytes, `Master_Barang_Produk_OAK_HIMS${safeFilter}_${dateSuffix}.xlsx`);
}

// ── ZIP & OpenXML (.xlsx) Reader ─────────────────────────────────────────────

async function inflateRawBytes(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressed as unknown as BufferSource);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLen += value.length;
    }
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function extractZipTextEntries(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map<string, string>();

  // Locate End of Central Directory (EOCD)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('File bukan format Excel (.xlsx) yang valid.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  let ptr = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > bytes.length || view.getUint32(ptr, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const fileNameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const fileName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + fileNameLen));
    ptr += 46 + fileNameLen + extraLen + commentLen;

    if (
      fileName === 'xl/sharedStrings.xml' ||
      fileName.startsWith('xl/worksheets/sheet')
    ) {
      if (localHeaderOffset + 30 > bytes.length) continue;
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const rawData = bytes.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        entries.set(fileName, decoder.decode(rawData));
      } else if (compressionMethod === 8) {
        const decompressed = await inflateRawBytes(rawData);
        entries.set(fileName, decoder.decode(decompressed));
      }
    }
  }

  return entries;
}

function parseSharedStringsXml(xmlText: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const siNodes = Array.from(doc.getElementsByTagName('si'));
  return siNodes.map((si) => {
    const tNodes = Array.from(si.getElementsByTagName('t'));
    return tNodes.map((t) => t.textContent || '').join('');
  });
}

function parseWorksheetXmlToGrid(xmlText: string, sharedStrings: string[]): string[][] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const rowNodes = Array.from(doc.getElementsByTagName('row'));
  const grid: string[][] = [];

  for (const rowNode of rowNodes) {
    const cellNodes = Array.from(rowNode.getElementsByTagName('c'));
    const rowArr: string[] = [];
    let fallbackColIdx = 0;

    for (const cNode of cellNodes) {
      const refAttr = cNode.getAttribute('r') || '';
      const colMatch = refAttr.match(/^([A-Za-z]+)/);
      const colIdx = colMatch ? columnNameToZeroBasedIndex(colMatch[1]) : fallbackColIdx;
      fallbackColIdx = colIdx + 1;

      const cellType = cNode.getAttribute('t') || '';
      let cellText = '';

      if (cellType === 's') {
        const vNode = cNode.getElementsByTagName('v')[0];
        const ssIdx = Number(vNode?.textContent ?? -1);
        cellText = ssIdx >= 0 && ssIdx < sharedStrings.length ? sharedStrings[ssIdx] : '';
      } else if (cellType === 'inlineStr') {
        const tNodes = Array.from(cNode.getElementsByTagName('t'));
        cellText = tNodes.map((t) => t.textContent || '').join('');
      } else {
        const vNode = cNode.getElementsByTagName('v')[0];
        cellText = vNode?.textContent || '';
      }

      while (rowArr.length <= colIdx) {
        rowArr.push('');
      }
      rowArr[colIdx] = cellText.trim();
    }

    if (rowArr.some((val) => val !== '')) {
      grid.push(rowArr);
    }
  }

  return grid;
}

function normalizeProductTypeFromCell(raw: string, fallbackType: ProductTypeCode = 'FINISHED_GOOD'): ProductTypeCode {
  const v = (raw || '').trim().toUpperCase();
  if (!v) return fallbackType;
  if (
    v === 'FINISHED_GOOD' ||
    v === 'FG' ||
    v === 'PRODUK JADI' ||
    v === 'PRODUK_JADI' ||
    v.includes('PRODUK JADI')
  ) {
    return 'FINISHED_GOOD';
  }
  if (
    v === 'SEMI_FINISHED' ||
    v === 'SF' ||
    v === 'SETENGAH JADI' ||
    v === 'PRODUK SETENGAH JADI' ||
    v.includes('SETENGAH JADI')
  ) {
    return 'SEMI_FINISHED';
  }
  if (
    v === 'RAW_MATERIAL' ||
    v === 'RM' ||
    v === 'BB' ||
    v === 'BMB' ||
    v === 'BAHAN BAKU' ||
    v.includes('BAHAN BAKU')
  ) {
    return 'RAW_MATERIAL';
  }
  if (
    v === 'OPERATIONAL_ITEM' ||
    v === 'OP' ||
    v === 'OPERASIONAL' ||
    v === 'ITEM OPERASIONAL' ||
    v.includes('OPERASIONAL')
  ) {
    return 'OPERATIONAL_ITEM';
  }
  return fallbackType;
}

function parseFlexibleNumber(raw: string): number {
  if (!raw) return 0;
  const cleaned = String(raw).replace(/[^0-9.,-]/g, '').trim();
  if (!cleaned) return 0;
  // Handle Indonesian thousand separator like "35.000" when there are 3 digits after dot
  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    return Number(cleaned.replace(/\./g, '')) || 0;
  }
  const normalized = cleaned.replace(/,/g, '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? Math.max(0, num) : 0;
}

export async function parseProductsFromXlsxFile(
  file: File,
  defaultProductType: ProductTypeCode = 'FINISHED_GOOD'
): Promise<ParsedExcelProductRow[]> {
  const buffer = await file.arrayBuffer();
  const entries = await extractZipTextEntries(buffer);
  const sharedStringsXml = entries.get('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml ? parseSharedStringsXml(sharedStringsXml) : [];

  let sheetXml = entries.get('xl/worksheets/sheet1.xml');
  if (!sheetXml) {
    for (const [key, val] of entries.entries()) {
      if (key.startsWith('xl/worksheets/sheet')) {
        sheetXml = val;
        break;
      }
    }
  }

  if (!sheetXml) {
    throw new Error('Lembar kerja (worksheet) tidak ditemukan di dalam file Excel.');
  }

  const grid = parseWorksheetXmlToGrid(sheetXml, sharedStrings);
  if (grid.length < 2) {
    throw new Error('File Excel kosong atau tidak memiliki baris data di bawah header.');
  }

  const headerRow = grid[0].map((h) => h.trim().toLowerCase());
  const findColIdx = (candidates: string[]): number => {
    for (const cand of candidates) {
      const exactIdx = headerRow.findIndex((h) => h === cand);
      if (exactIdx !== -1) return exactIdx;
    }
    for (const cand of candidates) {
      const idx = headerRow.findIndex((h) => h.includes(cand));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const skuIdx = findColIdx(['kode item / sku', 'kode item', 'sku']);
  const barcodeIdx = headerRow.findIndex((h) => h === 'barcode' || (h.includes('barcode') && !h.startsWith('varian')));
  const nameIdx = findColIdx(['nama item', 'nama produk', 'nama barang', 'name', 'nama']);
  const typeIdx = findColIdx(['jenis', 'tipe produk', 'product_type', 'tipe']);
  const categoryIdx = findColIdx(['kategori', 'category']);
  const unitIdx = findColIdx(['satuan', 'base_unit', 'unit']);
  const locationCodeIdx = findColIdx([
    'kode lokasi stok',
    'kode lokasi',
    'lokasi stok',
    'lokasi properti',
    'location_code',
    'lokasi',
  ]);
  const storageIdx = findColIdx(['tempat penyimpanan', 'sublokasi', 'storage_sublocation', 'penyimpanan']);
  const stockQtyIdx = headerRow.findIndex(
    (h) =>
      h === 'stok' ||
      h === 'stock' ||
      h === 'kuantitas' ||
      h === 'qty' ||
      h === 'jumlah stok' ||
      h === 'saldo awal' ||
      ((h.includes('stok') || h.includes('stock') || h.includes('qty')) &&
        !h.includes('lokasi') &&
        !h.includes('lacak') &&
        !h.includes('track'))
  );
  const costIdx = findColIdx(['harga pokok', 'hpp', 'cost_price', 'modal']);
  const priceIdx = findColIdx(['harga jual', 'harga', 'price']);
  const sellableIdx = findColIdx(['tampil di pos', 'pos', 'is_sellable_pos']);
  const trackStockIdx = findColIdx([
    'lacak inventory',
    'lacak inventori',
    'lacak stok',
    'track_inventory',
    'track_stock',
    'stok fisik',
    'inventory',
  ]);
  const notesIdx = findColIdx(['catatan', 'keterangan', 'notes', 'deskripsi']);

  if (nameIdx === -1) {
    throw new Error('Kolom "Nama Item" tidak ditemukan pada baris pertama (header) file Excel.');
  }

  // Detect Variant columns dynamically: Varian1_Nama, Varian1_Harga, Varian1_HPP, Varian1_Barcode, ...
  const variantColMap = new Map<
    number,
    { nameCol?: number; priceCol?: number; costCol?: number; barcodeCol?: number }
  >();

  headerRow.forEach((h, idx) => {
    const match = h.match(/^varian\s*(\d+)\s*[_-\s]\s*(nama|name|harga|price|hpp|modal|barcode)$/i);
    if (match) {
      const vNum = Number(match[1]);
      const field = match[2].toLowerCase();
      const entry = variantColMap.get(vNum) || {};
      if (field === 'nama' || field === 'name') entry.nameCol = idx;
      else if (field === 'harga' || field === 'price') entry.priceCol = idx;
      else if (field === 'hpp' || field === 'modal') entry.costCol = idx;
      else if (field === 'barcode') entry.barcodeCol = idx;
      variantColMap.set(vNum, entry);
    }
  });

  const sortedVariantIndices = Array.from(variantColMap.keys()).sort((a, b) => a - b);
  const parsedRows: ParsedExcelProductRow[] = [];

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const name = (row[nameIdx] || '').trim();
    if (!name) continue;

    const sku = skuIdx !== -1 ? (row[skuIdx] || '').trim() : '';
    const barcode = barcodeIdx !== -1 ? (row[barcodeIdx] || '').trim() : '';
    const rawType = typeIdx !== -1 ? row[typeIdx] || '' : '';
    const product_type = normalizeProductTypeFromCell(rawType, defaultProductType);
    const category_name = categoryIdx !== -1 ? (row[categoryIdx] || '').trim() : '';
    const base_unit = (unitIdx !== -1 ? (row[unitIdx] || '').trim().toUpperCase() : '') || 'PCS';
    const location_code = locationCodeIdx !== -1 ? (row[locationCodeIdx] || '').trim().toUpperCase() : '';
    const storage_sublocation = storageIdx !== -1 ? (row[storageIdx] || '').trim() : '';
    const rawStockStr = stockQtyIdx !== -1 ? (row[stockQtyIdx] || '').trim() : '';
    const stock_qty = rawStockStr !== '' ? parseFlexibleNumber(rawStockStr) : null;
    const cost_price = costIdx !== -1 ? parseFlexibleNumber(row[costIdx] || '') : 0;
    const rawPriceStr = priceIdx !== -1 ? (row[priceIdx] || '').trim() : '';
    const priceNum = rawPriceStr ? parseFlexibleNumber(rawPriceStr) : 0;
    const notes = notesIdx !== -1 ? (row[notesIdx] || '').trim() : '';

    let is_sellable_pos = product_type === 'FINISHED_GOOD';
    if (sellableIdx !== -1 && (row[sellableIdx] || '').trim() !== '') {
      const sVal = (row[sellableIdx] || '').trim().toUpperCase();
      is_sellable_pos = sVal === 'YA' || sVal === 'YES' || sVal === 'TRUE' || sVal === '1';
    }

    let track_stock = true;
    if (trackStockIdx !== -1 && (row[trackStockIdx] || '').trim() !== '') {
      const tVal = (row[trackStockIdx] || '').trim().toUpperCase();
      track_stock = !['TIDAK', 'NO', 'FALSE', '0', 'NONAKTIF', 'NON-STOK'].includes(tVal);
    } else if (location_code !== '' || (stock_qty !== null && stock_qty > 0)) {
      track_stock = true;
    } else if (product_type === 'FINISHED_GOOD' && base_unit === 'PORSI') {
      track_stock = false;
    }

    const variants: ProductVariantDto[] = [];
    if (product_type === 'FINISHED_GOOD') {
      for (const vNum of sortedVariantIndices) {
        const cols = variantColMap.get(vNum);
        if (!cols || cols.nameCol === undefined) continue;
        const vName = (row[cols.nameCol] || '').trim();
        if (!vName) continue;
        const vPrice = cols.priceCol !== undefined ? parseFlexibleNumber(row[cols.priceCol] || '') : priceNum;
        const vCostRaw = cols.costCol !== undefined ? (row[cols.costCol] || '').trim() : '';
        const vCost = vCostRaw ? parseFlexibleNumber(vCostRaw) : null;
        const vBarcode = cols.barcodeCol !== undefined ? (row[cols.barcodeCol] || '').trim() || null : null;
        variants.push({
          name: vName,
          price: vPrice,
          cost_price: vCost,
          barcode: vBarcode,
        });
      }
    }

    const finalPrice =
      is_sellable_pos || priceNum > 0
        ? priceNum > 0
          ? priceNum
          : variants.length > 0
            ? variants[0].price
            : 0
        : null;

    parsedRows.push({
      rowNumber: r + 1,
      sku,
      barcode,
      name,
      product_type,
      category_name,
      base_unit,
      location_code,
      storage_sublocation,
      stock_qty,
      cost_price,
      price: finalPrice,
      is_sellable_pos,
      track_stock,
      notes,
      variants,
    });
  }

  if (parsedRows.length === 0) {
    throw new Error('Tidak ada baris produk yang valid (Nama Item wajib diisi).');
  }

  return parsedRows;
}
