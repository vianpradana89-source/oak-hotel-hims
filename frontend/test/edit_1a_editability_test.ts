import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isTransactionEditable,
  isOperationalEditDomainType,
  isTransactionVerificationEditable
} from '../src/features/transactions/transactionDomainTypes.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== Starting Edit-1A Unified Transaction Editability Regression Tests ===\n');

// ============================================================================
// Load source files for wiring regression checks
// ============================================================================
const workspacePath = path.resolve(process.cwd(), 'src/features/transactions/TransactionWorkspace.tsx');
check(fs.existsSync(workspacePath), 'Source file TransactionWorkspace.tsx exists');
const workspaceSource = fs.readFileSync(workspacePath, 'utf8');

const drawerPath = path.resolve(process.cwd(), 'src/features/transactions/TransactionDetailDrawer.tsx');
check(fs.existsSync(drawerPath), 'Source file TransactionDetailDrawer.tsx exists');
const drawerSource = fs.readFileSync(drawerPath, 'utf8');

// ============================================================================
// Test A: Production helpers are exported
// ============================================================================
console.log('--- Test A: Production helper exports ---');
const typesSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/features/transactions/transactionDomainTypes.ts'),
  'utf8'
);
check(/export function isTransactionEditable/.test(typesSource), 'A1. isTransactionEditable exported from transactionDomainTypes');
check(/export function isOperationalEditDomainType/.test(typesSource), 'A2. isOperationalEditDomainType exported from transactionDomainTypes');
check(/export function isTransactionVerificationEditable/.test(typesSource), 'A3. isTransactionVerificationEditable exported from transactionDomainTypes');

// Verify functions are callable (not just source-text declarations)
check(typeof isTransactionEditable === 'function', 'A4. isTransactionEditable is a callable function at runtime');
check(typeof isOperationalEditDomainType === 'function', 'A5. isOperationalEditDomainType is a callable function at runtime');
check(typeof isTransactionVerificationEditable === 'function', 'A6. isTransactionVerificationEditable is a callable function at runtime');

// ============================================================================
// Test B: Source usage regression — components consume correct helpers
// ============================================================================
console.log('\n--- Test B: Source wiring regression ---');
check(/!isTransactionEditable\(t\)/.test(workspaceSource), 'B1. TransactionWorkspace uses !isTransactionEditable(t) for lifecycle guards');
check(/isTransactionVerificationEditable/.test(drawerSource), 'B2. TransactionDetailDrawer imports isTransactionVerificationEditable');
check(/!isTransactionVerificationEditable\(tx\)/.test(drawerSource), 'B3. Drawer verification button uses !isTransactionVerificationEditable(tx)');
check(!drawerSource.includes('isOperationalEditDomainType(tx.transaction_type) ? !isTransactionEditable(tx)'),
  'B4. Drawer no longer has inline domain conditional (uses helper instead)');

// ============================================================================
// Test C: isTransactionEditable — real runtime truth table
// ============================================================================
console.log('\n--- Test C: isTransactionEditable runtime truth table ---');
check(isTransactionEditable({ operational_sheet: 'PROSES' }) === true, 'C1. PROSES → true');
check(isTransactionEditable({ operational_sheet: 'SELESAI' }) === false, 'C2. SELESAI → false');
check(isTransactionEditable({ operational_sheet: 'BATAL' }) === false, 'C3. BATAL → false');
check(isTransactionEditable({ operational_sheet: 'HAPUS' }) === false, 'C4. HAPUS → false');
check(isTransactionEditable({}) === false, 'C5. empty object (undefined sheet) → false');
check(isTransactionEditable({ operational_sheet: null }) === false, 'C6. null sheet → false');

// ============================================================================
// Test D: isOperationalEditDomainType — real runtime truth table
// ============================================================================
console.log('\n--- Test D: isOperationalEditDomainType runtime truth table ---');
check(isOperationalEditDomainType('PURCHASE') === true, 'D1. PURCHASE → true');
check(isOperationalEditDomainType('EXPENSE') === true, 'D2. EXPENSE → true');
check(isOperationalEditDomainType('INCOME') === true, 'D3. INCOME → true');
check(isOperationalEditDomainType('SALE') === false, 'D4. SALE → false');
check(isOperationalEditDomainType(undefined) === false, 'D5. undefined → false');
check(isOperationalEditDomainType(null) === false, 'D6. null → false');

