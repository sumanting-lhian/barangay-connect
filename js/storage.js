// js/storage.js
// =====================================================
// Handles all Firebase Storage uploads for the project.
// Import this in any file that needs image uploading.
// =====================================================

import { storage } from './firebase-config.js';
import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";


// =====================================================
// FOLDER STRUCTURE
// Keep these consistent across the whole project.
//
// Firebase Storage layout:
//   id-photos/{uid}/front.webp
//   id-photos/{uid}/back.webp
//   reports/{uid}/{reportId}.webp
//   announcements/{announcementId}.webp
//   posts/{uid}/{postId}.webp
//   avatars/{uid}.webp
// =====================================================
export const FOLDERS = {
  idPhotos:      'id-photos',
  reports:       'reports',
  announcements: 'announcements',
  posts:         'posts',
  avatars:       'avatars',
};

// =====================================================
// compressImage(file, maxWidthPx, qualityPercent)
//
// Shrinks and compresses an image client-side before
// uploading. Uses a canvas to resize, then converts
// to WebP for smallest file size.
//
// Returns a Blob (treat it like a File for uploading).
//
// Defaults:
//   maxWidth  = 1200px  
//   quality   = 0.82    
// =====================================================
export function compressImage(file, maxWidth = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url); // cleanup memory

      // Calculate new dimensions keeping aspect ratio
      let width  = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width  = maxWidth;
      }

      // Draw onto canvas
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Export as WebP
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Image compression failed.'));
            return;
          }
          resolve(blob);
        },
        'image/webp',
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image for compression.'));
    };

    img.src = url;
  });
}


// =====================================================
// uploadImage(file, storagePath)
//
// Compresses then uploads a single image to Firebase
// Storage. Returns the public download URL.
//
// storagePath — full path inside your Storage bucket
//   e.g. "id-photos/uid123/front.webp"
//
// Usage:
//   const url = await uploadImage(file, `${FOLDERS.idPhotos}/${uid}/front.webp`);
// =====================================================
export async function uploadImage(file, storagePath) {
  if (!file)        throw new Error('No file provided.');
  if (!storagePath) throw new Error('No storage path provided.');

  validateImageFile(file);

  // Compress before uploading
  const compressed = await compressImage(file);

  // Upload to Firebase Storage
  const storageRef = ref(storage, storagePath);
  const snapshot   = await uploadBytes(storageRef, compressed, {
    contentType: 'image/webp',
    // Custom metadata — useful for admin tools and debugging
    customMetadata: {
      originalName: file.name,
      uploadedAt:   new Date().toISOString(),
    },
  });

  // Return the public download URL
  return await getDownloadURL(snapshot.ref);
}


// =====================================================
// uploadIdPhotos(uid, frontFile, backFile)
//
// Convenience wrapper specifically for registration.
// Uploads both ID photos and returns their URLs.
//
// Storage paths:
//   id-photos/{uid}/front.webp
//   id-photos/{uid}/back.webp
//
// Usage:
//   const { frontURL, backURL } = await uploadIdPhotos(uid, frontFile, backFile);
// =====================================================
export async function uploadIdPhotos(uid, frontFile, backFile) {
  const [frontURL, backURL] = await Promise.all([
    uploadImage(frontFile, `${FOLDERS.idPhotos}/${uid}/front.webp`),
    uploadImage(backFile,  `${FOLDERS.idPhotos}/${uid}/back.webp`),
  ]);

  return { frontURL, backURL };
}


// =====================================================
// deleteIdPhotos(uid)
//
// Deletes both ID photos for a user from Firebase
// Storage. Call this from the admin panel after
// approving a registration.
//
// NOTE: This is also called automatically by the
// Cloud Function (functions/index.js) when admin
// sets user status to "active" in Firestore.
// This frontend version is a fallback / manual option.
//
// Usage:
//   await deleteIdPhotos(uid);
// =====================================================
export async function deleteIdPhotos(uid) {
  const paths = [
    `${FOLDERS.idPhotos}/${uid}/front.webp`,
    `${FOLDERS.idPhotos}/${uid}/back.webp`,
  ];

  await Promise.all(
    paths.map(async (path) => {
      try {
        await deleteObject(ref(storage, path));
      } catch (err) {
        // If file doesn't exist (already deleted), ignore silently
        if (err.code !== 'storage/object-not-found') {
          console.warn(`Could not delete ${path}:`, err.message);
        }
      }
    })
  );
}


// =====================================================
// validateImageFile(file)
//
// Throws a descriptive error if the file is the
// wrong type or too large. Reuse this anywhere.
// =====================================================
export function validateImageFile(file) {
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error('Only JPG, PNG, or WEBP images are allowed.');
  }
  if (file.size > MAX_SIZE_BYTES) {
    throw new Error('Image must be under 5MB.');
  }
}


// =====================================================
// previewImage(file, imgElement)
//
// Show a local preview before uploading.
// Reuse on any page with image uploads.
//
// Usage:
//   import { previewImage } from './storage.js';
//   fileInput.addEventListener('change', (e) => {
//     previewImage(e.target.files[0], document.getElementById('myPreview'));
//   });
// =====================================================
export function previewImage(file, imgElement) {
  if (!file || !imgElement) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    imgElement.src = e.target.result;
    imgElement.style.display = 'block';
  };
  reader.readAsDataURL(file);
}
