const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const moment = require('moment');
const { exec } = require('child_process');
const { promisify } = require('util');
const { getPool } = require('../database');

const execAsync = promisify(exec);
const mkdir = promisify(fs.mkdir);
const rmdir = promisify(fs.rmdir);

const BACKUP_DIR = path.join(__dirname, '../../backups');
const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Find mysqldump executable
function findMySQLDump() {
  // Get project root by going up from src/services/backupService.js
  const projectRoot = path.resolve(__dirname, '../../..');
  
  // Check for bundled MariaDB in various locations
  const bundledPaths = [
    // From workshop-app/backend
    path.join(projectRoot, 'electron-app/bundled/mariadb/bin/mysqldump.exe'),
    // From electron-app/bundled/backend
    path.join(projectRoot, 'mariadb/bin/mysqldump.exe'),
    // From electron-app/dist structure
    path.join(projectRoot, 'resources/bundled/mariadb/bin/mysqldump.exe'),
    // Absolute paths in case of other setups
    'D:\\Project Laxman\\workshop-complete\\electron-app\\bundled\\mariadb\\bin\\mysqldump.exe',
    'C:\\Program Files\\MariaDB\\bin\\mysqldump.exe',
  ];

  for (const p of bundledPaths) {
    if (fs.existsSync(p)) {
      console.log('✅ Using bundled mysqldump:', p);
      return p;
    }
  }

  // Fall back to system PATH
  console.log('ℹ️ Using system mysqldump');
  return 'mysqldump';
}

// Find mysql executable
function findMySQL() {
  // Get project root by going up from src/services/backupService.js
  const projectRoot = path.resolve(__dirname, '../../..');
  
  // Check for bundled MariaDB in various locations
  const bundledPaths = [
    // From workshop-app/backend
    path.join(projectRoot, 'electron-app/bundled/mariadb/bin/mysql.exe'),
    // From electron-app/bundled/backend
    path.join(projectRoot, 'mariadb/bin/mysql.exe'),
    // From electron-app/dist structure
    path.join(projectRoot, 'resources/bundled/mariadb/bin/mysql.exe'),
    // Absolute paths in case of other setups
    'D:\\Project Laxman\\workshop-complete\\electron-app\\bundled\\mariadb\\bin\\mysql.exe',
    'C:\\Program Files\\MariaDB\\bin\\mysql.exe',
  ];

  for (const p of bundledPaths) {
    if (fs.existsSync(p)) {
      console.log('✅ Using bundled mysql:', p);
      return p;
    }
  }

  // Fall back to system PATH
  console.log('ℹ️ Using system mysql');
  return 'mysql';
}

async function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    await mkdir(BACKUP_DIR, { recursive: true });
  }
}

async function dumpDatabase(outputFile) {
  try {
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || 3306;
    const dbUser = process.env.DB_USER || 'root';
    const dbPassword = process.env.DB_PASSWORD || '';
    const dbName = process.env.DB_NAME || 'workshop_manager';

    const mysqldumpPath = findMySQLDump();
    let cmd = `"${mysqldumpPath}" -h ${dbHost} -P ${dbPort} -u ${dbUser}`;
    
    if (dbPassword) {
      cmd += ` -p${dbPassword}`;
    }
    
    cmd += ` --single-transaction --quick --lock-tables=false ${dbName} > "${outputFile}"`;

    console.log('📊 Creating database dump...');
    await execAsync(cmd, { maxBuffer: 1024 * 1024 * 100 }); // 100MB buffer
    console.log('✅ Database dump created');

    return outputFile;
  } catch (err) {
    console.error('❌ Database dump error:', err.message);
    throw new Error('Failed to dump database: ' + err.message);
  }
}

