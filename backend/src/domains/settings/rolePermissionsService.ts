import type { PoolClient } from 'pg';

export interface MenuDefinition {
  key: string;
  label: string;
  group: 'Front Office' | 'Departemen' | 'Manajemen' | 'Operasional';
  description: string;
}

export const AVAILABLE_MENUS: MenuDefinition[] = [
  {
    key: 'Kalender',
    label: 'Kalender & Kamar',
    group: 'Front Office',
    description: 'Visual Tape Chart, ketersediaan kamar harian, dan alur pergerakan tamu.'
  },
  {
    key: 'Transaksi',
    label: 'Transaksi & Folio',
    group: 'Front Office',
    description: 'Billing reservasi, split folio, pelunasan pembayaran, deposit, dan void.'
  },
  {
    key: 'Pelanggan',
    label: 'Tamu / CRM',
    group: 'Front Office',
    description: 'Database profil tamu, riwayat kunjungan, preferensi khusus, dan status VIP.'
  },
  {
    key: 'Housekeeping',
    label: 'Housekeeping Board',
    group: 'Departemen',
    description: 'Status kebersihan kamar, task assignment, checklist inspeksi, dan temuan lost & found.'
  },
  {
    key: 'HRD',
    label: 'HRD & Karyawan',
    group: 'Departemen',
    description: 'Manajemen data staf hotel, absensi GPS, akun login, dan matriks hak akses role.'
  },
  {
    key: 'POS',
    label: 'Kasir POS & Resto',
    group: 'Departemen',
    description: 'Pemesanan makanan & minuman, kasir restoran, dan integrasi bill-to-room.'
  },
  {
    key: 'Master Kamar',
    label: 'Master Kamar',
    group: 'Manajemen',
    description: 'Konfigurasi 9 tipe kamar, 23 kamar fisik, kapasitas ranjang, dan harga dasar.'
  },
  {
    key: 'Master Produk',
    label: 'Master Produk & Menu',
    group: 'Manajemen',
    description: 'Katalog item F&B, harga jual produk restoran, dan kategori menu.'
  },
  {
    key: 'Laporan',
    label: 'Laporan & Okupansi',
    group: 'Manajemen',
    description: 'Laporan tingkat hunian (okupansi), statistik revenue, dan audit harian.'
  },
  {
    key: 'Employee Mobile',
    label: 'Employee Mobile Portal',
    group: 'Operasional',
    description: 'Portal mandiri staf untuk absensi selfie, tugas housekeeping, dan mobile task.'
  },
  {
    key: 'Pengaturan',
    label: 'Pengaturan Properti',
    group: 'Manajemen',
    description: 'Identitas hotel, branding, konfigurasi durasi day use, dan kebijakan properti.'
  }
];

export const SOP_DEFAULT_PERMISSIONS: Record<string, string[]> = {
  'Super Admin': [
    'Kalender',
    'Transaksi',
    'Pelanggan',
    'Housekeeping',
    'HRD',
    'POS',
    'Master Kamar',
    'Master Produk',
    'Laporan',
    'Employee Mobile',
    'Pengaturan'
  ],
  'General Manager': [
    'Kalender',
    'Transaksi',
    'Pelanggan',
    'Housekeeping',
    'HRD',
    'POS',
    'Master Kamar',
    'Master Produk',
    'Laporan',
    'Employee Mobile',
    'Pengaturan'
  ],
  'Front Office': [
    'Kalender',
    'Transaksi',
    'Pelanggan',
    'POS',
    'Employee Mobile'
  ],
  'Housekeeping': [
    'Housekeeping',
    'Employee Mobile'
  ],
  'Accounting': [
    'Transaksi',
    'Laporan'
  ],
  'POS / Resto': [
    'POS',
    'Master Produk'
  ],
  'Crew': [
    'Employee Mobile'
  ]
};

export const STANDARD_ROLE_LIST = [
  'Super Admin',
  'General Manager',
  'Front Office',
  'Housekeeping',
  'Accounting',
  'POS / Resto',
  'Crew'
];

export interface RolePermissionItem {
  role: string;
  permissions: string[];
  is_system_locked?: boolean;
  updated_at?: string;
  updated_by?: string;
}

export interface RolePermissionsMatrixResponse {
  property_id: number;
  roles: RolePermissionItem[];
  available_menus: MenuDefinition[];
}

