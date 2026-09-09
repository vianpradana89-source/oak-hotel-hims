import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Expense Expandable (EXPENSE-1D) Regression Tests ===\n');

// ============================================================================
// Load source file
// ============================================================================
const srcPath = path.resolve(process.cwd(), 'src/features/transactions/TransactionWorkspace.tsx');
check(fs.existsSync(srcPath), 'Source file exists');
const source = fs.readFileSync(srcPath, 'utf8');

// ============================================================================
// Test A: Expense expandable state exists
// ============================================================================
console.log('--- Test A: Expense expandable state ---');
check(source.includes('expandedExpenseIds'), 'A1. expandedExpenseIds state exists');
check(source.includes('expenseDetailCache'), 'A2. expenseDetailCache state exists');
check(source.includes('expenseLoadingIds'), 'A3. expenseLoadingIds state exists');
check(source.includes('expenseExpandErrors'), 'A4. expenseExpandErrors state exists');

// ============================================================================
// Test B: toggleExpenseExpand and retryExpenseExpand exist
// ============================================================================
console.log('\n--- Test B: Handler existence ---');
check(source.includes('const toggleExpenseExpand'), 'B1. toggleExpenseExpand function exists');
check(source.includes('const retryExpenseExpand'), 'B2. retryExpenseExpand function exists');

// ============================================================================
// Test C: Expense detail uses fetchTransactionDetailApi lazily
// ============================================================================
console.log('\n--- Test C: Lazy API path ---');
check(source.includes('fetchTransactionDetailApi'), 'C1. fetchTransactionDetailApi is imported/used');
const toggleExpensePattern = /toggleExpenseExpand[\s\S]*?fetchTransactionDetailApi/.test(source);
check(toggleExpensePattern, 'C2. Toggle expand triggers fetchTransactionDetailApi call');

