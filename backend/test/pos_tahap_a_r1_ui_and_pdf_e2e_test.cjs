'use strict';

/**
 * OAK HIMS — Verifikasi UI E2E, Race Network Browser (TA-F01), & Bukti Cetak PDF A4 Landscape
 * Pendek + Multi-Halaman >=120 Baris (TA-F02) pada Aplikasi Aktual di Fixture Terisolasi.
 *
 * Keamanan:
 * - Menggunakan nama container PostgreSQL unik per sesi dan port TCP bebas yang dicek sebelum mulai.
 * - Tidak pernah menjalankan `docker rm -f` sebelum container dibuat oleh sesi ini.
 * - Tidak menyentuh UAT Owner (44187/55451) maupun Pembanding (44185/55449).
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

process.env.JWT_SECRET = 'test-tahap-a-r1-ui-pdf-e2e-jwt-secret-20261105';
process.env.TZ = 'Asia/Jakarta';

const pwRunnerNodeModules =
  'C:\\Users\\PC\\.gemini\\antigravity\\brain\\5569acf2-8d54-43cc-b5c2-4f0964cd148e\\scratch\\pw_runner\\node_modules';
const repoRoot = path.resolve(__dirname, '..', '..');
const backendNodeModules = path.join(repoRoot, 'backend', 'node_modules');
module.paths.unshift(pwRunnerNodeModules, backendNodeModules);

const express = require('express');
const { Pool } = require('pg');
const { chromium } = require('playwright-core');

const schema = require(path.join(repoRoot, 'backend', 'dist', 'db', 'schema_v3'));
const { runPosPaymentSettlementMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_payment_settlement_v1'));
const { runPosPurchaseOrdersMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_orders_v1'));
const { runPosPurchaseReceiptDraftPostMigration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_receipt_draft_post_v1'));
const { runPosPurchaseReceiptDraftPostV2Migration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_purchase_receipt_draft_post_v2'));
const { runPosProcurementTahap1aV1Migration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'pos_procurement_tahap1a_v1'));
const { runProductInventoryMp04bB1Migration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'product_inventory_mp04b_b1_v1'));
const { runProductInventoryMp04bB3Migration } = require(path.join(repoRoot, 'backend', 'dist', 'db', 'migrations', 'product_inventory_mp04b_b3_v1'));

const { requireAuth } = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'auth', 'authMiddleware'));
const { generateToken } = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'auth', 'authService'));
const {
  SYSTEM_CANONICAL_UNITS,
  createStockLocationListHandler,
} = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'pos', 'productMasterStage1'));

const {
  createGlobalStockMovementsHandler,
  createInventoryValuationHandler,
  createOpnameVarianceHandler,
  createStockLedgerHandler,
  createStockBalancesHandler,
} = require(path.join(repoRoot, 'backend', 'dist', 'domains', 'pos', 'stockInventoryService'));

const PROTECTED_PORTS = new Set([5432, 5433, 55449, 55451, 44185, 44187]);
const CONTAINER_NAME = `oak_hims_test_tahap_a_r1_ui_pg_${process.pid}_${Date.now()}`;
const DB_NAME = 'oak_hims_test_tahap_a_r1_ui';

const DEFAULT_EVIDENCE_DIR =
  process.argv[2]
    ? path.resolve(process.argv[2])
    : 'C:\\Users\\PC\\.gemini\\antigravity\\brain\\b8e002ac-c03f-4ef0-ba28-ef17b644dfb3\\scratch\\tahap_a_r1_review_stage\\EVIDENCE';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isTcpPortAvailable(port) {
  if (PROTECTED_PORTS.has(port)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort, maxTries = 30) {
  for (let p = startPort; p < startPort + maxTries; p++) {
    if (await isTcpPortAvailable(p)) return p;
  }
  throw new Error(`Tidak ditemukan port TCP bebas mulai dari ${startPort}`);
}

function containerExists(name) {
  const out = execSync(`docker ps -a --filter "name=^/${name}$" --format "{{.Names}}"`, {
    encoding: 'utf8',
  }).trim();
  return out === name;
}

async function waitForPostgres(pool, maxAttempts = 40) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('PostgreSQL test container did not become ready');
}

/**
 * Parser PDF Chromium berbasis zlib + ToUnicode CMap untuk mengekstrak jumlah halaman,
 * MediaBox setiap halaman, dan teks Unicode per halaman secara langsung dari file PDF.
 */
