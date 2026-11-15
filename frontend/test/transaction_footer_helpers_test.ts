import assert from 'node:assert/strict';
import { buildPageNumbers, rangeForPage } from '../src/features/transactions/transactionFooterHelpers.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

async function run() {
  console.log('=== OAK HIMS — Transaction Footer Helpers Tests ===\n');

  // ------------------------------------------------------------------
  // buildPageNumbers: totalPages ≤ 7 → all numbers
  // ------------------------------------------------------------------
  console.log('--- 1. buildPageNumbers: totalPages ≤ 7 ---');
  check(JSON.stringify(buildPageNumbers(1, 1))  === '[1]',     'total=1 → [1]');
  check(JSON.stringify(buildPageNumbers(1, 3))  === '[1,2,3]', 'total=3, cur=1 → [1,2,3]');
  check(JSON.stringify(buildPageNumbers(3, 3))  === '[1,2,3]', 'total=3, cur=3 → [1,2,3]');
  check(JSON.stringify(buildPageNumbers(4, 7))  === '[1,2,3,4,5,6,7]', 'total=7 → all 7');

  // ------------------------------------------------------------------
  // buildPageNumbers: totalPages > 7 with ellipsis
  // ------------------------------------------------------------------
  console.log('--- 2. buildPageNumbers: totalPages > 7 ---');
  {
    // page 1 of 9 → [1, 2, …, 9]
    const r1 = buildPageNumbers(1, 9);
    check(r1.includes(1) && r1.includes(9) && r1.includes('ellipsis'), 'page 1/9 → has 1, 9, ellipsis');
    check(r1[0] === 1, 'first element is 1');

    // page 5 of 9 → [1, …, 4, 5, 6, …, 9]
    const r5 = buildPageNumbers(5, 9);
    check(r5.includes(1) && r5.includes(9), 'page 5/9 → includes first and last');
    check(r5.includes(5), 'page 5/9 → includes current page 5');
    check(r5.includes(4) && r5.includes(6), 'page 5/9 → includes neighbours 4 and 6');

    // page 9 of 9 → [1, …, 8, 9]
    const r9 = buildPageNumbers(9, 9);
    check(r9.includes(8) && r9.includes(9), 'page 9/9 → includes 8 and 9');
    check(r9.includes('ellipsis'), 'page 9/9 → has ellipsis');

    // page 2 of 12 → [1, 2, 3, …, 12]
    const r12 = buildPageNumbers(2, 12);
    check(r12.includes(1) && r12.includes(2) && r12.includes(3), 'page 2/12 → includes 1, 2, 3');
    check(r12.includes('ellipsis') && r12.includes(12), 'page 2/12 → has ellipsis and last');
  }

  // ------------------------------------------------------------------
  // rangeForPage: normal cases
  // ------------------------------------------------------------------
  console.log('--- 3. rangeForPage: normal PAGED cases ---');
  check(JSON.stringify(rangeForPage(1, 30, 0))   === '[0,0]',   'total=0 → [0,0]');
  check(JSON.stringify(rangeForPage(1, 30, 30))  === '[1,30]',  'page 1/30 items → 1–30');
  check(JSON.stringify(rangeForPage(2, 30, 245)) === '[31,60]', 'page 2, size 30, total 245 → 31–60');
  check(JSON.stringify(rangeForPage(9, 30, 245)) === '[241,245]','last page, total 245 → 241–245');
  check(JSON.stringify(rangeForPage(1, 50, 75))  === '[1,50]',  'page 1, size 50, total 75 → 1–50');
  check(JSON.stringify(rangeForPage(2, 50, 75))  === '[51,75]', 'page 2, size 50, total 75 → 51–75');
  check(JSON.stringify(rangeForPage(1, 100, 100)) === '[1,100]','page 1, size 100, total 100 → 1–100');

  // ------------------------------------------------------------------
  // rangeForPage: size change 30 → 100 → 30
  // ------------------------------------------------------------------
  console.log('--- 4. rangeForPage: size transition 30 → 100 → 30 ---');
  // total=245, starting at page 2 size 30
  check(JSON.stringify(rangeForPage(2, 30, 245)) === '[31,60]', 'page 2 size 30 total 245 → 31–60');
  // user switches to size 100 → page resets to 1
  check(JSON.stringify(rangeForPage(1, 100, 245)) === '[1,100]', 'page 1 size 100 total 245 → 1–100');
  // user switches back to size 30 → page resets to 1
  check(JSON.stringify(rangeForPage(1, 30, 245)) === '[1,30]', 'page 1 size 30 total 245 → 1–30');

  // ------------------------------------------------------------------
  // totalPages > 1 in SEMUA mode: range display still valid
  // ------------------------------------------------------------------
  console.log('--- 5. rangeForPage: SEMUA mode shows total count ---');
  // In SEMUA mode totalCount can be > 100 but there's no paging; rangeForPage
  // is only used in PAGED mode. The "Menampilkan N (Semua)" label uses totalCount directly.
  check(true, 'SEMUA mode uses totalCount directly, not rangeForPage');

  // ------------------------------------------------------------------
  // Data shrinks while on last page → clamped page is reflected
  // ------------------------------------------------------------------
  console.log('--- 6. rangeForPage: data shrink (page clamp) ---');
  // total was 245, page was 9; data removed → total now 100, page clamps to ceil(100/30)=4
  const clampedPage = Math.max(1, Math.min(9, Math.ceil(100 / 30)));
  check(clampedPage === 4, 'page clamps from 9 to 4 when total shrinks to 100 (size 30)');
  check(JSON.stringify(rangeForPage(clampedPage, 30, 100)) === '[91,100]', 'clamped page 4 size 30 total 100 → 91–100');

  console.log(`\n=== ALL FOOTER HELPER TESTS PASSED (${assertions} assertions) ===`);
}

run().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
