import type { FixedAssetItem } from './laporanTypes';

export interface ImportedAssetRow {
  asset_code?: string;
  asset_name: string;
  brand?: string;
  serial_number?: string;
  category: string;
  storage_location: string;
  purchase_date: string;
  purchase_price: number;
  current_value: number;
  depreciation_rate: number;
  notes: string;
}

// ============================================================================
// 1. PURE BROWSER .XLSX (Office Open XML ZIP) GENERATOR
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function escapeXml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colLetter(colIdx0: number): string {
  let n = colIdx0 + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

function buildWorksheetXml(rows: Array<Array<string | number>>): string {
  const rowXml = rows
    .map((r, rIdx) => {
      const rowNum = rIdx + 1;
      const cells = r
        .map((val, cIdx) => {
          const ref = `${colLetter(cIdx)}${rowNum}`;
          if (typeof val === 'number' && Number.isFinite(val)) {
            return `<c r="${ref}" t="n"><v>${val}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(val ?? ''))}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNum}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function createZipArchive(files: Array<{ name: string; content: string }>): Blob {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const dataBytes = enc.encode(file.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed
    lv.setUint16(6, 0, true); // Flags
    lv.setUint16(8, 0, true); // Compression method 0 (STORE)
    lv.setUint16(10, 0, true); // Mod time
    lv.setUint16(12, 0x21, true); // Mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true); // STORE
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // End of central directory signature
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd] as BlobPart[], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function downloadAssetsXlsx(filename: string, assets: FixedAssetItem[]): void {
  const headerRow = [
    'Kode Aset',
    'Kategori',
    'Nama Barang',
    'Merek',
    'No. Seri',
    'Lokasi Penyimpanan',
    'Tanggal Beli (YYYY-MM-DD)',
    'Harga Beli',
    'Nilai Saat Ini',
    'Depresiasi (%/tahun)',
    'Catatan',
  ];

  const dataRows = assets.map((a) => [
    a.asset_code || `AST-${String(a.id).padStart(4, '0')}`,
    a.category,
    a.asset_name,
    a.brand || '-',
    a.serial_number || '-',
    a.storage_location || '-',
    a.purchase_date,
    Number(a.purchase_price || 0),
    Number(a.current_value || 0),
    Number(a.depreciation_rate || 0),
    a.notes || '',
  ]);

  const files = [
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Data Aset" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: buildWorksheetXml([headerRow, ...dataRows]),
    },
  ];

  const blob = createZipArchive(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// 2. PURE BROWSER .XLSX / .XLS / .CSV PARSER FOR ASSET IMPORT
// ============================================================================

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressed as unknown as BufferSource);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function extractZipTextEntries(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const dec = new TextDecoder('utf-8');
  const result = new Map<string, string>();

  // Locate End of Central Directory (EOCD) from the end of the file
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Format file ZIP/XLSX tidak valid.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);

  for (let idx = 0; idx < totalEntries; idx++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const fileName = dec.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
    cdOffset += 46 + nameLen + extraLen + commentLen;

    if (
      fileName === 'xl/sharedStrings.xml' ||
      fileName === 'xl/worksheets/sheet1.xml'
    ) {
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const rawSlice = bytes.subarray(dataStart, dataStart + compSize);

      if (method === 0) {
        result.set(fileName, dec.decode(rawSlice));
      } else if (method === 8) {
        const inflated = await inflateRaw(rawSlice);
        result.set(fileName, dec.decode(inflated));
      }
    }
  }
  return result;
}

function colLettersToIndex(colStr: string): number {
  let n = 0;
  for (let i = 0; i < colStr.length; i++) {
    n = n * 26 + (colStr.charCodeAt(i) - 64);
  }
  return Math.max(0, n - 1);
}

function normalizeDateCell(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return new Date().toISOString().slice(0, 10);
  // Excel serial date number (e.g., 46344)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    const utcDays = serial - 25569;
    const d = new Date(utcDays * 86400 * 1000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function mapGridToAssets(grid: string[][]): ImportedAssetRow[] {
  if (grid.length <= 1) return [];
  const header = grid[0].map((h) => String(h || '').trim().toLowerCase());

  const findCol = (keywords: string[], fallbackIdx: number): number => {
    const idx = header.findIndex((h) => keywords.some((k) => h.includes(k)));
    return idx >= 0 ? idx : fallbackIdx;
  };

  const hasCodeCol = header.some((h) => h.includes('kode') || h.includes('code'));
  const codeIdx = hasCodeCol ? findCol(['kode', 'code'], 0) : -1;
  const catIdx = findCol(['kategori', 'category'], hasCodeCol ? 1 : 1);
  const nameIdx = findCol(['nama barang', 'nama aset', 'nama', 'barang', 'asset'], hasCodeCol ? 2 : 0);
  const hasBrandCol = header.some((h) => h.includes('merek') || h.includes('merk') || h.includes('brand'));
  const brandIdx = hasBrandCol ? findCol(['merek', 'merk', 'brand'], -1) : -1;
  const hasSerialCol = header.some((h) => h.includes('seri') || h.includes('serial') || h.includes('sn'));
  const serialIdx = hasSerialCol ? findCol(['seri', 'serial', 'sn'], -1) : -1;
  const hasLocationCol = header.some((h) => h.includes('lokasi') || h.includes('penyimpanan') || h.includes('location'));
  const locIdx = hasLocationCol ? findCol(['lokasi', 'penyimpanan', 'location'], hasCodeCol ? 3 : 2) : -1;
  const dateIdx = findCol(['tanggal', 'date', 'beli'], hasCodeCol ? 4 : hasLocationCol ? 3 : 2);
  const priceIdx = findCol(['harga beli', 'harga', 'price'], hasCodeCol ? 5 : hasLocationCol ? 4 : 3);
  const curValIdx = findCol(['nilai saat ini', 'nilai', 'current'], hasCodeCol ? 6 : hasLocationCol ? 5 : 4);
  const depIdx = findCol(['depresiasi', 'penyusutan', 'depreciation'], hasCodeCol ? 7 : hasLocationCol ? 6 : 5);
  const notesIdx = findCol(['catatan', 'keterangan', 'note'], hasCodeCol ? 8 : hasLocationCol ? 7 : 6);

  const results: ImportedAssetRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row || row.length === 0) continue;
    const assetName = String(row[nameIdx] ?? '').trim();
    if (!assetName) continue;

    const assetCode = codeIdx >= 0 ? String(row[codeIdx] ?? '').trim() || undefined : undefined;
    const brand = brandIdx >= 0 ? String(row[brandIdx] ?? '').trim() || '-' : '-';
    const serialNumber = serialIdx >= 0 ? String(row[serialIdx] ?? '').trim() || '-' : '-';
    const category = String(row[catIdx] ?? '').trim() || 'Peralatan';
    const storageLocation = locIdx >= 0 ? String(row[locIdx] ?? '').trim() || '-' : '-';
    const purchaseDate = normalizeDateCell(String(row[dateIdx] ?? ''));
    const cleanNum = (v: any) => Number(String(v ?? '0').replace(/[^\d.-]/g, '')) || 0;
    const purchasePrice = Math.max(0, cleanNum(row[priceIdx]));
    const rawCur = String(row[curValIdx] ?? '').trim();
    const currentValue = rawCur !== '' ? Math.max(0, cleanNum(rawCur)) : purchasePrice;
    const depreciationRate = Math.max(0, cleanNum(row[depIdx]));
    const notes = String(row[notesIdx] ?? '').trim();

    results.push({
      asset_code: assetCode,
      asset_name: assetName,
      brand,
      serial_number: serialNumber,
      category,
      storage_location: storageLocation,
      purchase_date: purchaseDate,
      purchase_price: purchasePrice,
      current_value: currentValue,
      depreciation_rate: depreciationRate,
      notes,
    });
  }
  return results;
}

export async function parseUploadedAssetsFile(file: File): Promise<ImportedAssetRow[]> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Check if file starts with PK (0x50, 0x4B) -> .xlsx ZIP archive
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = await extractZipTextEntries(buffer);
    const sheetXml = entries.get('xl/worksheets/sheet1.xml');
    if (!sheetXml) {
      throw new Error('Worksheet utama (sheet1.xml) tidak ditemukan di dalam file XLSX.');
    }

    const sharedStrings: string[] = [];
    const ssXml = entries.get('xl/sharedStrings.xml');
    if (ssXml) {
      const ssDoc = new DOMParser().parseFromString(ssXml, 'application/xml');
      const siNodes = Array.from(ssDoc.getElementsByTagName('si'));
      for (const si of siNodes) {
        const tNodes = Array.from(si.getElementsByTagName('t'));
        sharedStrings.push(tNodes.map((t) => t.textContent || '').join(''));
      }
    }

    const doc = new DOMParser().parseFromString(sheetXml, 'application/xml');
    const rowNodes = Array.from(doc.getElementsByTagName('row'));
    const grid: string[][] = [];

    for (const rNode of rowNodes) {
      const cNodes = Array.from(rNode.getElementsByTagName('c'));
      const rowArr: string[] = [];
      for (const cNode of cNodes) {
        const ref = cNode.getAttribute('r') || '';
        const colMatch = ref.match(/^([A-Z]+)/i);
        const colIdx = colMatch ? colLettersToIndex(colMatch[1].toUpperCase()) : rowArr.length;
        const tAttr = cNode.getAttribute('t') || '';
        let val = '';
        if (tAttr === 's') {
          const vNode = cNode.getElementsByTagName('v')[0];
          const ssIdx = parseInt(vNode?.textContent || '0', 10);
          val = sharedStrings[ssIdx] ?? '';
        } else if (tAttr === 'inlineStr') {
          const tNode = cNode.getElementsByTagName('t')[0];
          val = tNode?.textContent || '';
        } else {
          const vNode = cNode.getElementsByTagName('v')[0];
          val = vNode?.textContent || '';
        }
        while (rowArr.length <= colIdx) rowArr.push('');
        rowArr[colIdx] = val;
      }
      grid.push(rowArr);
    }
    return mapGridToAssets(grid);
  }

  // Otherwise decode as text (SpreadsheetML .xls XML or .csv)
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('<Workbook') || text.includes('<Row')) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const rowNodes = Array.from(doc.getElementsByTagName('Row'));
    const grid = rowNodes.map((rNode) =>
      Array.from(rNode.getElementsByTagName('Cell')).map((c) => (c.textContent || '').trim())
    );
    return mapGridToAssets(grid);
  }

  // CSV fallback
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const sep = lines[0]?.includes(';') ? ';' : ',';
  const grid = lines.map((line) =>
    line.split(sep).map((cell) => cell.replace(/^"|"$/g, '').trim())
  );
  return mapGridToAssets(grid);
}
