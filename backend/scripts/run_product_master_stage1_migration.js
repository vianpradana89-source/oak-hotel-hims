'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { runProductMasterStage1Migration } = require('../dist/db/migrations/product_master_stage1_v1');

async function main() {
  const pool = new Pool(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT || 5432),
          database: process.env.DB_NAME || 'oak_hotel_db',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
        }
  );

  try {
    await runProductMasterStage1Migration(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[Migration Error]', err);
  process.exit(1);
});
