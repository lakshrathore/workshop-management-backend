/**
 * Clean up image URLs in task_images table
 * Converts full Cloudinary URLs to just public IDs
 * 
 * Examples:
 * From: https://res.cloudinary.com/CLOUD/image/upload/v1773904322/workshop/task-images/abc123.jpg
 * To:   workshop/task-images/abc123
 * 
 * Run with: node scripts/cleanup-image-urls.js
 */

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
    
    console.log('🔍 Analyzing image_path data...\n');
    
    // Count how many have full URLs
    const [[{ fullUrlCount }]] = await conn.query(
      "SELECT COUNT(*) as fullUrlCount FROM task_images WHERE image_path LIKE 'https://%' OR image_path LIKE 'http://%'"
    );
    
    // Count how many have public_id only
    const [[{ publicIdCount }]] = await conn.query(
      "SELECT COUNT(*) as publicIdCount FROM task_images WHERE image_path NOT LIKE 'https://%' AND image_path NOT LIKE 'http://%' AND image_path IS NOT NULL AND image_path != ''"
    );
    
    // Count empty ones
    const [[{ emptyCount }]] = await conn.query(
      "SELECT COUNT(*) as emptyCount FROM task_images WHERE image_path IS NULL OR image_path = ''"
    );
    
    console.log('📊 Current database state:');
    console.log(`  ✅ Public IDs (correct):   ${publicIdCount}`);
    console.log(`  ❌ Full URLs (need fix):    ${fullUrlCount}`);
    console.log(`  ⚠️  Empty paths:            ${emptyCount}`);
    console.log(`  📦 Total images:            ${publicIdCount + fullUrlCount + emptyCount}\n`);
    
    if (fullUrlCount === 0) {
      console.log('✅ No cleanup needed! All records are clean.');
      conn.release();
      pool.end();
      return;
    }
    
    console.log(`🔄 Converting ${fullUrlCount} full URLs to public_id format...\n`);
    
    // Show sample bad records
    const [badSamples] = await conn.query(
      "SELECT id, image_path FROM task_images WHERE image_path LIKE 'https://%' OR image_path LIKE 'http://%' LIMIT 3"
    );
    
    if (badSamples.length > 0) {
      console.log('📋 Sample URLs to convert:');
      badSamples.forEach(r => {
        console.log(`  [ID ${r.id}] ${r.image_path.substring(0, 120)}...`);
      });
      console.log('');
    }
    
    // Update URLs that contain workshop/
    const [result1] = await conn.query(`
      UPDATE task_images 
      SET image_path = SUBSTRING(
        image_path, 
        LOCATE('workshop/', image_path),
        CHAR_LENGTH(image_path)
      )
      WHERE (image_path LIKE 'https://%' OR image_path LIKE 'http://%')
      AND LOCATE('workshop/', image_path) > 0
    `);
    
    console.log(`✅ Fixed ${result1.changedRows} URLs containing 'workshop/'`);
    
    // Verify results
    const [[{ remaining }]] = await conn.query(
      `SELECT COUNT(*) as remaining FROM task_images WHERE image_path LIKE 'https://%' OR image_path LIKE 'http://%'`
    );
    
    if (remaining > 0) {
      console.log(`\n⚠️  ${remaining} URLs still remain (don't contain 'workshop/' path)\n`);
      const [remaining_samples] = await conn.query(
        "SELECT id, image_path FROM task_images WHERE image_path LIKE 'https://%' OR image_path LIKE 'http://%' LIMIT 3"
      );
      console.log('Remaining problematic URLs:');
      remaining_samples.forEach(r => {
        console.log(`  [ID ${r.id}] ${r.image_path.substring(0, 120)}`);
      });
    } else {
      console.log('\n✅ All URLs successfully converted to public_id format!');
    }
    
    conn.release();
    pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

cleanupImageUrls();
