const { Pool } = require('pg');
const p = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'secretpassword',
  database: process.env.DB_NAME || 'oak_hotel_db',
});

(async () => {
  try {
    // 1. All properties
    const all = await p.query('SELECT id, property_code, name, is_active FROM properties ORDER BY id');
    console.log('=== ALL PROPERTIES ===');
    console.log(JSON.stringify(all.rows, null, 2));
    console.log('Count:', all.rows.length);

    // 2. OAK Lawang specific
    const lwg = await p.query("SELECT id, property_code, name, is_active FROM properties WHERE property_code = 'LWG'");
    console.log('\n=== OAK LAWANG ===');
    console.log(JSON.stringify(lwg.rows, null, 2));

    // 3. Check if is_active column exists and its value
    const activeCheck = await p.query("SELECT id, property_code, name, is_active FROM properties");
    console.log('\n=== IS_ACTIVE CHECK ===');
    for (const row of activeCheck.rows) {
      console.log(`  id=${row.id}, code=${row.property_code}, name=${row.name}, is_active=${row.is_active} (type=${typeof row.is_active})`);
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await p.end();
  }
})();
