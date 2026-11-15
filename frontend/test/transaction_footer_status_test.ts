/**
 * TX-F1-R2-01: Pagination footer status-gate test.
 *
 * Tests the pure `getFooterDisplay` helper from
 * transactionFooterHelpers.ts, which is the exact status-gating logic the
 * component's footer IIFE delegates to. The test covers:
 *
 *   - IDLE (initial mount, totalCount=0)
 *   - LOADING (new query in flight; stale total must not be shown as success)
 *   - ERROR   (incomplete cap / network failure; retry hint shown, no total)
 *   - SUCCESS (query completed; correct count/range/navigation rendered)
 *   - Paged loading and paged error states
 *   - SEMUA dropdown can exit to 30/50/100 from every state
 *
 * The reviewer's repro scenario is covered directly:
 *   Seed total=245 from old query → cap incomplete 15 000 / network failure
 *   → label "Menampilkan 245 (Semua)" must NOT appear; selector still present;
 *   → retry success total=205 → "Menampilkan 205 (Semua)" is correct.
 */
import assert from 'node:assert/strict';
import { getFooterDisplay } from '../src/features/transactions/transactionFooterHelpers.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

/** Simpler label-based assertions — the helper returns structured data. */
const allSemuaLabel = (s: ReturnType<typeof getFooterDisplay>) => s.rightContent.includes('Semua') && s.showCountLabel;