// ============================================================================
// Test D: Multiple expanded rows supported via Set
// ============================================================================
console.log('\n--- Test D: Set-based expansion ---');
check(/setExpandedExpenseIds\(\(prev\) => \{\s*const next = new Set\(prev\);\s*next\.add\(txId\);/.test(source), 'D1. Set.add pattern for expandedExpenseIds');
check(/setExpandedExpenseIds\(\(prev\) => \{\s*const next = new Set\(prev\);\s*next\.delete\(txId\);/.test(source), 'D2. Set.delete pattern for expandedExpenseIds');
check(/new Map\(prev\);\s*next\.set\(txId,\s*detail\);/.test(source), 'D3. Map.set pattern for expenseDetailCache');

// ============================================================================
// Test E: Expand chevron uses stopPropagation
// ============================================================================
console.log('\n--- Test E: Chevron stopPropagation ---');
const chevronExpensePattern = /toggleExpenseExpand[\s\S]*?onClick=\{\(e\)\s*=>\s*\{[\s\S]*?e\.stopPropagation\(\)[\s\S]*?toggleExpenseExpand/;
check(chevronExpensePattern.test(source), 'E1. Chevron onClick handler calls stopPropagation before toggleExpenseExpand');

// ============================================================================
// Test F: Expand chevron call site passes t.id (row identity)
// ============================================================================
console.log('\n--- Test F: Chevron call site ---');
const chevronCallPattern = /onClick=\{\(e\) => \{[\s\S]*?stopPropagation\(\)[\s\S]*?\}\)([\s\S]*?)toggleExpenseExpand\(t\.id\)/;
check(chevronCallPattern.test(source), 'F1. Chevron onClick calls stopPropagation then toggleExpenseExpand(t.id)');

// ============================================================================
// Test G: Expense expandable colSpan matches table column count (10)
// ============================================================================
console.log('\n--- Test G: colSpan invariant ---');
check(source.includes('colSpan={10}'), 'G1. Expense expandable child row uses colSpan={10}');
// PURCHASE should still use colSpan={9}
check(source.includes('colSpan={9}'), 'G2. PURCHASE expandable still uses colSpan={9} (unchanged)');

// Verify EXPENSE block specifically uses colSpan={10}
const expenseBlock = source.match(/if \(activeTab === 'EXPENSE'\)[\s\S]*?(?=if \(activeTab === ['"]INCOME['"]\)|if \(activeTab === ['"]ALL['"]\))/);
if (expenseBlock) {
  check(/colSpan=\{10\}/.test(expenseBlock[0]), 'G3. EXPENSE block contains colSpan={10}');
  check(!/colSpan=\{9\}/.test(expenseBlock[0]), 'G4. EXPENSE block does not contain colSpan={9}');
}

// ============================================================================
// Test H: Zero-line branch is safe
// ============================================================================
console.log('\n--- Test H: Zero-line branch ---');
const detailBlockExpense = source.match(/Rincian Operasional Pengeluaran[\s\S]{0,3000}/);
if (detailBlockExpense) {
  check(/detail\.lines && detail\.lines\.length > 0/.test(detailBlockExpense[0]), 'H1. Lines length check present');
  check(/Tidak ada rincian item/.test(detailBlockExpense[0]) || /detail \?/.test(detailBlockExpense[0]), 'H2. Zero-line safe branch present');
} else {
  check(false, 'H1. Detail block found');
}

// ============================================================================
// Test I: Recipient bank uses recipient_bank_* fields
// ============================================================================
console.log('\n--- Test I: Recipient bank fields ---');
check(source.includes('recipient_bank_name'), 'I1. recipient_bank_name referenced in source');
check(source.includes('recipient_bank_account'), 'I2. recipient_bank_account referenced in source');
check(source.includes('recipient_bank_holder'), 'I3. recipient_bank_holder referenced in source');

// Verify in EXPENSE block
if (expenseBlock) {
  check(/recipient_bank_name/.test(expenseBlock[0]), 'I4. recipient_bank_name used in EXPENSE block');
  check(/recipient_bank_account/.test(expenseBlock[0]), 'I5. recipient_bank_account used in EXPENSE block');
  check(/recipient_bank_holder/.test(expenseBlock[0]), 'I6. recipient_bank_holder used in EXPENSE block');
}

// ============================================================================
// Test J: Bank popover contains both supplier_* and recipient_* fields
// ============================================================================
console.log('\n--- Test J: Bank popover fields ---');
const popoverSection = source.match(/aria-label=\{bankPopoverTx/);
if (popoverSection) {
  // Grab a large enough section to cover the full popover
  const startIdx = popoverSection.index!;
  const popoverContent = source.slice(startIdx, startIdx + 8000);
  check(/supplier_bank_name/.test(popoverContent), 'J1. supplier_bank_name used in popover');
  check(/supplier_bank_account/.test(popoverContent), 'J2. supplier_bank_account used in popover');
  check(/supplier_bank_holder/.test(popoverContent), 'J3. supplier_bank_holder used in popover');
  check(/recipient_bank_name/.test(popoverContent), 'J4. recipient_bank_name used in popover');
  check(/recipient_bank_account/.test(popoverContent), 'J5. recipient_bank_account used in popover');
  check(/recipient_bank_holder/.test(popoverContent), 'J6. recipient_bank_holder used in popover');
}

// ============================================================================
// Test K: Bank empty-state checks all three fields for active type
// ============================================================================
console.log('\n--- Test K: Bank empty-state logic ---');
// The source has two ternary branches, each checking all 3 fields
const emptyStateExpr = /recipient_bank_name \|\| .*recipient_bank_account \|\| .*recipient_bank_holder/.test(source);
const supplierEmptyStateExpr = /supplier_bank_name \|\| .*supplier_bank_account \|\| .*supplier_bank_holder/.test(source);
check(emptyStateExpr, 'K1. EXPENSE empty-state checks all three recipient_bank_* fields');
check(supplierEmptyStateExpr, 'K2. PURCHASE empty-state checks all three supplier_bank_* fields');

// ============================================================================
// Test L: Expense bank button only shown if any recipient_bank_* exists
// ============================================================================
console.log('\n--- Test L: Bank button conditional ---');
check(/hasRecipientBank/.test(source), 'L1. hasRecipientBank conditional computed');
check(/recipient_bank_name \|\|.*recipient_bank_account \|\|.*recipient_bank_holder/.test(source) ||
      /recipient_bank_name \|\| t\.recipient_bank_account \|\| t\.recipient_bank_holder/.test(source),
  'L2. Bank button shown only if any recipient_bank_* field exists');

// ============================================================================
// Test M: Lifecycle controls remain present in Expense row
// ============================================================================
console.log('\n--- Test M: Lifecycle controls ---');
if (expenseBlock) {
  check(/handleExpenseLifecycleMutation/.test(expenseBlock[0]), 'M1. handleExpenseLifecycleMutation used in EXPENSE block');
  check(/getPurchaseVerificationClass/.test(expenseBlock[0]), 'M2. Verification dropdown present');
  check(/getPurchaseWorkflowClass/.test(expenseBlock[0]), 'M3. Workflow dropdown present');
}

// ============================================================================
// Test N: Terminal state controls — VERIFICATION disabled for terminal states
// (Guard now uses isTransactionEditable helper instead of raw checks)
// ============================================================================
console.log('\n--- Test N: Terminal state controls ---');
if (expenseBlock) {
  const verificationSection = expenseBlock[0].match(/SET_VERIFICATION[\s\S]{0,300}/);
  if (verificationSection) {
    check(/isTransactionEditable/.test(verificationSection[0]),
      'N1. VERIFICATION dropdown uses isTransactionEditable helper for editability');
  }
  const workflowSection = expenseBlock[0].match(/SET_WORKFLOW[\s\S]{0,300}/);
  if (workflowSection) {
    check(/lifecycleSaving.*SET_WORKFLOW/.test(workflowSection[0]),
      'N2. WORKFLOW dropdown disabled during save operation');
  }
}

// ============================================================================
// Test O: Detail button still opens drawer
// ============================================================================
console.log('\n--- Test O: Detail button behavior ---');
if (expenseBlock) {
  check(/openDetailDrawer\(t\.id\)/.test(expenseBlock[0]), 'O1. openDetailDrawer(t.id) present in EXPENSE block');
}

// ============================================================================
// Test P: Expense row clickable opens drawer
// ============================================================================
console.log('\n--- Test P: Row click behavior ---');
if (expenseBlock) {
  const rowClickMatch = expenseBlock[0].match(/onClick=\{[^}]*openDetailDrawer[\s\S]{0,200}\}/);
  check(rowClickMatch !== null, 'P1. Main row onClick calls openDetailDrawer');
  check(rowClickMatch && !rowClickMatch[0].includes('toggleExpenseExpand'),
    'P2. Main row click does not trigger toggleExpenseExpand');
}

// ============================================================================
// Test Q: No malformed Tailwind class concatenations
// ============================================================================
console.log('\n--- Test Q: Tailwind class integrity ---');
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
check(!malformedFound, 'Q1. No concatenated/malformed Tailwind classes detected in current source');

// ============================================================================
// Test R: Reset effect includes EXPENSE-1D state
// ============================================================================
console.log('\n--- Test R: Reset effect completeness ---');
check(source.includes('setExpandedExpenseIds(new Set())'), 'R1. Reset clears expandedExpenseIds');
check(source.includes('setExpenseDetailCache(new Map())'), 'R2. Reset clears expenseDetailCache');
check(source.includes('setExpenseLoadingIds(new Set())'), 'R3. Reset clears expenseLoadingIds');
check(source.includes('setExpenseExpandErrors(new Map())'), 'R4. Reset clears expenseExpandErrors');

console.log(`\n=== All ${assertions} Expense Expandable (EXPENSE-1D) Assertions PASSED ===\n`);
