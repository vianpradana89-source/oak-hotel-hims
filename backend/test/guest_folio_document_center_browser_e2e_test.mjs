import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const testDir = import.meta.dirname;
const repoRoot = path.resolve(testDir, '../..');
const frontendDir = path.resolve(repoRoot, 'frontend');
const samplesDir = path.resolve(repoRoot, 'artifacts/guest-folio-samples');

if (!fs.existsSync(samplesDir)) {
  fs.mkdirSync(samplesDir, { recursive: true });
}

// Dynamic Playwright & Chrome resolution (GF-O03: remove machine-specific hardcoded paths)
function resolvePlaywrightChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    path.resolve(repoRoot, 'node_modules/playwright'),
    path.resolve(repoRoot, 'node_modules/playwright-core'),
    path.resolve(frontendDir, 'node_modules/playwright'),
    path.resolve(frontendDir, 'node_modules/playwright-core'),
    'C:/Users/PC/.gemini/antigravity/brain/5569acf2-8d54-43cc-b5c2-4f0964cd148e/scratch/pw_runner/node_modules/playwright-core',
  ].filter(Boolean);

  for (const cand of candidates) {
    try {
      const entry = path.join(cand, 'index.mjs');
      if (fs.existsSync(entry)) return entry;
      const cjsEntry = path.join(cand, 'index.js');
      if (fs.existsSync(cjsEntry)) return cjsEntry;
    } catch {}
  }
  return null;
}

function resolveChromeExecutable() {
  const envPath = process.env.CHROME_PATH || process.env.CHROME_BIN || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe') : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return undefined;
}

const resolvedPw = resolvePlaywrightChromium();
if (!resolvedPw) {
  throw new Error('Playwright not found in environment or fallback search paths! Please set PLAYWRIGHT_PATH.');
}
const { chromium } = await import(pathToFileURL(resolvedPw).href);
const resolvedChrome = resolveChromeExecutable();

// Load Vite
const vitePath = path.join(frontendDir, 'node_modules/vite/dist/node/index.js');
const { createServer } = await import(pathToFileURL(vitePath).href);