function run() {
  console.log('=== OAK HIMS — Footer Status-Gate Tests (TX-F1-R2-01) ===\n');

  // ------------------------------------------------------------------
  // 1. IDLE (initial mount, totalCount=0, PAGED)
  // ------------------------------------------------------------------
  console.log('--- 1. IDLE state: no success label ---');
  {
    const s = getFooterDisplay('IDLE', 'PAGED', 30, 1, 0);
    check(!s.showCountLabel, 'IDLE: no count/range label (totalCount=0 at init)');
    check(!s.showPageNav, 'IDLE: no page navigation');
    check(s.showDropdown, 'IDLE: Baris dropdown still available');
  }

  // ------------------------------------------------------------------
  // 2. LOADING in SEMUA mode: stale total=245 must NOT appear
  // ------------------------------------------------------------------
  console.log('--- 2. LOADING SEMUA: stale total not shown as success ---');
  {
    // Reviewer scenario: totalCount=245 from old query, new SEMUA query in flight
    const s = getFooterDisplay('LOADING', 'SEMUA', 30, 1, 245);
    check(!s.showCountLabel, 'LOADING SEMUA: no "Menampilkan 245 (Semua)" label');
    check(!s.showPageNav, 'LOADING SEMUA: no page navigation');
    check(s.showLoadingSpinner, 'LOADING SEMUA: spinner shown');
    check(s.showDropdown, 'LOADING SEMUA: Baris dropdown still available');
  }

  // ------------------------------------------------------------------
  // 3. LOADING in PAGED mode: no range shown during new query
  // ------------------------------------------------------------------
  console.log('--- 3. LOADING PAGED: no range/navigation during new query ---');
  {
    const s = getFooterDisplay('LOADING', 'PAGED', 30, 2, 245);
    check(!s.showCountLabel, 'LOADING PAGED: no "31–60 dari 245" range label');
    check(!s.showPageNav, 'LOADING PAGED: no page buttons');
    check(s.showLoadingSpinner, 'LOADING PAGED: spinner shown');
    check(s.showDropdown, 'LOADING PAGED: Baris dropdown still available');
  }

  // ------------------------------------------------------------------
  // 4. ERROR SEMUA: incomplete cap (15 000) → retry hint, not stale total
  // ------------------------------------------------------------------
  console.log('--- 4. ERROR SEMUA (incomplete cap): no stale total, retry hint ---');
  {
    // Reviewer scenario: incomplete 15 000 → totalCount not updated → still 245 stale
    const s = getFooterDisplay('ERROR', 'SEMUA', 30, 1, 245);
    check(!s.showCountLabel, 'ERROR SEMUA: "Menampilkan 245 (Semua)" NOT shown');
    check(!s.showPageNav, 'ERROR SEMUA: no navigation');
    check(s.showErrorHint, 'ERROR SEMUA: retry hint shown');
    check(s.showDropdown, 'ERROR SEMUA: Baris dropdown still available');
  }

  // ------------------------------------------------------------------
  // 5. ERROR PAGED: network failure → no stale range, retry hint
  // ------------------------------------------------------------------
  console.log('--- 5. ERROR PAGED (network failure): no stale range ---');
  {
    const s = getFooterDisplay('ERROR', 'PAGED', 30, 2, 245);
    check(!s.showCountLabel, 'ERROR PAGED: no "31–60 dari 245" range label');
    check(!s.showPageNav, 'ERROR PAGED: no page buttons');
    check(s.showErrorHint, 'ERROR PAGED: retry hint shown');
    check(s.showDropdown, 'ERROR PAGED: Baris dropdown still available');
  }

  // ------------------------------------------------------------------
  // 6. SUCCESS SEMUA: correct count shown after retry (total=205)
  // ------------------------------------------------------------------
  console.log('--- 6. SUCCESS SEMUA: correct total shown after retry ---');
  {
    // Reviewer scenario: retry succeeds → totalCount=205 committed
    const s = getFooterDisplay('SUCCESS', 'SEMUA', 30, 1, 205);
    check(s.showCountLabel, 'SUCCESS SEMUA: count label shown');
    check(s.rightContent.includes('205'), 'SUCCESS SEMUA: "Menampilkan 205 transaksi (Semua)"');
    check(s.rightContent.includes('(Semua)'), 'SUCCESS SEMUA: label contains "(Semua)"');
    check(s.showDropdown, 'SUCCESS SEMUA: Baris dropdown available');
    check(s.showReturnToPageButton, 'SUCCESS SEMUA: "Kembali ke halaman" button shown');
    check(!s.showLoadingSpinner, 'SUCCESS SEMUA: no spinner');
    check(!s.showErrorHint, 'SUCCESS SEMUA: no error hint');
  }

  // ------------------------------------------------------------------
  // 7. SUCCESS PAGED: correct range + navigation
  // ------------------------------------------------------------------
  console.log('--- 7. SUCCESS PAGED: range + page navigation ---');
  {
    const s = getFooterDisplay('SUCCESS', 'PAGED', 30, 2, 245);
    check(s.showCountLabel, 'SUCCESS PAGED: range label shown');
    check(s.rightContent.includes('31'), 'SUCCESS PAGED: range starts at 31');
    check(s.rightContent.includes('60'), 'SUCCESS PAGED: range ends at 60');
    check(s.rightContent.includes('245'), 'SUCCESS PAGED: total 245 in range text');
    check(s.showPageNav, 'SUCCESS PAGED: page navigation shown');
    check(s.pageNumbers !== null && s.pageNumbers.length > 0, 'SUCCESS PAGED: page numbers built');
    check(s.showDropdown, 'SUCCESS PAGED: Baris dropdown available');
  }

  // ------------------------------------------------------------------
  // 8. SUCCESS PAGED with 0 results: "0 dari 0"
  // ------------------------------------------------------------------
  console.log('--- 8. SUCCESS PAGED total=0: "0 dari 0" ---');
  {
    const s = getFooterDisplay('SUCCESS', 'PAGED', 30, 1, 0);
    check(s.showCountLabel, 'SUCCESS PAGED 0: label shown');
    check(s.rightContent.includes('0 dari 0'), 'SUCCESS PAGED 0: "0 dari 0"');
    check(!s.showPageNav, 'SUCCESS PAGED 0: no navigation (totalPages=1)');
  }

  // ------------------------------------------------------------------
  // 9. SEMUA dropdown exit: from ERROR/LOADING, dropdown value stays
  //    usable (dropdownValue reflects current mode, not a success claim)
  // ------------------------------------------------------------------
  console.log('--- 9. Dropdown value consistency across all states ---');
  {
    for (const status of ['IDLE', 'LOADING', 'ERROR', 'SUCCESS'] as const) {
      const s = getFooterDisplay(status, 'SEMUA', 30, 1, 245);
      check(s.dropdownValue === 'semua', `dropdown value = "semua" in SEMUA mode for ${status}`);
      check(s.showDropdown, `dropdown visible in SEMUA mode for ${status}`);
    }
    for (const status of ['IDLE', 'LOADING', 'ERROR', 'SUCCESS'] as const) {
      const s = getFooterDisplay(status, 'PAGED', 50, 3, 245);
      check(s.dropdownValue === '50', `dropdown value = "50" in PAGED mode for ${status}`);
      check(s.showDropdown, `dropdown visible in PAGED mode for ${status}`);
    }
  }

  // ------------------------------------------------------------------
  // 10. full scenario: seed 245 → incomplete cap → retry 205
  //     (exact reviewer repro, end-to-end via state transitions)
  // ------------------------------------------------------------------
  console.log('--- 10. Reviewer repro: seed 245 → cap error → retry success 205 ---');
  {
    // Phase 1: initial load succeeded with 245
    let s1 = getFooterDisplay('SUCCESS', 'SEMUA', 30, 1, 245);
    check(s1.showCountLabel && s1.rightContent.includes('245'),
      'phase1 SUCCESS: "Menampilkan 245 transaksi (Semua)"');

    // Phase 2: user keeps SEMUA, a new query is triggered (e.g. filter change
    //          or page-size change) and hits the incomplete cap
    let s2 = getFooterDisplay('LOADING', 'SEMUA', 30, 1, 245);
    check(!s2.showCountLabel,
      'phase2 LOADING: old "245" label hidden (query in flight)');

    let s3 = getFooterDisplay('ERROR', 'SEMUA', 30, 1, 245);
    check(!s3.showCountLabel,
      'phase3 ERROR (cap): "245" label NOT shown (query failed)');
    check(s3.showErrorHint,
      'phase3 ERROR (cap): retry hint visible');
    check(s3.showDropdown,
      'phase3 ERROR (cap): Baris dropdown still available');

    // Phase 4: user retries successfully → totalCount=205
    let s4 = getFooterDisplay('SUCCESS', 'SEMUA', 30, 1, 205);
    check(s4.showCountLabel && s4.rightContent.includes('205'),
      'phase4 SUCCESS (retry): "Menampilkan 205 transaksi (Semua)"');
    check(!s4.rightContent.includes('245'),
      'phase4 SUCCESS (retry): old total 245 gone');
  }

  // ------------------------------------------------------------------
  // 11. Paged loading: user switches to PAGED, new page query in flight
  // ------------------------------------------------------------------
  console.log('--- 11. Paged loading: range/nav hidden during PAGED query ---');
  {
    const s = getFooterDisplay('LOADING', 'PAGED', 50, 2, 245);
    check(!s.showCountLabel, 'PAGED LOADING: no "51–100 dari 245" range');
    check(!s.showPageNav, 'PAGED LOADING: no page buttons');
    check(s.showLoadingSpinner, 'PAGED LOADING: spinner visible');
    check(s.showDropdown, 'PAGED LOADING: dropdown available');
  }

  console.log(`\n=== ALL FOOTER STATUS-GATE TESTS PASSED (${assertions} assertions) ===`);
}

run();
process.exit(0);
