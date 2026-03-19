/**
 * Manual SQL to fix existing image URLs in task_images table
 * 
 * These URLs should be fixed from:
 * https://res.cloudinary.com/CLOUD/image/upload/vXXXXXXXX/workshop/task-images/ABC123.jpg
 * 
 * To just the public_id:
 * workshop/task-images/ABC123
 * 
 * ============ RUN THIS DIRECTLY IN DATABASE ============
 * 
 * -- Check how many have bad URLs:
 * SELECT COUNT(*) FROM task_images WHERE image_path LIKE 'https://%';
 * 
 * -- Fix: Extract public_id from Cloudinary URL
 * UPDATE task_images 
 * SET image_path = SUBSTRING_INDEX(
 *   SUBSTRING_INDEX(image_path, '/upload/v', -1),  -- Everything after "/upload/v"
 *   '/',
 *   -COUNT(CHAR_LENGTH(SUBSTRING_INDEX(image_path, '/', -1)))  -- Remove version number
 * )
 * WHERE image_path LIKE 'https://%';
 * 
 * -- BETTER APPROACH (simpler):
 * UPDATE task_images 
 * SET image_path = SUBSTRING(
 *   image_path, 
 *   LOCATE('workshop/', image_path),
 *   LENGTH(image_path)
 * )
 * WHERE image_path LIKE 'https://%' AND LOCATE('workshop/', image_path) > 0;
 * 
 * -- Verify the fix:
 * SELECT id, LEFT(image_path, 50) as path FROM task_images LIMIT 5;
 * 
 * ========================================================
 * 
 * Frontend will handle both old (full URL) and new (public_id) formats automatically.
 */

// If you want to run this programmatically:
require('dotenv').config();
const mysql = require('mysql2/promise');

async function cleanupImageUrls() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 1,
    queueLimit: 0
  });

  try {
    const conn = await pool.getConnection();
    
    console.log('🔍 Finding image records with full URLs...');
    const [[{ count }]] = await conn.query(
      "SELECT COUNT(*) as count FROM task_images WHERE image_path LIKE 'https://%'"
    );
    
    console.log(`Found ${count} records with full Cloudinary URLs`);
    
    if (count === 0) {
      console.log('✅ No cleanup needed! All records are clean.');
      conn.release();
      pool.end();
      return;
    }
    
    console.log('\n📝 Converting full URLs to public_id format...');
    
    // This UPDATE extracts just the public_id from the full URL
    // FROM: https://res.cloudinary.com/CLOUD/image/upload/v1773904322/workshop/task-images/abc123.jpg
    // TO:   workshop/task-images/abc123
    const result = await conn.query(`
      UPDATE task_images 
      SET image_path = SUBSTRING(
        image_path, 
        LOCATE('workshop/', image_path),
        LENGTH(image_path) - LOCATE('workshop/', image_path)
      )
      WHERE image_path LIKE 'https://%' AND LOCATE('workshop/', image_path) > 0
    `);
    
    console.log(`✅ Updated ${result[0].changedRows} records`);
    
    // Verify
    const [[{ remaining }]] = await conn.query(
      `SELECT COUNT(*) as remaining FROM task_images WHERE image_path LIKE 'https://%'`
    );
    
    if (remaining === 0) {
      console.log('✅ Database cleanup complete! All URLs are now clean.');
    } else {
      console.log(`⚠️ ${remaining} records still have full URLs (not matching workshop/ pattern)`);
    }
    
    conn.release();
    pool.end();
  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
    pool.end();
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  cleanupImageUrls();
}

