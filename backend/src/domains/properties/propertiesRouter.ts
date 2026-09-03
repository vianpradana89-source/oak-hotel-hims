import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { seedBaselineStayChargeRules } from '../stayCharges/stayChargeRuleDefaults';

export function createPropertiesRouter(pool: Pool): Router {
  const router = Router();

  // GET /api/properties - List all properties with metadata & room counts
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { all } = req.query;
      const whereClause = all === 'true' ? '' : 'WHERE p.is_active = true';
      
      const query = `
        SELECT 
          p.id,
          p.name,
          p.property_code,
          p.address,
          p.phone,
          p.timezone,
          COALESCE(NULLIF(BTRIM(p.currency), ''), 'IDR') AS currency,
          p.is_active,
          p.created_at,
          p.updated_at,
          COALESCE(r.room_count, 0)::int AS total_rooms,
          COALESCE(rt.type_count, 0)::int AS total_room_types
        FROM properties p
        LEFT JOIN (
          SELECT property_id, COUNT(*) AS room_count 
          FROM rooms 
          GROUP BY property_id
        ) r ON r.property_id = p.id
        LEFT JOIN (
          SELECT property_id, COUNT(*) AS type_count 
          FROM room_types 
          GROUP BY property_id
        ) rt ON rt.property_id = p.id
        ${whereClause}
        ORDER BY p.id ASC
      `;
      const result = await pool.query(query);
      res.json({ status: 'OK', data: result.rows });
    } catch (err: any) {
      console.error('Error fetching properties:', err);
      res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

  // GET /api/properties/:id - Get property details
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT id, name, property_code, address, phone, timezone,
                COALESCE(NULLIF(BTRIM(currency), ''), 'IDR') AS currency,
                is_active, created_at, updated_at
         FROM properties
         WHERE id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ status: 'ERROR', message: 'Properti tidak ditemukan' });
      }
      res.json({ status: 'OK', data: result.rows[0] });
    } catch (err: any) {
      res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

  // POST /api/properties - Create new property with foundational settings
  router.post('/', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const {
        name,
        property_code,
        address = null,
        phone = null,
        timezone = 'Asia/Jakarta',
        currency = 'IDR'
      } = req.body;

      if (!name || !String(name).trim()) {
        return res.status(400).json({ status: 'ERROR', message: 'Nama properti wajib diisi' });
      }
      if (!property_code || !String(property_code).trim()) {
        return res.status(400).json({ status: 'ERROR', message: 'Kode properti wajib diisi' });
      }

      const cleanName = String(name).trim();
      const cleanCode = String(property_code).trim().toUpperCase();
      const cleanCurrency = String(currency || 'IDR').trim().toUpperCase() || 'IDR';

      await client.query('BEGIN');

      // Check duplicate property_code
      const codeCheck = await client.query(
        'SELECT id FROM properties WHERE UPPER(property_code) = UPPER($1)',
        [cleanCode]
      );
      if (codeCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          status: 'ERROR',
          message: `Kode properti '${cleanCode}' sudah digunakan oleh properti lain.`
        });
      }

      // 1. Insert Property
      const safeAddress = address !== undefined && address !== null ? String(address).trim() : '';
      const safePhone = phone !== undefined && phone !== null ? String(phone).trim() : '';

      const propRes = await client.query(
        `INSERT INTO properties (name, property_code, address, phone, timezone, currency, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())
         RETURNING *`,
        [cleanName, cleanCode, safeAddress, safePhone, timezone, cleanCurrency]
      );
      const newProp = propRes.rows[0];
      const newId = newProp.id;

      // 2. Initialize default property brandings
      await client.query(
        `INSERT INTO property_brandings (
          property_id, display_name, short_name, tagline, primary_color,
          accent_color, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 'Hospitality Management System', '#1b4332',
          '#c5a880', NOW(), NOW()
        ) ON CONFLICT (property_id) DO NOTHING`,
        [newId, cleanName, cleanCode]
      );

      // 3. Initialize default property features
      const defaultFeatures = [
        ['front_office.enabled', true],
        ['housekeeping.enabled', true],
        ['pos.enabled', true],
        ['finance.enabled', true],
        ['hrd.enabled', true],
        ['marketing.enabled', true],
        ['housekeeping.room_operations', true],
        ['housekeeping.checkout_inspection', true],
        ['housekeeping.final_inspection', true],
        ['housekeeping.service_requests', true],
        ['housekeeping.department_tasks', true]
      ];
      for (const [featKey, featVal] of defaultFeatures) {
        await client.query(
          `INSERT INTO property_features (property_id, feature_key, enabled, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (property_id, feature_key) DO UPDATE SET enabled = $3, updated_at = NOW()`,
          [newId, featKey, featVal]
        );
      }

      // 4. Initialize default housekeeping settings
      await client.query(
        `INSERT INTO property_housekeeping_settings (
          property_id, require_final_inspection, require_checkout_room_check, allow_calendar_room_status_override,
          created_at, updated_at
        ) VALUES ($1, false, false, false, NOW(), NOW())
        ON CONFLICT (property_id) DO NOTHING`,
        [newId]
      );

      // 5. Initialize default attendance settings
      await client.query(
        `INSERT INTO property_attendance_settings (
          property_id, attendance_enabled, require_employee_attendance, require_checkin_photo, require_checkout_photo,
          geofence_enabled, geofence_radius_meters, outside_geofence_policy, created_at, updated_at
        ) VALUES ($1, true, true, true, false, false, 100, 'ALLOW_WITH_REASON', NOW(), NOW())
        ON CONFLICT (property_id) DO NOTHING`,
        [newId]
      );

      // 6. Initialize default pricing settings
      await client.query(
        `INSERT INTO property_pricing_settings (
          property_id, tax_percent, service_charge_percent, prices_include_tax, prices_include_service, created_at, updated_at
        ) VALUES ($1, 10.00, 0.00, false, false, NOW(), NOW())
        ON CONFLICT (property_id) DO NOTHING`,
        [newId]
      );

      // 7. Initialize property-scoped operational charge defaults.
      await seedBaselineStayChargeRules(client, newId);

      await client.query('COMMIT');
      res.status(201).json({
        status: 'SUCCESS',
        message: `Properti '${cleanName}' (${cleanCode}) berhasil ditambahkan.`,
        data: newProp
      });
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error('Error creating property:', err);
      res.status(500).json({ status: 'ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  // PATCH /api/properties/:id - Update property details
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { name, property_code, address, phone, timezone, currency, is_active } = req.body;

      // Ensure property exists
      const existRes = await pool.query('SELECT * FROM properties WHERE id = $1', [id]);
      if (existRes.rows.length === 0) {
        return res.status(404).json({ status: 'ERROR', message: 'Properti tidak ditemukan' });
      }
      const existing = existRes.rows[0];

      // Check unique code if code changed
      if (property_code && property_code.trim().toUpperCase() !== existing.property_code) {
        const check = await pool.query(
          'SELECT id FROM properties WHERE UPPER(property_code) = UPPER($1) AND id != $2',
          [property_code.trim().toUpperCase(), id]
        );
        if (check.rows.length > 0) {
          return res.status(409).json({
            status: 'ERROR',
            message: `Kode properti '${property_code.toUpperCase()}' sudah digunakan.`
          });
        }
      }

      const updatedName = name !== undefined ? String(name).trim() : existing.name;
      const updatedCode = property_code !== undefined ? String(property_code).trim().toUpperCase() : existing.property_code;
      const updatedAddress = address !== undefined ? (address ? String(address).trim() : null) : existing.address;
      const updatedPhone = phone !== undefined ? (phone ? String(phone).trim() : null) : existing.phone;
      const updatedTimezone = timezone !== undefined ? String(timezone).trim() : existing.timezone;
      const updatedCurrency = currency !== undefined
        ? String(currency || 'IDR').trim().toUpperCase() || 'IDR'
        : existing.currency;
      const updatedIsActive = is_active !== undefined ? Boolean(is_active) : existing.is_active;

      const updateRes = await pool.query(
        `UPDATE properties
         SET name = $1, property_code = $2, address = $3, phone = $4, timezone = $5, currency = $6, is_active = $7, updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [updatedName, updatedCode, updatedAddress, updatedPhone, updatedTimezone, updatedCurrency, updatedIsActive, id]
      );

      res.json({
        status: 'SUCCESS',
        message: 'Informasi properti berhasil diperbarui.',
        data: updateRes.rows[0]
      });
    } catch (err: any) {
      res.status(500).json({ status: 'ERROR', message: err.message });
    }
  });

  // DELETE /api/properties/:id - Delete property safely
  router.delete('/:id', async (req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const propertyId = parseInt(id, 10);

      if (propertyId === 1) {
        return res.status(403).json({
          status: 'ERROR',
          message: 'Properti utama (OAK Lawang) dilindungi dan tidak dapat dihapus.'
        });
      }

      // Check if property has existing bookings or reservations
      const bookingCheck = await client.query(
        'SELECT COUNT(*)::int AS count FROM bookings WHERE property_id = $1',
        [propertyId]
      );
      if (bookingCheck.rows[0].count > 0) {
        return res.status(409).json({
          status: 'ERROR',
          message: 'Properti memiliki riwayat booking/reservasi. Silakan nonaktifkan (is_active = false) daripada menghapus.'
        });
      }

      await client.query('BEGIN');

      // Cascade delete configuration records
      await client.query('DELETE FROM property_brandings WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM property_features WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM property_housekeeping_settings WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM property_attendance_settings WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM property_pricing_settings WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM property_quick_booking_rules WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM property_day_use_durations WHERE property_id = ANY($1)', [[propertyId]]);
      await client.query('DELETE FROM rooms WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM room_types WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM room_categories WHERE property_id = $1', [propertyId]);
      await client.query('DELETE FROM audit_logs WHERE property_id = $1', [propertyId]);

      const delRes = await client.query('DELETE FROM properties WHERE id = $1 RETURNING *', [propertyId]);
      if (delRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'ERROR', message: 'Properti tidak ditemukan' });
      }

      await client.query('COMMIT');
      res.json({
        status: 'SUCCESS',
        message: 'Properti berhasil dihapus.'
      });
    } catch (err: any) {
      await client.query('ROLLBACK');
      res.status(500).json({ status: 'ERROR', message: err.message });
    } finally {
      client.release();
    }
  });

  return router;
}
