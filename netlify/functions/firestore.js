// Server-side Firestore helper for Netlify Functions (CommonJS)
//
// Env var required on Netlify (Site settings → Environment variables):
//   FIREBASE_CONFIG = stringified service account JSON from Firebase
//
// Example FIREBASE_CONFIG value:
// {
//   "type": "service_account",
//   "project_id": "...",
//   "private_key_id": "...",
//   "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
//   "client_email": "...",
//   "client_id": "...",
//   ...
// }
//
// Add dependency in your backend:
//   npm i firebase-admin

const admin = require('firebase-admin');

// Initialize once per lambda container
if (!admin.apps.length) {
  if (!process.env.FIREBASE_CONFIG) {
    throw new Error('FIREBASE_CONFIG is not set');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

  // Netlify/CI often escape newlines in the private key:
  if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/**
 * Save one turn (user + bot) into a subcollection:
 * chat_history/{sessionId}/messages/{autoId}
 * Uses FieldValue.serverTimestamp() (valid here since it's not inside an array).
 */
async function saveHistory(sessionId, userMessage, botReply) {
  const colRef = db.collection('chat_history').doc(sessionId).collection('messages');

  await colRef.add({
    user: userMessage,
    bot: botReply,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Optionally maintain summary fields on the parent doc (not required)
  const sessionRef = db.collection('chat_history').doc(sessionId);
  await sessionRef.set(
    {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      // (optionally) lastUserMessage: userMessage.slice(0, 500),
    },
    { merge: true }
  );
}

/**
 * Read full ordered history (ascending by timestamp).
 * Returns array of { user, bot, timestamp: Date|null }
 */
async function getHistory(sessionId) {
  const colRef = db.collection('chat_history').doc(sessionId).collection('messages');
  const snap = await colRef.orderBy('timestamp', 'asc').get();

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      user: data.user,
      bot: data.bot,
      timestamp: data.timestamp ? data.timestamp.toDate() : null,
      _id: d.id,
    };
  });
}

/**
 * Paged history: pass a pageSize and an optional cursor (doc id to start after).
 * Returns { items, nextCursor }
 */
async function getHistoryPaged(sessionId, pageSize = 20, startAfterId = null) {
  const colRef = db.collection('chat_history').doc(sessionId).collection('messages').orderBy('timestamp', 'asc');

  let query = colRef.limit(pageSize);
  if (startAfterId) {
    const docRef = db.collection('chat_history').doc(sessionId).collection('messages').doc(startAfterId);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      query = colRef.startAfter(docSnap).limit(pageSize);
    }
  }

  const snap = await query.get();
  const items = snap.docs.map((d) => ({ _id: d.id, ...d.data(), timestamp: d.data().timestamp?.toDate() || null }));
  const nextCursor = snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1].id : null;
  return { items, nextCursor };
}

/**
 * Delete an entire session (careful!)
 */
async function deleteSession(sessionId) {
  const colRef = db.collection('chat_history').doc(sessionId).collection('messages');
  const snap = await colRef.get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(db.collection('chat_history').doc(sessionId));
  await batch.commit();
}

module.exports = {
  db,
  saveHistory,
  getHistory,
  getHistoryPaged,
  deleteSession,
};