export async function getRolePermissionsMatrix(
  client: PoolClient,
  propertyId: number
): Promise<RolePermissionsMatrixResponse> {
  const res = await client.query(
    `SELECT role_name, permissions, updated_by, updated_at
     FROM role_permissions
     WHERE property_id = $1`,
    [propertyId]
  );

  const dbMap: Record<string, { permissions: string[]; updated_by?: string; updated_at?: string }> = {};
  for (const row of res.rows) {
    let pList: string[] = [];
    if (Array.isArray(row.permissions)) {
      pList = row.permissions;
    } else if (typeof row.permissions === 'string') {
      try {
        pList = JSON.parse(row.permissions);
      } catch {
        pList = [];
      }
    }
    dbMap[row.role_name] = {
      permissions: pList,
      updated_by: row.updated_by,
      updated_at: row.updated_at
    };
  }

  const allMenusKeys = AVAILABLE_MENUS.map(m => m.key);

  const roles: RolePermissionItem[] = STANDARD_ROLE_LIST.map((roleName) => {
    if (roleName === 'Super Admin') {
      return {
        role: roleName,
        permissions: allMenusKeys,
        is_system_locked: true,
        updated_by: dbMap[roleName]?.updated_by || 'SYSTEM',
        updated_at: dbMap[roleName]?.updated_at
      };
    }

    const custom = dbMap[roleName];
    const defaultPerms = SOP_DEFAULT_PERMISSIONS[roleName] || ['Employee Mobile'];

    return {
      role: roleName,
      permissions: custom ? custom.permissions : defaultPerms,
      is_system_locked: false,
      updated_by: custom?.updated_by || 'SOP_DEFAULT',
      updated_at: custom?.updated_at
    };
  });

  return {
    property_id: propertyId,
    roles,
    available_menus: AVAILABLE_MENUS
  };
}

export async function updateRolePermissionsMatrix(
  client: PoolClient,
  propertyId: number,
  rolesPayload: Array<{ role: string; permissions: string[] }>,
  actor: { id?: number; name?: string; role?: string }
): Promise<RolePermissionsMatrixResponse> {
  const allMenusKeys = new Set(AVAILABLE_MENUS.map(m => m.key));

  for (const item of rolesPayload) {
    const roleName = item.role?.trim();
    if (!roleName) continue;

    // Super Admin cannot have permissions stripped
    if (roleName === 'Super Admin') {
      await client.query(
        `INSERT INTO role_permissions (property_id, role_name, permissions, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (property_id, role_name)
         DO UPDATE SET permissions = $3, updated_by = $4, updated_at = NOW()`,
        [propertyId, roleName, JSON.stringify(Array.from(allMenusKeys)), actor.name || 'Admin']
      );
      continue;
    }

    // Filter valid menu keys
    const validPerms = (Array.isArray(item.permissions) ? item.permissions : [])
      .filter((p: string) => allMenusKeys.has(p));

    await client.query(
      `INSERT INTO role_permissions (property_id, role_name, permissions, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (property_id, role_name)
       DO UPDATE SET permissions = $3, updated_by = $4, updated_at = NOW()`,
      [propertyId, roleName, JSON.stringify(validPerms), actor.name || 'Admin']
    );
  }

  // Audit log
  try {
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'SETTINGS',
        'UPDATE_ROLE_PERMISSIONS_MATRIX',
        'role_permissions',
        String(propertyId),
        JSON.stringify({ updated_roles_count: rolesPayload.length, actor_name: actor.name || 'Admin', timestamp: new Date().toISOString() }),
        `RBAC-UPD-${Date.now()}`,
        propertyId
      ]
    );
  } catch (e: any) {
    console.warn('Audit log write warning:', e.message);
  }

  return getRolePermissionsMatrix(client, propertyId);
}

export async function resetRolePermissionsToDefault(
  client: PoolClient,
  propertyId: number,
  actor: { id?: number; name?: string; role?: string }
): Promise<RolePermissionsMatrixResponse> {
  for (const [roleName, defaultPerms] of Object.entries(SOP_DEFAULT_PERMISSIONS)) {
    await client.query(
      `INSERT INTO role_permissions (property_id, role_name, permissions, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (property_id, role_name)
       DO UPDATE SET permissions = $3, updated_by = $4, updated_at = NOW()`,
      [propertyId, roleName, JSON.stringify(defaultPerms), actor.name || 'Admin (Reset SOP)']
    );
  }

  // Audit log
  try {
    await client.query(
      `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'SETTINGS',
        'RESET_ROLE_PERMISSIONS_TO_SOP',
        'role_permissions',
        String(propertyId),
        JSON.stringify({ action: 'RESET_TO_SOP_DEFAULT', actor_name: actor.name || 'Admin', timestamp: new Date().toISOString() }),
        `RBAC-RST-${Date.now()}`,
        propertyId
      ]
    );
  } catch (e: any) {
    console.warn('Audit log write warning:', e.message);
  }

  return getRolePermissionsMatrix(client, propertyId);
}