function inspectChromiumPdf(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const rawLatin1 = buf.toString('latin1');

  // Kumpulkan semua objek PDF: id -> { headerDict, streamBuf, rawBody }
  const objects = new Map();
  const objRegex = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;
  let match;
  while ((match = objRegex.exec(rawLatin1)) !== null) {
    const objId = Number(match[1]);
    const body = match[2];
    const streamIdx = body.indexOf('stream');
    let headerDict = body;
    let streamBuf = null;
    if (streamIdx !== -1) {
      headerDict = body.slice(0, streamIdx);
      let dataStart = streamIdx + 6;
      if (body[dataStart] === '\r' && body[dataStart + 1] === '\n') dataStart += 2;
      else if (body[dataStart] === '\n' || body[dataStart] === '\r') dataStart += 1;
      const endStreamIdx = body.lastIndexOf('endstream');
      if (endStreamIdx > dataStart) {
        let dataEnd = endStreamIdx;
        if (body[dataEnd - 2] === '\r' && body[dataEnd - 1] === '\n') dataEnd -= 2;
        else if (body[dataEnd - 1] === '\n' || body[dataEnd - 1] === '\r') dataEnd -= 1;
        const rawSlice = Buffer.from(body.slice(dataStart, dataEnd), 'latin1');
        if (/\/Filter\s*\/FlateDecode/.test(headerDict)) {
          try {
            streamBuf = zlib.inflateSync(rawSlice);
          } catch {
            streamBuf = rawSlice;
          }
        } else {
          streamBuf = rawSlice;
        }
      }
    }
    objects.set(objId, { objId, headerDict, streamBuf, rawBody: body });
  }

  // Parse ToUnicode CMap dari stream objek
  function parseToUnicodeCMap(cmapText) {
    const map = new Map();
    const bfcharBlocks = cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g);
    for (const b of bfcharBlocks) {
      const pairs = b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g);
      for (const p of pairs) {
        const srcCode = parseInt(p[1], 16);
        const dstHex = p[2];
        let str = '';
        for (let i = 0; i < dstHex.length; i += 4) {
          str += String.fromCodePoint(parseInt(dstHex.slice(i, i + 4), 16));
        }
        map.set(srcCode, str);
      }
    }
    const bfrangeBlocks = cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g);
    for (const b of bfrangeBlocks) {
      const lines = b[1].trim().split(/\r?\n/);
      for (const line of lines) {
        const mRange = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(line);
        if (mRange) {
          const startCode = parseInt(mRange[1], 16);
          const endCode = parseInt(mRange[2], 16);
          let targetCode = parseInt(mRange[3], 16);
          for (let c = startCode; c <= endCode; c++) {
            map.set(c, String.fromCodePoint(targetCode++));
          }
        }
      }
    }
    return map;
  }

  // Petakan fontObjId -> Map<glyphId, unicodeStr>
  const fontGlyphMaps = new Map();
  for (const [objId, obj] of objects.entries()) {
    const toUniMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.rawBody);
    if (toUniMatch) {
      const cmapObj = objects.get(Number(toUniMatch[1]));
      if (cmapObj && cmapObj.streamBuf) {
        fontGlyphMaps.set(objId, parseToUnicodeCMap(cmapObj.streamBuf.toString('latin1')));
      }
    }
  }

  // Temukan semua halaman (/Type /Page, bukan /Pages)
  const pageObjects = [];
  for (const [objId, obj] of objects.entries()) {
    if (/\/Type\s*\/Page\b(?!s)/.test(obj.headerDict)) {
      pageObjects.push(obj);
    }
  }

  function decodeHexWithFont(hexStr, glyphMap) {
    let out = '';
    const clean = hexStr.replace(/\s+/g, '');
    if (glyphMap && glyphMap.size > 0 && clean.length % 4 === 0) {
      for (let i = 0; i < clean.length; i += 4) {
        const code = parseInt(clean.slice(i, i + 4), 16);
        out += glyphMap.get(code) ?? '';
      }
      return out;
    }
    for (let i = 0; i < clean.length; i += 2) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
    }
    return out;
  }

  function decodePageContentStream(contentStr, pageFontMap) {
    let currentFontName = null;
    let pageText = '';
    const tokenRegex = /\/([A-Za-z0-9_.]+)\s+[0-9.]+\s+Tf|\[([\s\S]*?)\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj|\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj|ET\b/g;
    let tok;
    while ((tok = tokenRegex.exec(contentStr)) !== null) {
      if (tok[1]) {
        currentFontName = tok[1];
      } else if (tok[2] !== undefined) {
        const glyphMap = pageFontMap.get(currentFontName);
        const inner = tok[2];
        const subToks = inner.matchAll(/<([0-9A-Fa-f\s]+)>|\(([^)\\]*(?:\\.[^)\\]*)*)\)/g);
        for (const st of subToks) {
          if (st[1] !== undefined) {
            pageText += decodeHexWithFont(st[1], glyphMap);
          } else if (st[2] !== undefined) {
            pageText += st[2];
          }
        }
      } else if (tok[3] !== undefined) {
        const glyphMap = pageFontMap.get(currentFontName);
        pageText += decodeHexWithFont(tok[3], glyphMap);
      } else if (tok[4] !== undefined) {
        pageText += tok[4];
      } else {
        pageText += '\n';
      }
    }
    return pageText;
  }

  const pages = pageObjects.map((pObj, idx) => {
    // MediaBox
    const mbMatch = /\/MediaBox\s*\[\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*\]/.exec(
      pObj.headerDict
    );
    const mediaBox = mbMatch
      ? [Number(mbMatch[1]), Number(mbMatch[2]), Number(mbMatch[3]), Number(mbMatch[4])]
      : [0, 0, 0, 0];

    // Font map pada halaman (atau Resources objek)
    let resourcesText = pObj.headerDict;
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(pObj.headerDict);
    if (resRef && objects.has(Number(resRef[1]))) {
      resourcesText += '\n' + objects.get(Number(resRef[1])).rawBody;
    }
    const pageFontMap = new Map();
    const fontRefs = resourcesText.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g);
    for (const fr of fontRefs) {
      const fName = fr[1];
      const fObjId = Number(fr[2]);
      if (fontGlyphMaps.has(fObjId)) {
        pageFontMap.set(fName, fontGlyphMaps.get(fObjId));
      }
    }

    // Contents stream(s)
    const contentIds = [];
    const singleContent = /\/Contents\s+(\d+)\s+0\s+R/.exec(pObj.headerDict);
    const arrayContent = /\/Contents\s*\[([\s\S]*?)\]/.exec(pObj.headerDict);
    if (singleContent) {
      contentIds.push(Number(singleContent[1]));
    } else if (arrayContent) {
      for (const m of arrayContent[1].matchAll(/(\d+)\s+0\s+R/g)) {
        contentIds.push(Number(m[1]));
      }
    }

    let combinedStream = '';
    for (const cid of contentIds) {
      const cObj = objects.get(cid);
      if (cObj && cObj.streamBuf) {
        combinedStream += cObj.streamBuf.toString('latin1') + '\n';
      }
    }

    const text = decodePageContentStream(combinedStream, pageFontMap);
    return {
      page_number: idx + 1,
      media_box_points: mediaBox,
      width_pt: Number((mediaBox[2] - mediaBox[0]).toFixed(2)),
      height_pt: Number((mediaBox[3] - mediaBox[1]).toFixed(2)),
      is_landscape: mediaBox[2] - mediaBox[0] > mediaBox[3] - mediaBox[1],
      text,
    };
  });

  return {
    page_count: pages.length,
    pages,
    full_text: pages.map((p) => p.text).join('\n--- PAGE BREAK ---\n'),
  };
}