// ============================================================================
// Test E: isTransactionVerificationEditable — edit-domain truth table
// ============================================================================
console.log('\n--- Test E: Verification editable — edit-domain (PURCHASE/EXPENSE/INCOME) ---');
check(isTransactionVerificationEditable({ transaction_type: 'PURCHASE', operational_sheet: 'PROSES' }) === true, 'E1. PURCHASE + PROSES → true');
check(isTransactionVerificationEditable({ transaction_type: 'PURCHASE', operational_sheet: 'SELESAI' }) === false, 'E2. PURCHASE + SELESAI → false');
check(isTransactionVerificationEditable({ transaction_type: 'PURCHASE', operational_sheet: 'BATAL' }) === false, 'E3. PURCHASE + BATAL → false');
check(isTransactionVerificationEditable({ transaction_type: 'PURCHASE', operational_sheet: 'HAPUS' }) === false, 'E4. PURCHASE + HAPUS → false');
check(isTransactionVerificationEditable({ transaction_type: 'EXPENSE', operational_sheet: 'PROSES' }) === true, 'E5. EXPENSE + PROSES → true');
check(isTransactionVerificationEditable({ transaction_type: 'EXPENSE', operational_sheet: 'SELESAI' }) === false, 'E6. EXPENSE + SELESAI → false');
check(isTransactionVerificationEditable({ transaction_type: 'INCOME', operational_sheet: 'PROSES' }) === true, 'E7. INCOME + PROSES → true');
check(isTransactionVerificationEditable({ transaction_type: 'INCOME', operational_sheet: 'SELESAI' }) === false, 'E8. INCOME + SELESAI → false');

// ============================================================================
// Test F: isTransactionVerificationEditable — non-edit-domain (SALE) truth table
// ============================================================================
console.log('\n--- Test F: Verification editable — non-edit-domain (SALE) ---');
check(isTransactionVerificationEditable({ transaction_type: 'SALE', operational_sheet: undefined }) === true, 'F1. SALE + undefined sheet → true');
check(isTransactionVerificationEditable({ transaction_type: 'SALE', operational_sheet: 'PROSES' }) === true, 'F2. SALE + PROSES → true');
check(isTransactionVerificationEditable({ transaction_type: 'SALE', operational_sheet: 'SELESAI' }) === true, 'F3. SALE + SELESAI → true');
check(isTransactionVerificationEditable({ transaction_type: 'SALE', operational_sheet: 'BATAL' }) === false, 'F4. SALE + BATAL → false');
check(isTransactionVerificationEditable({ transaction_type: 'SALE', operational_sheet: 'HAPUS' }) === false, 'F5. SALE + HAPUS → false');

// ============================================================================
// Test G: SET_WORKFLOW dropdown independence from editability helpers
// ============================================================================
console.log('\n--- Test G: Workflow independence ---');
const workflowDisabledLines = workspaceSource.split('\n').filter(l => /SET_WORKFLOW/.test(l) && /disabled/.test(l));
check(workflowDisabledLines.length >= 2, 'G1. SET_WORKFLOW disabled lines exist in Workspace');
const hasEditabilityInWorkflow = workflowDisabledLines.some(l => /isTransactionEditable/.test(l) || /isTransactionVerificationEditable/.test(l));
check(!hasEditabilityInWorkflow, 'G2. SET_WORKFLOW disabled does NOT reference editability helpers');

// ============================================================================
// Test H: Workflow transition options preserved
// ============================================================================
console.log('\n--- Test H: Workflow transition options ---');
check(/<option value="PROSES">Proses<\/option>/.test(workspaceSource), 'H1. PROSES workflow option present');
check(/<option value="SELESAI">Selesai<\/option>/.test(workspaceSource), 'H2. SELESAI workflow option present');

// ============================================================================
// Test I: Documentation accuracy
// ============================================================================
console.log('\n--- Test I: Documentation ---');
check(/EDIT-1A/.test(typesSource), 'I1. EDIT-1A reference exists in source');
check(/operational edit domain/.test(typesSource) || /operational edit domains/.test(typesSource),
  'I2. Documentation uses correct "operational edit domain" wording');

// ============================================================================
// Test J: No scattered inline BATAL/HAPUS guards in Workspace lifecycle controls
// ============================================================================
console.log('\n--- Test J: No scattered inline guards in Workspace ---');
const rawTerminalPatterns = workspaceSource.match(/\|\|\s*t\.operational_sheet\s*===\s*['"]BATAL['"]\s*\|\|\s*t\.operational_sheet\s*===\s*['"]HAPUS/g) || [];
check(rawTerminalPatterns.length === 0, 'J1. No raw BATAL||HAPUS chained patterns in Workspace lifecycle controls');

// ============================================================================
// Test K: Tailwind class integrity
// ============================================================================
console.log('\n--- Test K: Tailwind integrity ---');
const malformed = ['text-rightfont', 'text-smtext', 'font-boldborder', 'font-semiboldtext', 'px-4py', 'py-3px', 'flexjustify', 'text-centertext', 'text-slatetext'];
let malformedFound = false;
for (const pat of malformed) {
  if (workspaceSource.includes(pat) || drawerSource.includes(pat)) {
    malformedFound = true;
  }
}
check(!malformedFound, 'K1. No concatenated/malformed Tailwind classes detected');

// ============================================================================
// Summary
// ============================================================================
console.log(`\n=== All ${assertions} Edit-1A Unified Transaction Editability Assertions PASSED ===\n`);
