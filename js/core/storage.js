/* ================================================
   storage.js — BarangayConnect
   Centralized Firebase Storage upload and deletion
   utilities. Import in any module that requires
   image uploading, compression, or cleanup.

   Storage paths:
     id-photos/{barangayId}/{uid}/front.webp
     id-photos/{barangayId}/{uid}/back.webp
     avatars/{barangayId}/{uid}.webp

   WHAT IS IN HERE:
     · Image compression via Canvas API (WebP output)
     · Generic image upload with compression and metadata
     · Paired ID photo upload scoped to barangay and user
     · Paired ID photo deletion with missing-file tolerance
     · Image file type and size validation
     · File preview helper for <img> elements

   WHAT IS NOT IN HERE:
     · Firebase Storage initialization    → firebase-config.js
     · Storage path construction          → db-paths.js
     · Firestore user document writes     → registration.js / profile.js

   REQUIRED IMPORTS:
     · ./firebase-config.js              (storage)
     · ./db-paths.js                     (idPhotoFrontPath, idPhotoBackPath)
     · firebase-storage.js@10.12.0       (ref, uploadBytes, getDownloadURL,
                                          deleteObject)

   QUICK REFERENCE:
     Compress image      → compressImage(file, maxWidth?, quality?)
     Upload image        → uploadImage(file, storagePath)
     Upload ID photos    → uploadIdPhotos(barangay, uid, frontFile, backFile)
     Delete ID photos    → deleteIdPhotos(barangay, uid)
     Validate image file → validateImageFile(file)
     Preview image       → previewImage(file, imgElement)
================================================ */


/* ================================================
   IMPORTS
================================================ */

import { storage } from './firebase-config.js';
import { idPhotoFrontPath, idPhotoBackPath } from './db-paths.js';

import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";


/* ================================================
   COMPRESS IMAGE
   Resizes and re-encodes a file to WebP using a
   Canvas element. Returns a compressed File object.
   Does not upscale images narrower than maxWidth.
================================================ */

export function compressImage(file, maxWidth = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let width  = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width  = maxWidth;
      }

      const canvas  = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error('Image compression failed.')); return; }
          resolve(new File([blob], 'compressed.webp', { type: 'image/webp' }));
        },
        'image/webp',
        quality,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image for compression.'));
    };

    img.src = url;
  });
}


/* ================================================
   UPLOAD IMAGE
   Validates, compresses, and uploads a single image
   to the given storage path. Returns the public
   download URL of the uploaded file.
================================================ */

export async function uploadImage(file, storagePath) {
  if (!file)        throw new Error('No file provided.');
  if (!storagePath) throw new Error('No storage path provided.');

  validateImageFile(file);

  const compressed = await compressImage(file);
  const storageRef = ref(storage, storagePath);

  const snapshot = await uploadBytes(storageRef, compressed, {
    contentType: 'image/webp',
    customMetadata: {
      originalName: file.name,
      uploadedAt:   new Date().toISOString(),
    },
  });

  return await getDownloadURL(snapshot.ref);
}


/* ================================================
   UPLOAD ID PHOTOS
   Uploads both front and back ID photos in parallel,
   scoped to the user's barangay.

   Returns: { frontURL, backURL }
================================================ */

export async function uploadIdPhotos(barangay, uid, frontFile, backFile) {
  const [frontURL, backURL] = await Promise.all([
    uploadImage(frontFile, idPhotoFrontPath(barangay, uid)),
    uploadImage(backFile,  idPhotoBackPath(barangay, uid)),
  ]);

  return { frontURL, backURL };
}


/* ================================================
   DELETE ID PHOTOS
   Deletes both front and back ID photos for a user.
   Missing files are silently ignored; other errors
   are logged as warnings without throwing.

   Called on registration rejection (client-side)
   and on approval cleanup (Cloud Function).
================================================ */

export async function deleteIdPhotos(barangay, uid) {
  const paths = [
    idPhotoFrontPath(barangay, uid),
    idPhotoBackPath(barangay, uid),
  ];

  await Promise.all(
    paths.map(async (path) => {
      try {
        await deleteObject(ref(storage, path));
      } catch (err) {
        if (err.code !== 'storage/object-not-found') {
          console.warn(`Could not delete ${path}:`, err.message);
        }
      }
    }),
  );
}


/* ================================================
   VALIDATE IMAGE FILE
   Throws if the file is not an accepted image type
   or exceeds the 5MB size limit.
================================================ */

export function validateImageFile(file) {
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX     = 5 * 1024 * 1024;

  if (!ALLOWED.includes(file.type)) throw new Error('Only JPG, PNG, or WEBP images are allowed.');
  if (file.size > MAX)              throw new Error('Image must be under 5MB.');
}


/* ================================================
   PREVIEW IMAGE
   Reads a File object and sets it as the src of
   an <img> element for inline preview display.
================================================ */

export function previewImage(file, imgElement) {
  if (!file || !imgElement) return;

  const reader    = new FileReader();
  reader.onload   = (e) => {
    imgElement.src          = e.target.result;
    imgElement.style.display = 'block';
  };
  reader.readAsDataURL(file);
}