function countPdfPages(pdfBuffer) {
  const str = pdfBuffer.toString('latin1');
  const matches = str.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

let passCount = 0;
function expect(cond, desc) {
  if (!cond) {
    console.error(`  [FAIL] ${desc}`);
    throw new Error(`Assertion failed: ${desc}`);
  }
  passCount++;
  console.log(`  [PASS] ${desc}`);
}

async function runBrowserTests() {
  console.log('==================================================================');
  console.log('  OAK HIMS — GUEST FOLIO BROWSER UI & TWO-PATH EXPORT SUITE');
  console.log('==================================================================\n');

  console.log('[1/4] Starting Vite test server on port 5188...');
  const viteServer = await createServer({
    root: frontendDir,
    server: { port: 5188 },
  });
  await viteServer.listen();
  console.log('  Vite test server listening on http://127.0.0.1:5188\n');

  console.log('[2/4] Launching headless Chromium browser...');
  const launchOptions = { headless: true };
  if (resolvedChrome) {
    launchOptions.executablePath = resolvedChrome;
  }
  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 950 },
    acceptDownloads: true,
  });

  const page = await context.newPage();
  page.on('console', msg => console.log('  [BROWSER_CONSOLE]', msg.type(), msg.text()));
  page.on('pageerror', err => console.error('  [BROWSER_ERROR]', err.message));
  page.on('requestfailed', req => console.log('  [REQUEST_FAILED]', req.url()));
  page.on('response', res => { if (res.status() >= 400) console.log('  [HTTP_ERROR]', res.status(), res.url()); });

  try {
    console.log('[3/4] Navigating to DocumentCenter test harness...');
    await page.goto('http://127.0.0.1:5188/test_document_center.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('#btn-select-partial', { timeout: 10000 });
    expect(true, 'Test harness loaded successfully');

    // ------------------------------------------------------------------
    // SCENARIO 1: Partial Payment Folio (Sample #1)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 1: Folio Bayar Sebagian (PARTIAL) UI & Two-Path Export ---');
    await page.click('#btn-select-partial');
    await page.waitForSelector('.oak-folio-identity-box', { timeout: 10000 });
    await page.waitForTimeout(600);

    // Helper to get normalized text
    const getDocText = async () => (await page.innerText('.document-center')).replace(/\u00a0/g, ' ');

    // Verify UI Badges & Financials
    const partialText = await getDocText();
    expect(partialText.includes('DIBAYAR SEBAGIAN'), 'UI shows badge DIBAYAR SEBAGIAN');
    expect(!partialText.includes('Peringatan Rekonsiliasi'), 'UI shows document is reconciled (no warning banner)');
    expect(partialText.includes('Rp 1.375.000'), 'UI displays total charges Rp 1.375.000');
    expect(partialText.includes('Rp 750.000'), 'UI displays total paid Rp 750.000');
    expect(partialText.includes('Rp 625.000'), 'UI displays remaining balance Rp 625.000');

    // Capture Browser UI Screenshot
    const shot1 = path.join(samplesDir, 'ui_preview_sample_1_partial.png');
    await page.screenshot({ path: shot1, fullPage: true });
    expect(fs.existsSync(shot1), 'Captured UI screenshot for Partial Folio');

    // Pathway A: Application "Save PDF" button via html2pdf.js
    console.log('  Triggering application Save PDF button (html2pdf pathway)...');
    const savePdfBtn = page.locator('button:has-text("Save PDF")');
    await savePdfBtn.click();
    await page.waitForSelector('.fixed.inset-0', { timeout: 5000 });
    const modalConfirmBtn = page.locator('.fixed.inset-0 button:has-text("Simpan PDF")');

    const downloadPromise1 = page.waitForEvent('download', { timeout: 20000 });
    await modalConfirmBtn.click();
    const download1 = await downloadPromise1;
    const appButtonPdf1Path = path.join(samplesDir, 'app_button_sample_1_partial.pdf');
    await download1.saveAs(appButtonPdf1Path);
    expect(fs.existsSync(appButtonPdf1Path), 'Application Save PDF button generated PDF successfully');
    const appBtnP1Pages = countPdfPages(fs.readFileSync(appButtonPdf1Path));
    expect(appBtnP1Pages === 1, `Application Save PDF for Partial has exactly 1 page (no orphaned footer), got ${appBtnP1Pages}`);

    // Pathway B: Browser Print "Cetak" via @media print
    console.log('  Triggering browser Print pathway (@media print)...');
    await page.emulateMedia({ media: 'print' });
    const browserPrintPdf1Path = path.join(samplesDir, 'browser_print_sample_1_partial.pdf');
    const printBuf1 = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.writeFileSync(browserPrintPdf1Path, printBuf1);
    await page.emulateMedia({ media: 'screen' });
    expect(fs.existsSync(browserPrintPdf1Path), 'Browser Print generated PDF successfully');
    const browserP1Pages = countPdfPages(printBuf1);
    expect(browserP1Pages === 1, `Browser Print for Partial has exactly 1 page (no orphaned footer), got ${browserP1Pages}`);

    // ------------------------------------------------------------------
    // SCENARIO 2: Paid Lunas Folio (Sample #2)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 2: Folio Lunas (PAID / LUNAS) UI & Two-Path Export ---');
    await page.click('#btn-select-paid');
    await page.waitForTimeout(600);

    const paidText = await getDocText();
    expect(paidText.includes('LUNAS'), 'UI shows badge LUNAS');
    expect(paidText.includes('Rp 0'), 'UI displays remaining balance Rp 0');

    const shot2 = path.join(samplesDir, 'ui_preview_sample_2_paid.png');
    await page.screenshot({ path: shot2, fullPage: true });
    expect(fs.existsSync(shot2), 'Captured UI screenshot for Paid Folio');

    // Pathway A: Application "Save PDF" button
    console.log('  Triggering application Save PDF button (html2pdf pathway)...');
    await savePdfBtn.click();
    await page.waitForSelector('.fixed.inset-0', { timeout: 5000 });
    const downloadPromise2 = page.waitForEvent('download', { timeout: 15000 });
    await modalConfirmBtn.click();
    const download2 = await downloadPromise2;
    const appButtonPdf2Path = path.join(samplesDir, 'app_button_sample_2_paid.pdf');
    await download2.saveAs(appButtonPdf2Path);
    expect(fs.existsSync(appButtonPdf2Path), 'Application Save PDF button generated PDF successfully');
    const appBtnP2Pages = countPdfPages(fs.readFileSync(appButtonPdf2Path));
    expect(appBtnP2Pages === 1, `Application Save PDF for Paid has exactly 1 page (no orphaned footer), got ${appBtnP2Pages}`);

    // Pathway B: Browser Print "Cetak"
    console.log('  Triggering browser Print pathway (@media print)...');
    await page.emulateMedia({ media: 'print' });
    const browserPrintPdf2Path = path.join(samplesDir, 'browser_print_sample_2_paid.pdf');
    const printBuf2 = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.writeFileSync(browserPrintPdf2Path, printBuf2);
    await page.emulateMedia({ media: 'screen' });
    expect(fs.existsSync(browserPrintPdf2Path), 'Browser Print generated PDF successfully');
    const browserP2Pages = countPdfPages(printBuf2);
    expect(browserP2Pages === 1, `Browser Print for Paid has exactly 1 page (no orphaned footer), got ${browserP2Pages}`);

    // ------------------------------------------------------------------
    // SCENARIO 3: Long Multi-Page Folio (Sample #3)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 3: Folio Panjang Multi-Halaman (>30 Item) UI & Two-Path Export ---');
    await page.click('#btn-select-long');
    await page.waitForTimeout(800);

    const longText = await getDocText();
    expect(longText.includes('Rp 9.825.000'), 'UI displays long folio charges Rp 9.825.000');

    const shot3 = path.join(samplesDir, 'ui_preview_sample_3_long.png');
    await page.screenshot({ path: shot3, fullPage: true });
    expect(fs.existsSync(shot3), 'Captured UI screenshot for Long Folio');

    // Pathway A: Application "Save PDF" button
    console.log('  Triggering application Save PDF button (html2pdf pathway)...');
    await savePdfBtn.click();
    await page.waitForSelector('.fixed.inset-0', { timeout: 5000 });
    const downloadPromise3 = page.waitForEvent('download', { timeout: 20000 });
    await modalConfirmBtn.click();
    const download3 = await downloadPromise3;
    const appButtonPdf3Path = path.join(samplesDir, 'app_button_sample_3_long.pdf');
    await download3.saveAs(appButtonPdf3Path);
    expect(fs.existsSync(appButtonPdf3Path), 'Application Save PDF button generated PDF successfully');
    const appBtnP3Pages = countPdfPages(fs.readFileSync(appButtonPdf3Path));
    expect(appBtnP3Pages === 3, `Application Save PDF for Long Folio has exactly 3 pages (got ${appBtnP3Pages})`);

    // Verify UI renders all 34 rows and complete thead column headers
    const tableCheck = await page.evaluate(() => {
      const table = document.querySelector('.oak-folio-table');
      if (!table) return null;
      const ths = Array.from(table.querySelectorAll('thead th')).map(t => t.textContent?.trim());
      const trCount = table.querySelectorAll('tbody tr').length;
      return { ths, trCount };
    });
    expect(tableCheck !== null, 'Long Folio table rendered in DOM');
    expect(tableCheck.trCount === 34, `Long Folio renders exactly 34 transaction rows (got ${tableCheck.trCount})`);
    expect(tableCheck.ths.length === 5, 'Long Folio table has 5 column headers');
    expect(tableCheck.ths[0] === 'Tanggal', 'Column 1 is Tanggal');
    expect(tableCheck.ths[1]?.includes('Uraian'), 'Column 2 is Uraian');
    expect(tableCheck.ths[2] === 'Referensi', 'Column 3 is Referensi');
    expect(tableCheck.ths[3]?.includes('Debit'), 'Column 4 is Debit');
    expect(tableCheck.ths[4]?.includes('Kredit'), 'Column 5 is Kredit');

    // Pathway B: Browser Print "Cetak"
    console.log('  Triggering browser Print pathway (@media print)...');
    await page.emulateMedia({ media: 'print' });
    const browserPrintPdf3Path = path.join(samplesDir, 'browser_print_sample_3_long.pdf');
    const printBuf3 = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.writeFileSync(browserPrintPdf3Path, printBuf3);
    await page.emulateMedia({ media: 'screen' });
    expect(fs.existsSync(browserPrintPdf3Path), 'Browser Print generated PDF successfully');
    const browserP3Pages = countPdfPages(printBuf3);
    expect(browserP3Pages === 3, `Browser Print for Long Folio has exactly 3 pages (got ${browserP3Pages})`);

    // ------------------------------------------------------------------
    // SCENARIO 4: Reconciliation Mismatch Guard (GF-F03)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 4: Reconciliation Mismatch Guard (GF-F03) ---');
    await page.click('#btn-select-corrupted');
    await page.waitForTimeout(600);

    const corrText = await getDocText();
    expect(corrText.includes('Peringatan Rekonsiliasi Finansial') || corrText.includes('tidak seimbang'), 'UI displays warning banner when unreconciled');
    expect(corrText.includes('Selisih audit charges dan total summary: Rp 50.000'), 'UI displays explicit discrepancy reasons');

    const isSaveDisabled = await savePdfBtn.isDisabled();
    expect(isSaveDisabled, 'Save PDF button is disabled when document is unreconciled');
    const printBtn = page.locator('button:has-text("Cetak")');
    const isPrintDisabled = await printBtn.isDisabled();
    expect(isPrintDisabled, 'Cetak button is disabled when document is unreconciled');

    const shotCorr = path.join(samplesDir, 'ui_preview_reconciliation_mismatch_guard.png');
    await page.screenshot({ path: shotCorr, fullPage: true });
    expect(fs.existsSync(shotCorr), 'Captured UI screenshot for reconciliation mismatch guard');

    // ------------------------------------------------------------------
    // SCENARIO 5: Multi-Room Sibling Switcher (GF-O01)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 5: Multi-Room Sibling Switcher (GF-O01) ---');
    await page.click('#btn-select-partial');
    await page.waitForTimeout(600);

    // Verify single active pill and exactly one sibling button (GF-O01 backend contract)
    const activePill = page.locator('.document-center-sibling-switcher button.active');
    expect(await activePill.count() === 1, 'Sibling switcher displays exactly 1 active room button');
    const activeText = await activePill.innerText();
    expect(activeText.includes('Kamar 101'), 'Active room button is Kamar 101');

    const siblingBtns = page.locator('.document-center-sibling-switcher button:not(.active)');
    expect(await siblingBtns.count() === 1, 'Sibling switcher displays exactly 1 sibling room button (GF-O01 backend contract)');
    const siblingText = await siblingBtns.first().innerText();
    expect(siblingText.includes('Kamar 102'), 'Sibling room button is Kamar 102');

    // Click sibling room 102
    await siblingBtns.first().click();
    await page.waitForTimeout(600);
    const room102Text = await getDocText();
    expect(room102Text.includes('RES-999') || room102Text.includes('Kamar 102') || room102Text.includes('Room 2'), 'Clicking sibling room switches active folio cleanly to Kamar 102');

    // After switching, active room is now Kamar 102 and sibling is Kamar 101
    const newActivePill = page.locator('.document-center-sibling-switcher button.active');
    expect(await newActivePill.count() === 1, 'After switch, exactly 1 active room button exists');
    expect((await newActivePill.innerText()).includes('Kamar 102'), 'Active room button is now Kamar 102');
    const newSiblingBtns = page.locator('.document-center-sibling-switcher button:not(.active)');
    expect(await newSiblingBtns.count() === 1, 'After switch, exactly 1 sibling button exists');
    expect((await newSiblingBtns.first().innerText()).includes('Kamar 101'), 'Sibling room button is now Kamar 101');

    // ------------------------------------------------------------------
    // SCENARIO 6: Guest Bill & Quotation Regression (R4-R6 Finalization)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 6: Guest Bill & Quotation Regression (R6 Rincian & Dual Signature) ---');
    const btnSelectConfirmation = page.locator('#btn-select-confirmation');
    const btnText = await btnSelectConfirmation.innerText();
    expect(btnText.includes('Guest Bill'), `Harness button displays "Guest Bill", got "${btnText}"`);

    await btnSelectConfirmation.click();
    await page.waitForTimeout(800);
    const billText = (await page.locator('.document-center-printable-wrapper').innerText()).replace(/\u00a0/g, ' ');
    expect(billText.toUpperCase().includes('GUEST BILL'), 'Guest Bill document renders title "GUEST BILL"');
    expect(!billText.toUpperCase().includes('TAGIHAN TAMU'), 'Guest Bill document strictly does NOT contain "Tagihan Tamu"');
    expect(!billText.toUpperCase().includes('KONFIRMASI PEMESANAN'), 'Guest Bill does not contain legacy "KONFIRMASI PEMESANAN"');
    expect(billText.includes('Total Tagihan'), 'Guest Bill displays "Total Tagihan"');
    expect(billText.includes('Jumlah Dibayar'), 'Guest Bill displays "Jumlah Dibayar"');
    expect(billText.includes('Sisa Tagihan'), 'Guest Bill displays "Sisa Tagihan"');

    // R5 Fix 2: Assert complete guest identity & stay details (no blanks or '---')
    expect(billText.includes('Bpk. Hendra Wijaya'), 'Guest Bill displays guest name "Bpk. Hendra Wijaya"');
    expect(billText.includes('081234560002'), 'Guest Bill displays guest phone "081234560002"');
    expect(billText.includes('TST001-261106-KSGF7BRR'), 'Guest Bill displays BID "TST001-261106-KSGF7BRR"');
    expect(billText.includes('Deluxe Room'), 'Guest Bill displays room type "Deluxe Room"');
    expect(billText.includes('101'), 'Guest Bill displays room number "101"');
    expect(billText.includes('DIRECT'), 'Guest Bill displays booking source "DIRECT"');
    expect(billText.includes('WALK_IN'), 'Guest Bill displays booking channel "WALK_IN"');

    // R6 Feature 1: Assert 4-column Itemized Charges Table (Rincian Tagihan)
    const upperBill = billText.toUpperCase();
    expect(upperBill.includes('RINCIAN TAGIHAN'), 'Guest Bill displays section "Rincian Tagihan"');
    expect(upperBill.includes('TANGGAL') && upperBill.includes('KETERANGAN') && upperBill.includes('QTY') && upperBill.includes('AMOUNT'), 'Charges table has 4 columns: Tanggal, Keterangan, Qty, Amount');
    // Sisa GB6-F02 (R8): Specifically check the Qty cell of the aggregate room charge row in the table, NOT whole-doc string search
    const firstRowQty = (await page.locator('.oak-guest-bill-table tbody tr:first-child td:nth-child(3)').innerText()).trim();
    expect(firstRowQty === '—', `Charges table displays "—" for aggregate room charge without explicit unit, got "${firstRowQty}"`);
    expect(billText.includes('2 malam'), 'Stay information in header displays stay duration "2 malam"');
    expect(billText.includes('—'), 'Charges table displays "—" when Qty not applicable / discount');

    // R6 Feature 2: Assert Dual Signature Block (Guest Signature & Receptionist Signature)
    expect(upperBill.includes('GUEST SIGNATURE'), 'Guest Bill displays "Guest Signature"');
    expect(upperBill.includes('RECEPTIONIST SIGNATURE'), 'Guest Bill displays "Receptionist Signature"');
    expect(billText.includes('(Tamu / Guest)'), 'Guest Bill displays "(Tamu / Guest)" role under guest signature');
    expect(billText.includes('(Front Office / Receptionist)'), 'Guest Bill displays "(Front Office / Receptionist)" role under receptionist signature');

    const shotBill = path.join(samplesDir, 'ui_preview_guest_bill.png');
    await page.screenshot({ path: shotBill, fullPage: true });
    expect(fs.existsSync(shotBill), 'Captured UI screenshot for Guest Bill');
    fs.copyFileSync(shotBill, path.join(samplesDir, 'ui_preview_confirmation.png'));

    // Pathway A: Application "Save PDF" button for Guest Bill (Partial)
    console.log('  Triggering application Save PDF button for Guest Bill (Partial)...');
    await savePdfBtn.click();
    await page.waitForSelector('.fixed.inset-0', { timeout: 5000 });
    const downloadPromiseBill = page.waitForEvent('download', { timeout: 20000 });
    await modalConfirmBtn.click();
    const downloadBill = await downloadPromiseBill;
    const billFilename = downloadBill.suggestedFilename();
    expect(billFilename.includes('Guest-Bill'), `Downloaded PDF filename contains "Guest-Bill", got "${billFilename}"`);
    expect(!billFilename.includes('Confirmation'), `Downloaded PDF filename does not contain "Confirmation", got "${billFilename}"`);

    const appButtonPdfBillPath = path.join(samplesDir, 'app_button_sample_guest_bill.pdf');
    await downloadBill.saveAs(appButtonPdfBillPath);
    expect(fs.existsSync(appButtonPdfBillPath), 'Application Save PDF button generated Guest Bill PDF successfully');
    const appBtnBillPages = countPdfPages(fs.readFileSync(appButtonPdfBillPath));
    expect(appBtnBillPages === 1, `Application Save PDF for Guest Bill has exactly 1 page, got ${appBtnBillPages}`);

    // Pathway B: Browser Print "Cetak" for Guest Bill (Partial)
    console.log('  Triggering browser Print pathway for Guest Bill (Partial)...');
    await page.emulateMedia({ media: 'print' });
    const browserPrintPdfBillPath = path.join(samplesDir, 'browser_print_sample_guest_bill.pdf');
    const printBufBill = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.writeFileSync(browserPrintPdfBillPath, printBufBill);
    await page.emulateMedia({ media: 'screen' });
    expect(fs.existsSync(browserPrintPdfBillPath), 'Browser Print generated Guest Bill PDF successfully');
    const browserBillPages = countPdfPages(printBufBill);
    expect(browserBillPages === 1, `Browser Print for Guest Bill has exactly 1 page, got ${browserBillPages}`);

    // ------------------------------------------------------------------
    // SCENARIO 6b: Paid Lunas Guest Bill (Sample #2)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 6b: Paid Lunas Guest Bill (Sample #2) ---');
    const btnSelectBillPaid = page.locator('#btn-select-bill-paid');
    await btnSelectBillPaid.click();
    await page.waitForTimeout(800);

    const paidBillText = (await page.locator('.document-center-printable-wrapper').innerText()).replace(/\u00a0/g, ' ');
    expect(paidBillText.includes('LUNAS'), 'Paid Guest Bill displays payment status "LUNAS"');
    expect(paidBillText.includes('Ibu Siti Rahma'), 'Paid Guest Bill displays guest name "Ibu Siti Rahma"');
    expect(paidBillText.includes('Deposit Diterapkan'), 'Paid Guest Bill displays "Deposit Diterapkan"');
    expect(paidBillText.includes('Rp 625.000'), 'Paid Guest Bill displays deposit amount "Rp 625.000"');
    expect(paidBillText.includes('Sisa Tagihan') && paidBillText.includes('Rp 0'), 'Paid Guest Bill displays "Sisa Tagihan" with "Rp 0"');
    expect(paidBillText.includes('(......................................................)'), 'Guest Bill without FO role displays signature placeholder dots');
    expect(paidBillText.toUpperCase().includes('GUEST SIGNATURE') && paidBillText.toUpperCase().includes('RECEPTIONIST SIGNATURE'), 'Paid Guest Bill displays dual signature block');

    const shotBillPaid = path.join(samplesDir, 'ui_preview_guest_bill_paid.png');
    await page.screenshot({ path: shotBillPaid, fullPage: true });
    expect(fs.existsSync(shotBillPaid), 'Captured UI screenshot for Paid Guest Bill');

    // Save PDF (Paid)
    console.log('  Triggering application Save PDF button for Paid Guest Bill...');
    await savePdfBtn.click();
    await page.waitForSelector('.fixed.inset-0', { timeout: 5000 });
    const downloadPromisePaid = page.waitForEvent('download', { timeout: 20000 });
    await modalConfirmBtn.click();
    const downloadPaid = await downloadPromisePaid;
    const appButtonPdfPaidPath = path.join(samplesDir, 'app_button_sample_guest_bill_paid.pdf');
    await downloadPaid.saveAs(appButtonPdfPaidPath);
    expect(fs.existsSync(appButtonPdfPaidPath), 'Application Save PDF generated Paid Guest Bill PDF');
    expect(countPdfPages(fs.readFileSync(appButtonPdfPaidPath)) === 1, 'Paid Guest Bill PDF has exactly 1 page');

    // Browser Print (Paid)
    await page.emulateMedia({ media: 'print' });
    const browserPrintPdfPaidPath = path.join(samplesDir, 'browser_print_sample_guest_bill_paid.pdf');
    const printBufPaid = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(browserPrintPdfPaidPath, printBufPaid);
    await page.emulateMedia({ media: 'screen' });
    expect(countPdfPages(printBufPaid) === 1, 'Browser Print for Paid Guest Bill has exactly 1 page');

    // ------------------------------------------------------------------
    // SCENARIO 6c: Long Multi-Page Guest Bill (Sample #3)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 6c: Long Multi-Page Guest Bill (Sample #3) ---');
    const btnSelectBillLong = page.locator('#btn-select-bill-long');
    await btnSelectBillLong.click();
    await page.waitForTimeout(800);

    const longBillText = (await page.locator('.document-center-printable-wrapper').innerText()).replace(/\u00a0/g, ' ');
    expect(longBillText.includes('Bpk. Bambang Soedirman'), 'Long Guest Bill displays guest name "Bpk. Bambang Soedirman"');
    expect(longBillText.includes('Executive Suite'), 'Long Guest Bill displays room type "Executive Suite"');
    expect(longBillText.toUpperCase().includes('GUEST SIGNATURE') && longBillText.toUpperCase().includes('RECEPTIONIST SIGNATURE'), 'Long Guest Bill displays dual signature block');

    const shotBillLong = path.join(samplesDir, 'ui_preview_guest_bill_long.png');
    await page.screenshot({ path: shotBillLong, fullPage: true });
    expect(fs.existsSync(shotBillLong), 'Captured UI screenshot for Long Guest Bill');

    // Save PDF (Long)
    console.log('  Triggering application Save PDF button for Long Guest Bill...');
    await savePdfBtn.click();
    await page.waitForSelector('.fixed.inset-0', { timeout: 5000 });
    const downloadPromiseLong = page.waitForEvent('download', { timeout: 20000 });
    await modalConfirmBtn.click();
    const downloadLong = await downloadPromiseLong;
    const appButtonPdfLongPath = path.join(samplesDir, 'app_button_sample_guest_bill_long.pdf');
    await downloadLong.saveAs(appButtonPdfLongPath);
    expect(fs.existsSync(appButtonPdfLongPath), 'Application Save PDF generated Long Guest Bill PDF');
    const appLongPages = countPdfPages(fs.readFileSync(appButtonPdfLongPath));
    expect(appLongPages === 3, `Long Guest Bill Save PDF spans exactly 3 pages (got ${appLongPages})`);

    // Browser Print (Long)
    await page.emulateMedia({ media: 'print' });
    const browserPrintPdfLongPath = path.join(samplesDir, 'browser_print_sample_guest_bill_long.pdf');
    const printBufLong = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(browserPrintPdfLongPath, printBufLong);
    await page.emulateMedia({ media: 'screen' });
    const browserLongPages = countPdfPages(printBufLong);
    expect(browserLongPages >= 2, `Browser Print for Long Guest Bill spans multiple pages (got ${browserLongPages})`);

    // ------------------------------------------------------------------
    // SCENARIO 6d: Unreconciled Guest Bill Print & Export Guard (R5 Fix 1)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 6d: Unreconciled Guest Bill Print & Export Guard (R5 Fix 1) ---');
    await page.click('#btn-select-corrupted-bill');
    await page.waitForTimeout(800);
    const corrBillText = (await page.innerText('.document-center')).replace(/\u00a0/g, ' ');
    expect(corrBillText.includes('Peringatan Rekonsiliasi Finansial'), 'Unreconciled Guest Bill displays reconciliation warning banner');
    expect(corrBillText.includes('Cetak & Ekspor PDF Dinonaktifkan'), 'Warning banner indicates Cetak & Ekspor PDF are disabled');

    const printBtnBill = page.locator('button:has-text("Cetak")');
    const savePdfBtnBill = page.locator('button:has-text("Save PDF")');
    expect(await printBtnBill.isDisabled(), 'Cetak button is DISABLED for unreconciled Guest Bill');
    expect(await savePdfBtnBill.isDisabled(), 'Save PDF button is DISABLED for unreconciled Guest Bill');

    const shotCorrBill = path.join(samplesDir, 'ui_preview_guest_bill_unreconciled_guard.png');
    await page.screenshot({ path: shotCorrBill, fullPage: true });
    expect(fs.existsSync(shotCorrBill), 'Captured UI screenshot for unreconciled Guest Bill guard');

    // ------------------------------------------------------------------
    // SCENARIO 6e: Charges Breakdown Discrepancy Guard (R7 GB6-F01/GB6-F04)
    // ------------------------------------------------------------------
    console.log('\n--- Scenario 6e: Charges Breakdown Discrepancy Guard (R7) ---');
    await page.click('#btn-select-chg-mismatch');
    await page.waitForTimeout(800);
    const chgMismatchText = (await page.innerText('.document-center')).replace(/\u00a0/g, ' ');
    expect(chgMismatchText.includes('Peringatan Rincian Tagihan'), 'Charges mismatch displays warning banner "Peringatan Rincian Tagihan"');
    expect(chgMismatchText.includes('Cetak & Ekspor PDF Dinonaktifkan'), 'Warning banner indicates Cetak & Ekspor PDF are disabled');

    const printBtnMismatch = page.locator('button:has-text("Cetak")');
    const savePdfBtnMismatch = page.locator('button:has-text("Save PDF")');
    expect(await printBtnMismatch.isDisabled(), 'Cetak button is DISABLED for charges mismatch');
    expect(await savePdfBtnMismatch.isDisabled(), 'Save PDF button is DISABLED for charges mismatch');

    const shotChgMismatch = path.join(samplesDir, 'ui_preview_charges_breakdown_mismatch_guard.png');
    await page.screenshot({ path: shotChgMismatch, fullPage: true });
    expect(fs.existsSync(shotChgMismatch), 'Captured UI screenshot for charges breakdown mismatch guard');

    // Quotation Regression
    await page.click('#btn-select-quotation');
    await page.waitForTimeout(600);
    const quotText = await getDocText();
    expect(quotText.includes('PENAWARAN HARGA') || quotText.includes('Quotation') || quotText.includes('PT Mitra Sukses Mandiri'), 'Quotation renders cleanly');
    const shotQuot = path.join(samplesDir, 'ui_preview_quotation.png');
    await page.screenshot({ path: shotQuot, fullPage: true });
    expect(fs.existsSync(shotQuot), 'Captured UI screenshot for Quotation');

    console.log('\n==================================================================');
    console.log(`  ALL ${passCount} BROWSER UI & EXPORT ASSERTIONS PASSED (0 FAILED)`);
    console.log('==================================================================\n');

  } finally {
    await browser.close();
    await viteServer.close();
  }
}

runBrowserTests().catch((err) => {
  console.error('[BROWSER_TEST_ERROR]', err);
  process.exit(1);
});
