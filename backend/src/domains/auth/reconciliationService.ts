// backend/src/domains/auth/reconciliationService.ts

export type ReconciliationCategory =
  | 'MATCHED_UNIQUE'
  | 'EMPLOYEE_WITHOUT_USER'
  | 'USER_WITHOUT_EMPLOYEE'
  | 'DUPLICATE_EMAIL'
  | 'DUPLICATE_USERNAME'
  | 'AMBIGUOUS_MATCH'
  | 'PROPERTY_MISMATCH'
  | 'ROLE_MISMATCH'
  | 'INACTIVE_EMPLOYEE_ACTIVE_USER'
  | 'INVALID_PASSWORD_STATE';

export interface RawEmployeeRow {
  id: number;
  property_id: number;
  employee_code: string;
  full_name: string;
  email?: string | null;
  username?: string | null;
  role?: string | null;
  is_active: boolean;
  status: string;
}

export interface RawUserRow {
  id: number;
  property_id: number;
  employee_id?: number | null;
  username: string;
  email: string;
  role_id: number;
  role_name?: string | null;
  full_name: string;
  is_active: boolean;
  password_hash?: string | null;
  google_sub?: string | null;
  local_password_enabled?: boolean;
}

export interface ReconciliationResult {
  category: ReconciliationCategory;
  employee_id?: number;
  user_id?: number;
  details: string;
  is_auto_linkable: boolean;
}

/**
 * Classifies existing employee and user records into authoritative reconciliation categories.
 * Completely read-only and safe.
 */
export function classifyAccounts(
  employees: RawEmployeeRow[],
  users: RawUserRow[]
): ReconciliationResult[] {
  const results: ReconciliationResult[] = [];

  // 1. Detect Duplicate Emails in users
  const userEmails = new Map<string, RawUserRow[]>();
  const userUsernames = new Map<string, RawUserRow[]>();
  for (const u of users) {
    const em = (u.email || '').trim().toLowerCase();
    if (em) {
      const list = userEmails.get(em) || [];
      list.push(u);
      userEmails.set(em, list);
    }
    const un = (u.username || '').trim().toLowerCase();
    if (un) {
      const list = userUsernames.get(un) || [];
      list.push(u);
      userUsernames.set(un, list);
    }
  }

  for (const [em, list] of userEmails.entries()) {
    if (list.length > 1) {
      for (const u of list) {
        results.push({
          category: 'DUPLICATE_EMAIL',
          user_id: u.id,
          details: `Email '${em}' digunakan oleh ${list.length} akun pengguna berbeda (IDs: ${list.map(x => x.id).join(', ')}).`,
          is_auto_linkable: false
        });
      }
    }
  }

  for (const [un, list] of userUsernames.entries()) {
    if (list.length > 1) {
      for (const u of list) {
        results.push({
          category: 'DUPLICATE_USERNAME',
          user_id: u.id,
          details: `Username '${un}' digunakan oleh ${list.length} akun pengguna berbeda (IDs: ${list.map(x => x.id).join(', ')}).`,
          is_auto_linkable: false
        });
      }
    }
  }

  // 2. Map & Classify Employees
  for (const emp of employees) {
    const empEmail = (emp.email || '').trim().toLowerCase();
    const empUsername = (emp.username || '').trim().toLowerCase();

    // Find candidate users by email or username
    const candidates = users.filter(u => {
      const uEmail = (u.email || '').trim().toLowerCase();
      const uUsername = (u.username || '').trim().toLowerCase();
      return (empEmail && uEmail === empEmail) || (empUsername && uUsername === empUsername) || (u.employee_id === emp.id);
    });

    if (candidates.length === 0) {
      results.push({
        category: 'EMPLOYEE_WITHOUT_USER',
        employee_id: emp.id,
        details: `Karyawan ${emp.full_name} (${emp.employee_code}) belum memiliki akun user login.`,
        is_auto_linkable: false
      });
      continue;
    }

    if (candidates.length > 1) {
      results.push({
        category: 'AMBIGUOUS_MATCH',
        employee_id: emp.id,
        details: `Karyawan ${emp.full_name} cocok dengan beberapa akun user login (IDs: ${candidates.map(c => c.id).join(', ')}).`,
        is_auto_linkable: false
      });
      continue;
    }

    const matchedUser = candidates[0];

    // Check INACTIVE_EMPLOYEE_ACTIVE_USER (CRITICAL SECURITY)
    if ((!emp.is_active || emp.status !== 'ACTIVE') && matchedUser.is_active) {
      results.push({
        category: 'INACTIVE_EMPLOYEE_ACTIVE_USER',
        employee_id: emp.id,
        user_id: matchedUser.id,
        details: `BAHAYA KEAMANAN: Karyawan ${emp.full_name} telah nonaktif di HR (${emp.status}), namun user ID ${matchedUser.id} masih AKTIF dapat login.`,
        is_auto_linkable: false
      });
      continue;
    }

    // Check Property Mismatch
    if (emp.property_id !== matchedUser.property_id) {
      results.push({
        category: 'PROPERTY_MISMATCH',
        employee_id: emp.id,
        user_id: matchedUser.id,
        details: `Property ID tidak cocok: Karyawan di properti ${emp.property_id}, sedangkan user di properti ${matchedUser.property_id}.`,
        is_auto_linkable: false
      });
      continue;
    }

    // Check Password State
    if (!matchedUser.password_hash && matchedUser.local_password_enabled !== false && !matchedUser.google_sub) {
      results.push({
        category: 'INVALID_PASSWORD_STATE',
        employee_id: emp.id,
        user_id: matchedUser.id,
        details: `User ID ${matchedUser.id} tidak memiliki password hash dan belum terhubung ke Google.`,
        is_auto_linkable: false
      });
      continue;
    }

    // Check Role Mismatch
    const hrRole = (emp.role || '').trim().toLowerCase();
    const userRole = (matchedUser.role_name || '').trim().toLowerCase();
    if (hrRole && userRole && hrRole !== userRole && !hrRole.includes(userRole) && !userRole.includes(hrRole)) {
      results.push({
        category: 'ROLE_MISMATCH',
        employee_id: emp.id,
        user_id: matchedUser.id,
        details: `Role tidak sinkron: HR role '${emp.role}', sedangkan Auth role '${matchedUser.role_name}'.`,
        is_auto_linkable: false
      });
      continue;
    }

    // Unambiguous 1:1 Match
    results.push({
      category: 'MATCHED_UNIQUE',
      employee_id: emp.id,
      user_id: matchedUser.id,
      details: `Karyawan ${emp.full_name} cocok secara unik 1:1 dengan user login ID ${matchedUser.id}.`,
      is_auto_linkable: true
    });
  }

  // 3. Find Users Without Employee
  for (const u of users) {
    // If user has no employee_id and matched no employee
    const matchedEmp = employees.find(e => {
      const eEmail = (e.email || '').trim().toLowerCase();
      const eUsername = (e.username || '').trim().toLowerCase();
      const uEmail = (u.email || '').trim().toLowerCase();
      const uUsername = (u.username || '').trim().toLowerCase();
      return u.employee_id === e.id || (eEmail && eEmail === uEmail) || (eUsername && eUsername === uUsername);
    });

    if (!matchedEmp) {
      // Super Admin / Platform accounts may legitimately have no employee
      results.push({
        category: 'USER_WITHOUT_EMPLOYEE',
        user_id: u.id,
        details: `Akun login ${u.username} (${u.email}) tidak memiliki relasi ke data karyawan HR manapun.`,
        is_auto_linkable: false
      });
    }
  }

  return results;
}
