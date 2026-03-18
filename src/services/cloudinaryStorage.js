const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Task images uploader (max 10MB)
const imgUpload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'workshop/task-images',
      allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Department gallery uploader (images + docs, max 50MB)
const galleryUpload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      const isImage = /\.(png|jpg|jpeg|gif)$/i.test(file.originalname);
      return {
        folder: 'workshop/department-gallery',
        resource_type: isImage ? 'image' : 'raw',
        allowed_formats: ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'xlsx', 'xls', 'docx', 'doc'],
      };
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpg|jpeg|gif|pdf|xlsx|xls|docx|doc)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('File type na chalega'), false);
  },
});

// License screenshot uploader (max 5MB)
const licenseUpload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'workshop/license-screenshots',
      allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Delete file from Cloudinary by public_id
async function deleteFile(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId);
    console.log('🗑️ Cloudinary file deleted:', publicId);
  } catch (err) {
    console.error('⚠️ Cloudinary delete failed:', err.message);
  }
}

// Get full URL from public_id
function getFileUrl(publicId) {
  return cloudinary.url(publicId);
}

module.exports = { imgUpload, galleryUpload, licenseUpload, getFileUrl, deleteFile };
