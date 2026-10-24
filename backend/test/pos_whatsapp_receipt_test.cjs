'use strict';

/**
 * OAK HIMS — MP-05A POS WhatsApp Digital Receipt Integration Test
 * =========================================================================
 *
 * File: backend/test/pos_whatsapp_receipt_test.cjs
 *
 * Skenario Pengujian:
 *   - Skenario 1: Phone Normalization (08xx, +628xx, 8xx -> 628xx, strip chars, invalid checks).
 *   - Skenario 2: Phone Privacy Masking (62812****7890).
 *   - Skenario 3: WhatsApp Receipt Markdown Template Formatting (Header, Items, Subtotal, PBJT, Total, Payment, WIB).
 *   - Skenario 4: Isolated Postgres DB Migration & Table pos_whatsapp_receipt_logs.
 *   - Skenario 5: Proteksi Order Status (reject dispatch on OPEN order).
 *   - Skenario 6: Dispatch Sukses pada Order PAID (Mock Gateway, status SENT, audit log created).
 *   - Skenario 7: Pengambilan Riwayat Kirim (getWhatsAppReceiptLogs).
 *   - Skenario 8: Fallback ke Order guest_phone saat phoneNumber tidak dikirim.
 *   - Skenario 9: Setting Komunikasi Properti (disable whatsapp_enabled -> 403, custom intro/closing).
 *
 * Keamanan:
 *   - Container Docker PostgreSQL 15 terisolasi.
 *   - Dibersihkan tuntas di blok finally (zero container residue).
 *   - Menggunakan mock gateway tanpa transmisi jaringan eksternal.
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert');

const BACKEND_DIR = path.resolve(__dirname, '..');

const IMAGE = 'postgres:15';
const TEST_DB = 'oak_hims_pos_wa_receipt_test';
const TEST_USER = 'oak_wa_runner';
const CONTAINER_PREFIX = 'oak-hims-pos-wa-test-';

function safeStringify(val) {
  try {
    return JSON.stringify(val, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (e) {
    return String(val);
  }
}

const logLines = [];
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
  logLines.push(line);
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const results = [];

async function step(name, fn) {
  const started = Date.now();
  const out = await fn();
  const durationMs = Date.now() - started;
  results.push({ name, ok: true, durationMs, detail: out === undefined ? null : out });
  log(`PASS  ${name} (${durationMs} ms)${out === undefined ? '' : ` :: ${typeof out === 'string' ? out : safeStringify(out)}`}`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Docker Management
// ─────────────────────────────────────────────────────────────────────────────
function docker(args, { timeout = 120000, allowFail = false } = {}) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (allowFail) return null;
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    const e = new Error(`docker ${args.join(' ')} gagal: ${stderr || err?.message || err}`);
    e.code = 'DOCKER_ERROR';
    throw e;
  }
}

function startContainer() {
  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const name = `${CONTAINER_PREFIX}${suffix}`;
  const password = crypto.randomBytes(18).toString('base64url');

  docker(
    [
      'run',
      '-d',
      '--name', name,
      '-e', `POSTGRES_USER=${TEST_USER}`,
      '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', `POSTGRES_DB=${TEST_DB}`,
      '-e', 'POSTGRES_INITDB_ARGS=--encoding=UTF8',
      '-p', '127.0.0.1::5432',
      IMAGE,
    ],
    { timeout: 300000 }
  );

  return { name, password };
}

function resolveHostPort(containerName) {
  const out = docker(['port', containerName, '5432/tcp'], { timeout: 30000 });
  const match = out.match(/127\.0\.0\.1:(\d+)/);
  if (!match) {
    throw new Error(`Tidak dapat membaca port host dari output "docker port": ${out || '(kosong)'}`);
  }
  return Number(match[1]);
}

function stopContainer(containerName) {
  if (!containerName) return;
  docker(['rm', '-f', containerName], { allowFail: true, timeout: 60000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Production module loading
// ─────────────────────────────────────────────────────────────────────────────
function loadProductionModules() {
  const dotenvPath = require.resolve('dotenv', { paths: [BACKEND_DIR] });
  const dotenv = require(dotenvPath);
  dotenv.config = () => ({ parsed: {} });

  const schemaPath = path.join(BACKEND_DIR, 'dist', 'db', 'schema_v3.js');
  const posWhatsappServicePath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'posWhatsappService.js');
  const settlementServicePath = path.join(BACKEND_DIR, 'dist', 'domains', 'pos', 'posSettlementService.js');

  const posPaymentSettlement = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_payment_settlement_v1.js'));
  const posOrderExpansion = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_order_expansion_v1.js'));
  const posServiceTax = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_service_tax_v1.js'));
  const posReceiptSnapshot = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_receipt_snapshot_v1.js'));
  const posCommSettings = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_communication_settings_v1.js'));
  const posWhatsappReceipt = require(path.join(BACKEND_DIR, 'dist', 'db', 'migrations', 'pos_whatsapp_receipt_v1.js'));

  return {
    schema: require(schemaPath),
    posWhatsapp: require(posWhatsappServicePath),
    settlement: require(settlementServicePath),
    migrations: {
      posPaymentSettlement,
      posOrderExpansion,
      posServiceTax,
      posReceiptSnapshot,
      posCommSettings,
      posWhatsappReceipt,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Test Runner
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log('========================================================================');
  log(' OAK HIMS — MP-05A POS WhatsApp Digital Receipt Test Suite');
  log('========================================================================');

  const { schema, posWhatsapp, settlement, migrations } = loadProductionModules();
  const {
    normalizeIndonesianPhoneNumber,
    maskPhoneNumber,
    buildPosDigitalReceiptWhatsAppMessage,
    sendPosReceiptWhatsApp,
    getWhatsAppReceiptLogs,
  } = posWhatsapp;
  const { payPosOrderCash } = settlement;

  // ── Skenario 1: Phone Normalization ──────────────────────────────────────
  await step('Unit: normalizeIndonesianPhoneNumber standard format', async () => {
    assert.strictEqual(normalizeIndonesianPhoneNumber('081234567890'), '6281234567890');
    assert.strictEqual(normalizeIndonesianPhoneNumber('+6281234567890'), '6281234567890');
    assert.strictEqual(normalizeIndonesianPhoneNumber('6281234567890'), '6281234567890');
    assert.strictEqual(normalizeIndonesianPhoneNumber('81234567890'), '6281234567890');
    assert.strictEqual(normalizeIndonesianPhoneNumber('0812-3456-7890'), '6281234567890');
    assert.strictEqual(normalizeIndonesianPhoneNumber('0812 3456 7890'), '6281234567890');
    assert.strictEqual(normalizeIndonesianPhoneNumber('+62 (812) 3456-7890'), '6281234567890');
  });

  await step('Unit: normalizeIndonesianPhoneNumber invalid cases return null', async () => {
    assert.strictEqual(normalizeIndonesianPhoneNumber('0211234567'), null, 'Landline must be rejected');
    assert.strictEqual(normalizeIndonesianPhoneNumber('12345'), null, 'Short numbers rejected');
    assert.strictEqual(normalizeIndonesianPhoneNumber('0812345'), null, 'Too short rejected');
    assert.strictEqual(normalizeIndonesianPhoneNumber('081234567890123456'), null, 'Too long rejected');
    assert.strictEqual(normalizeIndonesianPhoneNumber(''), null);
    assert.strictEqual(normalizeIndonesianPhoneNumber(null), null);
    assert.strictEqual(normalizeIndonesianPhoneNumber(undefined), null);
    assert.strictEqual(normalizeIndonesianPhoneNumber('abcdef'), null);
  });

  // ── Skenario 2: Phone Privacy Masking ────────────────────────────────────
  await step('Unit: maskPhoneNumber protects customer phone privacy', async () => {
    assert.strictEqual(maskPhoneNumber('6281234567890'), '62812****7890');
    assert.strictEqual(maskPhoneNumber('081234567890'), '08123****7890');
    assert.strictEqual(maskPhoneNumber(null), 'EMPTY');
  });

  // ── Skenario 3: WhatsApp Receipt Markdown Template Formatting ───────────
  await step('Unit: buildPosDigitalReceiptWhatsAppMessage formats complete markdown', async () => {
    const mockReceipt = {
      property: {
        id: 1,
        name: 'OAK Prime Boutique Hotel',
        timezone: 'Asia/Jakarta',
      },
      order: {
        id: 101,
        order_number: 'ORD-20261024-001',
        property_id: 1,
        status: 'PAID',
        guest_name: 'Budi Santoso',
        guest_phone: '081234567890',
        table_number: 'Table 04',
        total_amount: '121000',
        discount_amount: '10000',
        service_amount: '10000',
        tax_amount: '11000',
        service_charge_percent_snapshot: '10',
        tax_percent_snapshot: '10',
        created_at: '2026-10-24T12:30:00Z',
      },
      items: [
        {
          item_name_snapshot: 'Nasi Goreng Spesial',
          quantity: 2,
          unit_price: '50000',
          discount_amount: '0',
        },
        {
          item_name_snapshot: 'Es Teh Manis',
          quantity: 2,
          unit_price: '10000',
          discount_amount: '0',
        },
      ],
      settlement: {
        id: 501,
        amount: '121000',
        payment_method: 'CASH',
        status: 'SUCCESS',
        cash_received: '150000',
        change_due: '29000',
        payment_reference: 'CASH-PAY-001',
      },
      sale: {
        id: 'sale-001',
        transaction_no: 'TRX-20261024-001',
        transaction_type: 'SALE',
        source_type: 'POS_ORDER',
        source_id: '101',
        payment_status: 'PAID',
        payment_method: 'CASH',
        net_amount: '121000',
      },
    };

    const msg = buildPosDigitalReceiptWhatsAppMessage(mockReceipt, {
      intro: 'Halo Budi, terima kasih telah berkunjung!',
      closing: 'Semoga harimu menyenangkan!',
      receiptUrl: 'https://oakhotel.com/pos/receipt/101',
    });

    assert(msg.includes('OAK Prime Boutique Hotel'), 'Contains property name');
    assert(msg.includes('No. Struk:'), 'Contains No. Struk');
    assert(msg.includes('DETAIL PESANAN:'), 'Contains DETAIL PESANAN');
    assert(msg.includes('ORD-20261024-001'), 'Contains order number');
    assert(msg.includes('Budi Santoso'), 'Contains guest name');
    assert(msg.includes('Table 04'), 'Contains table');
    assert(msg.includes('Nasi Goreng Spesial'), 'Contains item 1');
    assert(msg.includes('Es Teh Manis'), 'Contains item 2');
    assert(msg.includes('121.000'), 'Contains grand total formatted');
    assert(msg.includes('Metode: *CASH*'), 'Contains payment method');
    assert(msg.includes('150.000'), 'Contains cash received');
    assert(msg.includes('29.000'), 'Contains change due');
    assert(msg.includes('Halo Budi'), 'Contains custom intro');
    assert(msg.includes('Semoga harimu menyenangkan!'), 'Contains custom closing');
    assert(msg.includes('https://oakhotel.com/pos/receipt/101'), 'Contains receipt URL');
    assert(msg.includes('WIB'), 'Contains WIB timezone indicator');
  });

  // ── Skenario 4-9: Isolated Postgres Container ────────────────────────────
  log('\nMenyiapkan database terisolasi di container Docker PostgreSQL 15...');
  let container = null;
  const { Pool } = require(path.join(BACKEND_DIR, 'node_modules', 'pg'));
  let pool = null;

  try {
    container = startContainer();
    const port = resolveHostPort(container.name);

    pool = new Pool({
      host: '127.0.0.1',
      port,
      user: TEST_USER,
      password: container.password,
      database: TEST_DB,
      connectionTimeoutMillis: 5000,
    });

    // Wait for PG to be ready
    let connected = false;
    for (let i = 0; i < 30; i++) {
      try {
        await pool.query('SELECT 1');
        connected = true;
        break;
      } catch {
        await sleep(500);
      }
    }
    assert(connected, 'Database container ready');

    // Initialize Schema V3 and all POS migrations
    await step('DB: Inisialisasi schema_v3 dan migrasi lengkap POS & WhatsApp', async () => {
      await schema.initializeDatabase(pool);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS property_payment_instructions (
          id SERIAL PRIMARY KEY,
          property_id INTEGER NOT NULL REFERENCES properties(id),
          bank_name VARCHAR(100),
          account_name VARCHAR(100),
          account_number VARCHAR(100),
          instruction_text TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await migrations.posPaymentSettlement.runPosPaymentSettlementMigration(pool);
      await migrations.posOrderExpansion.runPosOrderExpansionMigration(pool);
      await migrations.posServiceTax.runPosServiceTaxMigration(pool);
      await migrations.posReceiptSnapshot.runPosReceiptSnapshotMigration(pool);
      await migrations.posCommSettings.runPosCommunicationSettingsMigration(pool);
      await migrations.posWhatsappReceipt.runPosWhatsappReceiptMigration(pool);

      const res = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'pos_whatsapp_receipt_logs'`
      );
      assert(res.rows.length >= 8, 'Tabel pos_whatsapp_receipt_logs harus memiliki minimal 8 kolom');
      return `pos_whatsapp_receipt_logs terverifikasi (${res.rows.length} kolom)`;
    });

    // Seed test fixtures
    let testPropertyId = null;
    let testProductId = null;
    let testOrderId = null;

    await step('DB: Setup Property, Category, Product, dan Order OPEN', async () => {
      const propRes = await pool.query(`
        INSERT INTO properties (name, property_code)
        VALUES ('OAK Grand Heritage', 'OGH')
        RETURNING id
      `);
      testPropertyId = Number(propRes.rows[0].id);

      const catRes = await pool.query(`
        INSERT INTO pos_menu_categories (property_id, name)
        VALUES ($1, 'Food & Beverage')
        RETURNING id
      `, [testPropertyId]);
      const catId = Number(catRes.rows[0].id);

      const prodRes = await pool.query(`
        INSERT INTO pos_menu_items (
          property_id, category_id, item_code, name, price, is_active, is_sellable_pos
        ) VALUES ($1, $2, 'FNB-STK-01', 'Wagyu Ribeye Steak', 250000, TRUE, TRUE)
        RETURNING id
      `, [testPropertyId, catId]);
      testProductId = Number(prodRes.rows[0].id);

      // Create OPEN order with snapshots
      const orderRes = await pool.query(`
        INSERT INTO pos_orders (
          property_id, order_number, status, guest_name, guest_phone, total_amount,
          service_amount, tax_amount, service_charge_percent_snapshot, tax_percent_snapshot,
          service_charge_enabled_snapshot, tax_enabled_snapshot, created_at, updated_at
        ) VALUES (
          $1, 'ORD-WA-001', 'OPEN', 'Pak Handoko', '081234567890', '250000',
          '0', '0', '0', '0', FALSE, FALSE, NOW(), NOW()
        ) RETURNING id
      `, [testPropertyId]);
      testOrderId = Number(orderRes.rows[0].id);

      await pool.query(`
        INSERT INTO pos_order_items (
          order_id, menu_item_id, item_name_snapshot, quantity, unit_price, discount_amount, created_at
        ) VALUES ($1, $2, 'Wagyu Ribeye Steak', 1, 250000, 0, NOW())
      `, [testOrderId, testProductId]);

      return `Property ${testPropertyId}, Product ${testProductId}, Order ${testOrderId} (status: OPEN)`;
    });

    // ── Skenario 5: Reject dispatch on OPEN order ───────────────────────────
    await step('Proteksi: Dispatch ditolak jika order belum PAID (status OPEN)', async () => {
      let rejected = false;
      try {
        await sendPosReceiptWhatsApp(pool, {
          orderId: testOrderId,
          propertyId: testPropertyId,
          phoneNumber: '081234567890',
        });
      } catch (err) {
        rejected = true;
        const msg = String(err.message || '');
        assert(
          msg.includes('hanya dapat dikirim untuk order yang sudah lunas/PAID') ||
          msg.includes('Settlement belum diselesaikan'),
          `Pesan error sesuai: ${msg}`
        );
      }
      assert(rejected, 'Harus ditolak dengan error');
    });

    // Settle order via payPosOrderCash
    await step('Operasional: Settle order via payPosOrderCash menjadi PAID', async () => {
      const settleClient = await pool.connect();
      try {
        const settleRes = await payPosOrderCash(settleClient, {
          orderId: testOrderId,
          propertyId: testPropertyId,
          idempotencyKey: `idemp-wa-test-${Date.now()}`,
          methodInput: { cashReceived: 300000 },
          actorName: 'Kasir Utama',
        });
        assert.strictEqual(settleRes.settlement.status, 'SUCCESS');
        assert.strictEqual(Number(settleRes.settlement.change_due), 50000);
      } finally {
        settleClient.release();
      }

      const checkOrder = await pool.query('SELECT status FROM pos_orders WHERE id = $1', [testOrderId]);
      assert.strictEqual(checkOrder.rows[0].status, 'PAID');
      return 'Order berstatus PAID';
    });

    // ── Skenario 6: Dispatch Sukses pada Order PAID ─────────────────────────
    let firstLogId = null;
    await step('Dispatch: Kirim struk WA dengan nomor eksplisit (Mock Gateway)', async () => {
      const res = await sendPosReceiptWhatsApp(pool, {
        orderId: testOrderId,
        propertyId: testPropertyId,
        phoneNumber: '0812-3456-7890',
        sentByUserId: 1,
      });

      assert.strictEqual(res.order_id, testOrderId);
      assert.strictEqual(res.phone_number, '6281234567890');
      assert.strictEqual(res.phone_number_masked, '62812****7890');
      assert.strictEqual(res.status, 'SENT');
      assert(res.message_id, 'Memiliki message_id dari gateway');

      // Verifikasi baris di pos_whatsapp_receipt_logs
      const logRows = await pool.query(
        'SELECT * FROM pos_whatsapp_receipt_logs WHERE order_id = $1 ORDER BY id DESC',
        [testOrderId]
      );
      assert.strictEqual(logRows.rows.length, 1);
      assert.strictEqual(logRows.rows[0].status, 'SENT');
      assert.strictEqual(logRows.rows[0].recipient_phone, '6281234567890');
      assert.strictEqual(logRows.rows[0].recipient_phone_masked, '62812****7890');
      assert(logRows.rows[0].message_content.includes('Wagyu Ribeye Steak'));
      firstLogId = Number(logRows.rows[0].id);

      return `Struk terkirim ke ${res.phone_number_masked} (Log ID: ${firstLogId})`;
    });

    // ── Skenario 7: Pengambilan Riwayat Kirim (getWhatsAppReceiptLogs) ───────
    await step('Query: getWhatsAppReceiptLogs mengembalikan riwayat pengiriman', async () => {
      const logs = await getWhatsAppReceiptLogs(pool, testOrderId, testPropertyId);
      assert(Array.isArray(logs));
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0].id, firstLogId);
      assert.strictEqual(logs[0].recipient_phone_masked, '62812****7890');
      assert.strictEqual(logs[0].status, 'SENT');
      return `Ditemukan ${logs.length} riwayat kirim`;
    });

    // ── Skenario 8: Fallback ke Order guest_phone ───────────────────────────
    await step('Fallback: Kirim struk otomatis ke order.guest_phone jika argumen kosong', async () => {
      // Update guest_phone menjadi nomor lain
      await pool.query('UPDATE pos_orders SET guest_phone = $1 WHERE id = $2', ['089876543210', testOrderId]);

      const res = await sendPosReceiptWhatsApp(pool, {
        orderId: testOrderId,
        propertyId: testPropertyId,
        phoneNumber: null, // biarkan kosong
      });

      assert.strictEqual(res.phone_number, '6289876543210');
      assert.strictEqual(res.phone_number_masked, '62898****3210');
      assert.strictEqual(res.status, 'SENT');

      const logsAfter = await getWhatsAppReceiptLogs(pool, testOrderId, testPropertyId);
      assert.strictEqual(logsAfter.length, 2);
      return `Fallback berhasil ke ${res.phone_number_masked}`;
    });

    // ── Skenario 9: Setting Komunikasi Properti ─────────────────────────────
    await step('Konfigurasi: setting whatsapp_enabled = FALSE menolak pengiriman', async () => {
      // Masukkan setting komunikasi whatsapp_enabled = false
      await pool.query(`
        INSERT INTO property_pos_communication_settings (property_id, whatsapp_enabled, updated_at)
        VALUES ($1, FALSE, NOW())
      `, [testPropertyId]);

      let blocked = false;
      try {
        await sendPosReceiptWhatsApp(pool, {
          orderId: testOrderId,
          propertyId: testPropertyId,
          phoneNumber: '081234567890',
        });
      } catch (err) {
        blocked = true;
        assert(err.code === 'WHATSAPP_DISABLED' || String(err.message).includes('dinonaktifkan'));
      }
      assert(blocked, 'Pengiriman harus diblokir saat setting whatsapp_enabled=FALSE');
      return 'Blokir berhasil ketika whatsapp_enabled = FALSE';
    });

    await step('Konfigurasi: custom intro & closing disisipkan ke pesan struk', async () => {
      // Aktifkan kembali dengan custom intro & closing
      await pool.query(`
        UPDATE property_pos_communication_settings
        SET whatsapp_enabled = TRUE,
            whatsapp_intro_message = 'Terima kasih telah bersantap di Restoran OAK!',
            whatsapp_closing_message = 'Simpan struk ini untuk klaim poin loyalty.',
            updated_at = NOW()
        WHERE property_id = $1
      `, [testPropertyId]);

      const res = await sendPosReceiptWhatsApp(pool, {
        orderId: testOrderId,
        propertyId: testPropertyId,
        phoneNumber: '081234567890',
      });
      assert.strictEqual(res.status, 'SENT');

      const latestLog = await pool.query(
        'SELECT message_content FROM pos_whatsapp_receipt_logs WHERE order_id = $1 ORDER BY id DESC LIMIT 1',
        [testOrderId]
      );
      const content = latestLog.rows[0].message_content;
      assert(content.includes('Terima kasih telah bersantap di Restoran OAK!'), 'Intro custom hadir');
      assert(content.includes('Simpan struk ini untuk klaim poin loyalty.'), 'Closing custom hadir');

      return 'Custom intro & closing pesan struk terverifikasi';
    });

    log('\n========================================================================');
    log(' SEMUA SKENARIO PENGUJIAN MP-05A LULUS 100% (PASS)');
    log('========================================================================');
  } finally {
    if (pool) {
      await pool.end().catch(() => {});
    }
    if (container) {
      log(`Menghentikan dan menghapus container uji: ${container.name}`);
      stopContainer(container.name);
      log('Container terisolasi dibersihkan (zero residue).');
    }
  }
}

main().catch((err) => {
  console.error('\nTEST RUN FAILED:', err);
  process.exit(1);
});
