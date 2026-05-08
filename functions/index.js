/* ================================================
   index.js — BarangayConnect
   Firebase Cloud Functions entry point.
   All server-side triggers and scheduled jobs
   for the BarangayConnect backend are defined here.

   WHAT IS IN HERE:
     · Path helpers for Storage ID photo files
     · deleteIdPhotosOnApproval     — clears ID photos when account activates
     · deleteAuthOnUserDocDeletion  — purges Storage, userIndex, and Auth on delete
     · pollPagasaAlerts             — scheduled RSS poller, runs every 30 minutes
     · notifyOnLike                 — creates in-app notification on post like
     · notifyOnComment              — creates in-app notification on post comment

   WHAT IS NOT IN HERE:
     · Client-side Firebase SDK usage  → public JS files
     · Firestore security rules        → firestore.rules
     · Storage security rules          → storage.rules

   REQUIRED IMPORTS:
     · firebase-functions/v2/firestore  (onDocumentCreated, onDocumentUpdated, onDocumentDeleted)
     · firebase-functions/v2/scheduler  (onSchedule)
     · firebase-admin/app               (initializeApp)
     · firebase-admin/storage           (getStorage)
     · firebase-admin/firestore         (getFirestore, Timestamp)
     · firebase-admin/auth              (getAuth)
     · rss-parser                       (Parser)

   QUICK REFERENCE:
     exports.deleteIdPhotosOnApproval    → trigger: users/{uid} updated
     exports.deleteAuthOnUserDocDeletion → trigger: users/{uid} deleted
     exports.pollPagasaAlerts            → schedule: every 30 minutes
     exports.notifyOnLike                → trigger: likes/{likerId} created
     exports.notifyOnComment             → trigger: comments/{commentId} created


// ================================================
// IMPORTS
// ================================================

const {
  onDocumentUpdated,
  onDocumentDeleted,
  onDocumentCreated,
} = require("firebase-functions/v2/firestore");

const {onSchedule} = require("firebase-functions/v2/scheduler");

const {initializeApp} = require("firebase-admin/app");
const {getStorage} = require("firebase-admin/storage");
const {getFirestore, Timestamp} = require("firebase-admin/firestore");
const {getAuth} = require("firebase-admin/auth");

const Parser = require("rss-parser");

initializeApp();


// ================================================
// PATH HELPERS
// ================================================

/* Storage paths for user ID photo assets */

function idPhotoFrontPath(barangayId, uid) {
  return `barangays/${barangayId}/id-photos/${uid}/front.webp`;
}

function idPhotoBackPath(barangayId, uid) {
  return `barangays/${barangayId}/id-photos/${uid}/back.webp`;
}


// ================================================
// HELPER — Delete ID Photos from Storage
// ================================================

/*
   Shared by deleteIdPhotosOnApproval and deleteAuthOnUserDocDeletion.
   Silently ignores 404s (file already gone); logs all other errors.
*/

async function deleteIdPhotos(barangayId, uid) {
  const bucket = getStorage().bucket();

  await Promise.all(
      [idPhotoFrontPath(barangayId, uid), idPhotoBackPath(barangayId, uid)].map(
          async (path) => {
            try {
              await bucket.file(path).delete();
            } catch (err) {
              if (err.code !== 404) {
                console.error(`Error deleting ${path}:`, err.message);
              }
            }
          },
      ),
  );
}


// ================================================
// 1. DELETE ID PHOTOS ON APPROVAL
// ================================================

/*
   Fires when a user document transitions from status "pending" → "active".
   Deletes front and back ID photos from Storage and nullifies the URL
   fields on the user document to complete the cleanup.
*/

exports.deleteIdPhotosOnApproval = onDocumentUpdated(
    "barangays/{barangayId}/users/{uid}",
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();

      if (before.status !== "pending" || after.status !== "active") {
        return null;
      }

      const {barangayId, uid} = event.params;
      const db = getFirestore();

      await deleteIdPhotos(barangayId, uid);

      await db
          .collection("barangays")
          .doc(barangayId)
          .collection("users")
          .doc(uid)
          .update({
            idFrontURL: null,
            idBackURL: null,
            idPhotosDeletedAt: new Date().toISOString(),
          });

      return null;
    },
);


// ================================================
// 2. DELETE AUTH ON USER DOC DELETE
// ================================================

/*
   Fires when a user document is deleted.
   Removes Storage ID photos, the userIndex lookup doc,
   and the Firebase Auth account for that uid.
*/

exports.deleteAuthOnUserDocDeletion = onDocumentDeleted(
    "barangays/{barangayId}/users/{uid}",
    async (event) => {
      const {barangayId, uid} = event.params;
      const db = getFirestore();

      await deleteIdPhotos(barangayId, uid);

      try {
        await db.collection("userIndex").doc(uid).delete();
      } catch (err) {
        console.warn(err.message);
      }

      try {
        await getAuth().deleteUser(uid);
      } catch (err) {
        console.warn(err.message);
      }

      return null;
    },
);


