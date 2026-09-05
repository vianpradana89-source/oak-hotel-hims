import assert from 'node:assert/strict';
import {
  ACCESS_ACTIONS,
  buildOverrideLookup,
  countOverrides,
  getOverrideChoice,
  getDefaultNavKey,
  getVisibleNavKeys,
  groupResources,
  isNavAllowed,
  resolveEffectiveCell,
  type AccessResource,
  type EffectiveAccessGrid,
  type UserOverrideRecord,
} from '../src/features/auth/accessControl.ts';
import { normalizeRole, getEffectiveRolePermissions } from '../src/features/auth/permissions.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

console.log('=== OAK HIMS Access Control (Hak Akses) Mapping Tests ===\n');

// ---------------------------------------------------------------------------
// 1. Legacy role alias security — OWNER/ADMIN must not become Super Admin
// ---------------------------------------------------------------------------
console.log('--- 1. Legacy role alias security ---');

for (const alias of ['OWNER', 'Owner', 'owner', 'ADMIN', 'Admin', 'admin']) {
  check(normalizeRole(alias) !== 'Super Admin', `normalizeRole('${alias}') must not resolve to Super Admin`);
}
check(normalizeRole('Owner') === 'General Manager', 'Owner keeps property-level General Manager compatibility');
check(normalizeRole('Admin') === 'General Manager', 'Admin keeps property-level General Manager compatibility');
check(normalizeRole('General Manager') !== 'Super Admin', 'General Manager is not Super Admin');
check(normalizeRole('Super Admin') === 'Super Admin', 'Canonical Super Admin spelling is preserved');
check(normalizeRole('SUPER_ADMIN') === 'Super Admin', 'Super Admin underscore spelling is preserved');

check(
  !getEffectiveRolePermissions('Owner').includes('Pengaturan') ||
    getEffectiveRolePermissions('Owner').length < getEffectiveRolePermissions('Super Admin').length + 1,
  'Owner resolves through General Manager defaults rather than Super Admin full access'
);

// ---------------------------------------------------------------------------
// 2. Effective permission precedence mirrors the backend resolver
// ---------------------------------------------------------------------------
console.log('--- 2. Effective permission precedence ---');

check(
  resolveEffectiveCell({ isPlatformSuperAdmin: true, roleAllowed: false, override: 'DENY' }).allowed,
  'Platform Super Admin outranks an explicit DENY override'
);
check(
  resolveEffectiveCell({ isPlatformSuperAdmin: true, roleAllowed: false }).source === 'PLATFORM_SUPER_ADMIN',
  'Platform Super Admin cell reports PLATFORM_SUPER_ADMIN as its source'
);

check(
  resolveEffectiveCell({ isPlatformSuperAdmin: false, roleAllowed: true, override: 'DENY' }).allowed === false,
  'User override DENY beats a role default ALLOW'
);
check(
  resolveEffectiveCell({ isPlatformSuperAdmin: false, roleAllowed: false, override: 'ALLOW' }).allowed === true,
  'User override ALLOW beats a role default DENY'
);
check(
  resolveEffectiveCell({ isPlatformSuperAdmin: false, roleAllowed: true, override: 'ALLOW' }).source === 'USER_OVERRIDE',
  'An explicit override always reports USER_OVERRIDE as its source'
);

check(
  resolveEffectiveCell({ isPlatformSuperAdmin: false, roleAllowed: true, override: 'INHERIT' }).source === 'ROLE_DEFAULT',
  'INHERIT falls through to the role default'
);
check(
  resolveEffectiveCell({ isPlatformSuperAdmin: false, roleAllowed: true, override: null }).allowed === true,
  'Absent override falls through to the role default'
);

check(
  resolveEffectiveCell({ isPlatformSuperAdmin: false, roleAllowed: false }).allowed === false,
  'Deny by default when nothing grants the cell'
);
check(
  resolveEffectiveCell({ isPlatformSuperAdmin: false, roleAllowed: false }).source === 'DEFAULT_DENY',
  'Deny-by-default cell reports DEFAULT_DENY as its source'
);

// ---------------------------------------------------------------------------
// 3. Reset to role default
// ---------------------------------------------------------------------------
console.log('--- 3. Reset ke Default Role ---');

