'use strict';

const { generateToken } = require('../../dist/domains/auth/authService');

async function getPlatformSuperAdminToken(pool, propertyId = 1) {
  const saRes = await pool.query(`
    SELECT u.id, u.username, u.full_name, u.email, u.property_id, r.id AS role_id, r.name AS role
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name = 'Super Admin'
      AND r.property_id IS NULL
      AND r.is_system_role = TRUE
    LIMIT 1
  `);
  if (saRes.rows.length === 0) {
    throw new Error('Platform Super Admin not found in DB.');
  }
  const row = saRes.rows[0];
  return generateToken({
    id: Number(row.id),
    email: row.email || 'sa@oak.test',
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    role_id: Number(row.role_id),
    property_id: Number(propertyId || row.property_id || 1),
    scope: 'FULL',
    access_type: 'PMS_STAFF',
  });
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function staffToken(propertyId, id = 900040) {
  return generateToken({
    id,
    email: `sales3c1${id}@oak.test`,
    username: `sales3c1${id}`,
    full_name: 'Sales Staff',
    role: 'Front Office',
    role_id: 3,
    property_id: propertyId,
    scope: 'FULL',
    access_type: 'PMS_STAFF',
  });
}

module.exports = {
  getPlatformSuperAdminToken,
  authHeaders,
  staffToken,
};