// ================================================
// 3. PAGASA ALERT POLLER
// ================================================

/* Barangay ID and alert expiry window */
const BARANGAY_ID = "bancod";
const MAX_AGE_HOURS = 12;

/* RSS feeds to poll — each maps to a siteAlert document shape */
const PAGASA_FEEDS = [
  {
    url: "https://www.pagasa.dost.gov.ph/rss/weather-warning",
    type: "weather",
    severity: "orange",
    label: "PAGASA Weather Warning",
  },
  {
    url: "https://www.pagasa.dost.gov.ph/rss/tropical-cyclone-bulletin",
    type: "weather",
    severity: "red",
    label: "PAGASA Typhoon Bulletin",
  },
];

/*
   Runs every 30 minutes. For each feed, fetches the latest RSS item,
   skips items older than MAX_AGE_HOURS, deduplicates by a base64 ID
   derived from the item link/title, and writes new alerts to siteAlerts.
*/

exports.pollPagasaAlerts = onSchedule(
    "every 30 minutes",
    async () => {
      const db = getFirestore();
      const parser = new Parser({timeout: 10000});
      const col = db.collection(`barangays/${BARANGAY_ID}/siteAlerts`);
      const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;

      for (const feed of PAGASA_FEEDS) {
        let parsed;

        try {
          parsed = await parser.parseURL(feed.url);
        } catch (err) {
          console.warn(err.message);
          continue;
        }

        if (!parsed.items?.length) continue;

        const item = parsed.items[0];
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();

        if (pubDate < cutoff) continue;

        /* Stable document ID derived from link or title, safe for Firestore */
        const dedupId = `pagasa-${Buffer.from(
            item.link || item.title || String(pubDate),
        )
            .toString("base64")
            .replace(/[^a-zA-Z0-9]/g, "")
            .slice(0, 40)}`;

        const existing = await col.doc(dedupId).get();
        if (existing.exists) continue;

        const rawDesc = item.contentSnippet || item.summary || item.content || "";
        const cleanDesc = rawDesc
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 280);

        await col.doc(dedupId).set({
          type: feed.type,
          severity: feed.severity,
          title: `${feed.label}: ${(item.title || "").trim()}`,
          message: cleanDesc || "See the PAGASA website for full bulletin.",
          source: "pagasa",
          active: true,
          dismissible: true,
          expiresAt: Timestamp.fromMillis(pubDate + MAX_AGE_HOURS * 60 * 60 * 1000),
          createdAt: Timestamp.now(),
          createdBy: "system",
        });
      }

      return null;
    },
);


// ================================================
// 4. LIKE NOTIFICATION
// ================================================

/*
   Fires when a like document is created on an announcement.
   Skips self-likes. Resolves the liker's display name, then
   writes a notification to the post author's subcollection.
*/

exports.notifyOnLike = onDocumentCreated(
    "barangays/{barangayId}/announcements/{postId}/likes/{likerId}",
    async (event) => {
      const {barangayId, postId, likerId} = event.params;
      const db = getFirestore();

      const postSnap = await db
          .collection(`barangays/${barangayId}/announcements`)
          .doc(postId)
          .get();

      if (!postSnap.exists) return null;

      const post = postSnap.data();
      const authorId = post.authorId;

      if (!authorId || authorId === likerId) return null;

      const likerSnap = await db
          .collection(`barangays/${barangayId}/users`)
          .doc(likerId)
          .get();

      const likerName = likerSnap.exists ?
      likerSnap.data().fullName ?? "Someone" :
      "Someone";

      await db
          .collection(`barangays/${barangayId}/users/${authorId}/notifications`)
          .add({
            type: "like",
            postId,
            postTitle: post.title ?? "",
            actorName: likerName,
            read: false,
            createdAt: new Date(),
          });

      return null;
    },
);


// ================================================
// 5. COMMENT NOTIFICATION
// ================================================

/*
   Fires when a comment document is created on an announcement.
   Skips comments by the post author. Writes a notification to
   the author's notifications subcollection.
*/

exports.notifyOnComment = onDocumentCreated(
    "barangays/{barangayId}/announcements/{postId}/comments/{commentId}",
    async (event) => {
      const {barangayId, postId} = event.params;
      const db = getFirestore();
      const comment = event.data.data();

      const postSnap = await db
          .collection(`barangays/${barangayId}/announcements`)
          .doc(postId)
          .get();

      if (!postSnap.exists) return null;

      const post = postSnap.data();
      const authorId = post.authorId;

      if (!authorId || authorId === comment.authorId) return null;

      await db
          .collection(`barangays/${barangayId}/users/${authorId}/notifications`)
          .add({
            type: "comment",
            postId,
            postTitle: post.title ?? "",
            actorName: comment.authorName ?? "Someone",
            read: false,
            createdAt: new Date(),
          });

      return null;
    },
);
