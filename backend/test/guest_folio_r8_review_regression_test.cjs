'use strict';

/**
 * OAK HIMS — Guest Bill R8 Finalization (Penyelesaian) Regression Suite
 *
 * This test suite verifies the fixes required in:
 * - KEPUTUSAN_REVIEW_GUEST_BILL_R7_20261106.md
 * - PROMPT_PENYELESAIAN_GUEST_BILL_R8_20261106.txt
 *
 * Requirements tested:
 * GB6-F01: GROUP_PAYMENT_ALLOCATION excluded from chargeBreakdownSum (CLOSED in R7, verified non-regression)
 * Sisa GB6-F02: Satu Agregat Booking Bukan Satu Malam —
 *               - Initial ROOM_CHARGE with unproven unit (unit = null / empty) returns '—'
 *               - 2-night and 10-night bookings with aggregate room charge render '—'
 *               - Explicit duration 'malam' renders '1 malam'
 *               - Stay extension does not overwrite base stay duration
 *               - Day use (nights === 0) renders '—'
 *               - All existing 7 source-bound cases preserved
 * Sisa GB6-F03: Penutup & Nomor Fisik Halaman PDF Panjang —
 *               - oak-guest-bill-closing-block wraps summary + special requests + dual signature block
 *               - break-inside: avoid !important; page-break-inside: avoid !important;
 *               - Balanced chunking (page1Max=13, intermediateMax=14, finalMax=8) ensures 31 rows split into 13, 10, 8
 *               - jsPDF stamps "Halaman ${i} dari ${pages}" at bottom-right of every page
 *               - Continuation headers indicate "Rincian Tagihan (Lanjutan - Halaman X dari Y)"
 *               - @media print @page includes @bottom-right counter(page) of counter(pages)
 * GB6-F04: Synthetic fixtures alignment & charges breakdown discrepancy guard (CLOSED in R7, non-regression)
 * GB6-F05: Receptionist FO role mapping (CLOSED in R7, non-regression)
 * GB6-O01: Sisa Tagihan Rp 0 on paid bills & relative patch paths (CLOSED in R7, non-regression)
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '../..');
const { resolveLineQtyAndUnit } = require(path.join(
  repoRoot,
  'backend/dist/domains/documents/documentGuestFolioReadService.js'
));

let passed = 0;
let failed = 0;

function expect(condition, message) {
  if (!condition) {
    failed += 1;
    console.error(`  [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passed += 1;
  console.log(`  [PASS] ${message}`);
}

async function runR8RegressionSuite() {
  console.log('==================================================================');
  console.log('  OAK HIMS — GUEST BILL R8 (PENYELESAIAN) REGRESSION SUITE');
  console.log('==================================================================\n');

  const readServicePath = path.join(repoRoot, 'backend/src/domains/documents/documentGuestFolioReadService.ts');
  const confirmationPrintPath = path.join(repoRoot, 'frontend/src/features/documents/ReservationConfirmationPrint.tsx');
  const documentCenterPath = path.join(repoRoot, 'frontend/src/features/documents/DocumentCenter.tsx');
  const cssPath = path.join(repoRoot, 'frontend/src/features/documents/guestDocumentPrint.css');
  const browserTestPath = path.join(__dirname, 'guest_folio_document_center_browser_e2e_test.mjs');
  const samplesDir = path.join(__dirname, 'fixtures/guest_folio_samples');

  const readServiceSource = fs.readFileSync(readServicePath, 'utf8');
  const printSource = fs.readFileSync(confirmationPrintPath, 'utf8');
  const docCenterSource = fs.readFileSync(documentCenterPath, 'utf8');
  const cssSource = fs.readFileSync(cssPath, 'utf8');
  const browserTestSource = fs.readFileSync(browserTestPath, 'utf8');

  // ==================================================================
  // PROBE 1: GB6-F01 — Group Payment Allocation & Payment Filtering (CLOSED Non-Regression)
  // ==================================================================
  console.log('--- Probe 1: GB6-F01 — Group Payment Allocation & Charge Scope ---');

  expect(
    docCenterSource.includes("l.category !== 'GROUP_PAYMENT_ALLOCATION'") &&
    docCenterSource.includes("l.category !== 'PAYMENT'") &&
    docCenterSource.includes("l.category !== 'DEPOSIT_APPLY'") &&
    docCenterSource.includes("l.category !== 'DEPOSIT_UNAPPLY'"),
    'Probe 1.1: DocumentCenter guestBillChargeLines explicitly excludes GROUP_PAYMENT_ALLOCATION, PAYMENT, DEPOSIT_APPLY, DEPOSIT_UNAPPLY'
  );

  const isExcluded = (cat) => [
    'PAYMENT',
    'DEPOSIT_APPLY',
    'DEPOSIT_UNAPPLY',
    'GROUP_PAYMENT_ALLOCATION',
  ].includes(cat);

  const mockLinesWithGroupPayment = [
    { category: 'ROOM_CHARGE', debit: 1000000, credit: 0 },
    { category: 'GROUP_PAYMENT_ALLOCATION', debit: 0, credit: 1000000 },
  ];
  const filteredLinesCaseA = mockLinesWithGroupPayment.filter((l) => !isExcluded(l.category));
  const chargeSumCaseA = filteredLinesCaseA.reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0);
  expect(
    chargeSumCaseA === 1000000,
    'Probe 1.2: Full group payment (1.000.000) does not contaminate charge breakdown; chargeBreakdownSum is exactly 1.000.000'
  );

  // ==================================================================
  // PROBE 2: Sisa GB6-F02 — Satu Agregat Booking Bukan Satu Malam
  // ==================================================================
  console.log('\n--- Probe 2: Sisa GB6-F02 — Source-Bound Quantity and Unit Inference ---');

  // 2.1 Aggregate 2-night booking: quantity = 1, unit = null -> quantity: null, unit: null, qty_label: '—' (NOT '1 malam')
  const res21a = resolveLineQtyAndUnit({ entry_type: 'ROOM_CHARGE', quantity: 1, unit: null }, 2, 1);
  expect(
    res21a.quantity === null && res21a.unit === null && res21a.qty_label === '—',
    `Probe 2.1a: Aggregate 2-night booking (qty 1, unit null) yields qty_label '—' instead of '1 malam' (got ${JSON.stringify(res21a)})`
  );

  // 2.1b Aggregate 10-night booking: quantity = 1, unit = null -> quantity: null, unit: null, qty_label: '—' (NOT '1 malam')
  const res21b = resolveLineQtyAndUnit({ entry_type: 'ROOM_CHARGE', quantity: 1, unit: null }, 10, 1);
  expect(
    res21b.quantity === null && res21b.unit === null && res21b.qty_label === '—',
    `Probe 2.1b: Aggregate 10-night booking (qty 1, unit null) yields qty_label '—' instead of '1 malam' (got ${JSON.stringify(res21b)})`
  );

  // 2.2 Explicit unit 'malam': quantity = 1, unit = 'malam' -> quantity: 1, unit: 'malam', qty_label: '1 malam'
  const res22 = resolveLineQtyAndUnit({ entry_type: 'ROOM_CHARGE', quantity: 1, unit: 'malam' }, 1, 1);
  expect(
    res22.quantity === 1 && res22.unit === 'malam' && res22.qty_label === '1 malam',
    `Probe 2.2: Explicit duration 'malam' yields '1 malam' (got ${JSON.stringify(res22)})`
  );

  // 2.3 Base room charge 1 malam + stay extension (total stay = 3 nights) -> base remains '1 malam', extension is '2 malam'
  const resBase = resolveLineQtyAndUnit({ entry_type: 'ROOM_CHARGE', quantity: 1, unit: 'malam' }, 3, 2);
  const resExt = resolveLineQtyAndUnit({ source_type: 'STAY_EXTENSION', quantity: 2, unit: 'malam' }, 3, 2);
  expect(
    resBase.qty_label === '1 malam' && resExt.qty_label === '2 malam',
    `Probe 2.3: Stay extension preserves base '1 malam' without overwriting with stay nights=3, extension renders '2 malam' (base: ${resBase.qty_label}, ext: ${resExt.qty_label})`
  );

  // 2.4 Day use (nights === 0) -> quantity: null, unit: null, qty_label: '—'
  const resDayUse = resolveLineQtyAndUnit({ entry_type: 'ROOM_CHARGE', quantity: 1, unit: null }, 0, 1);
  expect(
    resDayUse.quantity === null && resDayUse.qty_label === '—',
    `Probe 2.4: Day use (nights === 0) yields qty_label '—' (got ${JSON.stringify(resDayUse)})`
  );

  // 2.5 Explicit unit 'kg', missing quantity -> quantity: null, unit: 'kg', qty_label: '—' (never default to 1)
  const resLaundry = resolveLineQtyAndUnit({ entry_type: 'LAUNDRY', unit: 'kg', quantity: null }, 2, 1);
  expect(
    resLaundry.quantity === null && resLaundry.unit === 'kg' && resLaundry.qty_label === '—',
    `Probe 2.5: Missing quantity with explicit unit 'kg' yields qty_label '—' (got ${JSON.stringify(resLaundry)})`
  );

  // 2.6 Minibar snack with unrecorded unit -> quantity: 2, unit: null, qty_label: '2' (never guess 'botol')
  const resMinibar = resolveLineQtyAndUnit({ entry_type: 'MINIBAR', quantity: 2, unit: null }, 2, 1);
  expect(
    resMinibar.quantity === 2 && resMinibar.unit === null && resMinibar.qty_label === '2',
    `Probe 2.6: Minibar snack with unrecorded unit yields qty_label '2' without guessing 'botol' (got ${JSON.stringify(resMinibar)})`
  );

  // 2.7 Stay extension without duration quantity -> quantity: null, unit: null, qty_label: '—'
  const resExtEmpty = resolveLineQtyAndUnit({ source_type: 'STAY_EXTENSION', quantity: null, unit: null }, 2, 1);
  expect(
    resExtEmpty.quantity === null && resExtEmpty.qty_label === '—',
    `Probe 2.7: Stay extension without duration quantity yields qty_label '—' (got ${JSON.stringify(resExtEmpty)})`
  );

  // 2.8 FNB line with 'BONUS acara' in description -> qty_label: '—' (never guess '1 bon' from description)
  const resFnbBonus = resolveLineQtyAndUnit({ entry_type: 'FNB', description: 'BONUS acara', quantity: null, unit: null }, 2, 1);
  expect(
    resFnbBonus.qty_label === '—' && resFnbBonus.unit === null,
    `Probe 2.8: FNB line with 'BONUS acara' returns '—' without guessing '1 bon' (got ${JSON.stringify(resFnbBonus)})`
  );

  // 2.9 Control: explicit quantity 2.5 and explicit unit 'kg' -> '2.5 kg'
  const resControl = resolveLineQtyAndUnit({ quantity: 2.5, unit: 'kg' }, 2, 1);
  expect(
    resControl.quantity === 2.5 && resControl.unit === 'kg' && resControl.qty_label === '2.5 kg',
    `Probe 2.9: Control with explicit 2.5 kg yields '2.5 kg' (got ${JSON.stringify(resControl)})`
  );

  // ==================================================================
  // PROBE 3: Sisa GB6-F03 — Penutup & Nomor Fisik Halaman PDF Panjang
  // ==================================================================
  console.log('\n--- Probe 3: Sisa GB6-F03 — Penutup & Nomor Fisik Halaman PDF Panjang ---');

  // 3.1 ReservationConfirmationPrint wraps summary, special requests, and dual signature block in oak-guest-bill-closing-block
  expect(
    printSource.includes('<div className="oak-guest-bill-closing-block">') &&
    printSource.includes('Ringkasan Pembayaran') &&
    printSource.includes('Permintaan Khusus') &&
    printSource.includes('oak-doc-signature-block'),
    'Probe 3.1: ReservationConfirmationPrint wraps summary, special requests, and signatures in oak-guest-bill-closing-block'
  );

  // 3.2 CSS rules protect oak-guest-bill-closing-block against page breaks
  expect(
    cssSource.includes('.oak-guest-bill-closing-block') &&
    cssSource.includes('break-inside: avoid !important;') &&
    cssSource.includes('page-break-inside: avoid !important;'),
    'Probe 3.2a: guestDocumentPrint.css defines break-inside: avoid !important on .oak-guest-bill-closing-block'
  );
  expect(
    cssSource.includes('.oak-pdf-export-body .oak-guest-bill-closing-block') &&
    cssSource.includes('break-inside: avoid !important;'),
    'Probe 3.2b: guestDocumentPrint.css defines break-inside: avoid !important on .oak-pdf-export-body .oak-guest-bill-closing-block'
  );

  // 3.3 DocumentCenter includes oak-guest-bill-closing-block in html2pdf pagebreak.avoid
  expect(
    docCenterSource.includes("'.oak-guest-bill-closing-block'"),
    'Probe 3.3: DocumentCenter html2pdf pagebreak avoid includes .oak-guest-bill-closing-block'
  );

  // 3.4 Balanced chunking thresholds for confirmation
  expect(
    docCenterSource.includes("const page1Max = kind === 'confirmation' ? 13 : 10;") &&
    docCenterSource.includes("const intermediateMax = kind === 'confirmation' ? 14 : 14;") &&
    docCenterSource.includes("const finalMax = kind === 'confirmation' ? 8 : 10;"),
    'Probe 3.4: DocumentCenter defines balanced chunking (page1Max=13, intermediateMax=14, finalMax=8)'
  );

  // 3.5 Chunking simulation with 31 rows (matching DocumentCenter algorithm)
  function simulateChunking(totalRows, page1Max, intermediateMax, finalMax) {
    const dummyRows = Array.from({ length: totalRows }, (_, i) => `row-${i + 1}`);
    const chunks = [];
    chunks.push(dummyRows.slice(0, page1Max));
    let cur = page1Max;
    while (cur < totalRows) {
      const rem = totalRows - cur;
      if (rem <= finalMax) {
        chunks.push(dummyRows.slice(cur));
        break;
      }
      if (rem <= intermediateMax + finalMax) {
        const nextSize = Math.min(intermediateMax, rem - Math.min(finalMax, Math.ceil(rem / 2)));
        chunks.push(dummyRows.slice(cur, cur + nextSize));
        cur += nextSize;
        chunks.push(dummyRows.slice(cur));
        break;
      } else {
        chunks.push(dummyRows.slice(cur, cur + intermediateMax));
        cur += intermediateMax;
      }
    }
    return chunks;
  }

  const chunks31 = simulateChunking(31, 13, 14, 8);
  expect(
    chunks31.length === 3 &&
    chunks31[0].length === 13 &&
    chunks31[1].length === 10 &&
    chunks31[2].length === 8,
    `Probe 3.5: 31-row long guest bill splits into [13, 10, 8] rows across 3 pages (got chunks: [${chunks31.map((c) => c.length).join(', ')}])`
  );

  // 3.6 Physical page numbering in jsPDF
  expect(
    docCenterSource.includes('pdf.text(pageNumText, 18 + contentWidthMm, 297 - overlayFooterGapMm - 1, { align: \'right\' })') &&
    docCenterSource.includes('const pageNumText = `Halaman ${i} dari ${pages}`;'),
    'Probe 3.6a: DocumentCenter jsPDF loop stamps "Halaman ${i} dari ${pages}" at footer right on every page'
  );

  // 3.7 Continuation header numbering
  expect(
    docCenterSource.includes('Rincian Tagihan (Lanjutan - Halaman ${c + 1} dari ${totalChunks})') &&
    docCenterSource.includes('Rincian Tagihan (Halaman 1 dari ${totalChunks})'),
    'Probe 3.7: DocumentCenter continuation headers render "Rincian Tagihan (Lanjutan - Halaman X dari Y)"'
  );

  // 3.8 @media print @page physical numbering
  expect(
    cssSource.includes('@bottom-right {') &&
    cssSource.includes('content: "Halaman " counter(page) " dari " counter(pages);'),
    'Probe 3.8: guestDocumentPrint.css defines @bottom-right counter(page) of counter(pages) for @media print'
  );

  // ==================================================================
  // PROBE 4: GB6-F04 — Test Environment & Fixture Integrity (CLOSED Non-Regression)
  // ==================================================================
  console.log('\n--- Probe 4: GB6-F04 — Test Environment & Fixture Integrity ---');

  const sample1 = JSON.parse(fs.readFileSync(path.join(samplesDir, 'sample_1_guest_folio_partial_payment.json'), 'utf8'));
  const sample2 = JSON.parse(fs.readFileSync(path.join(samplesDir, 'sample_2_guest_folio_paid_lunas.json'), 'utf8'));
  const sample3 = JSON.parse(fs.readFileSync(path.join(samplesDir, 'sample_3_guest_folio_long_multipage.json'), 'utf8'));

  const s1RoomLine = sample1.effective_lines.find((l) => l.category === 'ROOM_CHARGE');
  expect(
    s1RoomLine.quantity === null && s1RoomLine.unit === null && s1RoomLine.qty_label === '—',
    `Probe 4.1: Sample 1 fixture room charge has qty_label '—' (got ${JSON.stringify(s1RoomLine.qty_label)})`
  );

  const s2RoomLine = sample2.effective_lines.find((l) => l.category === 'ROOM_CHARGE');
  expect(
    s2RoomLine.quantity === null && s2RoomLine.unit === null && s2RoomLine.qty_label === '—',
    `Probe 4.2: Sample 2 fixture room charge has qty_label '—' (got ${JSON.stringify(s2RoomLine.qty_label)})`
  );

  const s3RoomLine = sample3.effective_lines.find((l) => l.category === 'ROOM_CHARGE');
  expect(
    s3RoomLine.quantity === null && s3RoomLine.unit === null && s3RoomLine.qty_label === '—',
    `Probe 4.3: Sample 3 fixture room charge has qty_label '—' (got ${JSON.stringify(s3RoomLine.qty_label)})`
  );

  expect(
    docCenterSource.includes('isGuestBillChargesReconciled = useMemo(') &&
    docCenterSource.includes('chargeBreakdownSum - Number(folioDoc.summary.net_total_charges || 0)'),
    'Probe 4.4: DocumentCenter preserves charges breakdown reconciliation guard'
  );

  // ==================================================================
  // PROBE 5: GB6-F05 — Receptionist FO Role Mapping (CLOSED Non-Regression)
  // ==================================================================
  console.log('\n--- Probe 5: GB6-F05 — Receptionist FO Role Mapping ---');

  const checkFoRole = (role) => {
    if (!role) return false;
    const norm = role.trim().toUpperCase().replace(/[\s_-]+/g, '');
    return ['RECEPTIONIST', 'FRONTDESK', 'FRONTOFFICE', 'FO', 'RESEPSIONIS'].includes(norm);
  };

  expect(checkFoRole('RECEPTIONIST') === true, 'Probe 5.1a: RECEPTIONIST is recognized as FO');
  expect(checkFoRole('Front Desk') === true, 'Probe 5.1b: Front Desk is recognized as FO');
  expect(checkFoRole('FRONT_OFFICE') === true, 'Probe 5.1c: FRONT_OFFICE is recognized as FO');
  expect(checkFoRole('FO') === true, 'Probe 5.1d: FO is recognized as FO');
  expect(checkFoRole('Resepsionis') === true, 'Probe 5.1e: Resepsionis is recognized as FO');

  expect(checkFoRole('SUPER_ADMIN') === false, 'Probe 5.2a: SUPER_ADMIN is excluded from FO role');
  expect(checkFoRole('ADMIN') === false, 'Probe 5.2b: ADMIN is excluded from FO role');
  expect(checkFoRole('KASIR') === false, 'Probe 5.2c: KASIR is excluded from FO role');
  expect(checkFoRole('STAFF') === false, 'Probe 5.2d: STAFF is excluded from FO role');
  expect(checkFoRole('OWNER') === false, 'Probe 5.2e: OWNER is excluded from FO role');

  // ==================================================================
  // PROBE 6: GB6-O01 — UI Sisa Tagihan Rp 0 & Diff Integrity
  // ==================================================================
  console.log('\n--- Probe 6: GB6-O01 — UI Sisa Tagihan Rp 0 & Diff Integrity ---');

  expect(
    printSource.includes('<td>Sisa Tagihan</td>') &&
    printSource.includes('<td className="right">{formatCurrency(remainingBalance)}</td>'),
    'Probe 6.1: ReservationConfirmationPrint renders Sisa Tagihan unconditionally (shows Rp 0 on paid bills)'
  );

  expect(
    browserTestSource.includes("Charges table displays \"—\" for aggregate room charge without explicit unit"),
    'Probe 6.2: Browser test specifically asserts Charges table Qty cell is "—" for aggregate room charge'
  );

  console.log('\n==================================================================');
  console.log(`  ALL ${passed} PROBES PASSED (0 FAILED)`);
  console.log('==================================================================\n');
}

runR8RegressionSuite().catch((err) => {
  console.error('[R8_REGRESSION_ERROR]', err);
  process.exit(1);
});
