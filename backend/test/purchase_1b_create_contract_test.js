'use strict';

const http = require('http');
const express = require('express');
const { createTransactionsRouter } = require('../dist/domains/transactions/transactionsRouter');
const {
  createPurchaseTransaction,
  getTransactionById,
  getTransactions,
  addTransactionAttachment,
  generatePurchaseDescription,
  createCustomCategory,
} = require('../dist/domains/transactions/transactionService');
const { createSupplier } = require('../dist/domains/suppliers/supplierService');
const { getPlatformSuperAdminToken, staffToken, authHeaders } = require('./helpers/transactionReadAuth');

let assertions = 0;
function expect(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function requestJson(port, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        const text = Buffer.concat(chunks).toString('utf8');
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function trxNo(value) {
  return /^TRX-\d{6}-\d{5}$/.test(String(value || ''));
}

async function run() {
  expect(
    generatePurchaseDescription({ lineDescriptions: ['Beras'], supplierName: 'Puga' }) === 'Pembelian Beras — Puga',
    'D. 1 item summary'
  );
  expect(
    generatePurchaseDescription({
      lineDescriptions: ['Beras', 'Minyak', 'Gula'],
      supplierName: 'Puga',
    }) === 'Pembelian Beras + 2 item lainnya — Puga',
    'D. multi-item summary'
  );
  expect(
    generatePurchaseDescription({ lineDescriptions: ['Beras'], supplierName: '' }) === 'Pembelian Beras',
    'D. summary without supplier'
  );

  const pkg = require('../dist/index.js');
  const schemaPkg = require('../dist/db/schema_v3.js');
  const pool = pkg.pool;
  await schemaPkg.initializeDatabase(pool);

  const rand = Math.floor(1000 + Math.random() * 9000);
  const propA = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('PUR-1B-A', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`PA${rand}`]
  );
  const propB = await pool.query(
    "INSERT INTO properties (name, property_code, timezone, currency, address, is_active) VALUES ('PUR-1B-B', $1, 'Asia/Jakarta', 'IDR', 'Addr', TRUE) RETURNING id",
    [`PB${rand}`]
  );
  const propertyA = Number(propA.rows[0].id);
  const propertyB = Number(propB.rows[0].id);
  const tracked = { transactions: [], suppliers: [] };

  const app = express();
  app.use(express.json());
  app.use('/api/transactions', createTransactionsRouter(pool));
  const { server, port } = await listen(app);

  try {
    const supplierA = await createSupplier(pool, {
      property_id: propertyA,
      name: 'Puga',
      actor_name: 'Tester',
    });
    tracked.suppliers.push(Number(supplierA.id));
    const supplierB = await createSupplier(pool, {
      property_id: propertyB,
      name: 'Vendor B',
      actor_name: 'Tester',
    });
    tracked.suppliers.push(Number(supplierB.id));

    const customPurchaseA = await createCustomCategory(pool, {
      property_id: propertyA,
      code: `PUR_CUSTOM_A_${rand}`,
      name: 'Pembelian Custom Properti A',
      transaction_type: 'PURCHASE',
      department_code: 'FNB',
    });
    const customPurchaseB = await createCustomCategory(pool, {
      property_id: propertyB,
      code: `PUR_CUSTOM_B_${rand}`,
      name: 'Pembelian Custom Properti B',
      transaction_type: 'PURCHASE',
      department_code: 'FNB',
    });

    const staging = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      transaction_date: '2026-09-08',
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      category_name: 'Pembelian Bahan Baku Makanan & Minuman',
      department_code: 'FNB',
      supplier_id: supplierA.id,
      source_reference: 'INV-PUGA-1',
      receiving_status: 'DITERIMA',
      lines: [{
        description_snapshot: 'Beras',
        quantity: 1,
        unit: 'kg',
        unit_price: 10000,
        discount_amount: 0,
      }],
      is_immediately_paid: true,
      payment_method: 'TRANSFER',
      paid_amount: 10000,
      notes: 'Nota Puga',
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(staging.id);

    expect(String(staging.transaction_type) === 'PURCHASE', 'A. type PURCHASE');
    expect(String(staging.description) === 'Pembelian Beras — Puga', 'B/C/D. generated description without caller title');
    expect(trxNo(staging.transaction_no), `E. canonical transaction_no ${staging.transaction_no}`);
    expect(String(staging.transaction_no) !== 'INV-PUGA-1', 'F. transaction_no != supplier invoice');
    expect(String(staging.source_reference) === 'INV-PUGA-1', 'W. source_reference saved separately');
    expect(String(staging.supplier_id) === String(supplierA.id), 'H. supplier_id persisted');
    expect(String(staging.party_name) === 'Puga', 'I. supplier snapshot');
    expect(String(staging.department_code) === 'FNB', 'J. department_code persisted');
    expect(String(staging.category_code) === 'FNB_INGREDIENTS_PURCHASE', 'A. category_code saved');
    expect(String(staging.category_name) === 'Pembelian Bahan Baku Makanan & Minuman', 'A. category_name snapshot');
    expect(Number(staging.net_amount) === 10000, 'Q. net 10000');
    expect(Number(staging.paid_amount) === 10000, 'Q. paid 10000');
    expect(Number(staging.outstanding_amount) === 0, 'Q. remaining 0');
    expect(String(staging.payment_status) === 'PAID', 'Q. PAID');
    expect(String(staging.receiving_status) === 'DITERIMA', 'T/G. receipt complete');
    expect(String(staging.category_code) === 'FNB_INGREDIENTS_PURCHASE', 'A. system PURCHASE category succeeds');
    expect(Array.isArray(staging.lines) && staging.lines.length === 1, 'K. one line');
    expect(String(staging.lines[0].description_snapshot) === 'Beras', 'K. item name');

    const payments = await pool.query(
      `SELECT id, transaction_type, amount FROM payment_transactions WHERE transaction_id = $1 AND property_id = $2`,
      [staging.id, propertyA]
    );
    expect(payments.rows.length === 1, 'X. one settlement payment');
    expect(String(payments.rows[0].transaction_type) === 'PAYMENT', 'X. payment type PAYMENT');
    const extraPurchase = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE property_id = $1 AND id <> $2 AND transaction_type = 'PURCHASE' AND supplier_id = $3 AND net_amount = 10000 AND source_reference = 'INV-PUGA-1'`,
      [propertyA, staging.id, supplierA.id]
    );
    expect(Number(extraPurchase.rows[0].n) === 0, 'X/1B1-M. payment does not duplicate PURCHASE');

    const listPurchase = await getTransactions(pool, { property_id: propertyA, transaction_type: 'PURCHASE' });
    const purchaseHits = listPurchase.transactions.filter((row) => Number(row.id) === Number(staging.id));
    expect(purchaseHits.length === 1, 'Y. appears once in Pembelian');
    const listAll = await getTransactions(pool, { property_id: propertyA });
    const allHits = listAll.transactions.filter((row) => Number(row.id) === Number(staging.id));
    expect(allHits.length === 1, 'Z. appears once in Lihat Semua');

    const second = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      category_name: 'Pembelian Bahan Baku Makanan & Minuman',
      department_code: 'FNB',
      supplier_id: supplierA.id,
      source_reference: 'INV-PUGA-2',
      lines: [{ description_snapshot: 'Gula', quantity: 1, unit: 'kg', unit_price: 8000 }],
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(second.id);
    expect(trxNo(second.transaction_no), 'E. second transaction_no');
    expect(String(second.transaction_no) !== String(staging.transaction_no), 'G. unique transaction_no');

    const multi = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      department_code: 'FNB',
      supplier_id: supplierA.id,
      lines: [
        { description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000, discount_amount: 0 },
        { description_snapshot: 'Minyak', quantity: 2, unit: 'L', unit_price: 15000, discount_amount: 5000 },
        { description_snapshot: 'Gula', quantity: 1, unit: 'kg', unit_price: 8000 },
      ],
      discount_amount: 2000,
      rounding_amount: 37,
      receiving_status: 'DITERIMA_SEBAGIAN',
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(multi.id);
    const multiDetail = await getTransactionById(pool, propertyA, multi.id);
    expect(multiDetail.lines.length === 3, 'L. three lines');
    expect(String(multiDetail.description) === 'Pembelian Beras + 2 item lainnya — Puga', 'D. multi summary');
    expect(Number(multiDetail.lines[0].line_total) === 10000, 'M. qty * price');
    expect(Number(multiDetail.lines[1].line_total) === 25000, 'N. line discount 30000-5000');
    expect(Number(multiDetail.amount) === 43000, 'O. subtotal before global discount');
    expect(Number(multiDetail.discount_amount) === 2000, 'O. global discount persisted');
    expect(Number(multiDetail.rounding_amount) === 37, 'P. rounding');
    expect(Number(multiDetail.net_amount) === 41037, 'O/P/1B1-L. net = 43000-2000+37 once');
    expect(String(multiDetail.receiving_status) === 'DITERIMA_SEBAGIAN', 'U/1B1-H. receipt partial');

    const tempo = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      supplier_id: supplierA.id,
      receiving_status: 'BELUM_DITERIMA',
      lines: [{ description_snapshot: 'Tepung', quantity: 1, unit: 'sak', unit_price: 20000 }],
      is_immediately_paid: false,
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(tempo.id);
    expect(String(tempo.payment_status) === 'UNPAID', 'S. tempo unpaid');
    expect(Number(tempo.paid_amount) === 0, 'S. paid 0');
    expect(Number(tempo.outstanding_amount) === 20000, 'S. remaining = net');
    expect(String(tempo.receiving_status) === 'BELUM_DITERIMA', 'V/1B1-I. not received');

    const partial = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      supplier_id: supplierA.id,
      lines: [{ description_snapshot: 'Garam', quantity: 1, unit: 'kg', unit_price: 10000 }],
      paid_amount: 4000,
      payment_method: 'TRANSFER',
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(partial.id);
    expect(String(partial.payment_status) === 'PARTIALLY_PAID', 'R. partial payment');
    expect(Number(partial.paid_amount) === 4000, 'R. paid 4000');
    expect(Number(partial.outstanding_amount) === 6000, 'R. remaining 6000');

    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        category_code: 'FNB_INGREDIENTS_PURCHASE',
        supplier_id: supplierB.id,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /bukan milik properti/,
      'AC. cross-property supplier blocked'
    );

    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: 0,
        lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      }),
      /property_id is required/,
      'AA. invalid property blocked at service'
    );

    const customCreated = await createPurchaseTransaction(pool, {
      property_id: propertyA,
      category_code: customPurchaseA.code,
      category_name: customPurchaseA.name,
      department_code: 'FNB',
      supplier_id: supplierA.id,
      receiving_status: 'BELUM_DITERIMA',
      lines: [{ description_snapshot: 'Garam Dapur', quantity: 1, unit: 'kg', unit_price: 5000 }],
      actor_name: 'Purchasing',
    });
    tracked.transactions.push(customCreated.id);
    expect(String(customCreated.category_code) === String(customPurchaseA.code), '1B1-B. custom PURCHASE category succeeds');
    expect(String(customCreated.transaction_type) === 'PURCHASE', '1B1-B. custom stays PURCHASE');

    const wrongTypeLine = { description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 };
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        category_code: 'ROOM_SALES',
        supplier_id: supplierA.id,
        lines: [wrongTypeLine],
      }),
      /bukan kategori pembelian|tidak valid/,
      '1B1-C. SALE category rejected'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        category_code: 'PETTY_CASH',
        supplier_id: supplierA.id,
        lines: [wrongTypeLine],
      }),
      /bukan kategori pembelian|tidak valid/,
      '1B1-D. EXPENSE category rejected'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        category_code: 'OTHER_INCOME',
        supplier_id: supplierA.id,
        lines: [wrongTypeLine],
      }),
      /bukan kategori pembelian|tidak valid/,
      '1B1-E. INCOME category rejected'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        category_code: customPurchaseB.code,
        supplier_id: supplierA.id,
        lines: [wrongTypeLine],
      }),
      /tidak valid/,
      '1B1-F. cross-property custom category rejected'
    );
    await expectReject(
      () => createPurchaseTransaction(pool, {
        property_id: propertyA,
        category_code: 'FNB_INGREDIENTS_PURCHASE',
        supplier_id: supplierA.id,
        receiving_status: 'DITERIMA_LENGKAP',
        lines: [wrongTypeLine],
      }),
      /Status penerimaan/,
      '1B1-J. invalid receiving_status rejected'
    );

    const saToken = await getPlatformSuperAdminToken(pool, propertyA);
    const staffB = staffToken(propertyB, 900141);
    const httpBody = {
      property_id: propertyA,
      category_code: 'FNB_INGREDIENTS_PURCHASE',
      category_name: 'Pembelian Bahan Baku Makanan & Minuman',
      department_code: 'FNB',
      supplier_id: supplierA.id,
      receiving_status: 'DITERIMA',
      lines: [{ description_snapshot: 'Beras', quantity: 1, unit: 'kg', unit_price: 10000 }],
      is_immediately_paid: true,
      payment_method: 'TRANSFER',
      paid_amount: 10000,
    };

    const anon = await requestJson(port, 'POST', '/api/transactions/purchases', null, httpBody);
    expect(anon.status === 401, `AA. missing token 401 got ${anon.status}`);

    const noProp = await requestJson(port, 'POST', '/api/transactions/purchases', saToken, {
      ...httpBody,
      property_id: undefined,
    });
    expect(noProp.status === 400, `AA. missing property_id 400 got ${noProp.status}`);

    const crossUser = await requestJson(port, 'POST', '/api/transactions/purchases', staffB, httpBody);
    expect(crossUser.status === 403, `AB. ordinary other-property user 403 got ${crossUser.status}`);

    const saCreate = await requestJson(port, 'POST', '/api/transactions/purchases', saToken, httpBody);
    expect(saCreate.status === 201, `AD. Super Admin create 201 got ${saCreate.status} ${saCreate.json && saCreate.json.error}`);
    expect(saCreate.json && saCreate.json.success === true, 'AD. Super Admin success');
    expect(String(saCreate.json.data.description) === 'Pembelian Beras — Puga', 'B. HTTP create generates description');
    expect(trxNo(saCreate.json.data.transaction_no), 'E. HTTP transaction_no');
    tracked.transactions.push(saCreate.json.data.id);

    const attachment = await addTransactionAttachment(pool, propertyA, saCreate.json.data.id, {
      fileName: `pur1b-${rand}.jpg`,
      originalName: 'nota.jpg',
      mimeType: 'image/jpeg',
      fileSize: 128,
      storagePath: `/uploads/transactions/pur1b-${rand}.jpg`,
      uploadedBy: 'Purchasing',
      attachmentPurpose: 'RECEIPT',
    });
    expect(Boolean(attachment && attachment.id), 'AE. attachment follow-up after create');

    console.log(`PASS | PURCHASE-1B create contract | ${assertions} assertions`);
  } finally {
    server.close();
    try {
      if (tracked.transactions.length) {
        await pool.query('DELETE FROM payment_transactions WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]);
        await pool.query('DELETE FROM transaction_attachments WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]);
        await pool.query('DELETE FROM transaction_lines WHERE transaction_id = ANY($1::bigint[])', [tracked.transactions]);
        await pool.query('DELETE FROM transactions WHERE id = ANY($1::bigint[])', [tracked.transactions]);
      }
      if (tracked.suppliers.length) {
        await pool.query('DELETE FROM suppliers WHERE id = ANY($1::bigint[])', [tracked.suppliers]);
      }
      await pool.query('DELETE FROM transaction_custom_categories WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
      await pool.query('DELETE FROM audit_logs WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
      await pool.query('DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1::int[])', [[propertyA, propertyB]]);
      await pool.query('DELETE FROM properties WHERE id = ANY($1::int[])', [[propertyA, propertyB]]);
    } catch (cleanupErr) {
      console.warn('PURCHASE-1B cleanup warning', cleanupErr.message);
    }
  }
}

async function expectReject(fn, pattern, message) {
  try {
    await fn();
    throw new Error(`${message}: expected rejection`);
  } catch (err) {
    if (String(err.message || '').includes('expected rejection')) throw err;
    expect(pattern.test(String(err.message || '')), `${message}: ${err.message}`);
  }
}

run().catch((err) => {
  console.error('PURCHASE-1B FAILED', err);
  process.exit(1);
});
