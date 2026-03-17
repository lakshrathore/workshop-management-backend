const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Service Account credentials (will be loaded from env or file)
let driveClient = null;

function initializeGoogleDrive() {
  try {
    const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || path.join(__dirname, '../../service-account-key.json');
    
    if (!fs.existsSync(keyPath)) {
      console.warn('⚠️ Service account key not found at:', keyPath);
      return null;
    }

    const keyFile = require(keyPath);
    const auth = new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    driveClient = google.drive({ version: 'v3', auth });
    console.log('✅ Google Drive initialized');
    return driveClient;
  } catch (err) {
    console.error('❌ Failed to initialize Google Drive:', err.message);
    return null;
  }
}

async function ensureBackupFolder() {
  if (!driveClient) initializeGoogleDrive();
  if (!driveClient) throw new Error('Google Drive not initialized');

  try {
    const query = "name='Workshop Manager Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    const response = await driveClient.files.list({
      q: query,
      spaces: 'drive',
      pageSize: 1,
      fields: 'files(id, name)',
    });

    if (response.data.files.length > 0) {
      return response.data.files[0].id;
    }

    // Create folder if not exists
    const folderResponse = await driveClient.files.create({
      resource: {
        name: 'Workshop Manager Backups',
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });

    return folderResponse.data.id;
  } catch (err) {
    console.error('Error ensuring backup folder:', err.message);
    throw err;
  }
}

async function uploadBackupFile(filePath, fileName, folderName = 'auto-backups') {
  if (!driveClient) initializeGoogleDrive();
  if (!driveClient) throw new Error('Google Drive not initialized');

  try {
    const parentFolderId = await ensureBackupFolder();

    // Create subfolder if needed
    const subfolderQuery = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`;
    const subfolderResponse = await driveClient.files.list({
      q: subfolderQuery,
      spaces: 'drive',
      pageSize: 1,
      fields: 'files(id)',
    });

    let subfolderId;
    if (subfolderResponse.data.files.length > 0) {
      subfolderId = subfolderResponse.data.files[0].id;
    } else {
      const newFolder = await driveClient.files.create({
        resource: {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentFolderId],
        },
        fields: 'id',
      });
      subfolderId = newFolder.data.id;
    }

    // Upload file
    const fileMetadata = {
      name: fileName,
      parents: [subfolderId],
    };

    const media = {
      mimeType: 'application/zip',
      body: fs.createReadStream(filePath),
    };

    const response = await driveClient.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, size',
    });

    console.log(`✅ Backup uploaded: ${fileName}`);
    return {
      id: response.data.id,
      name: fileName,
      link: response.data.webViewLink,
      size: response.data.size,
    };
  } catch (err) {
    console.error('Error uploading backup:', err.message);
    throw err;
  }
}

async function listBackups(folderName = null) {
  if (!driveClient) initializeGoogleDrive();
  if (!driveClient) throw new Error('Google Drive not initialized');

  try {
    const parentFolderId = await ensureBackupFolder();
    
    let query = `'${parentFolderId}' in parents and trashed=false and mimeType='application/zip'`;
    
    if (folderName) {
      const subfolderQuery = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`;
      const subfolderResponse = await driveClient.files.list({
        q: subfolderQuery,
        spaces: 'drive',
        pageSize: 1,
        fields: 'files(id)',
      });
      
      if (subfolderResponse.data.files.length > 0) {
        query = `'${subfolderResponse.data.files[0].id}' in parents and trashed=false and mimeType='application/zip'`;
      }
    }

    const response = await driveClient.files.list({
      q: query,
      spaces: 'drive',
      pageSize: 50,
      fields: 'files(id, name, createdTime, size, webViewLink)',
      orderBy: 'createdTime desc',
    });

    return response.data.files.map(f => ({
      id: f.id,
      name: f.name,
      createdTime: f.createdTime,
      size: Math.round(f.size / 1024 / 1024), // MB
      link: f.webViewLink,
    }));
  } catch (err) {
    console.error('Error listing backups:', err.message);
    throw err;
  }
}

async function downloadBackupFile(fileId, outputPath) {
  if (!driveClient) initializeGoogleDrive();
  if (!driveClient) throw new Error('Google Drive not initialized');

  try {
    const dest = fs.createWriteStream(outputPath);

    const response = await driveClient.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      response.data
        .on('end', () => {
          console.log(`✅ Download complete: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', err => {
          console.error('Download error:', err);
          reject(err);
        })
        .pipe(dest);
    });
  } catch (err) {
    console.error('Error downloading backup:', err.message);
    throw err;
  }
}

async function deleteBackupFile(fileId) {
  if (!driveClient) initializeGoogleDrive();
  if (!driveClient) throw new Error('Google Drive not initialized');

  try {
    await driveClient.files.delete({ fileId });
    console.log(`✅ Deleted backup: ${fileId}`);
  } catch (err) {
    console.error('Error deleting backup:', err.message);
    throw err;
  }
}

module.exports = {
  initializeGoogleDrive,
  ensureBackupFolder,
  uploadBackupFile,
  listBackups,
  downloadBackupFile,
  deleteBackupFile,
};