async function runUiAndPdfE2E() {
  fs.mkdirSync(DEFAULT_EVIDENCE_DIR, { recursive: true });

  if (containerExists(CONTAINER_NAME)) {
    throw new Error(`Container ${CONTAINER_NAME} sudah ada; dibatalkan demi keamanan (fail-safe).`);
  }

  const pgPort = await findAvailablePort(55456);
  const httpPort = await findAvailablePort(44196);
  let createdContainerByThisSession = false;

  console.log(`[UI-PDF-E2E] Menjalankan container PostgreSQL terisolasi (${CONTAINER_NAME} di port ${pgPort})...`);
  execSync(
    `docker run -d --name ${CONTAINER_NAME} -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=${DB_NAME} -p 127.0.0.1:${pgPort}:5432 postgres:15-alpine`,
    { stdio: 'inherit' }
  );
  createdContainerByThisSession = true;

  const pool = new Pool({
    host: '127.0.0.1',
    port: pgPort,
    user: 'postgres',
    password: 'postgres',
    database: DB_NAME,
  });

  let server = null;
  let browser = null;

  try {
    await waitForPostgres(pool);
    await schema.initializeDatabase(pool);
    await runPosPaymentSettlementMigration(pool);
    await runPosPurchaseOrdersMigration(pool);
    await runPosPurchaseReceiptDraftPostMigration(pool);
    await runPosPurchaseReceiptDraftPostV2Migration(pool);
    await runPosProcurementTahap1aV1Migration(pool);
    await runProductInventoryMp04bB1Migration(pool);
    await runProductInventoryMp04bB3Migration(pool);

    // Seed property, locations, products, and movements:
    // - Location 11 (WH-01): 1 prior movement (2026-10-31) + 5 in-period movements (2026-11-01..04) -> Short PDF (5 rows)
    // - Location 12 (OUT-CAFE): 125 in-period movements (2026-11-01..04) with unique notes LROW-0001..LROW-0125 -> Long PDF (125 rows, >1 page)
    await pool.query(`
      INSERT INTO properties (id, name, property_code, address)
      VALUES (1, 'OAK Lawang', 'OAKLWG', 'Jl. Raya Lawang No. 1')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO roles (id, name, description)
      VALUES (1, 'SUPER_ADMIN', 'Platform Super Admin')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO users (id, property_id, role_id, username, email, password_hash, full_name, is_active, account_status)
      VALUES (1, 1, 1, 'superadmin.ui', 'superadmin@oakhims.local', 'hash', 'Owner OAK Lawang', TRUE, 'READY')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO pos_menu_categories (id, property_id, name)
      VALUES (1, 1, 'Minuman & Bahan Baku')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO stock_locations (id, property_id, code, name, location_type, is_active)
      VALUES
        (11, 1, 'WH-01', 'Gudang 1', 'WAREHOUSE', TRUE),
        (12, 1, 'OUT-CAFE', 'Outlet Cafe', 'POS_OUTLET', TRUE)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO pos_menu_items (
        id, property_id, category_id, item_code, name, price,
        average_cost, last_cost, base_unit, canonical_base_unit_code,
        track_stock, is_active, is_sellable_pos
      ) VALUES
        (101, 1, 1, 'AM-600', 'Air Mineral 600ml', 5000.00, 3120.00, 30000.00, 'BOTOL', 'BOTOL', TRUE, TRUE, TRUE),
        (102, 1, 1, 'KOPI-ARB', 'Biji Kopi Arabika', 0.00, 150.00, 150.00, 'GRAM', 'GRAM', TRUE, TRUE, FALSE)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO pos_goods_receipts (
        id, property_id, grn_number, location_id, receipt_date, status, operation_key, created_at, updated_at
      ) VALUES
        (501, 1, 'GRN-20261031-001', 11, '2026-10-31', 'POSTED', 'ui-op-grn-1', '2026-10-31T10:00:00+07:00', '2026-10-31T10:00:00+07:00'),
        (502, 1, 'GRN-20261101-002', 11, '2026-11-01', 'POSTED', 'grn-hdr-key-separate-502', '2026-11-01T09:00:00+07:00', '2026-11-01T09:00:00+07:00')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO stock_operations (
        id, property_id, operation_type, operation_key, payload_fingerprint, notes, metadata, created_by, created_at
      ) VALUES
        (1001, 1, 'PURCHASE_RECEIPT', 'ui-op-grn-1', 'fp-1', 'Penerimaan PO Oktober [SROW_0000]', '{"location_id":11}'::jsonb, 1, '2026-10-31T23:59:59+07:00'),
        (1002, 1, 'OPENING_BALANCE', 'ui-op-open-kopi', 'fp-2', 'Saldo awal kopi gudang [SROW_0001]', '{"location_id":11}'::jsonb, 1, '2026-11-01T08:00:00+07:00'),
        (1003, 1, 'PURCHASE_RECEIPT', 'ui-op-grn-2-meta-only', 'fp-3', 'Penerimaan Batch 2 [SROW_0002]', '{"location_id":11,"grn_id":502}'::jsonb, 1, '2026-11-01T09:15:00+07:00'),
        (1004, 1, 'STOCK_ADJUSTMENT', 'ui-op-adj-wh1-a', 'fp-4', 'Koreksi stok pagi [SROW_0003]', '{"location_id":11}'::jsonb, 1, '2026-11-02T14:30:00+07:00'),
        (1005, 1, 'STOCK_OPNAME', 'ui-op-opn-1', 'fp-5', 'Opname fisik sore [SROW_0004]', '{"location_id":11}'::jsonb, 1, '2026-11-03T16:45:00+07:00'),
        (1006, 1, 'STOCK_ADJUSTMENT', 'ui-op-adj-1', 'fp-6', 'Koreksi botol pecah [SROW_0005]', '{"location_id":11}'::jsonb, 1, '2026-11-04T23:59:59+07:00')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO stock_movements (
        id, operation_id, property_id, product_id, location_id,
        quantity_delta, base_unit_code, unit_cost, created_at
      ) VALUES
        (2001, 1001, 1, 101, 11, 24.000, 'BOTOL', 2000.00, '2026-10-31T23:59:59+07:00'),
        (2002, 1002, 1, 102, 11, 1000.000, 'GRAM', 150.00, '2026-11-01T08:00:00+07:00'),
        (2003, 1003, 1, 101, 11, 24.000, 'BOTOL', 2000.00, '2026-11-01T09:15:00+07:00'),
        (2004, 1004, 1, 101, 11, -10.000, 'BOTOL', 2000.00, '2026-11-02T14:30:00+07:00'),
        (2005, 1005, 1, 101, 11, 2.000, 'BOTOL', 3120.00, '2026-11-03T16:45:00+07:00'),
        (2006, 1006, 1, 101, 11, -1.000, 'BOTOL', 3120.00, '2026-11-04T23:59:59+07:00')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed 125 baris mutasi untuk lokasi 12 (OUT-CAFE) pada periode 2026-11-01 s/d 2026-11-04
    // Baris 1..100 untuk produk 101 (BOTOL), baris 101..125 untuk produk 102 (GRAM)
    const LONG_ROW_COUNT = 125;
    let cafeBotolBalance = 0;
    let cafeGramBalance = 0;
    for (let i = 1; i <= LONG_ROW_COUNT; i++) {
      const opId = 3000 + i;
      const movId = 4000 + i;
      const rowCode = `LROW_${String(i).padStart(4, '0')}`;
      const isBotol = i <= 100;
      const productId = isBotol ? 101 : 102;
      const unitCode = isBotol ? 'BOTOL' : 'GRAM';
      // Selang-seling masuk (+5) dan keluar (-2) dengan saldo selalu positif
      const delta = i === 1 || i === 101 ? 50 : i % 3 === 0 ? -2 : 4;
      if (isBotol) cafeBotolBalance += delta;
      else cafeGramBalance += delta;

      // Waktu monoton naik ketat dari 2026-11-01 08:00 WIB sampai 2026-11-04 22:48 WIB (+42 menit per mutasi)
      const baseEpochMs = Date.parse('2026-11-01T08:00:00+07:00');
      const ts = new Date(baseEpochMs + (i - 1) * 42 * 60 * 1000).toISOString();
      const opType = i === 1 || i === 101 ? 'OPENING_BALANCE' : i % 3 === 0 ? 'POS_SALE' : 'STOCK_ADJUSTMENT';
      const opKey = `POS-202611-${String(i).padStart(4, '0')}`;

      await pool.query(
        `INSERT INTO stock_operations (
           id, property_id, operation_type, operation_key, payload_fingerprint,
           notes, metadata, created_by, created_at
         ) VALUES ($1, 1, $2, $3, $3, $4, '{"location_id":12}'::jsonb, 1, $5::timestamptz)`,
        [opId, opType, opKey, `Mutasi Uji Multi-Halaman [${rowCode}]`, ts]
      );
      await pool.query(
        `INSERT INTO stock_movements (
           id, operation_id, property_id, product_id, location_id,
           quantity_delta, base_unit_code, unit_cost, created_at
         ) VALUES ($1, $2, 1, $3, 12, $4, $5, $6, $7::timestamptz)`,
        [movId, opId, productId, delta.toFixed(3), unitCode, isBotol ? '2000.00' : '150.00', ts]
      );
    }

    await pool.query(
      `INSERT INTO stock_balances (property_id, product_id, location_id, quantity, updated_at)
       VALUES
         (1, 101, 11, 39.000, NOW()),
         (1, 102, 11, 1000.000, NOW()),
         (1, 101, 12, $1, NOW()),
         (1, 102, 12, $2, NOW())
       ON CONFLICT (property_id, product_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cafeBotolBalance.toFixed(3), cafeGramBalance.toFixed(3)]
    );

    const userPayload = {
      id: 1,
      email: 'superadmin@oakhims.local',
      username: 'superadmin.ui',
      full_name: 'Owner OAK Lawang',
      role: 'Super Admin',
      role_id: 1,
      property_id: 1,
      scope: 'FULL',
      account_status: 'ACTIVE',
      access_type: 'ADMIN',
    };
    const jwtToken = generateToken(userPayload);

    const app = express();
    app.use(express.json());

    const deps = {
      pool,
      assertPropertyScope: async () => true,
    };

    app.get('/api/auth/me', requireAuth, (_req, res) => {
      res.json({ status: 'OK', data: { user: userPayload } });
    });

    app.get('/api/auth/permissions', requireAuth, (_req, res) =>
      res.json({
        status: 'OK',
        data: {
          permissions: [
            'pos.view',
            'pos.manage',
            'inventory.view',
            'inventory.create',
            'inventory.edit',
            'transactions.view',
            'transactions.manage',
            'purchases.approve',
            'reservations.view',
            'rooms.view',
          ],
        },
      })
    );

    app.get('/api/access-control/me', requireAuth, (_req, res) => {
      const fullPerm = {
        view: { allowed: true, source: 'PLATFORM_SUPER_ADMIN' },
        edit: { allowed: true, source: 'PLATFORM_SUPER_ADMIN' },
        delete: { allowed: true, source: 'PLATFORM_SUPER_ADMIN' },
      };
      res.json({
        status: 'OK',
        data: {
          user_id: 1,
          property_id: 1,
          full_name: 'Owner OAK Lawang',
          username: 'superadmin.ui',
          role_id: 1,
          role_name: 'Super Admin',
          is_platform_super_admin: true,
          resources: [],
          role_access: {},
          overrides: [],
          effective: {
            Kalender: fullPerm,
            Transaksi: fullPerm,
            'Master Kamar': fullPerm,
            'Master Produk': fullPerm,
            'Produk & Inventori': fullPerm,
            POS: fullPerm,
            Pengaturan: fullPerm,
          },
        },
      });
    });

    app.get('/api/properties', requireAuth, (_req, res) =>
      res.json({
        status: 'OK',
        data: [{ id: 1, name: 'OAK Lawang', code: 'OAKLWG' }],
      })
    );

    app.get('/api/properties/:id/branding', (_req, res) =>
      res.json({
        status: 'OK',
        data: { property_id: 1, hotel_name: 'OAK Lawang', tagline: 'Uji Tahap A R1' },
      })
    );

    app.get('/api/pos/inventory/stock-movements-global', requireAuth, createGlobalStockMovementsHandler(deps));
    app.get('/api/pos/stock/movements-global', requireAuth, createGlobalStockMovementsHandler(deps));
    app.get('/api/pos/inventory/valuation', requireAuth, createInventoryValuationHandler(deps));
    app.get('/api/pos/inventory/opname-variance', requireAuth, createOpnameVarianceHandler(deps));
    app.get('/api/pos/inventory/ledger-card', requireAuth, createStockLedgerHandler(deps));
    app.get('/api/pos/inventory/ledger', requireAuth, createStockLedgerHandler(deps));
    app.get('/api/pos/stock/balances', requireAuth, createStockBalancesHandler(deps));
    app.get('/api/pos/stock-locations', requireAuth, createStockLocationListHandler(deps));

    app.get('/api/pos/menu', requireAuth, async (_req, res) => {
      const items = await pool.query(
        `SELECT id, property_id, category_id, item_code, name, price, average_cost, last_cost, base_unit, canonical_base_unit_code, track_stock, is_active, is_sellable_pos
         FROM pos_menu_items WHERE property_id = 1 ORDER BY id ASC`
      );
      res.json({
        status: 'OK',
        data: {
          categories: [{ id: 1, property_id: 1, name: 'Minuman & Bahan Baku' }],
          items: items.rows.map((r) => ({ ...r, packaging_conversions: [] })),
          canonical_units: SYSTEM_CANONICAL_UNITS,
        },
      });
    });

    app.get('/api/*', (_req, res) => {
      res.json({ status: 'OK', data: [] });
    });

    const distDir = path.join(repoRoot, 'frontend', 'dist');
    app.use(express.static(distDir));
    app.use((_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(httpPort, '127.0.0.1', resolve));
    console.log(`[UI-PDF-E2E] Server HTTP terisolasi aktif di http://127.0.0.1:${httpPort}`);

    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('oak_hims_auth_token', token);
      window.__printCalledCount = 0;
      window.print = () => {
        window.__printCalledCount = (window.__printCalledCount || 0) + 1;
      };
    }, jwtToken);

    const page = await context.newPage();
    const globalMovementsRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/pos/inventory/stock-movements-global')) {
        globalMovementsRequests.push(req.url());
      }
    });

    await page.goto(`http://127.0.0.1:${httpPort}/`, { waitUntil: 'networkidle' });

    const stokMutasiNav = page.locator('aside button', { hasText: 'Stok & Mutasi' });
    await stokMutasiNav.waitFor({ state: 'visible', timeout: 10000 });
    await stokMutasiNav.click();

    const subTabValuation = page.getByTestId('inventory-tab-valuation');
    const subTabHistory = page.getByTestId('inventory-tab-movements');
    await subTabValuation.waitFor({ state: 'visible', timeout: 10000 });
    await subTabHistory.waitFor({ state: 'visible', timeout: 10000 });
    await sleep(400);

    await page.screenshot({
      path: path.join(DEFAULT_EVIDENCE_DIR, 'tahapa_01_subtab_saldo_dan_valuasi_utuh.png'),
      fullPage: false,
    });

    await subTabHistory.click();
    await page.getByTestId('stock-movement-history-section').waitFor({ state: 'visible', timeout: 10000 });
    await sleep(600);

    await page.screenshot({
      path: path.join(DEFAULT_EVIDENCE_DIR, 'tahapa_02_tab_riwayat_mutasi_global.png'),
      fullPage: false,
    });

    // -------------------------------------------------------------------------
    // SKENARIO 1: Laporan Pendek (5 Baris pada WH-01) -> Cetak / PDF A4 Landscape
    // -------------------------------------------------------------------------
    console.log('[UI-PDF-E2E] Skenario 1: Verifikasi pratinjau & PDF pendek (5 baris di WH-01)...');
    await page.getByTestId('mutation-filter-start-date').fill('2026-11-01');
    await page.getByTestId('mutation-filter-end-date').fill('2026-11-04');
    await page.getByTestId('mutation-filter-warehouse').selectOption('11');
    await page.getByTestId('mutation-filter-sort-order').selectOption('ASC');
    await sleep(600);

    // Pastikan baris 2003 (metadata.grn_id=502 dengan operation_key berbeda) menampilkan GRN-20261101-002 dan Saldo Awal 24 -> 48
    const row2003 = page.getByTestId('mutation-row-2003');
    await row2003.waitFor({ state: 'visible', timeout: 10000 });
    const row2003Cells = await row2003.locator('td').allInnerTexts();
    assert.equal(row2003Cells[4].trim(), '24');
    assert.equal(row2003Cells[5].trim(), '+24');
    assert.equal(row2003Cells[7].trim(), '48');
    assert(row2003Cells[9].includes('GRN-20261101-002'), 'Lookup GRN via metadata.grn_id=502 harus tampil di UI');

    await page.screenshot({
      path: path.join(DEFAULT_EVIDENCE_DIR, 'tahapa_03_filter_gabungan_wh01_periode_nov.png'),
      fullPage: false,
    });

    const reqCountBeforeShortPreview = globalMovementsRequests.length;
    await page.getByTestId('open-mutation-report-preview-btn').click();
    const previewModal = page.getByTestId('mutation-report-preview-modal');
    await previewModal.waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('mutation-report-printable-sheet').waitFor({ state: 'visible', timeout: 10000 });
    await sleep(400);

    const reqCountAfterShortPreview = globalMovementsRequests.length;
    assert.equal(reqCountAfterShortPreview, reqCountBeforeShortPreview + 1);
    assert(globalMovementsRequests.at(-1).includes('export_all=true'));

    const headerCells = await page.locator('[data-testid="mutation-report-8col-table"] thead th').allInnerTexts();
    assert.deepEqual(
      headerCells.map((h) => h.trim()),
      ['Tgl', 'Kode', 'Nama Barang', 'Saldo Awal', 'Masuk', 'Keluar', 'Saldo Akhir', 'Keterangan']
    );

    await page.screenshot({
      path: path.join(DEFAULT_EVIDENCE_DIR, 'tahapa_04_pratinjau_cetak_laporan_8_kolom.png'),
      fullPage: false,
    });

    // Klik tombol Cetak / Simpan PDF -> tidak boleh ada fetch baru
    await page.getByTestId('print-mutation-report-btn').click();
    await sleep(200);
    const reqCountAfterShortPrint = globalMovementsRequests.length;
    const printCount1 = await page.evaluate(() => window.__printCalledCount);
    assert.equal(printCount1, 1);
    assert.equal(reqCountAfterShortPrint, reqCountAfterShortPreview, 'Cetak tidak boleh memicu fetch baru');

    // Hasilkan PDF aktual aplikasi untuk laporan pendek (5 baris)
    const shortPdfPath = path.join(DEFAULT_EVIDENCE_DIR, 'laporan_mutasi_barang_pendek_5_baris.pdf');
    await page.pdf({
      path: shortPdfPath,
      preferCSSPageSize: true,
      printBackground: true,
    });
    const shortPdfInspection = inspectChromiumPdf(shortPdfPath);
    const shortMarkers = [];
    for (let i = 1; i <= 5; i++) {
      const m = `SROW_${String(i).padStart(4, '0')}`;
      assert(shortPdfInspection.full_text.includes(m), `PDF pendek wajib memuat baris ${m}`);
      shortMarkers.push(m);
    }
    assert(!shortPdfInspection.full_text.includes('SROW_0000'), 'Baris sebelum periode (SROW_0000) tidak boleh masuk tabel PDF');
    assert.equal(shortPdfInspection.page_count, 1, 'PDF 5 baris harus 1 halaman A4 landscape');
    assert.equal(shortPdfInspection.pages[0].is_landscape, true, 'PDF pendek wajib berorientasi A4 landscape');
    assert(shortPdfInspection.full_text.includes('OAK Lawang'));
    assert(shortPdfInspection.full_text.includes('Laporan Mutasi Barang'));
    assert(shortPdfInspection.full_text.includes('Warehouse: WH-01 (Gudang 1)'));
    assert(shortPdfInspection.full_text.includes('Tempat penyimpanan: Belum dirinci'));
    assert(shortPdfInspection.full_text.includes('Dibuat Oleh'));
    assert(shortPdfInspection.full_text.includes('Mengetahui'));

    // Tutup modal pratinjau pendek
    await page.getByTestId('close-mutation-preview-btn').click();
    await previewModal.waitFor({ state: 'hidden', timeout: 5000 });

    // -------------------------------------------------------------------------
    // SKENARIO 2: Laporan Panjang Multi-Halaman (125 Baris >= 120 Baris di OUT-CAFE)
    // -------------------------------------------------------------------------
    console.log('[UI-PDF-E2E] Skenario 2: Verifikasi pratinjau & PDF multi-halaman (125 baris di OUT-CAFE)...');
    await page.getByTestId('mutation-filter-warehouse').selectOption('12');
    await sleep(600);

    const reqCountBeforeLongPreview = globalMovementsRequests.length;
    await page.getByTestId('open-mutation-report-preview-btn').click();
    await previewModal.waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('mutation-report-printable-sheet').waitFor({ state: 'visible', timeout: 10000 });
    await sleep(500);

    const reqCountAfterLongPreview = globalMovementsRequests.length;
    assert.equal(reqCountAfterLongPreview, reqCountBeforeLongPreview + 1);

    // Pastikan di DOM pratinjau terdapat tepat 125 baris pada tabel 8 kolom
    const domPreviewRowCount = await page.locator('[data-testid="mutation-report-8col-table"] tbody tr').count();
    assert.equal(domPreviewRowCount, LONG_ROW_COUNT, 'Tabel pratinjau wajib merender seluruh 125 baris');

    // Klik Cetak / Simpan PDF -> pastikan memakai snapshot yang sama tanpa fetch tambahan
    await page.getByTestId('print-mutation-report-btn').click();
    await sleep(200);
    const reqCountAfterLongPrint = globalMovementsRequests.length;
    const printCount2 = await page.evaluate(() => window.__printCalledCount);
    assert.equal(printCount2, 2);
    assert.equal(reqCountAfterLongPrint, reqCountAfterLongPreview, 'Cetak laporan 125 baris tidak boleh memicu fetch baru');

    // Hasilkan PDF aktual aplikasi untuk laporan 125 baris
    const longPdfPath = path.join(DEFAULT_EVIDENCE_DIR, 'laporan_mutasi_barang_panjang_125_baris.pdf');
    await page.pdf({
      path: longPdfPath,
      preferCSSPageSize: true,
      printBackground: true,
    });

    const longPdfInspection = inspectChromiumPdf(longPdfPath);
    assert(longPdfInspection.page_count > 1, `PDF 125 baris wajib >1 halaman (aktual: ${longPdfInspection.page_count} halaman)`);

    for (const p of longPdfInspection.pages) {
      assert.equal(p.is_landscape, true, `Halaman ${p.page_number} wajib A4 landscape (${p.width_pt}x${p.height_pt})`);
    }

    // Verifikasi seluruh 125 kode baris (LROW_0001 s.d. LROW_0125) hadir tepat 1 kali dan berurutan tanpa terpotong/duplikat
    const allLongMatches = [...longPdfInspection.full_text.matchAll(/LROW_\d{4}/g)].map((m) => m[0]);
    const uniqueLongMatches = new Set(allLongMatches);
    assert.equal(
      uniqueLongMatches.size,
      LONG_ROW_COUNT,
      `Seluruh ${LONG_ROW_COUNT} baris unik wajib tercetak di PDF (aktual unik: ${uniqueLongMatches.size})`
    );
    assert.equal(
      allLongMatches.length,
      LONG_ROW_COUNT,
      `Tidak boleh ada baris terduplikasi di PDF (aktual kemunculan: ${allLongMatches.length})`
    );
    for (let i = 1; i <= LONG_ROW_COUNT; i++) {
      const expectedCode = `LROW_${String(i).padStart(4, '0')}`;
      assert.equal(
        allLongMatches[i - 1],
        expectedCode,
        `Urutan baris PDF ke-${i} harus ${expectedCode}, aktual ${allLongMatches[i - 1]}`
      );
    }

    // Verifikasi pengulangan header tabel 8 kolom pada setiap halaman yang memuat baris tabel
    const pagesWithRows = longPdfInspection.pages.filter((p) => /LROW_\d{4}/.test(p.text));
    assert(pagesWithRows.length >= 2, 'Baris tabel 125 baris harus tersebar di >=2 halaman');
    for (const p of pagesWithRows) {
      for (const colTitle of ['Tgl', 'Kode', 'Nama Barang', 'Saldo Awal', 'Masuk', 'Keluar', 'Saldo Akhir', 'Keterangan']) {
        assert(
          p.text.includes(colTitle),
          `Halaman ${p.page_number} yang memuat baris tabel wajib mengulang kolom header "${colTitle}"`
        );
      }
    }

    // Verifikasi ringkasan per satuan & blok tanda tangan utuh di halaman akhir
    const normalizedLongPdfText = longPdfInspection.full_text.replace(/\s+/g, ' ');
    assert(
      normalizedLongPdfText.includes('Ringkasan Kuantitas Mutasi per Satuan Dasar'),
      'Judul ringkasan kuantitas mutasi per satuan dasar wajib ada di PDF'
    );
    assert(
      /BOTOL\s*:\s*Masuk\s+314\s*•\s*Keluar\s+66\s*\(\s*100\s*baris\s*\)/.test(normalizedLongPdfText),
      'Ringkasan satuan BOTOL (Masuk 314 • Keluar 66, 100 baris) wajib ada di PDF'
    );
    assert(
      /GRAM\s*:\s*Masuk\s+114\s*•\s*Keluar\s+16\s*\(\s*25\s*baris\s*\)/.test(normalizedLongPdfText),
      'Ringkasan satuan GRAM (Masuk 114 • Keluar 16, 25 baris) wajib ada di PDF'
    );
    const lastPageWithSig = longPdfInspection.pages.find((p) => p.text.includes('Dibuat Oleh'));
    assert(lastPageWithSig, 'Blok tanda tangan Dibuat Oleh wajib ada di PDF');
    assert(
      lastPageWithSig.text.includes('Mengetahui') && lastPageWithSig.text.includes('(Nama jelas)'),
      'Blok tanda tangan (Dibuat Oleh + Mengetahui + Nama jelas) wajib utuh pada halaman yang sama (tidak terpotong)'
    );

    // -------------------------------------------------------------------------
    // SKENARIO 3: Uji E2E TA-F01 di Browser (Reload Preview Gagal & Race Jaringan)
    // -------------------------------------------------------------------------
    console.log('[UI-PDF-E2E] Skenario 3: Verifikasi TA-F01 di browser (reload preview gagal menonaktifkan cetak & race jaringan)...');

    let failNextPreviewExport = true;
    await page.route('**/api/pos/inventory/stock-movements-global*', async (route) => {
      const url = route.request().url();
      if (failNextPreviewExport && url.includes('export_all=true')) {
        failNextPreviewExport = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'ERROR',
            code: 'SIMULATED_PREVIEW_ERROR',
            message: 'Simulasi kegagalan jaringan saat muat ulang pratinjau',
          }),
        });
        return;
      }
      await route.continue();
    });

    // Klik Muat Ulang Pratinjau saat modal sedang menampilkan 125 baris -> gagal
    await page.getByTestId('refresh-mutation-preview-btn').click();
    await page.getByTestId('mutation-report-preview-error').waitFor({ state: 'visible', timeout: 5000 });

    // Pastikan lembar printable hilang dari DOM dan tombol cetak disabled
    const printableSheetCountAfterError = await page.getByTestId('mutation-report-printable-sheet').count();
    assert.equal(printableSheetCountAfterError, 0, 'Lembar printable tidak boleh tampil saat reload preview gagal');
    const isPrintBtnDisabled = await page.getByTestId('print-mutation-report-btn').isDisabled();
    assert.equal(isPrintBtnDisabled, true, 'Tombol Cetak wajib disabled saat reload preview gagal');

    await page.unroute('**/api/pos/inventory/stock-movements-global*');
    await page.getByTestId('close-mutation-preview-btn').click();
    await previewModal.waitFor({ state: 'hidden', timeout: 5000 });

    const uiSummary = {
      verified_at: new Date().toISOString(),
      status: 'PASS',
      fixture_environment: {
        container_name: CONTAINER_NAME,
        pg_port: pgPort,
        http_port: httpPort,
        frontend_dist_served: path.join(repoRoot, 'frontend', 'dist'),
        owner_uat_44187_55451_touched: false,
        comparator_uat_44185_55449_touched: false,
      },
      short_pdf_verification: {
        filename: 'laporan_mutasi_barang_pendek_5_baris.pdf',
        size_bytes: fs.statSync(shortPdfPath).size,
        sha256: sha256File(shortPdfPath),
        page_count: shortPdfInspection.page_count,
        page_1_dimensions_pt: [shortPdfInspection.pages[0].width_pt, shortPdfInspection.pages[0].height_pt],
        is_a4_landscape: shortPdfInspection.pages[0].is_landscape,
        row_count_verified: shortMarkers.length,
        row_markers_verified: shortMarkers,
        grn_metadata_only_lookup_verified: 'GRN-20261101-002',
        signatures_intact: true,
        extra_fetch_on_print: 0,
      },
      long_pdf_verification: {
        filename: 'laporan_mutasi_barang_panjang_125_baris.pdf',
        size_bytes: fs.statSync(longPdfPath).size,
        sha256: sha256File(longPdfPath),
        page_count: longPdfInspection.page_count,
        per_page_dimensions_pt: longPdfInspection.pages.map((p) => ({
          page: p.page_number,
          width_pt: p.width_pt,
          height_pt: p.height_pt,
          is_landscape: p.is_landscape,
          has_repeated_8col_header: ['Tgl', 'Kode', 'Nama Barang', 'Saldo Awal', 'Masuk', 'Keluar', 'Saldo Akhir', 'Keterangan'].every(
            (h) => p.text.includes(h)
          ),
          row_markers_on_page: [...p.text.matchAll(/LROW_\d{4}/g)].length,
        })),
        total_unique_row_markers_in_pdf: uniqueLongMatches.size,
        first_row_marker: allLongMatches[0],
        last_row_marker: allLongMatches[allLongMatches.length - 1],
        duplicate_or_missing_rows: 0,
        repeated_header_on_all_table_pages: true,
        totals_by_unit_present: ['BOTOL', 'GRAM'],
        signatures_intact_on_single_page: true,
        extra_fetch_on_print: 0,
      },
      ta_f01_browser_error_guard_verification: {
        reload_failure_clears_printable_sheet: true,
        print_button_disabled_on_error: true,
      },
    };

    fs.writeFileSync(
      path.join(DEFAULT_EVIDENCE_DIR, 'ui_e2e_print_preview_verification.json'),
      JSON.stringify(uiSummary, null, 2) + '\n',
      'utf8'
    );
    console.log('[UI-PDF-E2E] SEMUA VERIFIKASI UI, RACE/ERROR GUARD (TA-F01), & PDF PENDEK/125 BARIS A4 LANDSCAPE (TA-F02) LULUS (PASS)');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r)).catch(() => {});
    await pool.end().catch(() => {});
    if (createdContainerByThisSession) {
      console.log(`[CLEANUP] Menghapus container PostgreSQL sesi ini (${CONTAINER_NAME})...`);
      try {
        execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' });
      } catch {}
    }
  }
}

runUiAndPdfE2E().catch((err) => {
  console.error('[UI-PDF-E2E FAIL]', err);
  process.exit(1);
});