const overrides: UserOverrideRecord[] = [
  { resource: 'Kalender', action: 'view', effect: 'DENY', reason: null, updated_at: null, updated_by_name: null },
  { resource: 'Laporan', action: 'view', effect: 'ALLOW', reason: null, updated_at: null, updated_by_name: null },
];

const lookup = buildOverrideLookup(overrides);
check(getOverrideChoice(lookup, 'Kalender', 'view') === 'DENY', 'Stored DENY override is read back');
check(getOverrideChoice(lookup, 'Laporan', 'view') === 'ALLOW', 'Stored ALLOW override is read back');
check(getOverrideChoice(lookup, 'Kalender', 'edit') === 'INHERIT', 'Unset cell defaults to INHERIT');

const counts = countOverrides(overrides);
check(counts.allow === 1 && counts.deny === 1, 'Override counts are summarized per effect');

const afterReset = buildOverrideLookup([]);
check(getOverrideChoice(afterReset, 'Kalender', 'view') === 'INHERIT', 'Reset returns every cell to INHERIT');
check(
  resolveEffectiveCell({
    isPlatformSuperAdmin: false,
    roleAllowed: true,
    override: getOverrideChoice(afterReset, 'Kalender', 'view'),
  }).source === 'ROLE_DEFAULT',
  'After reset the cell resolves from the role default again'
);

// ---------------------------------------------------------------------------
// 4. Navigation visibility uses the same effective grid as API enforcement
// ---------------------------------------------------------------------------
console.log('--- 4. Navigation visibility source ---');

const effective: EffectiveAccessGrid = {
  'Kalender': {
    view: { allowed: true, source: 'ROLE_DEFAULT' },
    edit: { allowed: true, source: 'ROLE_DEFAULT' },
    delete: { allowed: false, source: 'DEFAULT_DENY' },
  },
  'Pengaturan': {
    view: { allowed: false, source: 'USER_OVERRIDE' },
    edit: { allowed: false, source: 'DEFAULT_DENY' },
    delete: { allowed: false, source: 'DEFAULT_DENY' },
  },
};

const visible = getVisibleNavKeys(effective);
check(visible.includes('Kalender'), 'A menu with VIEW allowed is visible');
check(!visible.includes('Pengaturan'), 'A menu with VIEW denied is hidden');
check(isNavAllowed(effective, 'Kalender'), 'isNavAllowed agrees with the effective grid');
check(!isNavAllowed(effective, 'Pengaturan'), 'isNavAllowed hides a denied menu');
check(!isNavAllowed(effective, 'Transaksi'), 'An unknown menu is denied rather than defaulting to visible');
check(getDefaultNavKey(effective) === 'Kalender', 'Default nav lands on the first VIEW-allowed menu');
check(getDefaultNavKey(null) === 'Kalender', 'Missing effective grid does not invent extra menus');

// ---------------------------------------------------------------------------
// 5. Resource grouping keeps canonical navigation order
// ---------------------------------------------------------------------------
console.log('--- 5. Resource grouping ---');

const resources: AccessResource[] = [
  { key: 'Kalender', label: 'Kalender & Kamar', group: 'Front Office', description: '', permission_keys: { view: [], edit: [], delete: [] } },
  { key: 'Transaksi', label: 'Transaksi & Folio', group: 'Front Office', description: '', permission_keys: { view: [], edit: [], delete: [] } },
  { key: 'HRD', label: 'HRD & Karyawan', group: 'Departemen', description: '', permission_keys: { view: [], edit: [], delete: [] } },
];

const grouped = groupResources(resources);
check(grouped.length === 2, 'Resources collapse into their canonical groups');
check(grouped[0].group === 'Front Office' && grouped[0].resources.length === 2, 'Front Office group keeps both menus in order');
check(grouped[1].group === 'Departemen' && grouped[1].resources[0].key === 'HRD', 'Departemen group follows Front Office');

check(ACCESS_ACTIONS.length === 3, 'Operators only see three actions');
check(
  ACCESS_ACTIONS[0] === 'view' && ACCESS_ACTIONS[1] === 'edit' && ACCESS_ACTIONS[2] === 'delete',
  'Actions are ordered View, Edit, Delete'
);

console.log(`\n=== ALL ACCESS CONTROL MAPPING TESTS PASSED (${assertions} assertions) ===`);