async function createBackup(backupName = null) {
  try {
    await ensureBackupDir();

    const timestamp = moment().format('YYYY-MM-DD-HHmm');
    const backupFolderName = backupName || `backup-${timestamp}`;
    const backupFolder = path.join(BACKUP_DIR, backupFolderName);
    const backupZip = path.join(BACKUP_DIR, `${backupFolderName}.zip`);

    // Create backup folder
    if (!fs.existsSync(backupFolder)) {
      await mkdir(backupFolder, { recursive: true });
    }

    // 1. Dump database
    const dbDumpPath = path.join(backupFolder, 'database.sql');
    await dumpDatabase(dbDumpPath);

    // 2. Create metadata
    const metadata = {
      backupName: backupFolderName,
      timestamp: new Date().toISOString(),
      dbVersion: process.env.DB_NAME || 'workshop_manager',
      filesIncluded: fs.existsSync(UPLOADS_DIR),
      version: '2.0.0',
    };

    fs.writeFileSync(
      path.join(backupFolder, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    // 3. Copy upload files if exist
    if (fs.existsSync(UPLOADS_DIR)) {
      const filesFolder = path.join(backupFolder, 'files');
      await mkdir(filesFolder, { recursive: true });
      
      const copy = (src, dest) => {
        if (fs.statSync(src).isDirectory()) {
          // Ensure destination directory exists
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
          }
          fs.readdirSync(src).forEach(file => {
            copy(path.join(src, file), path.join(dest, file));
          });
        } else {
          // Ensure destination directory exists before copying file
          const destDir = path.dirname(dest);
          if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
          }
          fs.copyFileSync(src, dest);
        }
      };

      copy(UPLOADS_DIR, filesFolder);
      console.log('📁 Files copied');
    }

    // 4. Create zip file
    console.log('📦 Creating backup archive...');
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(backupZip);
      const archive = archiver('zip', { zlib: { level: 6 } });

      archive.on('error', reject);
      output.on('close', resolve);

      archive.directory(backupFolder, false);
      archive.finalize();
      archive.pipe(output);
    });

    console.log(`✅ Backup created: ${backupZip}`);

    // Cleanup backup folder
    fs.rmSync(backupFolder, { recursive: true, force: true });

    const sizeInMB = Math.round(fs.statSync(backupZip).size / 1024 / 1024);

    return {
      name: backupFolderName,
      path: backupZip,
      size: sizeInMB,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error('❌ Backup creation failed:', err.message);
    throw err;
  }
}

async function restoreBackup(zipPath) {
  try {
    await ensureBackupDir();

    const extractFolder = path.join(BACKUP_DIR, `restore-${moment().format('YYYYMMDDHHmmss')}`);
    await mkdir(extractFolder, { recursive: true });

    console.log('📦 Extracting backup...');
    
    // Extract zip
    const unzipper = require('unzipper');
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: extractFolder }))
        .on('close', resolve)
        .on('error', reject);
    });

    console.log('✅ Backup extracted');

    // 1. Restore database
    const dbDumpPath = path.join(extractFolder, 'database.sql');
    if (fs.existsSync(dbDumpPath)) {
      console.log('📊 Restoring database...');
      
      const dbHost = process.env.DB_HOST || 'localhost';
      const dbPort = process.env.DB_PORT || 3306;
      const dbUser = process.env.DB_USER || 'root';
      const dbPassword = process.env.DB_PASSWORD || '';
      const dbName = process.env.DB_NAME || 'workshop_manager';

      const mysqlPath = findMySQL();
      let cmd = `"${mysqlPath}" -h ${dbHost} -P ${dbPort} -u ${dbUser}`;
      
      if (dbPassword) {
        cmd += ` -p${dbPassword}`;
      }
      
      cmd += ` ${dbName} < "${dbDumpPath}"`;

      await execAsync(cmd);
      console.log('✅ Database restored');
    }

    // 2. Restore files
    const filesFolder = path.join(extractFolder, 'files');
    if (fs.existsSync(filesFolder)) {
      console.log('📁 Restoring files...');
      
      // Backup existing uploads
      if (fs.existsSync(UPLOADS_DIR)) {
        const backupUploads = UPLOADS_DIR + '.backup-' + moment().format('YYYYMMDDHHmmss');
        fs.renameSync(UPLOADS_DIR, backupUploads);
        console.log(`⚠️ Old files backed up to: ${backupUploads}`);
      }

      // Copy restored files
      const copy = (src, dest) => {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach(file => {
          const srcPath = path.join(src, file);
          const destPath = path.join(dest, file);
          if (fs.statSync(srcPath).isDirectory()) {
            copy(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        });
      };

      copy(filesFolder, UPLOADS_DIR);
      console.log('✅ Files restored');
    }

    // Cleanup
    fs.rmSync(extractFolder, { recursive: true, force: true });

    return {
      success: true,
      message: 'Backup restored successfully',
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error('❌ Restore failed:', err.message);
    throw new Error('Failed to restore backup: ' + err.message);
  }
}

async function getBackupStatus() {
  try {
    await ensureBackupDir();

    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.zip'));
    
    if (files.length === 0) {
      return { lastBackup: null, backupCount: 0 };
    }

    const sorted = files.sort().reverse();
    const latestFile = sorted[0];
    const latestPath = path.join(BACKUP_DIR, latestFile);
    const stat = fs.statSync(latestPath);

    return {
      lastBackup: {
        name: latestFile,
        timestamp: stat.mtime,
        size: Math.round(stat.size / 1024 / 1024),
      },
      backupCount: files.length,
    };
  } catch (err) {
    console.error('Error getting backup status:', err.message);
    return { lastBackup: null, backupCount: 0 };
  }
}

module.exports = {
  createBackup,
  restoreBackup,
  getBackupStatus,
  BACKUP_DIR,
};
