import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Purchase Expandable (PURCHASE-2B) Regression Tests ===\n');

// ============================================================================
// Load source file
// ============================================================================
const srcPath = path.resolve(process.cwd(), 'src/features/transactions/TransactionWorkspace.tsx');
check(fs.existsSync(srcPath), 'Source file exists');
const source = fs.readFileSync(srcPath, 'utf8');

// ============================================================================
// Test A: Chevron uses stopPropagation
// ============================================================================
console.log('--- Test A: Chevron stopPropagation ---');

const chevronPattern = /togglePurchaseExpand[\s\S]*?onClick=\{\(e\)\s*=>\s*\{[\s\S]*?e\.stopPropagation\(\)[\s\S]*?togglePurchaseExpand/;
check(chevronPattern.test(source), 'A1. Chevron onClick handler calls stopPropagation before togglePurchaseExpand');

// Verify the chevron button is inside the PURCHASE block
const purchaseBlock = source.match(/if \(activeTab === 'PURCHASE'\)[\s\S]*?if \(activeTab === 'EXPENSE'\)/);
check(purchaseBlock !== null, 'A2. PURCHASE block exists');
if (purchaseBlock) {
  const chevronInPurchase = /togglePurchaseExpand[\s\S]*?stopPropagation/.test(purchaseBlock[0]);
  check(chevronInPurchase, 'A3. Chevron with stopPropagation found within PURCHASE block');
}

// ============================================================================
// Test B: colSpan={9} for child row
// ============================================================================
console.log('\n--- Test B: colSpan invariant ---');
check(source.includes('colSpan={9}'), 'B1. Child row uses colSpan={9}');
// The PURCHASE expandable child row specifically uses colSpan={9}
// (the SALE bid child row uses colSpan={12}, so we verify the PURCHASE-specific one exists)
const purchaseChildRowMatch = source.match(/isExpanded &&[\s\S]{0,300}colSpan=\{9\}/);
check(purchaseChildRowMatch !== null, 'B2. PURCHASE expandable child row uses colSpan={9}');

// ============================================================================
// Test C: Lazy detail API uses fetchTransactionDetailApi
// ============================================================================
console.log('\n--- Test C: Lazy API path ---');
check(source.includes('fetchTransactionDetailApi'), 'C1. fetchTransactionDetailApi is imported/used');
check(/togglePurchaseExpand[\s\S]*?fetchTransactionDetailApi/.test(source), 'C2. Toggle expand triggers fetchTransactionDetailApi call');

// ============================================================================
// Test D: Immutable Set/Map updates (NO mutation patterns)
// ============================================================================
console.log('\n--- Test D: Immutable state updates ---');

const badSetMutation = /new Set\(prev\.add\(/.test(source);
check(!badSetMutation, 'D1. No "new Set(prev.add(" found — immutable pattern enforced');

const badMapMutation = /new Map\(prev\.set\(/.test(source);
check(!badMapMutation, 'D2. No "new Map(prev.set(" found — immutable pattern enforced');

// Verify correct pattern exists
const correctSetPattern = /setExpandedPurchaseIds\(\(prev\) => \{\s*const next = new Set\(prev\);\s*next\.add\(txId\);/;
check(correctSetPattern.test(source), 'D3. Correct immutable Set pattern present for expandedPurchaseIds');

const correctMapPattern = /setPurchaseDetailCache\(\(prev\) => \{\s*const next = new Map\(prev\);\s*next\.set\(txId,/;
check(correctMapPattern.test(source), 'D4. Correct immutable Map pattern present for purchaseDetailCache');

// ============================================================================
// Test E: Retry uses retryPurchaseExpand, NOT togglePurchaseExpand
// ============================================================================
console.log('\n--- Test E: Retry handler invariant ---');
check(source.includes('retryPurchaseExpand'), 'E1. retryPurchaseExpand function exists');

// Capture the full error/retry button JSX block and verify:
// - it contains retryPurchaseExpand(t.id)
// - it contains e.stopPropagation()
// - it does NOT contain togglePurchaseExpand(t.id)
const errorRetryBlock = source.match(/Gagal memuat detail pembelian[\s\S]{0,800}<\/div>/);
check(errorRetryBlock !== null, 'E2. Error/retry button JSX block found in source');
if (errorRetryBlock) {
  const retryBlockContent = errorRetryBlock[0];
  check(retryBlockContent.includes('retryPurchaseExpand(t.id)'),
    'E3. Retry button invokes retryPurchaseExpand(t.id)');
  check(retryBlockContent.includes('e.stopPropagation()'),
    'E4. Retry button calls e.stopPropagation()');
  check(!retryBlockContent.includes('togglePurchaseExpand(t.id)'),
    'E5. Retry button does NOT call togglePurchaseExpand(t.id)');
}

// ============================================================================
// Test F: Zero-line detail still renders summary (structured assertion)
// ============================================================================
console.log('\n--- Test F: Zero-line summary rendering ---');

// The detail block structure is: detail ? (<>{ ...lines ternary... } + summary) : (...)
// Extract a section that contains both the lines check and the summary fields
const detailBlockMatch = source.match(
  /detail\s*\?\s*[\(<][\s\S]*?detail\.lines && detail\.lines\.length > 0[\s\S]*?Gross \/\s*Nilai Bruto:/
);
check(detailBlockMatch !== null,
  'F1. Detail block has lines ternary AND summary fields in same scope (zero-line safe)');

if (detailBlockMatch) {
  // Verify the lines branch contains the item table with canonical line_total
  check(detailBlockMatch[0].includes('line.line_total'), 'F2. Detail block uses canonical line.line_total');
  check(detailBlockMatch[0].includes('Tidak ada rincian item'), 'F3. Empty-state text present');
}

// ============================================================================
// Test G: line.line_total is canonical subtotal (no recomputation)
// ============================================================================
console.log('\n--- Test G: Canonical line_total ---');
check(source.includes('Number(line.line_total)'), 'G1. line.line_total used as canonical subtotal');
check(!/quantity.*unit_price|qty.*price|recalculat/i.test(source.split('line.line_total')[0].slice(-500)),
  'G2. No qtyÃ—price recomputation before line_total usage');

// ============================================================================
// Test H: Summary row retains openDetailDrawer(t.id)
// ============================================================================
console.log('\n--- Test H: Summary row click behavior ---');
const purchaseBlockFull = source.match(/if \(activeTab === 'PURCHASE'\)[\s\S]*?(?=if \(activeTab === ['"]EXPENSE['"]\))/);
check(purchaseBlockFull !== null, 'H1. PURCHASE block found');
if (purchaseBlockFull) {
  const drawerClick = /openDetailDrawer\(t\.id\)/.test(purchaseBlockFull[0]);
  check(drawerClick, 'H2. openDetailDrawer(t.id) retained in PURCHASE summary row click');
}

// ============================================================================
// Test I: Terminal states (BATAL/SELESAI) not excluded from expansion
// ============================================================================
console.log('\n--- Test I: Terminal state expandability ---');
// The isExpanded variable should be computed from expandedPurchaseIds regardless of operational_sheet
const expandedComputedFromSet = /const isExpanded = expandedPurchaseIds\.has\(t\.id\)/.test(source);
check(expandedComputedFromSet, 'I1. isExpanded derived from Set.has — not filtered by operational status');

// Verify no conditional that blocks expansion for BATAL or SELESAI
const noBlockedExpansion = !/isExpanded.*BATAL|BATAL.*isExpanded|operational_sheet.*!isExpanded/.test(source);
check(noBlockedExpansion, 'I2. No conditional exclusion of BATAL/SELESAI from expansion');

// ============================================================================
// Test J: Supplier bank popover and lifecycle controls preserved
// ============================================================================
console.log('\n--- Test J: Controls preservation ---');
check(source.includes('handleBankPopoverToggle'), 'J1. Supplier bank popover handler preserved');
check(source.includes('handlePurchaseLifecycleMutation'), 'J2. Lifecycle mutation handler preserved');
check(source.includes('getPurchaseReceivingClass'), 'J3. Receiving class helper preserved');
check(source.includes('getPurchaseVerificationClass'), 'J4. Verification class helper preserved');
check(source.includes('getPurchaseWorkflowClass'), 'J5. Workflow class helper preserved');

// ============================================================================
// Test K: No malformed Tailwind class concatenations (in current saved source)
// ============================================================================
console.log('\n--- Test K: Tailwind class integrity ---');
const malformedPatterns = [
  'text-rightfont',
  'text-smtext',
  'font-boldborder',
  'font-semiboldtext',
  'px-4py',
  'py-3px',
  'flexjustify',
  'text-centertext',
  'text-slatetext',
];
let malformedFound = false;
for (const pat of malformedPatterns) {
  if (source.includes(pat)) {
    console.log(`  WARNING: Found malformed pattern: ${pat}`);
    malformedFound = true;
  }
}
check(!malformedFound, 'K1. No concatenated/malformed Tailwind classes detected in current source');

// ============================================================================
// Test L: reset effect includes PURCHASE-2B state
// ============================================================================
console.log('\n--- Test L: Reset effect completeness ---');
check(source.includes('setExpandedPurchaseIds(new Set())'), 'L1. Reset clears expandedPurchaseIds');
check(source.includes('setPurchaseDetailCache(new Map())'), 'L2. Reset clears purchaseDetailCache');
check(source.includes('setPurchaseLoadingIds(new Set())'), 'L3. Reset clears purchaseLoadingIds');
check(source.includes('setPurchaseExpandErrors(new Map())'), 'L4. Reset clears purchaseExpandErrors');

console.log(`\n=== All ${assertions} Purchase Expandable (PURCHASE-2B) Assertions PASSED ===\n`);
